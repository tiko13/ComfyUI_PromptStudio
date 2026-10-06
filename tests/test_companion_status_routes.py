import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

from test_regressions import load_modules


class CompanionStatusRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_registered_video_route_proves_loaded_without_importing_companion(self):
        with tempfile.TemporaryDirectory() as directory:
            nodes, routes = load_modules(directory)
            request = SimpleNamespace(app=SimpleNamespace(router=SimpleNamespace(routes=lambda: [
                SimpleNamespace(method="GET", resource=SimpleNamespace(canonical="/promptstudio-video/capabilities"))])))
            with mock.patch.object(nodes.folder_paths, "get_folder_paths", return_value=[directory], create=True), \
                 mock.patch.object(routes.web, "json_response", side_effect=lambda data, **kwargs: (data, 200)):
                payload, status = await routes.prompt_studio_video_status(request)
            self.assertEqual(status, 200)
            self.assertEqual(payload, {"installed": True, "loaded": True, "state": "loaded"})
            routes.shared_job_ledger().close()
