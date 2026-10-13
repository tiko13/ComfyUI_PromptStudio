"""Synthetic embedded metadata; no local model files or network required."""
import asyncio
import concurrent.futures
import copy
import io
import json
from pathlib import Path
import tempfile
import threading
import types
import unittest
from unittest import mock

from test_civitai_metadata import metadata, VERSION, MODEL


STUDIO = {"schema_version": 1, "studio_version": "0.1.0", "name": "Synthetic [name]",
          "description": "<img src=x onerror=bad()> public description", "author": "Author", "license": "",
          "trigger_words": ["phrase, with comma", "Case", "case", "literal [name]"],
          "recommended_strength": 0,
          "training": {"model": {"id": "krea2", "arch": "krea2", "base_model": "public/base", "quantize": True},
                       "train": {"steps": 1200, "lr": 0.0001, "optimizer_params": {"weight_decay": 0.0001}},
                       "network": {"type": "lora", "linear": 16, "linear_alpha": 16},
                       "dataset": {"resolution": [1024], "buckets": True},
                       "sample": {"width": 1024, "height": 1024}}}


class LocalMetadataTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.path = self.root / "synthetic.safetensors"
        self.fetch = mock.Mock(side_effect=AssertionError("Local metadata must not query Civitai"))
        self.service = metadata.MetadataService(self.root / "cache", resolve=lambda *args: self.path, fetch=self.fetch)
        self.write()

    def write(self, studio=STUDIO, extra=None):
        fields = {} if studio is None else {"lora_studio": json.dumps(studio).replace("[name]", r"\u005bname]")}
        fields.update(extra or {})
        raw = json.dumps({"__metadata__": fields, "weight": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}).encode()
        self.path.write_bytes(len(raw).to_bytes(8, "little") + raw + b"\0" * 4)

    def local(self):
        return self.service.local_details("loras", self.path.name)

    def test_header_only_preserves_usage_and_allowlists_training(self):
        studio = copy.deepcopy(STUDIO)
        studio["unknown"] = "private"
        studio["training"]["dataset"]["folder_path"] = "private path"
        studio["training"]["sample"]["prompts"] = ["private prompt"]
        self.write(studio, {"training_info": '{"step":250,"epoch":0,"private":"ignored"}',
                           "ss_tag_frequency": '{"dataset":{"training trigger":20}}'})
        blob = self.path.read_bytes()
        class HeaderOnly(io.BytesIO):
            def read(self, size=-1):
                self_test.assertGreaterEqual(size, 0)
                self_test.assertLessEqual(self.tell() + size, len(blob) - 4, "Tensor bytes must never be read")
                return super().read(size)
        self_test = self
        with mock.patch.object(Path, "open", return_value=HeaderOnly(blob)):
            result = metadata.read_local_metadata(self.path)
        self.assertEqual(result["name"], "Synthetic [name]")
        self.assertEqual(result["trigger_words"], STUDIO["trigger_words"])
        self.assertEqual(result["recommended_strength"], 0)
        self.assertEqual(result["legacy"]["training_info"], {"step": 250, "epoch": 0})
        self.assertNotIn("private", json.dumps(result))

    def test_offline_triggers_persist_and_population_skips_hash_and_network(self):
        with mock.patch.object(metadata.hashlib, "sha256", wraps=metadata.hashlib.sha256) as sha:
            population = metadata.LibraryPopulation(self.service, catalog=lambda: [("loras", self.path.name)], delay=0)
            asyncio.run(population.run())
            self.assertTrue(all(call.args for call in sha.call_args_list), "Only cache keys may be hashed")
        self.assertEqual(population.state["state"], "complete")
        self.assertEqual(self.service.summary(), {"local": 1})
        saved = self.service.saved_details("loras", self.path.name)
        self.assertEqual(saved["trigger_words"], STUDIO["trigger_words"])
        self.assertEqual(saved["trigger_words_source"], "LoRA Studio")
        self.assertFalse(saved["refresh_due"])
        self.assertEqual(saved["sha256"], "")
        with mock.patch.object(Path, "open", side_effect=AssertionError("Unchanged header must be cached")):
            self.assertEqual(self.local(), saved)
        self.fetch.assert_not_called()

    def test_precedence_local_edits_then_studio_then_remote_then_legacy(self):
        self.fetch.side_effect = lambda path, site: copy.deepcopy(VERSION if path.startswith("model-versions/") else MODEL)
        self.write(extra={"ss_tag_frequency": '{"dataset":{"legacy":20}}'})
        result = self.service.details("loras", self.path.name, lookup=True)
        self.assertEqual(result["trigger_words"], STUDIO["trigger_words"])
        self.assertEqual(result["creator"], "Example", "Remote fields remain separate")
        self.service.save_trigger_words("loras", self.path.name, [])
        self.assertEqual(self.local()["trigger_words"], [])
        self.write({**STUDIO, "trigger_words": [], "name": "Replacement"})
        replaced = self.local()
        self.assertFalse(replaced["trigger_words_edited"])
        self.assertEqual(replaced["trigger_words"], [])
        self.assertEqual(replaced["trigger_words_source"], "LoRA Studio")

    def test_absent_studio_uses_legacy_without_invented_author_or_license(self):
        self.write(None, {"ss_tag_frequency": '{"dataset":{"old, phrase":4}}', "ss_base_model_version": "base",
                          "software": '{"name":"ai-toolkit","version":"test"}'})
        result = self.local()
        self.assertEqual(result["local_metadata"]["status"], "missing")
        self.assertEqual(result["trigger_words"], ["old, phrase"])
        self.assertNotIn("author", result["local_metadata"])
        self.assertNotIn("license", result["local_metadata"])

    def test_generic_caption_tag_frequency_is_not_a_trigger_list(self):
        self.write(None, {"ss_tag_frequency": '{"dataset":{"portrait":40,"outdoors":20}}'})
        self.assertNotIn("trigger_words", self.local())

    def test_invalid_and_unsupported_metadata_are_distinct_and_bounded(self):
        for value, status in [({**STUDIO, "schema_version": 2}, "unsupported"),
                              ({**STUDIO, "schema_version": True}, "malformed"),
                              ({**STUDIO, "trigger_words": "not a list"}, "malformed"),
                              ({**STUDIO, "trigger_words": [1]}, "malformed"),
                              ({**STUDIO, "recommended_strength": True}, "malformed"),
                              ({**STUDIO, "recommended_strength": float("nan")}, "malformed"),
                              ({**STUDIO, "recommended_strength": 11}, "malformed"),
                              ({**STUDIO, "training": {"train": {"steps": "1200"}}}, "malformed")]:
            with self.subTest(value=value):
                self.write(value)
                self.assertEqual(metadata.read_local_metadata(self.path)["status"], status)
        for raw in ['{', '"' + 'x' * metadata.MAX_STUDIO_METADATA + '"']:
            self.write(None, {"lora_studio": raw})
            self.assertEqual(metadata.read_local_metadata(self.path)["status"], "malformed")
        self.path.write_bytes((metadata.MAX_HEADER + 1).to_bytes(8, "little"))
        self.assertEqual(metadata.read_local_metadata(self.path)["status"], "malformed")
        self.path.write_bytes((100).to_bytes(8, "little") + b"{}")
        self.assertEqual(metadata.read_local_metadata(self.path)["status"], "malformed")

    def test_null_strength_and_non_safetensors(self):
        self.write({**STUDIO, "recommended_strength": None})
        self.assertIsNone(self.local()["local_metadata"]["recommended_strength"])
        self.assertEqual(metadata.read_local_metadata(self.root / "never-open.ckpt"), {"status": "not_supported"})

    def test_local_read_ignores_blocked_remote_and_save_survives_late_response(self):
        entered, release = threading.Event(), threading.Event()
        def fetch(path, site):
            entered.set()
            if not release.wait(5):
                raise AssertionError("Remote test not released")
            return copy.deepcopy(VERSION if path.startswith("model-versions/") else MODEL)
        self.service.fetch = fetch
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            remote = pool.submit(self.service.details, "loras", self.path.name, lookup=True)
            try:
                self.assertTrue(entered.wait(2))
                self.assertEqual(pool.submit(self.local).result(timeout=2)["trigger_words"], STUDIO["trigger_words"])
                self.service.save_trigger_words("loras", self.path.name, ["custom"])
                self.assertFalse(remote.done())
            finally:
                release.set()
            self.assertEqual(remote.result(timeout=2)["trigger_words"], ["custom"])

    def test_changed_header_and_missing_file(self):
        signature = metadata._signature(self.path)
        with mock.patch.object(metadata, "_signature", side_effect=[signature, [999]]):
            with self.assertRaisesRegex(ValueError, "changed while reading"):
                self.local()
        self.local()
        self.path.unlink()
        result = self.local()
        self.assertTrue(result["missing_file"])
        self.assertEqual(result["trigger_words"], STUDIO["trigger_words"])

    def test_local_route_bypasses_remote_queue(self):
        from test_regressions import load_modules
        _, routes = load_modules(str(self.root))
        async def body():
            return {"category": "loras", "name": self.path.name, "local_only": True}
        request = types.SimpleNamespace(method="POST", json=body)
        with mock.patch.object(routes, "_civitai_metadata", self.service), \
                mock.patch.object(routes, "_civitai_lookup_requests", None), \
                mock.patch.object(routes.web, "json_response", side_effect=lambda value, **kwargs: value):
            result = asyncio.run(routes.prompt_studio_model_metadata(request))
        self.assertEqual(result["trigger_words"], STUDIO["trigger_words"])
