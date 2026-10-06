import io
import json
import socket
import tempfile
import threading
import time
import unittest
import urllib.request
from unittest import mock

import provider_transport as transport
from llm_coordinator import CancellationToken, LlmCoordinator
from test_regressions import load_modules


class InferenceTimeoutTests(unittest.TestCase):
    def test_silent_processing_survives_headers_but_idle_and_cancelled_do_not(self):
        for mode in ("busy", "idle", "unknown", "cancelled"):
            with self.subTest(mode=mode):
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
                    listener.bind(("127.0.0.1", 0))
                    listener.listen(1)
                    reader = socket.create_connection(listener.getsockname(), timeout=1)
                    writer, _ = listener.accept()
                cancelled = threading.Event()
                def serve():
                    try:
                        writer.recv(4096)
                        time.sleep(.5)
                        writer.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}')
                    except OSError:
                        pass
                    finally:
                        writer.close()
                peer = threading.Thread(target=serve, daemon=True)
                peer.start()
                timer = threading.Timer(.1, cancelled.set)
                if mode == "cancelled":
                    timer.start()
                activity = mock.Mock(return_value=True if mode in {"busy", "cancelled"} else None if mode == "unknown" else False)
                try:
                    with mock.patch.object(transport, "_create_connection", return_value=reader), \
                         transport.operation_scope(time.monotonic() + 3, cancelled.is_set):
                        def request():
                            with transport.open_response(urllib.request.Request("http://localhost/test"), .2,
                                    lambda _: None, inference=True, activity_check=activity) as response:
                                return response.read()
                        if mode == "busy":
                            self.assertEqual(request(), b"{}")
                        else:
                            with self.assertRaisesRegex(RuntimeError, "cancelled|deadline"):
                                request()
                    self.assertGreater(activity.call_count, 0)
                    calls = activity.call_count
                    time.sleep(.1)
                    self.assertEqual(activity.call_count, calls, "activity monitor must stop with the request")
                finally:
                    reader.close()
                    peer.join(2)
                    if mode == "cancelled":
                        timer.join()

    def test_reasoning_streams_renew_timeout_for_llamacpp_and_ollama(self):
        with tempfile.TemporaryDirectory() as directory:
            nodes, _ = load_modules(directory)
            for provider in ("llamacpp", "ollama"):
                if provider == "llamacpp":
                    lines = [b'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n'] * 12
                    lines += [b'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n', b'data: [DONE]\n']
                else:
                    lines = [b'{"message":{"thinking":"thinking"},"done":false}\n'] * 12
                    lines += [b'{"message":{"content":"answer"},"done":true,"done_reason":"stop"}\n']
                class Stream(io.BytesIO):
                    def read1(self, size):
                        time.sleep(.04)
                        return lines.pop(0) if lines else b""
                with self.subTest(provider=provider), \
                     mock.patch.object(nodes._provider_transport, "_open", return_value=Stream()), \
                     mock.patch.object(nodes, "_get_json", return_value=None):
                    if provider == "llamacpp":
                        result = nodes._post_llamacpp_chat("http://localhost:8080", {"model": "test"}, .2)
                        self.assertEqual(result["choices"][0]["message"]["content"], "answer")
                    else:
                        result = nodes._post_json("http://localhost:11434/api/chat", {"stream": True}, .2, "Ollama")
                        self.assertEqual(result["message"]["content"], "answer")
                        self.assertEqual(result["message"]["thinking"], "thinking" * 12)

    def test_inference_stall_and_heartbeats_do_not_extend_wait(self):
        with tempfile.TemporaryDirectory() as directory:
            nodes, _ = load_modules(directory)
            class Heartbeats(io.BytesIO):
                def read1(self, size):
                    time.sleep(.04)
                    return b": keepalive\n"
            with mock.patch.object(nodes._provider_transport, "_open", return_value=Heartbeats()), \
                 mock.patch.object(nodes, "_get_json", return_value=None):
                with self.assertRaisesRegex(RuntimeError, "deadline"):
                    nodes._post_llamacpp_chat("http://localhost:8080", {"model": "test"}, .2)

    def test_confirmed_activity_renews_operation_budget(self):
        coordinator = LlmCoordinator()
        token = CancellationToken()
        with mock.patch.object(transport, "MAX_TOTAL_SECONDS", .2):
            token.note_activity()
            def work():
                with transport.open_response(urllib.request.Request("http://localhost/test"), .15,
                        lambda _: None, inference=True) as response:
                    for _ in range(12):
                        time.sleep(.04)
                        response.note_activity()
                    token.check()
                    return response.read()
            with mock.patch.object(transport, "_open", return_value=io.BytesIO(b"done")):
                self.assertEqual(coordinator.run({"endpoint"}, work, token=token), b"done")

    def test_provider_probes_use_server_work_not_loaded_or_owned_stream_flags(self):
        with tempfile.TemporaryDirectory() as directory:
            nodes, _ = load_modules(directory)
            for service, url, payload, busy, idle in (
                ("Llama.cpp", "http://localhost:8080/v1/chat/completions", {"model": "chosen"},
                 [{"is_processing": True}], [{"is_processing": False}]),
                ("KoboldCpp", "http://localhost:5001/api/v1/generate", {}, {"idle": 0}, {"idle": 1}),
            ):
                with mock.patch.object(nodes._provider_transport, "open_response") as opening:
                    nodes._open_provider_response(urllib.request.Request(url, data=json.dumps(payload).encode()), 120, service)
                probe = opening.call_args.kwargs["activity_check"]
                for value, expected in ((busy, True), (idle, False), (None, False)):
                    with mock.patch.object(nodes, "_get_json", return_value=value) as get:
                        self.assertEqual(probe(), expected)
                        if service == "Llama.cpp":
                            self.assertIn("model=chosen&autoload=false", get.call_args.args[0])
