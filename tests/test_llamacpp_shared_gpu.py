import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_regressions import load_modules


class LlamaSharedGpuTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.nodes, self.routes = load_modules(self.temp.name)

    def test_router_preserves_model_identity_and_worker_options(self):
        root = Path(self.temp.name)
        model, vision = root / "model with spaces.gguf", root / "vision.gguf"
        launcher = {"model": str(model), "mmproj": str(vision),
                    "config_path": str(root / "test.json"),
                    "command": ["llama", "serve", "--model", str(model), "--mmproj", str(vision),
                                "--device", "CUDA0", "--spec-type", "draft-mtp", "--ctx-size", "64000"]}
        original = list(launcher["command"])
        command = self.routes._llamacpp_router_command(launcher)
        self.assertEqual(launcher["command"], original)
        self.assertNotIn("--model", command)
        self.assertNotIn("--mmproj", command)
        self.assertEqual(command[:2], ["llama", "serve"])
        self.assertEqual(command[command.index("--device") + 1], "CUDA0")
        self.assertEqual(command[command.index("--spec-type") + 1], "draft-mtp")
        preset = Path(command[command.index("--models-preset") + 1])
        self.assertEqual(preset, root / "test.json.router.ini")
        self.assertIn(f"[{model.name}]\nmodel = {model}\nalias = {model}\nmmproj = {vision}\n", preset.read_text())
        self.assertEqual(command[-2:], ["--models-max", "1"])

    def test_status_of_unloaded_router_model_never_calls_loading_endpoints(self):
        urls = []
        def get(url, *_):
            urls.append(url)
            if url.endswith("/health"):
                return {"status": "ok"}
            if url.endswith("/models"):
                return {"data": [{"id": "test", "status": {"value": "unloaded"}}]}
            self.fail(f"Status requested a model endpoint: {url}")
        with (mock.patch.object(self.routes, "_get_json", side_effect=get),
              mock.patch.object(self.routes, "_list_llamacpp_models", return_value=["test"]),
              mock.patch.object(self.routes, "_llamacpp_managed_process_status", return_value={"running": True}),
              mock.patch.object(self.routes, "_llamacpp_props") as props):
            status = self.routes._llamacpp_generation_status({"llamacpp_url": "http://localhost:8080"})
        props.assert_not_called()
        self.assertTrue(status["reachable"])
        self.assertTrue(status["model_installed"])
        self.assertEqual(status["model_state"], "unloaded")

    def test_loaded_status_disables_autoload_on_both_model_probes(self):
        urls = []
        def get(url, *_):
            urls.append(url)
            return {"status": "ok"} if url.endswith("/health") else {}
        with (mock.patch.object(self.routes, "_get_json", side_effect=get),
              mock.patch.object(self.routes, "_list_llamacpp_models", return_value=["test"]),
              mock.patch.object(self.routes, "_llamacpp_managed_process_status", return_value={}),
              mock.patch.object(self.routes, "_llamacpp_props", return_value={}) as props):
            self.routes._llamacpp_generation_status({"llamacpp_url": "http://localhost:8080"})
        self.assertTrue(any("slots?model=test&autoload=false" in url for url in urls))
        props.assert_called_once_with("http://localhost:8080", 3, "test", autoload=False)

    def test_release_uses_router_unload_without_stopping_server(self):
        with (mock.patch.object(self.routes, "_post_json", return_value={"success": True}) as post,
              mock.patch.object(self.routes, "_get_json", side_effect=[{},
                  {"data": [{"id": "test", "status": {"value": "loading"}}]},
                  {"data": [{"id": "test", "status": {"value": "unloaded"}}]}]) as get,
              mock.patch.object(self.routes, "_stop_llamacpp_server") as stop):
            result = self.routes._unload_llamacpp_model("http://localhost:8080", "test")
        self.assertTrue(result["unloaded"])
        self.assertEqual(post.call_args.args[:2], ("http://localhost:8080/models/unload", {"model": "test"}))
        stop.assert_not_called()
        self.assertEqual(get.call_count, 3)

    def test_props_status_opt_out_keeps_generation_autoload_default(self):
        with mock.patch.object(self.nodes, "_get_json", return_value={}) as get:
            self.nodes._llamacpp_props("http://localhost:8080", 3, "test", autoload=False)
            self.assertIn("autoload=false", get.call_args.args[0])
            self.nodes._llamacpp_props("http://localhost:8080", 3, "test")
            self.assertNotIn("autoload=false", get.call_args.args[0])

    def test_comfy_handoff_reawakens_worker_after_lost_cleanup_notification(self):
        queue = mock.Mock()
        queue.get_tasks_remaining.return_value = 0
        queue.get_flags.side_effect = [{"unload_models": True, "free_memory": True}, {}]
        with (mock.patch.object(self.routes.PromptServer.instance, "prompt_queue", queue, create=True),
              mock.patch.object(self.routes, "_comfy_loaded_model_count", side_effect=[1, 0])):
            self.routes._release_comfy_models(timeout=1)
        self.assertEqual(queue.set_flag.call_args_list, [mock.call("unload_models", True),
            mock.call("free_memory", True), mock.call("unload_models", True), mock.call("free_memory", True)])

    def test_keep_loaded_never_touches_either_models_or_shared_gpu_state(self):
        settings = {"llm_provider": "llamacpp", "llamacpp_url": "http://localhost:8080",
                    "llamacpp_model": "test", "keep_models_loaded": True}
        self.routes._SHARED_GPU_OWNER = "comfy"
        self.routes._ACTIVE_SHARED_LLM = {"llm_provider": "ollama"}
        active = self.routes._ACTIVE_SHARED_LLM
        with (mock.patch.object(self.routes, "_release_comfy_models", side_effect=AssertionError("Comfy unload")),
              mock.patch.object(self.routes, "_unload_llm_provider", side_effect=AssertionError("LLM unload")),
              mock.patch.object(self.routes, "_stop_llamacpp_server", side_effect=AssertionError("server stop")),
              mock.patch.object(self.routes, "_start_llamacpp_server", side_effect=AssertionError("server start")),
              mock.patch.object(self.routes, "_wait_for_pending_comfy_handoffs", side_effect=AssertionError("shared handoff"))):
            self.routes._prepare_shared_gpu_for_llm(settings)
            result = self.routes._release_shared_llm_for_comfy(settings)
        self.assertEqual(result, {"unloaded": False, "kept_loaded": True})
        self.assertEqual(self.routes._SHARED_GPU_OWNER, "comfy")
        self.assertIs(self.routes._ACTIVE_SHARED_LLM, active)
