import asyncio
from contextlib import chdir
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_regressions import load_modules


class LlamaProfileManagerTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        _, self.routes = load_modules(temp.name)
        self.configs = self.root / "configs"
        self.configs.mkdir()
        self.routes.LLAMACPP_CONFIG_DIRECTORY = str(self.configs)
        self.routes.LLAMACPP_AUTOSTART_PATH = str(self.root / "autostart.json")

    def profile(self, name, data):
        path = self.configs / name
        path.write_text(json.dumps(data), encoding="utf-8")
        return path

    def test_presence_aliases_optional_and_bad_documents(self):
        model = self.root / "model.gguf"
        model.touch()
        missing = self.root / "deleted.gguf"
        self.profile("a.json", {"model_gguf": str(model), "mmproj_gguf": str(missing)})
        self.profile("b.json", {"model": str(missing), "model_gguf": str(model), "mmproj": str(model)})
        self.profile("c.json", {"model": str(model)})
        (self.configs / "bad.json").write_text("broken", encoding="utf-8")
        result = {item["name"]: item for item in self.routes._inspect_llamacpp_config_profiles()}
        self.assertEqual(result["a.json"]["model"], {"path": str(model), "present": True})
        self.assertFalse(result["a.json"]["mmproj"]["present"])
        self.assertFalse(result["b.json"]["model"]["present"])
        self.assertTrue(result["b.json"]["mmproj"]["present"])
        self.assertIsNone(result["c.json"]["mmproj"]["present"])
        self.assertIn("error", result["bad.json"])
        model.unlink()
        self.assertFalse(self.routes._inspect_llamacpp_config_profiles()[0]["model"]["present"])

    def test_relative_paths_match_launcher_working_directory(self):
        model = self.root / "relative.gguf"
        model.touch()
        self.profile("relative.json", {"model": model.name})
        with chdir(self.root):
            self.assertTrue(self.routes._inspect_llamacpp_config_profiles()[0]["model"]["present"])
        with chdir(self.configs):
            self.assertFalse(self.routes._inspect_llamacpp_config_profiles()[0]["model"]["present"])

    def test_delete_only_profile_and_matching_autostart(self):
        model = self.root / "model.gguf"
        model.touch()
        profile = self.profile("selected.json", {"model": str(model), "mmproj": str(model)})
        other = self.profile("other.json", {})
        router = Path(str(profile) + ".router.ini")
        router.touch()
        startup = Path(self.routes.LLAMACPP_AUTOSTART_PATH)
        startup.write_text(json.dumps({"version": 1, "enabled": True, "llamacpp_executable": "llama-server",
                                       "llamacpp_config_profile": profile.name}), encoding="utf-8")
        self.routes._delete_llamacpp_config_profile(other.name)
        self.assertTrue(startup.is_file())
        result = self.routes._delete_llamacpp_config_profile(profile.name)
        self.assertEqual(result["deleted"], profile.name)
        self.assertFalse(result["autostart"]["enabled"])
        self.assertFalse(profile.exists())
        self.assertFalse(startup.exists())
        self.assertTrue(model.is_file())
        self.assertTrue(router.is_file())
        with self.assertRaises(ValueError):
            self.routes._delete_llamacpp_config_profile(profile.name)

    def test_invalid_json_can_be_deleted_and_paths_cannot_escape(self):
        target = self.configs / "broken.json"
        target.write_text("not json", encoding="utf-8")
        self.routes._delete_llamacpp_config_profile(target.name)
        self.assertFalse(target.exists())
        # Both persisted foreign separators must be rejected on every OS.
        for name in ("../outside.json", "..\\outside.json", "nested/file.json", "nested\\file.json", "C:outside.json", "", "file.txt"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.routes._delete_llamacpp_config_profile(name)

    def test_autostart_removal_failure_keeps_profile(self):
        profile = self.profile("selected.json", {})
        startup = {"llamacpp_config_profile": profile.name}
        with mock.patch.object(self.routes, "_read_llamacpp_autostart_config", return_value=startup), \
                mock.patch.object(self.routes.os, "remove", side_effect=PermissionError("locked")):
            with self.assertRaises(PermissionError):
                self.routes._delete_llamacpp_config_profile(profile.name)
        self.assertTrue(profile.is_file())

    def test_endpoint_checks_local_access_before_inspection_or_deletion(self):
        class Request:
            content_length = None

            async def json(self):
                return {"action": "inspect"}

        with mock.patch.object(self.routes, "_require_loopback_server_control", side_effect=PermissionError("local only")), \
                mock.patch.object(self.routes, "_inspect_llamacpp_config_profiles") as inspect:
            _, status = asyncio.run(self.routes.prompt_studio_llamacpp_config_profiles(Request()))
        self.assertEqual(status, 403)
        inspect.assert_not_called()
        self.profile("a.json", {})
        with mock.patch.object(self.routes, "_require_loopback_server_control"):
            data, status = asyncio.run(self.routes.prompt_studio_llamacpp_config_profiles(Request()))
        self.assertEqual(status, 200)
        self.assertEqual(data["profiles"][0]["name"], "a.json")
