import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_regressions import load_modules


class ConfigEditorTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        _, self.routes = load_modules(temp.name)
        self.routes.LLAMACPP_CONFIG_DIRECTORY = str(self.root / "configs")
        self.model = self.root / "model.gguf"
        self.model.touch()
        self.config = self.routes._edit_llamacpp_config({"action": "new"})["config"]
        self.config.update(model_gguf=str(self.model), custom={"retain": True},
                           mtp_enabled="on", mtp_draft_tokens=2, extra_args=["--jinja"])

    def save(self, **changes):
        return self.routes._edit_llamacpp_config({"action": "save", "llamacpp_config_profile": "test.json",
                                                 "config": self.config, "revision": None, **changes})

    def test_create_edit_roundtrip_and_launch_share_validation_without_process(self):
        with mock.patch.object(self.routes.subprocess, "Popen") as popen:
            result = self.save()
            loaded = self.routes._edit_llamacpp_config({"llamacpp_config_profile": "test.json"})
            self.assertEqual(result["revision"], loaded["revision"])
            self.assertEqual(loaded["config"]["custom"], {"retain": True})
            self.assertEqual(loaded["config"]["llm_profile"]["instruct_modes"], [])
            self.config["llm_profile"]["thinking_temperature"] = 1.2
            self.save(revision=loaded["revision"])
            popen.assert_not_called()
        executable = self.root / "llama-server.exe"
        executable.touch()
        launcher = self.routes._load_llamacpp_launcher_config({"llamacpp_executable": str(executable),
                                                              "llamacpp_config_profile": "test.json"})
        self.assertIn("draft-mtp", launcher["command"])
        self.assertEqual(Path(launcher["model"]), self.model)
        self.assertEqual(list((self.root / "configs").glob("*.tmp")), [])

    def test_conflicts_and_atomic_failure_preserve_previous_file(self):
        saved = self.save()
        target = self.root / "configs" / "test.json"
        before = target.read_bytes()
        for revision in (None, "stale"):
            with self.assertRaises(self.routes.LlamacppConfigConflict):
                self.save(revision=revision)
            self.assertEqual(target.read_bytes(), before)
        with mock.patch.object(self.routes.os, "replace", side_effect=OSError("locked")):
            with self.assertRaises(OSError):
                self.save(revision=saved["revision"])
        self.assertEqual(target.read_bytes(), before)
        self.assertEqual(list(target.parent.glob("*.tmp")), [])
        target.unlink()
        with self.assertRaises(self.routes.LlamacppConfigConflict):
            self.save(revision=saved["revision"])
        self.assertFalse(target.exists())

    def test_invalid_values_and_foreign_paths_do_not_write(self):
        for update in ({"model_gguf": str(self.root / "missing.gguf")}, {"port": 0}, {"port": 4.5},
                       {"gpu_layers": "-1"}, {"tensor_split": "bad"}, {"mtp_min_draft_tokens": 9},
                       {"extra_args": "--jinja"}, {"llm_profile": []}, {"custom": "x" * 65536}):
            with self.subTest(update=list(update)), self.assertRaises(ValueError):
                self.save(config={**self.config, **update})
        for name in ("../bad.json", "..\\bad.json", "C:bad.json", "folder/file.json", "bad.txt"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.save(llamacpp_config_profile=name)
        self.assertFalse((self.root / "configs" / "test.json").exists())

    def test_legacy_modes_and_aliases_load_without_changing_file(self):
        self.config["llm_profile"] = {"thinking_modes": ["Low", "Disabled"], "thinking_mode": "Low"}
        self.config["model"] = self.config.pop("model_gguf")
        saved = self.save()
        path = self.root / "configs" / "test.json"
        before = path.read_bytes()
        loaded = self.routes._edit_llamacpp_config({"llamacpp_config_profile": path.name})
        self.assertEqual(loaded["config"]["model"], str(self.model))
        self.assertEqual(loaded["config"]["llm_profile"]["thinking_modes"], ["Low", "Disabled"])
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(saved["revision"], loaded["revision"])

    def test_endpoint_enforces_local_access_and_conflict_status(self):
        class Request:
            content_length = None

            async def json(inner):
                return {"action": "save", "llamacpp_config_profile": "test.json", "config": self.config}

        with mock.patch.object(self.routes, "_require_loopback_server_control", side_effect=PermissionError("local only")), \
                mock.patch.object(self.routes, "_edit_llamacpp_config") as edit:
            _, status = asyncio.run(self.routes.prompt_studio_llamacpp_config_builder(Request()))
            self.assertEqual(status, 403)
            edit.assert_not_called()
        self.save()
        with mock.patch.object(self.routes, "_require_loopback_server_control"):
            _, status = asyncio.run(self.routes.prompt_studio_llamacpp_config_builder(Request()))
            self.assertEqual(status, 409)

    def test_gguf_picker_accepts_assets_and_cancel(self):
        for kind in ("model", "mmproj"):
            self.assertEqual(Path(self.routes._validate_llamacpp_picker_selection(kind, str(self.model))), self.model)
            self.assertEqual(self.routes._validate_llamacpp_picker_selection(kind, ""), "")
        other = self.root / "other.txt"
        other.touch()
        with self.assertRaises(ValueError):
            self.routes._validate_llamacpp_picker_selection("model", str(other))
