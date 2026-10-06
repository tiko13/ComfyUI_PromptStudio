import asyncio
import tempfile
import threading
import unittest
from unittest import mock

from test_regressions import load_modules


class ProfileSwitchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        _, self.routes = load_modules(self.temp.name)
        self.settings = {"llm_provider": "llamacpp", "llamacpp_url": "http://localhost:8080",
                         "llamacpp_config_profile": "new.json", "llamacpp_model": "old.gguf",
                         "keep_models_loaded": True, "when_idle": True}
        self.process = {"managed": True, "running": True, "model": "new.gguf",
                        "config_profile": "new.json", "url": "http://127.0.0.1:8080"}

    async def asyncTearDown(self):
        await self.routes._shutdown_llm_queues(None)
        self.temp.cleanup()

    async def restart(self):
        request = mock.Mock(remote="127.0.0.1", content_length=100)
        request.json = mock.AsyncMock(return_value=self.settings)
        return await self.routes.prompt_studio_llamacpp_server_restart(request)

    async def test_stale_selection_uses_active_managed_model_and_vision(self):
        def get(url, *_):
            if url.endswith("/health"):
                return {"status": "ok"}
            if "/slots?" in url:
                self.assertIn("model=new.gguf", url)
                return []
            return {"data": [{"id": "new.gguf", "status": {"value": "loaded"}}]}
        with (mock.patch.object(self.routes, "_get_json", side_effect=get),
              mock.patch.object(self.routes, "_list_llamacpp_models", return_value=["new.gguf"]),
              mock.patch.object(self.routes, "_llamacpp_managed_process_status", return_value=self.process),
              mock.patch.object(self.routes, "_llamacpp_props", return_value={"modalities": {"vision": True}})):
            status = self.routes._llamacpp_generation_status(self.settings)
        self.assertEqual(status["model"], "new.gguf")
        self.assertTrue(status["model_installed"])
        self.assertTrue(status["vision"])

    async def test_external_endpoint_retains_its_selection(self):
        with (mock.patch.object(self.routes, "_get_json", return_value={"status": "ok"}),
              mock.patch.object(self.routes, "_list_llamacpp_models", return_value=["new.gguf"]),
              mock.patch.object(self.routes, "_llamacpp_managed_process_status", return_value=self.process),
              mock.patch.object(self.routes, "_llamacpp_props", return_value={})):
            status = self.routes._llamacpp_generation_status({**self.settings, "llamacpp_url": "http://localhost:9090"})
        self.assertEqual(status["model"], "old.gguf")
        self.assertFalse(status["model_installed"])

    async def test_busy_or_unknown_status_defers_and_external_is_skipped(self):
        for busy in (True, None, False):
            with (mock.patch.object(self.routes, "_llamacpp_generation_status", return_value={
                    "reachable": True, "busy": busy, "server_process": self.process}),
                  mock.patch.object(self.routes, "_restart_llamacpp_server", return_value={"model": "new.gguf"}) as restart):
                result, code = await self.restart()
            self.assertEqual(code, 200)
            self.assertEqual(restart.call_count, 1 if busy is False else 0)
            if busy is not False:
                self.assertTrue(result["deferred"])
        with (mock.patch.object(self.routes, "_llamacpp_generation_status", return_value={"server_process": {"managed": False}}),
              mock.patch.object(self.routes, "_restart_llamacpp_server") as restart):
            result, _ = await self.restart()
        self.assertTrue(result["skipped"])
        restart.assert_not_called()

    async def test_restart_waits_for_video_work_and_holds_exclusive_capacity(self):
        self.routes.shared_llm_configure_capacity(self.settings, 2)
        started, finish = threading.Event(), threading.Event()
        restarting, release = threading.Event(), threading.Event()
        next_started = threading.Event()
        def video(_):
            started.set()
            if not finish.wait(5): raise RuntimeError("Video test timed out")
        def restart(_):
            restarting.set()
            if not release.wait(5): raise RuntimeError("Restart test timed out")
            return {"model": "new.gguf"}
        with (mock.patch.object(self.routes, "_llamacpp_generation_status", return_value={
                "reachable": True, "busy": False, "server_process": self.process}),
              mock.patch.object(self.routes, "_restart_llamacpp_server", side_effect=restart)):
            video_task = asyncio.create_task(self.routes._run_llm_request(self.settings, 0, video, prepare_for_llm=False))
            self.assertTrue(await asyncio.to_thread(started.wait, 2))
            switch = asyncio.create_task(self.restart())
            await asyncio.sleep(0.05)
            self.assertFalse(restarting.is_set())
            finish.set()
            self.assertTrue(await asyncio.to_thread(restarting.wait, 2))
            next_task = asyncio.create_task(self.routes._run_llm_request(self.settings, 0, lambda _: next_started.set(), prepare_for_llm=False))
            await asyncio.sleep(0.05)
            self.assertFalse(next_started.is_set())
            release.set()
            await asyncio.gather(video_task, switch, next_task)
            self.assertTrue(next_started.is_set())
