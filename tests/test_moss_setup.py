import copy
import hashlib
import tempfile
import unittest
from pathlib import Path
from test_setup_service import Paths, SETUP


class MossSetupTests(unittest.TestCase):
    def test_recipes_share_encoder_and_vae_without_optional_runtime_packages(self):
        catalog = SETUP.load_catalog()
        packs = [p for p in catalog["packs"] if p["family"] == "MOSS Image"]
        self.assertEqual(len(packs), 4)
        requirements = {r["id"]: r for r in catalog["requirements"]}
        assets = {a["id"]: a for a in catalog["assets"]}
        self.assertEqual(requirements["fibo2_vae"]["default_asset"], "flux2_vae")
        for pack in packs:
            self.assertIn("moss_encoder", pack["requirements"])
            self.assertIn("fibo2_vae", pack["requirements"])
            self.assertEqual(pack["nodes"], [])
            for name in pack["requirements"]:
                asset = assets[requirements[name]["default_asset"]]
                self.assertRegex(asset["sha256"], r"^[0-9a-f]{64}$")
                if name == "moss_snapshot":
                    self.assertEqual(asset["url"], "https://civitai.com/api/download/models/3417017?fileId=3310231")
                else:
                    self.assertRegex(asset["url"], r"/resolve/[0-9a-f]{40}/")
        dmd = next(p for p in packs if p["id"] == "kromoss_dmd2_create")
        self.assertNotIn("moss_destripe", dmd["requirements"])
        self.assertNotIn("moss_control", dmd["requirements"])
        realism = next(p for p in packs if p["id"] == "kromoss_realism_create")
        self.assertEqual(set(realism["requirements"]), set(dmd["requirements"]) | {"kromoss_dmd", "moss_snapshot"})
        for name in ("moss_destripe", "moss_control", "kromoss_dmd2", "kromoss_dmd", "moss_snapshot"):
            self.assertEqual(requirements[name]["binding"]["asset"], name)

    def test_setup_reports_outdated_named_map_schema_and_encoder_enum(self):
        catalog = copy.deepcopy(SETUP.load_catalog())
        for asset in catalog["assets"]:
            asset["size"] = 7
            asset["sha256"] = hashlib.sha256(b"fixture").hexdigest()
        class OldStructure:
            @classmethod
            def INPUT_TYPES(cls): return {"required": {"width": ("INT",), "height": ("INT",)}}
        class OldClip:
            @classmethod
            def INPUT_TYPES(cls): return {"required": {"type": (["flux", "qwen_image"],)}}
        with tempfile.TemporaryDirectory() as directory:
            paths = Paths(Path(directory) / "models")
            service = SETUP.SetupService(paths, {}, catalog=catalog)
            flow = service.workflow_source("moss_sft_controlled")
            service.nodes.update({n["type"]: object() for n in SETUP.workflow_nodes(flow)})
            service.nodes.update(PS_StructureInput=OldStructure, CLIPLoader=OldClip)
            for asset in catalog["assets"]: paths.add(asset["category"], asset["relative_path"])
            plan = service.plan(Path(directory) / "user", {"packs": ["moss_sft_controlled"]})
            self.assertTrue(any("control_key" in error for error in plan["blockers"]))
            self.assertTrue(any("guide_types" in error for error in plan["blockers"]))
            self.assertTrue(any("moss_image" in error for error in plan["blockers"]))
