"""Optional Prompt Studio bridge. No weights are copied or registered as library LoRAs.

Installed as backend/lora_studio_bridge.py in Prompt Studio. Registration accepts
a short-lived capability issued by LoRA Studio, never a caller-supplied file path.
"""
import asyncio
import hashlib
import ipaddress
import json
import math
from pathlib import Path
import re
import threading
import urllib.parse
import urllib.request
import uuid

VERSION = 1
REGISTRY = {}
LOCK = threading.RLock()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Bridge redirects are not allowed')


def register_checkpoint(origin, token):
    parsed = urllib.parse.urlsplit(origin)
    if (parsed.scheme != 'http' or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'}
            or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {'', '/'}):
        raise ValueError('LoRA Studio must be a local HTTP origin')
    if not isinstance(token, str) or not re.fullmatch(r'[a-f0-9]{64}', token):
        raise ValueError('Invalid checkpoint capability')
    request = urllib.request.Request(origin.rstrip('/') + '/api/comparison-bridge',
        data=json.dumps({'token': token}).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=15) as response:
        data = json.loads(response.read(16385))
    if data.get('app') != 'lora-studio' or data.get('version') != VERSION:
        raise ValueError('Unsupported LoRA Studio bridge')
    digest = data.get('sha256', '')
    if not re.fullmatch(r'[a-f0-9]{64}', digest):
        raise ValueError('Invalid checkpoint digest')
    original = Path(data['path'])
    path = original.resolve(strict=True)
    root = Path(data['root']).resolve(strict=True)
    if (not original.is_absolute() or path != root / 'weights' / (digest + '.safetensors')
            or root.parent.name != 'comparisons' or not re.fullmatch(r'[a-f0-9]{32}', root.name)):
        raise ValueError('Checkpoint must be a managed comparison snapshot')
    with path.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != digest:
            raise ValueError('Checkpoint snapshot changed')
    identity = uuid.uuid4().hex
    stat = path.stat()
    with LOCK:
        # Reuse the immutable identity so ComfyUI can cache weights between seeds.
        for key, item in REGISTRY.items():
            if item['path'] == path and item['stat'] == (stat.st_size, stat.st_mtime_ns):
                return key
        REGISTRY[identity] = {'path': path, 'stat': (stat.st_size, stat.st_mtime_ns)}
    return identity


class LoraStudioCheckpoint:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'model': ('MODEL',), 'checkpoint_id': ('STRING',),
                             'strength': ('FLOAT', {'default': 1.0, 'min': -100, 'max': 100})}}

    RETURN_TYPES = ('MODEL',)
    FUNCTION = 'load'
    CATEGORY = 'Prompt Studio/integrations'

    def load(self, model, checkpoint_id, strength):
        if not math.isfinite(strength) or not -100 <= strength <= 100:
            raise ValueError('Invalid checkpoint strength')
        with LOCK:
            item = REGISTRY.get(checkpoint_id)
        if not item:
            raise ValueError('Checkpoint registration expired. Retry the comparison in LoRA Studio.')
        stat = item['path'].stat()
        if item['stat'] != (stat.st_size, stat.st_mtime_ns):
            raise ValueError('Checkpoint snapshot changed. Create a new comparison.')
        if strength == 0:
            return (model,)
        import comfy.utils
        import comfy.sd
        if getattr(self, '_identity', None) != checkpoint_id:
            self._weights = comfy.utils.load_torch_file(str(item['path']), safe_load=True)
            self._identity = checkpoint_id
        patched, _ = comfy.sd.load_lora_for_models(model, None, self._weights, strength, 0)
        return (patched,)


def register(server, classes, names):
    from aiohttp import web
    from . import routes
    from .generation_reservation import GenerationReservation, install_admission

    def release_owned_gpu():
        with routes._GPU_HANDOFF_LOCK:
            if routes._ACTIVE_SHARED_LLM is not None:
                result = routes._release_shared_llm_for_comfy({})
                routes._complete_comfy_handoff(result['handoff_token'])

    def track_token(token, active):
        # Existing restart/shutdown checks must see reservations between cells too.
        with routes._LLM_OPERATION_TOKENS_LOCK:
            if active:
                routes._LLM_OPERATION_TOKENS.add(token)
            else:
                routes._LLM_OPERATION_TOKENS.discard(token)

    reservation = GenerationReservation(routes._LLM_COORDINATOR, routes.CancellationToken,
        lambda: sum((list(q) for q in server.prompt_queue.get_current_queue()), []), release_owned_gpu,
        track_token=track_token)
    admission = install_admission(server, reservation)
    classes['PS_LoraStudioCheckpoint'] = LoraStudioCheckpoint
    names['PS_LoraStudioCheckpoint'] = 'LoRA Studio Comparison Checkpoint'

    def guard(request):
        try:
            local = ipaddress.ip_address(request.remote).is_loopback
        except (ValueError, TypeError):
            local = False
        host = urllib.parse.urlsplit('http://' + request.host).hostname
        if not local or host not in {'127.0.0.1', 'localhost', '::1'}:
            raise web.HTTPForbidden(text='Comparison bridge is local only')
        if request.headers.get('Origin') not in {None, 'http://' + request.host}:
            raise web.HTTPForbidden(text='Cross-origin bridge requests are not allowed')

    @server.routes.get('/promptstudio/lora-studio/capabilities')
    async def capabilities(request):
        guard(request)
        return web.json_response({'version': VERSION, 'node': 'PS_LoraStudioCheckpoint', 'generation_reservation': 1})

    @server.routes.get('/promptstudio/lora-studio/generation')
    async def generation_status(request):
        return web.json_response(reservation.status(), headers={'Cache-Control': 'no-store'})

    @server.routes.post('/promptstudio/lora-studio/generation/{action}')
    async def generation_action(request):
        guard(request)
        try:
            if request.content_type != 'application/json' or not request.content_length or request.content_length > 4096:
                raise ValueError('Use a small JSON reservation request')
            data = await request.json()
            action = request.match_info['action']
            if action == 'begin':
                comparison = data.get('comparison', '')
                if not re.fullmatch(r'[a-f0-9]{32}', str(comparison)):
                    raise ValueError('Invalid comparison identity')
                async with admission:
                    result = reservation.start(comparison)
            elif action in {'pulse', 'end'}:
                result = reservation.pulse(data.get('token', ''), finish=action=='end')
            else:
                raise ValueError('Unknown reservation action')
            return web.json_response(result)
        except (ValueError, TypeError):
            return web.json_response({'error': 'Generation reservation unavailable or expired; wait for active work to finish and resume.'}, status=409)

    @server.routes.post('/promptstudio/lora-studio/release')
    async def release_route(request):
        guard(request)
        from . import routes

        def release_owned(_data):
            with routes._GPU_HANDOFF_LOCK:
                if routes._ACTIVE_SHARED_LLM is None:
                    # This integration does not select an LLM. Never invent a
                    # default provider and try to unload an unrelated endpoint.
                    return {'handoff_token': routes._reserve_comfy_handoff()}
                return routes._release_shared_llm_for_comfy({})
        try:
            result = await routes._run_llm_request({}, routes.LLM_PRIORITY_STUDIO,
                release_owned, prepare_for_llm=False)
            return web.json_response(result)
        except Exception:
            return web.json_response({'error': 'Prompt Studio could not release its active LLM. Wait for its current work to finish and retry.'}, status=409)

    @server.routes.post('/promptstudio/lora-studio/register')
    async def register_route(request):
        guard(request)
        try:
            if request.content_type != 'application/json' or not request.content_length or request.content_length > 4096:
                raise ValueError('Use a small JSON registration request')
            data = await request.json()
            identity = await asyncio.to_thread(register_checkpoint, data['origin'], data['token'])
            return web.json_response({'checkpoint_id': identity})
        except (ValueError, KeyError, TypeError, OSError):
            return web.json_response({'error': 'Checkpoint registration failed. Check that LoRA Studio is running on this computer and retry.'}, status=400)
