"""Thin host adapter for shared replay identities; no queue side effects."""
import asyncio
import hashlib
import importlib.util
from pathlib import Path
import sys
import re

from aiohttp import web
import folder_paths
from server import PromptServer
from .provenance import capture_runtime_metadata, DEFAULT_ASSET_CACHE
from .request_security import install_boundary

ROOT = Path(__file__).resolve().parent


def _digest(path):
    try: return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError: return "unavailable"


def _version(root):
    try:
        match = re.search(r'^version\s*=\s*"([^"]+)"', (root / "pyproject.toml").read_text(encoding="utf-8"), re.MULTILINE)
        return match.group(1) if match else "unavailable"
    except OSError: return "unavailable"


def _pure_video_module(name, relative):
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, ROOT.parent / "PromptStudio_Video" / relative)
        if spec is None or spec.loader is None: raise ValueError("Video provenance adapter is unavailable")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


def metadata_for_snapshot(snapshot, product):
    versions = {"wire_schema": _digest(ROOT / "wire_contracts.py"), "image_extension": _version(ROOT),
                "python": sys.version.split()[0], "image_prompt_policy": _digest(ROOT / "nodes.py")}
    host = sys.modules.get("comfyui_version")
    versions["comfyui"] = str(getattr(host, "__version__", "unavailable"))
    if product == "video":
        video_root = ROOT.parent / "PromptStudio_Video"
        versions.update({"video_extension": _version(video_root), "director_policy": _digest(video_root / "video/director_policy.py"),
                         "video_schema": _digest(video_root / "video/contracts.py")})
        versions["h3_base_guide"] = _digest(video_root / "video/guides/VIDEO_PROMPT_WRITING_GUIDE_base_en.md")
        versions["h3_reference_guide"] = _digest(video_root / "video/guides/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md")
        adapter = _pure_video_module("_studio_video_provenance", "video/provenance.py")
        policy = _pure_video_module("_studio_video_turbo_policy", "nodes/minimax_h3_turbo_profile.py")
        snapshot = adapter.effective_asset_snapshot(snapshot, policy.select_turbo_profile)
    resolver = getattr(folder_paths, "get_full_path", None)
    if resolver is None: resolver = lambda category, name: None
    return capture_runtime_metadata(snapshot, resolver, versions=versions)


@PromptServer.instance.routes.post("/promptstudio/prompt-studio/provenance")
async def prompt_studio_provenance(request):
    try:
        data = await request.json()
        if not isinstance(data, dict) or data.get("product", "image") not in {"image", "video"}:
            raise ValueError("Provenance product must be image or video")
        snapshot = data.get("snapshot")
        if not isinstance(snapshot, dict) or not isinstance(snapshot.get("output"), dict):
            raise ValueError("Provenance requires an executable workflow/output snapshot")
        return web.json_response(await asyncio.to_thread(metadata_for_snapshot, snapshot, data.get("product", "image")))
    except (ValueError, TypeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)


async def _close_identity_cache(_application):
    await asyncio.to_thread(DEFAULT_ASSET_CACHE.close)


if getattr(PromptServer.instance.app, "on_cleanup", None) is not None:
    PromptServer.instance.app.on_cleanup.append(_close_identity_cache)
install_boundary(PromptServer.instance.app, {"/promptstudio/prompt-studio/provenance":100 * 1024 * 1024})
