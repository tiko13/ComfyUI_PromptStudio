import asyncio
import io
import socket
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest import mock

import provider_transport as transport
from llm_coordinator import CancellationToken, LlmCoordinator, LlmOverloadedError
from test_regressions import load_modules


class ProviderTransportTests(unittest.TestCase):
    def test_response_and_unterminated_sse_line_have_hard_byte_bounds(self):
        with transport.BoundedResponse(io.BytesIO(b"x" * 33), time.monotonic() + 1, max_bytes=32) as response:
            with self.assertRaises(transport.ProviderLimitError):
                response.read()
        with mock.patch.object(transport, "MAX_LINE_BYTES", 16):
            with transport.BoundedResponse(io.BytesIO(b"x" * 17), time.monotonic() + 1) as response:
                with self.assertRaises(transport.ProviderLimitError):
                    list(response)

    def test_slow_trickle_obeys_total_deadline(self):
        class Trickle(io.BytesIO):
            def read1(self, size):
                time.sleep(.02)
                return b"x"
        started = time.monotonic()
        with transport.BoundedResponse(Trickle(), started + .08) as response:
            with self.assertRaises(transport.ProviderDeadlineError):
                response.read()
        self.assertLess(time.monotonic() - started, .4)

    def test_blocked_socket_is_interrupted_by_deadline_and_cancellation(self):
        # Socket pairs are local synthetic streams, with no provider/server.
        for cancelled in (False, True):
            reader, writer = socket.socketpair()
            stream = reader.makefile("rb")
            response = type("Response", (), {"fp": stream, "read1": stream.read1,
                                              "read": stream.read, "close": stream.close})()
            event = threading.Event()
            bounded = transport.BoundedResponse(response, time.monotonic() + (.08 if not cancelled else 2), event.is_set)
            timer = threading.Timer(.05, event.set) if cancelled else None
            if timer:
                timer.start()
            started = time.monotonic()
            try:
                with self.assertRaisesRegex(RuntimeError, "cancelled|deadline"):
                    bounded.read()
                self.assertLess(time.monotonic() - started, .5)
            finally:
                bounded.close()
                writer.close()
                reader.close()
                if timer:
                    timer.join()

    def test_redirect_revalidates_allowlist_strips_credentials_and_blocks_downgrade(self):
        def validate(url):
            if urllib.parse.urlsplit(url).hostname not in {"allowed.test", "other.test"}:
                raise ValueError("host denied")
        handler = transport.ValidatedRedirectHandler(validate)
        request = urllib.request.Request("https://allowed.test/start", headers={"Authorization": "secret", "Cookie": "session", "X-Api-Key": "key"})
        with self.assertRaisesRegex(ValueError, "host denied"):
            handler.redirect_request(request, None, 302, "", {}, "https://forbidden.test/")
        with self.assertRaisesRegex(ValueError, "downgrade"):
            handler.redirect_request(request, None, 302, "", {}, "http://allowed.test/")
        redirected = handler.redirect_request(request, None, 302, "", {}, "https://other.test/")
        self.assertEqual(redirected.headers, {})
        same = handler.redirect_request(request, None, 302, "", {}, "/next")
        self.assertEqual(same.get_header("Authorization"), "secret")

    def test_error_body_is_bounded_and_closed(self):
        stream = io.BytesIO(b"x" * (17 * 1024))
        error = urllib.error.HTTPError("http://localhost/", 500, "error", {}, stream)
        with mock.patch.object(transport, "_open", side_effect=error):
            with self.assertRaises(transport.ProviderLimitError):
                transport.open_response(urllib.request.Request("http://localhost/"), 1, lambda _url: None)
        self.assertTrue(stream.closed)

    def test_real_http_parser_and_headers_use_bounded_socket_reads(self):
        for trickle in (False, True):
            # HTTPConnection sets TCP_NODELAY. socketpair() uses AF_UNIX on
            # Linux, so it cannot stand in for the transport's TCP connection.
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
                listener.bind(("127.0.0.1", 0))
                listener.listen(1)
                listener.settimeout(1)
                reader = socket.create_connection(listener.getsockname(), timeout=1)
                self.addCleanup(reader.close)
                writer, _ = listener.accept()
            writer.settimeout(1)
            def serve():
                try:
                    writer.recv(4096)
                    payload = b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}'
                    if trickle:
                        for byte in payload:
                            time.sleep(.02)
                            writer.send(bytes([byte]))
                    else:
                        writer.sendall(payload)
                except OSError:
                    pass
                finally:
                    writer.close()
            peer = threading.Thread(target=serve, daemon=True)
            peer.start()
            try:
                with mock.patch.object(transport, "_create_connection", return_value=reader):
                    if trickle:
                        with self.assertRaises(transport.ProviderDeadlineError):
                            transport.open_response(urllib.request.Request("http://localhost/test"), .08, lambda _: None)
                    else:
                        with transport.open_response(urllib.request.Request("http://localhost/test"), 1, lambda _: None) as response:
                            self.assertEqual(response.read(), b"{}")
            finally:
                reader.close()
                writer.close()
                peer.join(1)
            self.assertFalse(peer.is_alive())

    def test_slow_dns_is_bounded_and_resolver_capacity_is_retained(self):
        release = threading.Event()
        slots = threading.BoundedSemaphore(1)
        def slow(*_args):
            release.wait(1)
            return []
        try:
            with mock.patch.object(transport, "_dns_slots", slots), mock.patch.object(transport.socket, "getaddrinfo", side_effect=slow):
                with self.assertRaises(transport.ProviderDeadlineError):
                    transport._create_connection(("example.test", 80), .05, None, time.monotonic() + 1, None)
                with self.assertRaises(transport.ProviderBusyError):
                    transport._create_connection(("example.test", 80), .05, None, time.monotonic() + 1, None)
                release.set()
                self.assertTrue(slots.acquire(timeout=1))
        finally:
            release.set()

    def test_provider_json_schemas_invalid_json_and_network_drop(self):
        with tempfile.TemporaryDirectory() as directory:
            nodes, _routes = load_modules(directory)
            for provider, payload in (("KoboldCpp", {"results": [{"text": "answer"}]}),
                                      ("Ollama", {"response": "answer", "thinking": "thought", "done": True})):
                raw = __import__("json").dumps(payload).encode()
                with mock.patch.object(nodes._provider_transport, "_open", return_value=io.BytesIO(raw)):
                    self.assertEqual(nodes._post_json("http://localhost/test", {}, 1, provider), payload)
            with mock.patch.object(nodes._provider_transport, "_open", return_value=io.BytesIO(b"invalid")):
                with self.assertRaisesRegex(RuntimeError, "invalid JSON"):
                    nodes._post_json("http://localhost/test", {}, 1)
            with mock.patch.object(nodes._provider_transport, "_open", side_effect=urllib.error.URLError("connection dropped")):
                with self.assertRaisesRegex(RuntimeError, "connection dropped"):
                    nodes._post_json("http://localhost/test", {}, 1)

    def test_operation_deadline_and_cancellation_prevent_a_second_stage(self):
        coordinator = LlmCoordinator()
        token = CancellationToken()
        token.deadline = time.monotonic() - 1
        operation = mock.Mock()
        with self.assertRaisesRegex(RuntimeError, "deadline"):
            coordinator.run({"endpoint"}, operation, token=token)
        operation.assert_not_called()
        token = CancellationToken()
        def stages():
            token.signal()
            return coordinator.run({"endpoint"}, operation)
        with self.assertRaises(asyncio.CancelledError):
            coordinator.run({"endpoint"}, stages, token=token)
        operation.assert_not_called()

    def test_coordinator_rejects_saturation_without_pending_growth(self):
        coordinator = LlmCoordinator()
        coordinator._active["endpoint"] = 128
        with self.assertRaises(LlmOverloadedError):
            coordinator.run({"endpoint"}, lambda: None)
        self.assertEqual(coordinator._pending, [])


class ImageAdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.nodes, self.routes = load_modules(self.temp.name)

    async def asyncTearDown(self):
        await self.routes.shared_llm_shutdown()
        self.temp.cleanup()

    async def test_active_job_registries_are_hard_bounded(self):
        routes = self.routes
        for i in range(routes.MAX_CONSULT_JOBS):
            routes.CONSULT_JOBS[str(i)] = {"status": "running", "created_at": 1}
        for i in range(routes.MAX_PROMPT_AGENT_REQUESTS):
            routes.PROMPT_AGENT_REQUESTS[str(i)] = {"status": "running", "created_at": 1}
        for operation in (lambda: routes._start_consult_job({}),
                          lambda: routes._start_prompt_agent_job("extra", {}),
                          lambda: routes._cancel_prompt_agent_request_id("extra")):
            with self.assertRaises(routes.LlmOverloadedError) as raised:
                operation()
            body, status = routes._llm_error_response(raised.exception)
            self.assertEqual(status, 503)
            self.assertTrue(body["retryable"])
        self.assertEqual(len(routes.CONSULT_JOBS), routes.MAX_CONSULT_JOBS)
        self.assertEqual(len(routes.PROMPT_AGENT_REQUESTS), routes.MAX_PROMPT_AGENT_REQUESTS)

    async def test_global_queue_rejects_saturation_before_creating_worker(self):
        routes = self.routes
        routes._LLM_OPERATION_TOKENS.update(routes.CancellationToken() for _ in range(routes.MAX_LLM_OPERATIONS))
        with self.assertRaises(routes.LlmOverloadedError):
            await routes.shared_llm_run({}, lambda _: None)
        self.assertFalse(routes._LLM_QUEUES)
        routes._LLM_OPERATION_TOKENS.clear()

    async def test_native_node_holds_shared_lane_across_retry_against_async_route(self):
        nodes, routes = self.nodes, self.routes
        started, release = threading.Event(), threading.Event()
        order = []
        def generate(*_args, **_kwargs):
            order.append("native stage")
            if len(order) == 1:
                started.set()
                if not release.wait(2):
                    raise TimeoutError("Test did not release native stage")
            return "A richly detailed answer with clear visual content."
        settings = dict(text="source", additional_instructions="", model_profile="Default",
                        style_preset="None", style_modifier="", framing_preset="None", framing_modifier="",
                        thinking_mode="Disabled", embellishment_level="Clean", kobold_url="http://localhost:5001",
                        max_response_tokens=100, temperature=.5, top_p=.9, top_k=40, min_p=.1,
                        rep_pen=1, rep_pen_range=100, sampler_seed=1)
        routes._LLM_COORDINATOR.native_prepare = mock.Mock()
        try:
            with mock.patch.object(nodes, "_generate_kcpp", side_effect=generate), \
                 mock.patch.object(nodes, "_needs_expansion_retry", return_value=True), \
                 mock.patch.object(nodes, "_get_profile", return_value=nodes.DEFAULT_PROFILE), \
                 mock.patch.object(nodes, "_get_style_template", return_value={}), \
                 mock.patch.object(nodes, "_get_framing_template", return_value={}), \
                 mock.patch.object(routes, "_prepare_shared_gpu_for_llm"):
                native = asyncio.create_task(asyncio.to_thread(nodes.KCPP_PromptAmplify().amplify, **settings))
                self.assertTrue(await asyncio.to_thread(started.wait, 1))
                route = asyncio.create_task(routes.shared_llm_run(
                    {"llm_provider": "koboldcpp", "kobold_url": "http://127.0.0.1:5001"},
                    lambda _: order.append("route"),
                ))
                await asyncio.sleep(.05)
                self.assertEqual(order, ["native stage"])
                release.set()
                await asyncio.gather(native, route)
            self.assertEqual(order, ["native stage", "native stage", "route"])
            routes._LLM_COORDINATOR.native_prepare.assert_called_once()
        finally:
            release.set()

    async def test_shutdown_cancels_owned_blocking_transport_then_settles_lane(self):
        routes = self.routes
        reader, writer = socket.socketpair()
        stream = reader.makefile("rb")
        raw = type("Response", (), {"fp": stream, "read1": stream.read1,
                                     "read": stream.read, "close": stream.close})()
        entered = threading.Event()
        def operation(_data):
            token = routes._LLM_COORDINATOR.current_token()
            with self.nodes._provider_transport.BoundedResponse(raw, time.monotonic() + 30, token.cancelled) as response:
                token.response_hook(response)
                entered.set()
                response.read()
        try:
            with mock.patch.object(routes, "_prepare_shared_gpu_for_llm"):
                task = asyncio.create_task(routes.shared_llm_run({}, operation))
                self.assertTrue(await asyncio.to_thread(entered.wait, 1))
                await asyncio.wait_for(routes.shared_llm_shutdown(), 1)
                with self.assertRaises(asyncio.CancelledError):
                    await task
            self.assertFalse(any(routes._LLM_COORDINATOR._active.values()))
            self.assertFalse(routes._LLM_QUEUES)
        finally:
            writer.close()
            reader.close()


if __name__ == "__main__":
    unittest.main()
