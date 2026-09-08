import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("shared_provenance_test", Path(__file__).resolve().parents[1] / "provenance.py")
provenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provenance)


class ProvenanceTests(unittest.TestCase):
    def test_same_filename_same_size_replacement_changes_content_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.safetensors"
            path.write_bytes(b"first asset")
            cache = provenance.AssetIdentityCache()
            try:
                first = cache.identify(path)
                old_mtime = path.stat().st_mtime_ns
                replacement = Path(directory) / "replacement"
                replacement.write_bytes(b"other asset")
                os.utime(replacement, ns=(old_mtime, old_mtime))
                os.replace(replacement, path)
                second = cache.identify(path)
                self.assertEqual(first["size"], second["size"])
                self.assertNotEqual(first["sha256"], second["sha256"])
                self.assertNotEqual(first["metadata_token"], second["metadata_token"])
                self.assertEqual(second, cache.identify(path))
            finally:
                cache.close()

    def test_large_hash_is_lazy_and_small_identity_does_not_wait_behind_it(self):
        entered, release = threading.Event(), threading.Event()
        class ControlledCache(provenance.AssetIdentityCache):
            def _hash(self, path, signature):
                if path.name == "large":
                    entered.set()
                    release.wait(5)
                return super()._hash(path, signature)
        with tempfile.TemporaryDirectory() as directory:
            large, small = Path(directory) / "large", Path(directory) / "small"
            large.write_bytes(b"not actually a model")
            small.write_bytes(b"x")
            cache = ControlledCache(eager_bytes=2)
            try:
                first = cache.identify(large)
                self.assertEqual(first["hash_state"], "pending")
                self.assertTrue(entered.wait(1))
                self.assertEqual(cache.identify(small)["hash_state"], "complete")
                release.set()
                cache._executor.submit(lambda: None).result(timeout=2)
            finally:
                release.set()
                cache.close()
            self.assertEqual(cache.identify(large)["hash_state"], "complete")

    def test_capture_keeps_snapshot_and_relative_asset_names_without_private_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "asset"
            path.write_bytes(b"fixture")
            snapshot = {"workflow": {"nodes": []}, "output": {
                "30:1": {"inputs": {"unet_name": "group/model.safetensors"}},
                "30:2": {"inputs": {"lora_stack_json": json.dumps([{"name": "style/lora.safetensors"}])}},
                "3": {"inputs": {"ckpt_name": "C:\\private\\model.safetensors", "vae_name": "../secret"}},
            }}
            before = json.dumps(snapshot)
            requested = []
            def resolver(category, name):
                requested.append((category, name))
                return path
            cache = provenance.AssetIdentityCache()
            try:
                result = provenance.capture_runtime_metadata(snapshot, resolver, versions={"schema": 1, "private": directory}, cache=cache)
            finally:
                cache.close()
            self.assertEqual(json.dumps(snapshot), before)
            self.assertEqual(requested, [("diffusion_models", "group/model.safetensors"), ("loras", "style/lora.safetensors")])
            self.assertNotIn(directory, json.dumps(result))
            self.assertNotIn("C:\\private", json.dumps(result))
            self.assertEqual(result["versions"], {"schema": "1"})
            self.assertEqual([asset["status"] for asset in result["assets"]], ["available", "available", "unavailable", "unavailable"])

    def test_missing_asset_reports_a_specific_identity_status(self):
        snapshot = {"output": {"1": {"inputs": {"lora_name": "missing.safetensors"}}}}
        result = provenance.capture_runtime_metadata(snapshot, lambda *_: None)
        self.assertEqual(result["assets"][0]["status"], "missing")
        self.assertEqual(result["assets"][0]["name"], "missing.safetensors")

    def test_image_metadata_works_without_a_video_checkout(self):
        from test_regressions import load_modules
        with tempfile.TemporaryDirectory() as directory:
            load_modules(directory)
            route_spec = importlib.util.spec_from_file_location(
                "ComfyUI_PromptStudio.provenance_routes_test",
                Path(__file__).resolve().parents[1] / "provenance_routes.py",
            )
            routes = importlib.util.module_from_spec(route_spec)
            route_spec.loader.exec_module(routes)
            root = Path(directory) / "ComfyUI_PromptStudio"
            root.mkdir()
            self.assertFalse((root.parent / "PromptStudio_Video").exists())
            with mock.patch.object(routes, "ROOT", root), mock.patch.object(
                routes, "_pure_video_module", side_effect=AssertionError("Image metadata must not load Video Studio"),
            ) as video_loader:
                result = routes.metadata_for_snapshot({"output": {}}, "image")
            self.assertEqual(result["assets"], [])
            self.assertNotIn("video_extension", result["versions"])
            video_loader.assert_not_called()

    @unittest.skipUnless(os.environ.get("STUDIO_TEST_VIDEO") == "1", "Video integration is opt-in (STUDIO_TEST_VIDEO=1)")
    def test_video_filter_tracks_only_effective_turbo_assets_without_changing_snapshot(self):
        from types import SimpleNamespace
        path = Path(__file__).resolve().parents[2] / "PromptStudio_Video" / "video" / "provenance.py"
        video_spec = importlib.util.spec_from_file_location("video_provenance_test", path)
        video = importlib.util.module_from_spec(video_spec)
        video_spec.loader.exec_module(video)
        inputs = {key: key + ".safetensors" for key in video.TURBO_LORA_INPUTS}
        inputs.update(mode=["1", 0], width=["1", 1], height=["1", 2])
        snapshot = {"workflow": {"nodes": []}, "output": {
            "1": {"class_type": "PSV_MiniMaxH3Director", "inputs": {"document_json": json.dumps({"resolved_mode": "ref2va", "width": 1344, "height": 768})}},
            "2": {"class_type": "PSV_MiniMaxH3TurboProfile", "inputs": inputs},
        }}
        before = json.dumps(snapshot)
        calls = []
        def select(*args):
            calls.append(args)
            return SimpleNamespace(lora_input="ref2va_4step_lora")
        filtered = video.effective_asset_snapshot(snapshot, select)
        self.assertEqual(calls, [("ref2va", 1344, 768, "auto_quality")])
        self.assertEqual([item["input"] for item in provenance.snapshot_asset_references(filtered)], ["ref2va_4step_lora"])
        self.assertEqual(json.dumps(snapshot), before)
        snapshot["output"]["2"]["inputs"]["enabled"] = False
        self.assertEqual(provenance.snapshot_asset_references(video.effective_asset_snapshot(snapshot, select)), [])


if __name__ == "__main__":
    unittest.main()
