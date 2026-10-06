import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest import mock

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer, make_mocked_request


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "studio_restart_test"
package = types.ModuleType(PACKAGE)
package.__path__ = [str(ROOT)]
sys.modules[PACKAGE] = package
spec = importlib.util.spec_from_file_location(PACKAGE + ".comfyui_restart", ROOT / "comfyui_restart.py")
restart = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restart)
security = sys.modules[PACKAGE + ".request_security"]
PATH = "/promptstudio/prompt-studio/restart-comfyui"


class RestartHTTPTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.http_modules = mock.patch.dict(sys.modules, {"aiohttp": aiohttp})
        self.http_modules.start()
        self.addCleanup(self.http_modules.stop)
        self.calls = []
        self.statuses = [200, 200]
        self.disconnect = False
        self.require_auth = False
        self.idle = mock.Mock(return_value={"generation_queue": 0, "studio_jobs": 0})
        self.controller = restart.RestartController(self.idle)

        @web.middleware
        async def manager_auth(request, handler):
            if request.path in restart.MANAGER_RESTART_PATHS and self.require_auth:
                if request.headers.get("Authorization") != "Bearer test" or request.cookies.get("session") != "test":
                    return web.Response(status=401)
            return await handler(request)

        async def manager(request):
            self.calls.append((request.path, await request.json()))
            if self.disconnect:
                request.transport.close()
            status = self.statuses[restart.MANAGER_RESTART_PATHS.index(request.path)]
            return web.Response(status=status, headers={"Location": "/elsewhere"} if status == 302 else {})

        app = web.Application(middlewares=[security.create_boundary_middleware({PATH: 1024}), manager_auth])
        app.router.add_post(PATH, self.controller.__call__)
        for path in restart.MANAGER_RESTART_PATHS:
            app.router.add_post(path, manager)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()

    async def test_restart_delegates_with_json_and_identifies_old_boot(self):
        response = await self.client.post(PATH, json={})
        self.assertEqual(response.status, 202)
        payload = await response.json()
        self.assertEqual(payload["status"], "restart_requested")
        self.assertEqual(payload["boot_id"], self.controller.boot_id)
        self.assertEqual(self.calls, [(restart.MANAGER_RESTART_PATHS[0], {})])
        self.assertNotEqual(self.controller.boot_id, restart.RestartController(self.idle).boot_id)
        self.assertEqual((await self.client.post(PATH, json={})).status, 409)
        self.assertEqual(len(self.calls), 1)

    async def test_fallback_only_for_missing_or_unsupported_manager_route(self):
        for status in (404, 405):
            self.controller.pending = False
            self.calls.clear()
            self.statuses = [status, 200]
            response = await self.client.post(PATH, json={})
            self.assertEqual(response.status, 202)
            self.assertEqual([path for path, _ in self.calls], list(restart.MANAGER_RESTART_PATHS))

    async def test_manager_errors_and_redirects_never_fall_back(self):
        for status in (401, 403, 500, 302):
            self.calls.clear()
            self.statuses = [status, 200]
            response = await self.client.post(PATH, json={})
            self.assertEqual(response.status, 502)
            self.assertEqual((await response.json())["manager_status"], status)
            self.assertEqual(len(self.calls), 1)
            self.assertFalse(self.controller.pending)

    async def test_missing_manager_is_reported_without_starting_a_process(self):
        self.statuses = [404, 405]
        response = await self.client.post(PATH, json={})
        self.assertEqual(response.status, 503)
        self.assertEqual((await response.json())["code"], "manager_restart_unavailable")

    async def test_busy_generation_and_either_studio_are_rejected(self):
        for busy in ({"generation_queue": 1}, {"studio_jobs": 1}, {"llm_operations": 1}, {"runtime_update": True}):
            self.idle.return_value = busy
            response = await self.client.post(PATH, json={})
            self.assertEqual(response.status, 409)
            self.assertEqual((await response.json())["busy"], busy)
        self.assertFalse(self.calls)

    async def test_unknown_idle_state_is_fail_closed(self):
        self.idle.side_effect = RuntimeError("queue unavailable")
        self.assertEqual((await self.client.post(PATH, json={})).status, 503)
        self.assertFalse(self.calls)

    async def test_malformed_or_forced_request_is_rejected(self):
        for body in ("invalid", "[]", '{"force":true}'):
            response = await self.client.post(PATH, data=body, headers={"Content-Type": "application/json"})
            self.assertEqual(response.status, 400)
        self.assertFalse(self.calls)

    async def test_body_limit_and_cross_origin_protection(self):
        response = await self.client.post(PATH, data="x" * 1025)
        self.assertEqual(response.status, 413)
        response = await self.client.post(PATH, json={}, headers={"Origin": "https://evil.invalid"})
        self.assertEqual(response.status, 403)
        self.assertFalse(self.calls)

    async def test_remote_client_cannot_use_loopback_proxy(self):
        request = make_mocked_request("POST", PATH).clone(remote="192.0.2.1")
        response = await self.controller(request)
        self.assertEqual(response.status, 403)
        self.idle.assert_not_called()

    async def test_manager_auth_is_enforced_and_credentials_preserved(self):
        self.require_auth = True
        self.assertEqual((await self.client.post(PATH, json={})).status, 502)
        response = await self.client.post(PATH, json={}, headers={
            "Authorization": "Bearer test", "Cookie": "session=test",
            "Origin": str(self.client.make_url("/")).rstrip("/"),
        })
        self.assertEqual(response.status, 202)
        self.assertEqual(len(self.calls), 1)

    async def test_host_header_does_not_select_destination(self):
        response = await self.client.post(PATH, json={}, headers={"Host": "untrusted.invalid:9999"})
        self.assertEqual(response.status, 202)
        self.assertEqual(len(self.calls), 1)

    async def test_disconnect_is_unconfirmed_and_never_retried(self):
        self.disconnect = True
        response = await self.client.post(PATH, json={})
        self.assertEqual(response.status, 202)
        self.assertEqual((await response.json())["status"], "restart_unconfirmed")
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(self.controller.pending)


if __name__ == "__main__":
    unittest.main()
