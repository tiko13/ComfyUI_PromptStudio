"""Expiring comparison reservation shared by HTTP admission and the GPU scheduler."""
import asyncio
from contextlib import contextmanager
import secrets
import threading
import time


class ReservationExpired(ValueError):
    pass


class GenerationReservation:
    def __init__(self, coordinator, token_factory, queue, release_gpu, *, clock=time.monotonic, ttl=30, track_token=None):
        self.coordinator, self.token_factory = coordinator, token_factory
        self.queue, self.release_gpu, self.clock, self.ttl = queue, release_gpu, clock, ttl
        self.lock = threading.RLock()
        self.current = None
        self.track_token = track_token or (lambda token, active: None)

    def start(self, comparison):
        with self.lock:
            if self.current:
                raise ValueError('Another LoRA Studio comparison already owns the generation reservation')
            item = {'comparison': comparison, 'token': secrets.token_hex(32), 'expires': self.clock()+self.ttl,
                    'state': 'waiting', 'closing': False, 'submitting': 0}
            self.current = item
            threading.Thread(target=self._hold, args=(item,), daemon=True).start()
            return {'token': item['token'], **self.status()}

    def _expired(self, item):
        return item['closing'] or self.clock() >= item['expires']

    def _own_work(self, item):
        if item['submitting']:
            return True  # Validation may still be running before ComfyUI queues it.
        for row in self.queue():
            extra = row[3] if len(row) > 3 and isinstance(row[3], dict) else {}
            owner = extra.get('lora_studio')
            if isinstance(owner, dict) and owner.get('comparison') == item['comparison']:
                return True
        return False

    def _hold(self, item):
        token = self.token_factory(lambda: self._expired(item) and not self._own_work(item))
        self.track_token(token, True)
        try:
            # Drain existing ComfyUI work before reserving the LLM lane. An
            # existing workflow may itself contain native LLM nodes.
            while self.queue():
                token.check()
                time.sleep(.1)

            def hold():
                self.release_gpu()
                with self.lock:
                    item['state'] = 'active'
                while not self._expired(item) or self._own_work(item):
                    token.check()
                    token.note_activity()
                    time.sleep(.1)

            self.coordinator.run([('shared-gpu',)], hold, token=token)
        except (Exception, asyncio.CancelledError):
            pass  # An expired/failed lease cannot authorize further cells.
        finally:
            self.track_token(token, False)
            with self.lock:
                if self.current is item:
                    self.current = None

    def pulse(self, token, *, finish=False):
        with self.lock:
            item = self.current
            if not item or not secrets.compare_digest(str(token), item['token']):
                raise ValueError('Generation reservation expired; resume the comparison')
            if not finish and self._expired(item):
                raise ValueError('Generation reservation expired; resume the comparison')
            item['expires'] = self.clock()+self.ttl
            item['closing'] = finish
            return self.status()

    def authorized(self, token):
        with self.lock:
            return bool(self.current and self.current['state']=='active' and not self._expired(self.current)
                        and secrets.compare_digest(str(token), self.current['token']))

    @contextmanager
    def submission(self, token):
        with self.lock:
            if not self.authorized(token):
                raise ReservationExpired('Generation reservation expired')
            item = self.current
            item['submitting'] += 1
        try:
            yield
        finally:
            with self.lock:
                item['submitting'] -= 1

    def status(self):
        with self.lock:
            item = self.current
            return {'reserved': bool(item), 'active': bool(item and item['state']=='active'),
                    'label': 'Generating in LoRA studio' if item and item['state']=='active' else
                             'LoRA studio waiting for current work' if item else ''}


def install_admission(server, reservation):
    from aiohttp import web
    admission = asyncio.Lock()

    @web.middleware
    async def gate(request, handler):
        if request.method != 'POST' or request.path not in {'/prompt', '/api/prompt'}:
            return await handler(request)
        supplied = request.headers.get('X-LoRA-Studio-Reservation')
        while True:
            async with admission:
                if supplied:
                    if not reservation.authorized(supplied):
                        return web.json_response({'error': 'LoRA Studio generation reservation expired'}, status=409)
                    try:
                        with reservation.submission(supplied):
                            return await handler(request)
                    except ReservationExpired:
                        return web.json_response({'error': 'LoRA Studio generation reservation expired'}, status=409)
                if not reservation.status()['reserved']:
                    if request.transport is None or request.transport.is_closing():
                        raise web.HTTPRequestTimeout(text='Queued request disconnected')
                    return await handler(request)
            if request.transport is None or request.transport.is_closing():
                raise web.HTTPRequestTimeout(text='Queued request disconnected')
            await asyncio.sleep(.1)

    server.app.middlewares.append(gate)
    return admission
