import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_regressions import load_modules


class LlamaAutoloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        _, self.routes = load_modules(self.temp.name)
        self.routes.LLAMACPP_AUTOSTART_PATH = str(self.root / "autostart.json")
        self.launcher = {"executable": str(self.root / "llama"),
                         "config_path": str(self.root / "profile.json"),
                         "model": str(self.root / "model.gguf"), "mmproj": "",
                         "command": ["llama", "--model", str(self.root / "model.gguf")]}

    def test_preference_round_trip_and_lazy_default(self):
        for value in (True, False, None):
            with self.subTest(value=value), mock.patch.object(
                    self.routes, "_load_llamacpp_launcher_config", return_value=self.launcher):
                data = {"enabled": True}
                if value is not None:
                    data["keep_models_loaded"] = value
                status = self.routes._save_llamacpp_autostart_config(data)
                config = self.routes._read_llamacpp_autostart_config()
                self.assertIs(status["keep_models_loaded"], value is True)
                self.assertIs(config["keep_models_loaded"], value is True)
                self.routes._llamacpp_router_command(
                    self.launcher, keep_models_loaded=self.routes._keep_models_loaded(config))
                preset = Path(self.launcher["config_path"] + ".router.ini").read_text()
                self.assertEqual("load-on-startup = true" in preset, value is True)

    def test_invalid_preference_does_not_overwrite_config(self):
        path = Path(self.routes.LLAMACPP_AUTOSTART_PATH)
        path.write_text("original")
        with self.assertRaises(ValueError):
            self.routes._save_llamacpp_autostart_config({"enabled": True, "keep_models_loaded": "false"})
        self.assertEqual(path.read_text(), "original")

    def test_startup_only_preloads_recovered_managed_server_when_enabled(self):
        for keep in (True, False):
            for managed, recovered in ((True, True), (True, False), (False, True)):
                with self.subTest(keep=keep, managed=managed, recovered=recovered):
                    config = {"enabled": True, "keep_models_loaded": keep}
                    status = {"managed": managed, "already_running": recovered}
                    with (mock.patch.object(self.routes, "_read_llamacpp_autostart_config", return_value=config),
                          mock.patch.object(self.routes, "_recover_llamacpp_process_locked"),
                          mock.patch.object(self.routes, "_start_llamacpp_server", return_value=status) as start,
                          mock.patch.object(self.routes, "_preload_recovered_llamacpp_model") as preload):
                        self.assertEqual(self.routes._initialize_llamacpp_process(), status)
                    start.assert_called_once_with(config)
                    self.assertEqual(preload.call_count, int(keep and managed and recovered))

    def test_recovery_only_loads_unloaded_model(self):
        for state in ("unloaded", "loaded", "loading"):
            with self.subTest(state=state):
                with (mock.patch.object(self.routes, "_get_json", return_value={"data": [
                        {"id": "selected.gguf", "status": {"value": state}}]}),
                      mock.patch.object(self.routes, "_post_json", return_value={"success": True}) as post,
                      mock.patch.object(self.routes, "_release_comfy_models", side_effect=AssertionError("unload")),
                      mock.patch.object(self.routes, "_stop_llamacpp_server", side_effect=AssertionError("stop"))):
                    self.routes._preload_recovered_llamacpp_model({"url": "http://localhost:8080"})
                if state == "unloaded":
                    post.assert_called_once_with("http://localhost:8080/models/load",
                                                 {"model": "selected.gguf"}, 300, "Llama.cpp")
                else:
                    post.assert_not_called()

    def test_failed_preload_is_reported(self):
        with (mock.patch.object(self.routes, "_get_json", return_value={"data": [
                {"id": "selected.gguf", "status": {"value": "unloaded"}}]}),
              mock.patch.object(self.routes, "_post_json", return_value={"success": False})):
            with self.assertRaisesRegex(RuntimeError, "could not preload"):
                self.routes._preload_recovered_llamacpp_model({"url": "http://localhost:8080"})
