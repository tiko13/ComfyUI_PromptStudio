"""Thin host adapters for the image setup wizard."""
import asyncio
import json
from pathlib import Path
import urllib.error
import urllib.request
import time
import uuid

from .setup_service import SetupService


def register_setup_routes(server):
    existing = getattr(server, "_promptstudio_setup_service", None)
    if existing is not None:
        return existing
    from aiohttp import web
    import folder_paths
    import nodes
    from .controlnet import register_aux_path
    register_aux_path(folder_paths)
    from .reference_regions import register_paths
    register_paths(folder_paths)

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
        return any(getattr(route.resource, "canonical", "") in {"/customnode/install/git_url", "/v2/manager/queue/task"}
                   for route in server.app.router.routes())

    def install_node(dependency):
        routes = {getattr(route.resource, "canonical", "") for route in server.app.router.routes()}
        if "/v2/manager/queue/task" in routes:
            identity = "promptstudio-" + uuid.uuid4().hex
            base = f"http://127.0.0.1:{server.port}/v2/manager/queue/"
            def call(action, payload=None):
                req = urllib.request.Request(base + action, data=None if payload is None else json.dumps(payload).encode(),
                                             headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=60) as response:
                    data = response.read()
                    return json.loads(data) if data else {}
            registry = dependency.get("registry_id")
            call("task", {"ui_id": identity, "client_id": "promptstudio-setup", "kind": "install", "params": {
                "id": registry or dependency["url"].removeprefix("https://github.com/"),
                "version": "latest" if registry else "nightly", "selected_version": "latest" if registry else "nightly",
                "repository": dependency["url"], "mode": "cache", "channel": "default", "skip_post_install": False}})
            call("start", {})
            deadline = time.monotonic() + 1200
            while time.monotonic() < deadline:
                history = call("history?ui_id=" + identity)
                item = history.get(identity) or history.get("history")
                if item and item.get("status", {}).get("completed"):
                    if item["status"]["status_str"] not in {"success", "skip", "skipped"}:
                        raise ValueError(f"ComfyUI Manager could not install {dependency['name']}: {item.get('result', '')}")
                    return
                time.sleep(1)
            raise ValueError("Manager installation is still pending. Check Manager before resuming setup.")
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
                register_aux_path(folder_paths)
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
