"""Thin host adapters for the image setup wizard."""
import asyncio
import json
from pathlib import Path
import urllib.error
import urllib.request

from .setup_service import SetupService


def register_setup_routes(server):
    existing = getattr(server, "_promptstudio_setup_service", None)
    if existing is not None:
        return existing
    from aiohttp import web
    import folder_paths
    import nodes

    def user_root(request):
        resolved = server.user_manager.get_request_user_filepath(request, None, create_dir=False)
        if not resolved:
            raise ValueError("ComfyUI user storage is unavailable")
        base = Path(folder_paths.get_user_directory()).resolve()
        path = Path(resolved).resolve()
        if base not in path.parents:
            raise ValueError("Invalid ComfyUI user directory")
        return path

    def manager_available():
        return any(getattr(route.resource, "canonical", "") == "/customnode/install/git_url"
                   for route in server.app.router.routes())

    def install_node(dependency):
        # The reviewed catalog owns this URL. Use the existing Manager contract
        # and let its security/install policy handle third-party code.
        url = f"http://127.0.0.1:{server.port}/customnode/install/git_url"
        request = urllib.request.Request(url, data=dependency["url"].encode(), method="POST",
                                         headers={"Content-Type": "text/plain"})
        try:
            with urllib.request.urlopen(request, timeout=1200) as response:
                response.read(64 * 1024)
        except urllib.error.HTTPError as exc:
            raise ValueError(f"ComfyUI Manager could not install {dependency['name']} (HTTP {exc.code}). "
                             "Check Manager's install/security settings, then resume setup.") from exc

    service = SetupService(folder_paths, nodes.NODE_CLASS_MAPPINGS,
                           install_node=install_node, manager_available=manager_available)

    async def dispatch(request):
        try:
            root = user_root(request)
            action = request.match_info["action"]
            payload = await request.json() if request.method == "POST" else {}
            if not isinstance(payload, dict):
                raise ValueError("Setup request must be an object")
            if action == "status" and request.method == "GET":
                result = await asyncio.to_thread(service.status, root)
            elif action == "plan" and request.method == "POST":
                result = await asyncio.to_thread(service.plan, root, payload)
            elif action == "start" and request.method == "POST":
                result = await asyncio.to_thread(service.start, root, payload)
            elif action == "dismiss" and request.method == "POST":
                result = await asyncio.to_thread(service.dismiss, root)
            elif action == "finish" and request.method == "POST":
                result = await asyncio.to_thread(service.finish, root, payload.get("job_id"), payload.get("results"))
            elif action in {"pause", "resume", "cancel"} and request.method == "POST":
                result = await asyncio.to_thread(service.control, root, action)
            else:
                raise web.HTTPNotFound()
            return web.json_response(result, headers={"Cache-Control": "no-store"})
        except (ValueError, OSError, KeyError) as exc:
            return web.json_response({"error": str(exc)}, status=400)

    server.routes.get("/promptstudio/setup/{action}")(dispatch)
    server.routes.post("/promptstudio/setup/{action}")(dispatch)
    server._promptstudio_setup_service = service
    return service
