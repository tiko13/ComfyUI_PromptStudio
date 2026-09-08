"""Exercise the real queue functions without importing ComfyUI's runtime."""

import ast
import asyncio
import itertools
from pathlib import Path
import threading
import unittest
from unittest import mock
from job_observability import JobLedger
from llm_coordinator import CancellationToken, LlmCoordinator, LlmOverloadedError, MAX_LLM_OPERATIONS


def load_queue_functions():
    source = Path(__file__).resolve().parents[1] / "routes.py"
    names = {
        "_cancel_pending_llm_requests", "_llm_queue_worker", "_run_llm_request",
        "_shutdown_llm_queues", "_cancel_consult_job", "shared_llm_check_admission",
    }
    tree = ast.parse(source.read_text(encoding="utf-8"))
    tree.body = [node for node in tree.body if isinstance(
        node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
    namespace = {
        "asyncio": asyncio,
        "uuid": __import__("uuid"),
        "shared_job_ledger": lambda ledger=JobLedger(":memory:"): ledger,
        "time": __import__("time"),
        "_LLM_QUEUE_SEQUENCE": itertools.count(),
        "_LLM_QUEUES": {},
        "_LLM_QUEUE_WORKERS": {},
        "_LLM_QUEUE_EXTRA_WORKERS": {},
        "_LLM_SHUTTING_DOWN": False,
        "_LLM_COORDINATOR": LlmCoordinator(),
        "_LLM_OPERATION_TOKENS": set(),
        "_LLM_OPERATION_TOKENS_LOCK": threading.Lock(),
        "CancellationToken": CancellationToken,
        "LlmOverloadedError": LlmOverloadedError,
        "MAX_LLM_OPERATIONS": MAX_LLM_OPERATIONS,
        "_llm_resources": lambda data: [("test-endpoint",)],
        "_llm_queue_key": lambda data: ("test-endpoint",),
        "_prepare_shared_gpu_for_llm": mock.Mock(),
        "PROMPT_AGENT_REQUESTS_LOCK": threading.Lock(),
        "PROMPT_AGENT_REQUESTS": {},
        "CONSULT_JOBS": {},
        "PROMPT_AGENT_TASKS": set(),
        "CONSULT_TASKS": set(),
    }
    exec(compile(tree, str(source), "exec"), namespace)
    return namespace


class QueueCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.ns = load_queue_functions()
        self.release = threading.Event()
        self.started = threading.Event()

    async def asyncTearDown(self):
        self.release.set()
        await self.ns["_shutdown_llm_queues"](None)

    async def wait_until(self, predicate):
        async def poll():
            while not predicate():
                await asyncio.sleep(0.001)
        await asyncio.wait_for(poll(), 2)

    def submit(self, operation):
        return asyncio.create_task(self.ns["_run_llm_request"]({}, 0, operation))

    def blocking(self, _data):
        self.started.set()
        if not self.release.wait(5):
            raise TimeoutError("Test did not release its blocking operation")
        return "first"

    async def test_operation_cancellation_does_not_strand_next_request(self):
        def cancelled(_data):
            raise asyncio.CancelledError()

        first = self.submit(cancelled)
        second = self.submit(lambda _data: "second")
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(first, 2)
        self.assertEqual(await asyncio.wait_for(second, 2), "second")
        worker = next(iter(self.ns["_LLM_QUEUE_WORKERS"].values()))
        self.assertFalse(worker.done())

    async def test_provider_failure_settles_future_and_continues(self):
        def failed(_data):
            raise ValueError("provider failed")

        first = self.submit(failed)
        second = self.submit(lambda _data: "second")
        with self.assertRaisesRegex(ValueError, "provider failed"):
            await first
        self.assertEqual(await asyncio.wait_for(second, 2), "second")

    async def test_queued_cancellation_never_calls_provider(self):
        first = self.submit(self.blocking)
        await self.wait_until(self.started.is_set)
        operation = mock.Mock()
        cancelled = self.submit(operation)
        await asyncio.sleep(0)
        cancelled.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await cancelled
        second = self.submit(lambda _data: "second")
        self.release.set()
        await first
        self.assertEqual(await asyncio.wait_for(second, 2), "second")
        operation.assert_not_called()

    async def test_running_cancellation_retains_endpoint_until_thread_exits(self):
        first = self.submit(self.blocking)
        await self.wait_until(self.started.is_set)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        operation = mock.Mock(return_value="second")
        second = self.submit(operation)
        await asyncio.sleep(0.02)
        operation.assert_not_called()
        self.release.set()
        self.assertEqual(await asyncio.wait_for(second, 2), "second")

    async def test_deadline_settles_caller_without_releasing_running_thread(self):
        first = self.submit(self.blocking)
        await self.wait_until(self.started.is_set)
        with self.assertRaises(asyncio.TimeoutError):
            await asyncio.wait_for(first, 0.01)
        operation = mock.Mock(return_value="second")
        second = self.submit(operation)
        await asyncio.sleep(0.02)
        operation.assert_not_called()
        self.release.set()
        self.assertEqual(await asyncio.wait_for(second, 2), "second")

    async def test_worker_shutdown_settles_active_and_queued_and_waits_for_thread(self):
        first = self.submit(self.blocking)
        await self.wait_until(self.started.is_set)
        operation = mock.Mock()
        second = self.submit(operation)
        await asyncio.sleep(0)
        worker = next(iter(self.ns["_LLM_QUEUE_WORKERS"].values()))
        queue = next(iter(self.ns["_LLM_QUEUES"].values()))
        worker.cancel()
        await self.wait_until(lambda: first.done() and second.done())
        self.assertTrue(first.cancelled())
        self.assertTrue(second.cancelled())
        self.assertFalse(worker.done())
        worker.cancel()  # Repeated shutdown cancellation must not orphan the thread.
        await asyncio.sleep(0)
        self.assertFalse(worker.done())
        self.release.set()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(worker, 2)
        await asyncio.wait_for(queue.join(), 2)
        operation.assert_not_called()

    async def test_application_shutdown_rejects_new_requests_and_drains_queue(self):
        first = self.submit(self.blocking)
        await self.wait_until(self.started.is_set)
        second = self.submit(mock.Mock())
        shutdown = asyncio.create_task(self.ns["_shutdown_llm_queues"](None))
        await self.wait_until(lambda: first.done() and second.done())
        with self.assertRaises(asyncio.CancelledError):
            await self.ns["_run_llm_request"]({}, 0, mock.Mock())
        self.release.set()
        await asyncio.wait_for(shutdown, 2)
        self.assertEqual(self.ns["_LLM_QUEUES"], {})
        self.assertEqual(self.ns["_LLM_QUEUE_WORKERS"], {})

    async def test_running_consult_cancel_is_logical_without_endpoint_abort(self):
        task = self.submit(self.blocking)
        await self.wait_until(self.started.is_set)
        self.ns["CONSULT_JOBS"]["job"] = {"status": "running", "task": task}
        self.ns["_abort_llm_generation"] = mock.Mock()
        result = await self.ns["_cancel_consult_job"]("job")
        self.assertEqual(result["status"], "cancelled")
        self.assertFalse(result["provider_aborted"])
        self.ns["_abort_llm_generation"].assert_not_called()
        with self.assertRaises(asyncio.CancelledError):
            await task


if __name__ == "__main__":
    unittest.main()
