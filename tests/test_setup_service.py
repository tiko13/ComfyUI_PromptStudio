import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location("setup_service", ROOT / "setup_service.py")
SETUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SETUP)


def tensor_file(path, *, krea=True, dtype="F16"):
    name = "txtfusion.projector.weight" if krea else "other.weight"
    header = json.dumps({name: {"dtype": dtype, "shape": [1], "data_offsets": [0, 2]}}).encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack("<Q", len(header)) + header + b"ok")


class Paths:
    def __init__(self, root):
        self.root = Path(root)
        self.files = {}
        self.filename_list_cache = {}

    def get_filename_list(self, category):
        return [name for cat, name in self.files if cat == category]

    def get_full_path(self, category, name):
        return self.files.get((category, name))

    def get_folder_paths(self, category):
        return [str(self.root / category)]

    def add(self, category, name, data=b"fixture"):
        # Registered names intentionally use either separator style. They must
        # remain unchanged in serialized workflows, even on Linux.
        path = self.root / category / Path(*name.replace("\\", "/").split("/"))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        self.files[category, name] = str(path)
        return path


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.paths = Paths(self.root / "models")
        self.user = self.root / "users" / "alice"
        self.catalog = SETUP.load_catalog()
        # Small verified fixture assets exercise acquisition without real weights.
        for asset in self.catalog["assets"]:
            asset["size"] = 7
            asset["sha256"] = hashlib.sha256(b"fixture").hexdigest()
        nodes = {n["type"]: object() for p in self.catalog["packs"] for n in SETUP.workflow_nodes(
            json.loads((ROOT / "setup" / "workflows" / p["file"]).read_text(encoding="utf-8")))}
        self.service = SETUP.SetupService(self.paths, nodes, catalog=self.catalog)

    def add_model(self, name="Krea2/custom.safetensors", dtype="F16"):
        path = self.paths.add("diffusion_models", name)
        tensor_file(path, dtype=dtype)
        return name

    def add_assets(self, encoder="qwen3vl_4b_fp8"):
        self.add_model()
        for req in self.catalog["requirements"]:
            if req["id"] == "krea2": continue
            asset = self.service.assets[encoder if req["id"] == "encoder" else req["default_asset"]]
            self.paths.add(asset["category"], asset["relative_path"])

    def wait_job(self):
        root = str(self.user.resolve())
        self.service.workers[root].join(5)
        self.assertFalse(self.service.workers[root].is_alive())
        return self.service.status(self.user)["job"]

    def row(self, plan, identity):
        return next(row for row in plan["requirements"] if row["id"] == identity)

    def test_non_turbo_model_satisfies_all_workflows(self):
        name = self.add_model("Krea2RAW\\custom-raw.safetensors")
        plan = self.service.plan(self.user)
        row = self.row(plan, "krea2")
        self.assertEqual(row["choice"], name)
        self.assertEqual(row["download_bytes"], 0)
        self.assertEqual(row["used_by"], ["Create", "Edit", "Upscale"])

    def test_wrong_architecture_and_truncated_files_are_rejected(self):
        bad = self.paths.add("diffusion_models", "Krea2/not-krea.safetensors")
        tensor_file(bad, krea=False)
        truncated = self.paths.add("diffusion_models", "Krea2/broken.safetensors")
        tensor_file(truncated)
        truncated.write_bytes(truncated.read_bytes()[:-1])
        row = self.row(self.service.plan(self.user), "krea2")
        self.assertEqual(row["candidates"], [])
        self.assertEqual(len(row["rejected"]), 2)

    def test_int8_requires_registered_loader(self):
        self.add_model(dtype="I8")
        self.assertFalse(self.row(self.service.plan(self.user), "krea2")["candidates"])
        self.service.nodes["OTUNetLoaderW8A8"] = object()
        self.assertTrue(self.row(self.service.plan(self.user), "krea2")["candidates"])

    def test_fp8_and_bf16_are_interchangeable_and_selectable(self):
        for identity in ["qwen3vl_4b_fp8", "qwen3vl_4b_bf16"]:
            with self.subTest(identity=identity):
                self.paths.files.clear()
                asset = self.service.assets[identity]
                name = "shared\\" + asset["relative_path"]
                self.paths.add("text_encoders", name)
                row = self.row(self.service.plan(self.user), "encoder")
                self.assertEqual(row["choice"], name)
                self.assertEqual(row["download_bytes"], 0)
        self.paths.files.clear()
        for identity in ["qwen3vl_4b_fp8", "qwen3vl_4b_bf16"]:
            row = self.row(self.service.plan(self.user, {"choices": {"encoder": "__download__:" + identity}}), "encoder")
            self.assertEqual(row["download_asset"], identity)
            self.assertEqual(row["download_bytes"], 7)
        self.assertEqual(len(row["download_options"]), 2)

    def test_alternate_model_from_extra_path_keeps_registered_name(self):
        name = "external\\renamed.safetensors"
        path = self.root / "shared-models" / "renamed.safetensors"
        tensor_file(path)
        self.paths.files["diffusion_models", name] = str(path)
        self.assertEqual(self.row(self.service.plan(self.user), "krea2")["choice"], name)

    def test_workflow_selection_limits_requirements(self):
        plan = self.service.plan(self.user, {"packs": ["create"]})
        self.assertNotIn("upscaler", [row["id"] for row in plan["requirements"]])
        self.assertEqual(plan["node_packs"], [])
        self.assertTrue(all(row["used_by"] == ["Create"] for row in plan["requirements"]))

    def test_unknown_choices_and_arbitrary_paths_are_rejected(self):
        for payload in [{"packs": ["../oops"]}, {"choices": {"encoder": "../file"}}, {"choices": {"encoder": "__download__:unknown"}}]:
            with self.assertRaises(ValueError): self.service.plan(self.user, payload)

    def test_missing_nodes_are_explained_per_workflow(self):
        del self.service.nodes["UltimateSDUpscale"]
        plan = self.service.plan(self.user)
        row = next(p for p in plan["node_packs"] if p["id"] == "ultimate")
        self.assertEqual(row["used_by"], ["Upscale"])
        self.assertEqual(row["missing"], ["UltimateSDUpscale"])
        self.assertTrue(any("Manager" in b for b in plan["blockers"]))

    def test_read_only_plan_does_not_create_user_files(self):
        self.service.plan(self.user)
        self.assertFalse(self.user.exists())

    def test_registered_node_with_missing_krea_capability_is_blocked(self):
        class OldClipLoader:
            @classmethod
            def INPUT_TYPES(cls):
                return {"required": {"type": (["stable_diffusion"],)}}
        self.service.nodes["CLIPLoader"] = OldClipLoader
        plan = self.service.plan(self.user)
        self.assertTrue(any("does not offer type = krea2" in b for b in plan["blockers"]))

    def test_reuse_verifies_and_binds_same_encoder_to_all_workflows(self):
        self.add_assets()
        with mock.patch.object(SETUP, "acquire_asset", side_effect=AssertionError("Unexpected download")):
            self.service.start(self.user, {})
            job = self.wait_job()
        self.assertEqual(job["status"], "awaiting_validation", job.get("error"))
        for installed in job["workflows"]:
            flow = json.loads((self.user / "workflows" / installed["path"]).read_text())
            for node in SETUP.workflow_nodes(flow):
                if node["type"] == "CLIPLoader":
                    self.assertEqual(node["widgets_values"][0], "qwen3vl_4b_fp8_scaled.safetensors")
                    self.assertEqual(node["widgets_values_named"]["clip_name"], node["widgets_values"][0])
                if node["type"] == "KCPP_PromptStudioModelLoader":
                    self.assertEqual(node["widgets_values_named"]["unet_name"], "Krea2/custom.safetensors")
        results = [{"path": w["path"], "role": w["role"], "error": ""} for w in job["workflows"]]
        self.service.finish(self.user, job["id"], results)
        self.assertEqual(self.service.status(self.user)["onboarding"], "complete")

    def test_root_model_clears_folder_restriction(self):
        self.add_assets()
        self.paths.files.pop(("diffusion_models", "Krea2/custom.safetensors"))
        self.add_model("renamed.safetensors")
        self.service.start(self.user, {"packs": ["create"]})
        job = self.wait_job()
        self.assertEqual(job["status"], "awaiting_validation", job["error"])
        flow = json.loads((self.user / "workflows" / job["workflows"][0]["path"]).read_text())
        loader = next(n for n in SETUP.workflow_nodes(flow) if n["type"] == "KCPP_PromptStudioModelLoader")
        self.assertEqual(loader["widgets_values_named"]["model_type"], "")

    def test_existing_workflow_is_preserved_and_repeat_setup_reuses_copy(self):
        self.add_assets()
        directory = self.user / "workflows"
        directory.mkdir(parents=True)
        target = directory / self.catalog["packs"][0]["file"]
        target.write_text('{"user_work": true}')
        self.service.start(self.user, {"packs": ["create"]})
        job = self.wait_job()
        self.assertIn("(Setup 1)", job["workflows"][0]["path"])
        self.assertEqual(json.loads(target.read_text()), {"user_work": True})
        self.service.finish(self.user, job["id"], [{"path": w["path"], "role": w["role"], "error": ""} for w in job["workflows"]])
        self.service.start(self.user, {"packs": ["create"]})
        second = self.wait_job()
        self.assertEqual(second["workflows"][0]["path"], job["workflows"][0]["path"])
        self.assertEqual(len(list(directory.glob("*.json"))), 2)

    def test_reused_asset_checksum_failure_is_not_overwritten(self):
        self.add_assets()
        asset = self.service.assets["qwen3vl_4b_fp8"]
        path = self.paths.add("text_encoders", asset["relative_path"], b"changed")
        self.service.start(self.user, {})
        job = self.wait_job()
        self.assertEqual(job["status"], "failed")
        self.assertIn("Checksum", job["error"])
        self.assertEqual(path.read_bytes(), b"changed")

    def test_recovery_and_deferred_onboarding_are_per_user(self):
        self.service.dismiss(self.user)
        self.assertEqual(self.service.status(self.root / "bob")["onboarding"], "new")
        state = self.service._state(self.user)
        state["job"] = {"status": "running", "started_at": time.time()}
        self.service._save(self.user)
        fresh = SETUP.SetupService(self.paths, self.service.nodes, catalog=self.catalog)
        recovered = fresh.status(self.user)
        self.assertEqual(recovered["onboarding"], "deferred")
        self.assertEqual(recovered["job"]["status"], "interrupted")

    def test_duplicate_start_joins_active_job(self):
        self.add_assets()
        entered, release = threading.Event(), threading.Event()
        def verify(*args, **kwargs):
            entered.set()
            release.wait(3)
            return True
        with mock.patch.object(SETUP, "verified_file", side_effect=verify):
            first = self.service.start(self.user, {})
            self.assertTrue(entered.wait(2))
            second = self.service.start(self.user, {})
            self.assertEqual(first["job"]["id"], second["job"]["id"])
            release.set()
            self.wait_job()

    def test_pause_retains_partial_and_resume_keeps_encoder_precision(self):
        self.add_assets()
        asset = self.service.assets["qwen3vl_4b_fp8"]
        old = self.paths.files.pop(("text_encoders", asset["relative_path"]))
        Path(old).unlink()
        entered, release = threading.Event(), threading.Event()
        def download(selected, target, report):
            self.assertEqual(selected["id"], "qwen3vl_4b_fp8")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.with_name(target.name + ".part").write_bytes(b"fix")
            entered.set(); release.wait(3)
            report(3, 7, "Downloading")
        with mock.patch.object(SETUP, "acquire_asset", side_effect=download):
            self.service.start(self.user, {"choices": {"encoder": "__download__:qwen3vl_4b_fp8"}})
            self.assertTrue(entered.wait(2))
            self.service.control(self.user, "pause")
            release.set()
            self.assertEqual(self.wait_job()["status"], "paused")
        target = self.service._target(asset)
        self.assertEqual(target.with_name(target.name + ".part").read_bytes(), b"fix")
        def finish(selected, destination, report):
            self.assertEqual(selected["id"], "qwen3vl_4b_fp8")
            self.paths.add("text_encoders", asset["relative_path"])
            report(7, 7, "Verified")
        with mock.patch.object(SETUP, "acquire_asset", side_effect=finish):
            self.service.control(self.user, "resume")
            self.assertEqual(self.wait_job()["status"], "awaiting_validation")

    def test_validation_failure_does_not_complete_onboarding(self):
        self.add_assets()
        self.service.start(self.user, {"packs": ["create"]})
        job = self.wait_job()
        results = [{"path": w["path"], "role": w["role"], "error": "Missing image output"} for w in job["workflows"]]
        self.service.finish(self.user, job["id"], results)
        state = self.service.status(self.user)
        self.assertEqual(state["job"]["status"], "awaiting_validation")
        self.assertEqual(state["onboarding"], "new")
        with self.assertRaises(ValueError): self.service.finish(self.user, job["id"], [])

    def test_supplied_workflow_prompts_are_clean_in_both_widget_formats(self):
        for pack in self.catalog["packs"]:
            for node in SETUP.workflow_nodes(self.service.workflow_source(pack["id"])):
                if node["type"] in {"CLIPTextEncode", "Krea2EditGroundedEncode"}:
                    self.assertEqual(node["widgets_values"][0], "")
                    for key in ("text", "prompt", "system_prompt"):
                        self.assertFalse(node.get("widgets_values_named", {}).get(key))
                if node["type"] == "KCPP_PromptAmplify":
                    self.assertEqual(node["widgets_values"][0], "a picture of a landscape")
                    self.assertEqual(node["widgets_values_named"]["text"], "a picture of a landscape")


if __name__ == "__main__": unittest.main()
