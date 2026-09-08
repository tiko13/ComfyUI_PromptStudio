import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from test_setup_service import SETUP, Paths


class SetupRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        paths = Paths(self.root / "models")
        paths.get_user_directory = lambda: str(self.root / "users")
        package = types.ModuleType("setup_route_fixture")
        package.__path__ = []
        user_manager = types.SimpleNamespace(get_request_user_filepath=lambda request, file, create_dir=False:
            str(self.root / "users" / request.headers.get("comfy-user", "default")))
        self.server = types.SimpleNamespace(app=web.Application(), routes=web.RouteTableDef(), user_manager=user_manager)
        spec = importlib.util.spec_from_file_location("setup_route_fixture.setup_routes", Path(__file__).resolve().parents[1] / "setup_routes.py")
        module = importlib.util.module_from_spec(spec)
        with mock.patch.dict(sys.modules, {"setup_route_fixture": package, "setup_route_fixture.setup_service": SETUP,
                                          "aiohttp": types.SimpleNamespace(web=web),
                                          "folder_paths": paths, "nodes": types.SimpleNamespace(NODE_CLASS_MAPPINGS={})}):
            spec.loader.exec_module(module)
            first = module.register_setup_routes(self.server)
            second = module.register_setup_routes(self.server)
            self.assertIs(first, second)
        self.server.app.add_routes(self.server.routes)
        self.client = TestClient(TestServer(self.server.app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def test_real_aiohttp_registration_and_host_user_path(self):
        result = await self.client.get("/promptstudio/setup/status")
        self.assertEqual(result.status, 200)
        self.assertEqual((await result.json())["onboarding"], "new")
        self.assertFalse((self.root / "users").exists())
        result = await self.client.post("/promptstudio/setup/dismiss", json={}, headers={"comfy-user": "alice"})
        self.assertEqual(result.status, 200)
        self.assertTrue((self.root / "users" / "alice" / ".promptstudio-setup" / "state.json").is_file())
        result = await self.client.get("/promptstudio/setup/status")
        self.assertEqual((await result.json())["onboarding"], "new")

    async def test_plan_reports_missing_capabilities_and_rejects_invalid_input(self):
        result = await self.client.post("/promptstudio/setup/plan", json={})
        self.assertEqual(result.status, 200)
        self.assertTrue((await result.json())["blockers"])
        result = await self.client.post("/promptstudio/setup/plan", json={"packs": ["bad"]})
        self.assertEqual(result.status, 400)


if __name__ == "__main__": unittest.main()
