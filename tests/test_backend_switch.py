import asyncio
import tempfile
import threading
import unittest
from unittest import mock

from test_regressions import load_modules


class BackendSwitchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        _, self.routes = load_modules(self.temp.name)
        self.llama = {"llm_provider": "llamacpp", "llamacpp_url": "http://localhost:8080"}
        self.ollama = {"llm_provider": "ollama", "ollama_url": "http://localhost:11434", "ollama_model": "test"}

    async def asyncTearDown(self):
        await self.routes._shutdown_llm_queues(None)
        self.temp.cleanup()

    async def switch(self, previous, provider="ollama", **overrides):
        request = mock.Mock(remote="127.0.0.1", content_length=100, **overrides)
        request.json = mock.AsyncMock(return_value={"previous": previous, "llm_provider": provider})
        return await self.routes.prompt_studio_llm_switch(request)

    async def test_managed_llama_stops_and_clears_shared_owner_even_when_kept_loaded(self):
        self.routes._ACTIVE_SHARED_LLM = self.llama
        self.routes._SHARED_GPU_OWNER = "llm"
        with (mock.patch.object(self.routes, "_llamacpp_managed_process_status", return_value={
                "managed": True, "running": True, "url": "http://127.0.0.1:8080/"}),
              mock.patch.object(self.routes, "_stop_llamacpp_server", return_value={"stopped": True}) as stop,
              mock.patch.object(self.routes, "_prepare_shared_gpu_for_llm") as prepare):
            result, status = await self.switch({**self.llama, "keep_models_loaded": True})
        self.assertEqual(status, 200)
        self.assertTrue(result["stopped"])
        stop.assert_called_once()
        prepare.assert_not_called()
        self.assertIsNone(self.routes._ACTIVE_SHARED_LLM)
        self.assertIsNone(self.routes._SHARED_GPU_OWNER)

    async def test_external_or_other_endpoint_llama_is_not_stopped(self):
        for managed, url in [(False, "http://localhost:8080"), (True, "http://localhost:8081")]:
            with (mock.patch.object(self.routes, "_llamacpp_managed_process_status", return_value={
                    "managed": managed, "running": True, "url": url}),
                  mock.patch.object(self.routes, "_stop_llamacpp_server") as stop):
                result, status = await self.switch(self.llama, "koboldcpp")
            self.assertEqual(status, 200)
            self.assertFalse(result["stopped"])
            stop.assert_not_called()

    async def test_ollama_unloads_selected_and_studio_models_but_never_stops_server(self):
        with mock.patch.object(self.routes, "_raw_generate_ollama", return_value="done"):
            self.routes._generate_ollama("", "http://127.0.0.1:11434", "earlier")
            self.routes._generate_ollama("", "http://localhost:11435", "other-endpoint")
        with (mock.patch.object(self.routes, "_unload_ollama_model") as unload,
              mock.patch.object(self.routes, "_stop_llamacpp_server") as stop):
            result, status = await self.switch({**self.ollama, "keep_models_loaded": True}, "llamacpp")
        self.assertEqual(status, 200)
        self.assertTrue(result["unloaded"])
        self.assertFalse(result["stopped"])
        self.assertEqual(unload.call_args_list, [
            mock.call("http://127.0.0.1:11434", "earlier"), mock.call("http://localhost:11434", "test")])
        stop.assert_not_called()
        self.assertEqual(len(self.routes._STUDIO_OLLAMA_MODELS), 1)

    async def test_same_provider_does_not_release_anything(self):
        with mock.patch.object(self.routes, "_release_previous_llm_backend") as release:
            _, status = await self.switch(self.ollama)
        self.assertEqual(status, 200)
        release.assert_not_called()

    async def test_cleanup_failure_is_reported_and_retains_owner_for_retry(self):
        self.routes._ACTIVE_SHARED_LLM = self.ollama
        with mock.patch.object(self.routes, "_unload_ollama_model", side_effect=RuntimeError("Unload failed")):
            result, status = await self.switch(self.ollama, "llamacpp")
        self.assertGreaterEqual(status, 400)
        self.assertIn("Unload failed", result["error"])
        self.assertEqual(self.routes._ACTIVE_SHARED_LLM, self.ollama)

    async def test_remote_process_control_is_rejected(self):
        request = mock.Mock(remote="192.0.2.1", content_length=100)
        _, status = await self.routes.prompt_studio_llm_switch(request)
        self.assertEqual(status, 403)

    async def test_invalid_switch_cannot_release_backend(self):
        for payload in [{}, {"previous": self.llama},
                        {"previous": self.llama, "llm_provider": "unknown"}]:
            request = mock.Mock(remote="127.0.0.1", content_length=100)
            request.json = mock.AsyncMock(return_value=payload)
            with mock.patch.object(self.routes, "_release_previous_llm_backend") as release:
                _, status = await self.routes.prompt_studio_llm_switch(request)
            self.assertEqual(status, 400)
            release.assert_not_called()

    async def test_ollama_without_selected_or_used_models_is_noop(self):
        with mock.patch.object(self.routes, "_unload_ollama_model") as unload:
            result, status = await self.switch({**self.ollama, "ollama_model": ""}, "llamacpp")
        self.assertEqual(status, 200)
        self.assertFalse(result["unloaded"])
        unload.assert_not_called()

    async def test_switch_waits_for_video_and_excludes_new_work_at_capacity_two(self):
        settings = {**self.ollama, "keep_models_loaded": True}
        self.routes.shared_llm_configure_capacity(settings, 2)
        video_started, finish_video = threading.Event(), threading.Event()
        cleanup_started, finish_cleanup = threading.Event(), threading.Event()
        next_started = threading.Event()
        def video(_):
            video_started.set()
            if not finish_video.wait(5):
                raise TimeoutError("video not released")
        def cleanup(_):
            cleanup_started.set()
            if not finish_cleanup.wait(5):
                raise TimeoutError("cleanup not released")
            return {"unloaded": True}
        async def wait_for(event):
            async def poll():
                while not event.is_set():
                    await asyncio.sleep(0.001)
            await asyncio.wait_for(poll(), 3)
        with (mock.patch.object(self.routes, "_prepare_shared_gpu_for_llm"),
              mock.patch.object(self.routes, "_release_previous_llm_backend", side_effect=cleanup)):
            try:
                active = asyncio.create_task(self.routes.shared_llm_run(settings, video))
                await wait_for(video_started)
                switch = asyncio.create_task(self.switch(settings, "llamacpp"))
                await asyncio.sleep(0.03)
                self.assertFalse(cleanup_started.is_set())
                finish_video.set()
                await wait_for(cleanup_started)
                later = asyncio.create_task(self.routes.shared_llm_run(settings, lambda _: next_started.set()))
                await asyncio.sleep(0.03)
                self.assertFalse(next_started.is_set())
                finish_cleanup.set()
                await asyncio.gather(active, switch, later)
                self.assertTrue(next_started.is_set())
            finally:
                finish_video.set()
                finish_cleanup.set()


if __name__ == "__main__":
    unittest.main()
