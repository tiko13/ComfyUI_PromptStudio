import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_regressions import load_modules


class ModelProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.nodes, self.routes = load_modules(self.temp.name)
        self.bundled = Path(self.temp.name) / "model_profiles.json"
        self.additional = Path(self.temp.name) / "model_profiles.additional.json"
        self.nodes.PROFILES_PATH = str(self.bundled)
        self.nodes.ADDITIONAL_PROFILES_PATH = str(self.additional)
        self.bundled.write_text(json.dumps({"profiles": [
            {"name": "Natural", "instruction": "Original instruction", "example_prompt": "Legacy example"},
            {"name": "Tags", "style": "comma_tags"},
        ]}), encoding="utf-8")
        self.original_bytes = self.bundled.read_bytes()

    def save(self, profile, original="", revision=None):
        return self.nodes._update_model_profiles({"action": "save", "profile": profile,
            "original_name": original, "revision": revision or self.nodes._read_model_profiles()["revision"]})

    def delete(self, name):
        return self.nodes._update_model_profiles({"action": "delete", "original_name": name,
            "revision": self.nodes._read_model_profiles()["revision"]})

    def test_add_override_restore_delete_and_hot_reload(self):
        self.assertFalse(self.additional.exists())
        self.assertEqual(self.nodes._get_profile("Natural")["example_prompts"], ["Legacy example"])
        saved = self.save({"name": "Custom", "style": "comma_tags", "final_prompt_prefix": "literal: ",
                           "final_prompt_suffix": " END", "example_prompts": ["tag_one, tag_two"]})
        self.assertEqual(self.nodes._profile_names(), ["Natural", "Tags", "Custom"])
        self.assertEqual(saved["output_length_profiles"]["Custom"]["unit"], "tags")
        self.assertEqual(self.nodes._get_profile("Custom")["final_prompt_prefix"], "literal: ")
        self.save({"name": "natural", "instruction": "Local override"}, "Natural")
        self.assertEqual(self.nodes._get_profile("Natural")["instruction"], "Local override")
        self.assertEqual(self.nodes._read_model_profiles()["profiles"][0]["source"], "override")
        self.delete("Natural")
        self.assertEqual(self.nodes._get_profile("Natural")["instruction"], "Original instruction")
        self.save({"name": "Renamed"}, "Custom")
        self.assertEqual(self.nodes._profile_names(), ["Natural", "Tags", "Renamed"])
        self.delete("Renamed")
        self.assertEqual(self.nodes._profile_names(), ["Natural", "Tags"])
        self.assertEqual(self.bundled.read_bytes(), self.original_bytes)

    def test_stale_revision_and_duplicate_names_never_overwrite(self):
        revision = self.nodes._read_model_profiles()["revision"]
        self.save({"name": "Custom"})
        before = self.additional.read_bytes()
        with self.assertRaises(self.nodes.ModelProfilesConflictError):
            self.save({"name": "Other"}, revision=revision)
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.save({"name": "CUSTOM"})
        with self.assertRaisesRegex(ValueError, "different name"):
            self.save({"name": "Renamed"}, "Natural")
        self.assertEqual(self.additional.read_bytes(), before)
        revision = self.nodes._read_model_profiles()["revision"]
        self.bundled.write_text('{"profiles": [{"name": "New bundled profile"}]}', encoding="utf-8")
        with self.assertRaises(self.nodes.ModelProfilesConflictError):
            self.save({"name": "Other"}, revision=revision)

    def test_validation_and_failed_write_preserve_files(self):
        self.save({"name": "Custom"})
        before = self.additional.read_bytes()
        for invalid in [None, {}, {"name": " "}, {"name": "New", "style": "invalid"},
                        {"name": "New", "default_max_response_tokens": 0},
                        {"name": "New", "default_max_response_tokens": 1.5},
                        {"name": "New", "default_max_response_tokens": True},
                        {"name": "New", "notes": {}}, {"name": "New", "instruction": []}]:
            with self.subTest(profile=invalid), self.assertRaises(ValueError):
                self.save(invalid)
        with mock.patch.object(self.nodes.os, "replace", side_effect=OSError("disk error")):
            with self.assertRaises(OSError):
                self.save({"name": "Other"})
        self.assertEqual(self.additional.read_bytes(), before)
        self.assertEqual(self.bundled.read_bytes(), self.original_bytes)
        self.assertEqual(list(Path(self.temp.name).glob("model_profiles.*.tmp")), [])

    def test_direct_file_edits_and_malformed_local_file(self):
        self.additional.write_text(json.dumps({"profiles": [
            {"name": "natural", "instruction": "Override from disk"}, {"name": "Disk profile"}]}), encoding="utf-8-sig")
        self.assertEqual(self.nodes._profile_names(), ["Natural", "Tags", "Disk profile"])
        self.assertEqual(self.nodes._get_profile("Natural")["instruction"], "Override from disk")
        self.additional.write_text('{"profiles": [{"name": "Same"}, {"name": "same"}]}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            self.nodes._load_profiles()
        self.additional.write_text("{broken", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "model_profiles.additional.json"):
            self.nodes._load_profiles()

    def test_fixed_seed_canvas_nodes_invalidate_when_selected_profile_changes(self):
        for node in (self.nodes.KCPP_PromptAmplify, self.nodes.KCPP_Ideogram4):
            before = node.IS_CHANGED(sampler_seed=42, model_profile="Natural")
            self.save({"name": "Natural", "instruction": node.__name__}, "Natural")
            after = node.IS_CHANGED(sampler_seed=42, model_profile="Natural")
            self.assertNotEqual(before, after)
            self.assertEqual(after, node.IS_CHANGED(sampler_seed=42, model_profile="Natural"))

    def test_http_success_validation_conflict_and_size_limit(self):
        catalog, status = asyncio.run(self.routes.prompt_studio_model_profiles(None))
        self.assertEqual(status, 200)
        def request(data, length=100):
            return mock.Mock(content_length=length, json=mock.AsyncMock(return_value=data))
        payload = {"action": "save", "revision": catalog["revision"], "profile": {"name": "API profile"}}
        result, status = asyncio.run(self.routes.prompt_studio_save_model_profiles(request(payload)))
        self.assertEqual(status, 200)
        self.assertEqual(result["profiles"][-1]["profile"]["name"], "API profile")
        _, status = asyncio.run(self.routes.prompt_studio_save_model_profiles(request(payload)))
        self.assertEqual(status, 409)
        _, status = asyncio.run(self.routes.prompt_studio_save_model_profiles(request([])))
        self.assertEqual(status, 400)
        _, status = asyncio.run(self.routes.prompt_studio_save_model_profiles(request(payload, 2 * 1024 * 1024)))
        self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main()
