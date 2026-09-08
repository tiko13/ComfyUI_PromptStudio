import asyncio
import tempfile
import threading
import unittest
from unittest import mock

from llm_coordinator import endpoint_identity
from test_regressions import load_modules


class SharedLlmSchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        _, self.routes = load_modules(self.temp.name)
        self.prepare_patch = mock.patch.object(self.routes, "_prepare_shared_gpu_for_llm")
        self.prepare = self.prepare_patch.start()
        self.release = threading.Event()
        self.settings = {"llm_provider": "koboldcpp", "kobold_url": "http://localhost:5001"}
        self.messages = [{"role": "user", "content": "test"}]

    async def asyncTearDown(self):
        self.release.set()
        await self.routes._shutdown_llm_queues(None)
        self.prepare_patch.stop()
        self.temp.cleanup()

    async def wait_until(self, predicate):
        async def poll():
            while not predicate():
                await asyncio.sleep(0.001)
        await asyncio.wait_for(poll(), 3)

    def blocked(self, event, result="done"):
        def operation(_data):
            event.set()
            if not self.release.wait(5):
                raise TimeoutError("Test did not release its operation")
            return result
        return operation

    def test_endpoint_aliases_paths_and_model_names_share_one_server(self):
        values = ["http://localhost:5001/", "http://127.0.0.1:5001/v1/",
                  "http://[::1]:5001/proxy/", "http://127.9.8.7:5001/api"]
        keys = [endpoint_identity({**self.settings, "kobold_url": value}) for value in values]
        self.assertTrue(all(key == keys[0] for key in keys))
        self.assertEqual(endpoint_identity({"llm_provider": "ollama", "ollama_url": values[0], "ollama_model": "a"}),
                         endpoint_identity({"llm_provider": "llamacpp", "llamacpp_url": values[1], "llamacpp_model": "b"}))

    async def test_image_and_video_share_gpu_even_on_distinct_endpoints(self):
        image_started = threading.Event()
        video_started = threading.Event()
        image = asyncio.create_task(self.routes._run_llm_request(
            self.settings, 0, self.blocked(image_started)))
        await self.wait_until(image_started.is_set)
        video = asyncio.create_task(self.routes.shared_llm_run(
            {"llm_provider": "ollama", "ollama_url": "http://localhost:11434"},
            self.blocked(video_started)))
        await asyncio.sleep(0.02)
        self.assertFalse(video_started.is_set())
        self.release.set()
        self.assertEqual(await asyncio.gather(image, video), ["done", "done"])

    async def test_direct_shared_generation_and_image_use_the_same_resource(self):
        started = threading.Event()
        image = asyncio.create_task(self.routes._run_llm_request(
            self.settings, 0, self.blocked(started)))
        await self.wait_until(started.is_set)
        with mock.patch.object(self.routes, "_generate_provider_messages", return_value="video") as provider:
            direct = asyncio.create_task(asyncio.to_thread(
                self.routes.shared_llm_generate,
                {**self.settings, "kobold_url": "http://127.0.0.1:5001/v1/", "keep_models_loaded": True},
                self.messages))
            await asyncio.sleep(0.02)
            provider.assert_not_called()
            self.release.set()
            self.assertEqual(await direct, "video")
        await image

    async def test_whole_operation_reuses_lane_and_prepares_gpu_once(self):
        def director(data):
            return [self.routes.shared_llm_generate(data, self.messages) for _ in range(3)]
        with mock.patch.object(self.routes, "_generate_provider_messages", return_value="stage") as provider:
            result = await asyncio.wait_for(self.routes.shared_llm_run(self.settings, director), 3)
        self.assertEqual(result, ["stage"] * 3)
        self.assertEqual(provider.call_count, 3)
        self.prepare.assert_called_once_with(self.settings)

    async def test_priority_applies_to_queued_operations(self):
        started = threading.Event()
        first = asyncio.create_task(self.routes.shared_llm_run(self.settings, self.blocked(started)))
        await self.wait_until(started.is_set)
        order = []
        low = asyncio.create_task(self.routes.shared_llm_run(self.settings, lambda _: order.append("low"), priority=10))
        high = asyncio.create_task(self.routes.shared_llm_run(self.settings, lambda _: order.append("high"), priority=0))
        await asyncio.sleep(0)
        self.release.set()
        await asyncio.gather(first, low, high)
        self.assertEqual(order, ["high", "low"])

    async def test_distinct_dedicated_endpoints_can_run_concurrently(self):
        first_started, second_started = threading.Event(), threading.Event()
        first = asyncio.create_task(self.routes.shared_llm_run(
            {**self.settings, "keep_models_loaded": True}, self.blocked(first_started)))
        second = asyncio.create_task(self.routes.shared_llm_run(
            {**self.settings, "keep_models_loaded": True, "kobold_url": "http://localhost:5002"},
            self.blocked(second_started)))
        await self.wait_until(lambda: first_started.is_set() and second_started.is_set())
        self.release.set()
        await asyncio.gather(first, second)

    async def test_model_switching_and_aliases_do_not_create_capacity(self):
        settings = {"llm_provider": "ollama", "ollama_url": "http://localhost:11434", "keep_models_loaded": True}
        first_started, second_started = threading.Event(), threading.Event()
        first = asyncio.create_task(self.routes.shared_llm_run(
            {**settings, "ollama_model": "a"}, self.blocked(first_started)))
        await self.wait_until(first_started.is_set)
        second = asyncio.create_task(self.routes.shared_llm_run(
            {**settings, "ollama_model": "b", "ollama_url": "http://127.0.0.1:11434/"}, self.blocked(second_started)))
        await asyncio.sleep(0.02)
        self.assertFalse(second_started.is_set())
        self.release.set()
        await asyncio.gather(first, second)

    async def test_explicit_server_capacity_allows_two_requests(self):
        settings = {**self.settings, "keep_models_loaded": True}
        self.routes.shared_llm_configure_capacity(settings, 2)
        first_started, second_started = threading.Event(), threading.Event()
        first = asyncio.create_task(self.routes.shared_llm_run(settings, self.blocked(first_started)))
        second = asyncio.create_task(self.routes.shared_llm_run(settings, self.blocked(second_started)))
        await self.wait_until(lambda: first_started.is_set() and second_started.is_set())
        with self.assertRaisesRegex(RuntimeError, "idle"):
            self.routes.shared_llm_configure_capacity(settings, 3)
        self.release.set()
        await asyncio.gather(first, second)

    async def test_cancellation_closes_own_transport_and_prevents_all_later_stages(self):
        started = threading.Event()
        response = mock.Mock()
        response.close.side_effect = self.release.set

        def provider(*_args, **kwargs):
            kwargs["response_hook"](response)
            started.set()
            if not self.release.wait(5):
                raise TimeoutError("Test transport was not closed")
            raise OSError("transport closed by cancellation")

        stages = []
        def director(data):
            for stage in ("router", "vision", "generation", "grounding", "correction"):
                stages.append(stage)
                self.routes.shared_llm_generate(data, self.messages)

        with mock.patch.object(self.routes, "_raw_generate_kcpp", side_effect=provider) as generate:
            operation = asyncio.create_task(self.routes.shared_llm_run(self.settings, director))
            await self.wait_until(started.is_set)
            operation.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await operation
            self.assertEqual(await self.routes.shared_llm_run(self.settings, lambda _: "next"), "next")
        self.assertEqual(stages, ["router"])
        self.assertEqual(generate.call_count, 1)
        response.close.assert_called_once_with()

    async def test_handoff_operation_does_not_prepare_or_lose_its_token(self):
        result = await self.routes._run_llm_request(
            self.settings, 0, lambda _: {"handoff_token": "ack-required"}, prepare_for_llm=False)
        self.assertEqual(result, {"handoff_token": "ack-required"})
        self.prepare.assert_not_called()

    async def test_shutdown_closes_and_waits_for_direct_synchronous_caller(self):
        started = threading.Event()
        response = mock.Mock()
        response.close.side_effect = self.release.set

        def provider(*_args, **kwargs):
            kwargs["response_hook"](response)
            started.set()
            if not self.release.wait(5):
                raise TimeoutError("Shutdown did not close the test transport")
            return "cancelled result"

        with mock.patch.object(self.routes, "_raw_generate_kcpp", side_effect=provider):
            direct = asyncio.create_task(asyncio.to_thread(
                self.routes.shared_llm_generate, self.settings, self.messages))
            await self.wait_until(started.is_set)
            await asyncio.wait_for(self.routes._shutdown_llm_queues(None), 3)
            with self.assertRaises(asyncio.CancelledError):
                await direct
        response.close.assert_called_once_with()
        self.assertFalse(self.routes._LLM_OPERATION_TOKENS)

    async def test_server_capacity_never_expands_shared_gpu_ownership(self):
        self.routes.shared_llm_configure_capacity(self.settings, 2)
        first_started, second_started = threading.Event(), threading.Event()
        first = asyncio.create_task(self.routes.shared_llm_run(self.settings, self.blocked(first_started)))
        await self.wait_until(first_started.is_set)
        second = asyncio.create_task(self.routes.shared_llm_run(self.settings, self.blocked(second_started)))
        await asyncio.sleep(0.02)
        self.assertFalse(second_started.is_set())
        self.release.set()
        await asyncio.gather(first, second)

    def test_invalid_settings_do_not_prepare_gpu(self):
        with self.assertRaisesRegex(ValueError, "settings must be an object"):
            self.routes.shared_llm_generate([], self.messages)
        self.prepare.assert_not_called()


if __name__ == "__main__":
    unittest.main()
