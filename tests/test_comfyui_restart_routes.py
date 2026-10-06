import tempfile
import unittest
from unittest import mock

from test_regressions import load_modules


class RestartRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        _, self.routes = load_modules(self.temp.name)
        self.routes.PromptServer.instance.prompt_queue = mock.Mock()
        self.routes.PromptServer.instance.prompt_queue.get_tasks_remaining.return_value = 0

    async def asyncTearDown(self):
        self.routes.shared_job_ledger().close()
        self.temp.cleanup()

    async def test_image_and_video_jobs_share_restart_guard(self):
        ledger = self.routes.shared_job_ledger()
        for studio in ("image", "video"):
            ledger.start(studio, studio=studio)
            self.assertEqual(self.routes._comfyui_restart_busy()["studio_jobs"], 1)
            ledger.update(studio, studio=studio, state="complete")
        self.assertFalse(any(self.routes._comfyui_restart_busy().values()))

    async def test_queue_unavailable_is_not_idle(self):
        self.routes.PromptServer.instance.prompt_queue = None
        with self.assertRaises(RuntimeError):
            self.routes._comfyui_restart_busy()

    async def test_queue_operations_and_updates_are_checked(self):
        self.routes.PromptServer.instance.prompt_queue.get_tasks_remaining.return_value = 2
        self.routes._LLM_OPERATION_TOKENS.add(object())
        with self.routes._COMFYUI_UPDATE_LOCK:
            busy = self.routes._comfyui_restart_busy()
        self.assertEqual(busy["generation_queue"], 2)
        self.assertEqual(busy["llm_operations"], 1)
        self.assertTrue(busy["runtime_update"])

    async def test_health_identifies_same_boot_as_restart_controller(self):
        payload, status = await self.routes.prompt_studio_runtime_health(None)
        self.assertEqual(status, 200)
        self.assertEqual(payload["boot_id"], self.routes._COMFYUI_RESTART.boot_id)

    async def test_route_delegates_to_shared_controller(self):
        request = object()
        with mock.patch.object(self.routes, "_COMFYUI_RESTART", new=mock.AsyncMock(return_value="result")) as controller:
            self.assertEqual(await self.routes.prompt_studio_restart_comfyui(request), "result")
            controller.assert_awaited_once_with(request)


if __name__ == "__main__":
    unittest.main()
