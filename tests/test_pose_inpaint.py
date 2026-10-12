import base64
import copy
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import torch
from PIL import Image
from backend.pose_inpaint_migration import is_pose_edit_workflow, upgrade_pose_workflow, upgrade_pose_snapshot

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "pose_inpaint_test"
package = types.ModuleType(PACKAGE)
package.__path__ = [str(ROOT / "backend")]
spec = importlib.util.spec_from_file_location(PACKAGE + ".reference_nodes", ROOT / "backend" / "reference_nodes.py")
nodes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nodes)
spec = importlib.util.spec_from_file_location(PACKAGE + ".pose_inpaint", ROOT / "backend" / "pose_inpaint.py")
pose_inpaint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pose_inpaint)


class PoseInpaintTests(unittest.TestCase):
    def setUp(self):
        # Other suites install a lightweight torch stub; these exercise real tensors.
        self.enterContext(patch.dict(sys.modules, {"torch": torch}))

    def test_png_is_exact_and_rejects_changed_source_dimensions_and_empty_masks(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "source.png", Path(directory) / "mask.png"
            Image.new("RGB", (8, 6), "red").save(source)
            info = pose_inpaint.source_info(source)
            def encoded(image):
                stream = io.BytesIO(); image.save(stream, format="PNG")
                return "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode()
            mask = Image.new("L", (8, 6)); mask.putpixel((2, 3), 255)
            pose_inpaint.save_painted_mask(source, encoded(mask), info["source_digest"], output)
            with Image.open(output) as saved:
                self.assertEqual(saved.tobytes(), mask.tobytes())
            for invalid in (Image.new("L", (8, 6)), Image.new("L", (8, 6), 255), Image.new("L", (4, 6))):
                with self.assertRaises(ValueError):
                    pose_inpaint.save_painted_mask(source, encoded(invalid), info["source_digest"], output)
            Image.new("RGB", (8, 6), "blue").save(source)
            with self.assertRaisesRegex(ValueError, "source changed"):
                pose_inpaint.save_painted_mask(source, encoded(mask), info["source_digest"], output)

    def test_composite_preserves_exact_pixels_and_uses_white_for_regeneration(self):
        source = torch.rand(1, 6, 8, 3)
        generated = torch.ones(2, 3, 4, 4)
        generated[..., 3] = 0  # RGBA decoder alpha must not erase the retained scene.
        mask = torch.zeros(1, 6, 8); mask[:, 2:4, 3:5] = 1
        result = pose_inpaint.composite(generated, source, mask)
        self.assertEqual(tuple(result.shape), (2, 6, 8, 3))
        self.assertTrue(torch.equal(result[:, mask[0] == 0], source.expand(2, -1, -1, -1)[:, mask[0] == 0]))
        self.assertTrue(bool((result[:, 2:4, 3:5] == 1).all()))
        with self.assertRaisesRegex(ValueError, "dimensions"):
            pose_inpaint.composite(generated, source, torch.zeros(1, 4, 4))

    def test_structure_outputs_same_mask_for_control_and_composite_and_off_bypasses(self):
        source, guide, mask = torch.rand(1, 6, 8, 3), torch.zeros(1, 6, 8, 3), torch.ones(1, 6, 8)
        source_module = types.SimpleNamespace(KCPP_ChatImageInput=lambda: types.SimpleNamespace(load_image=lambda _: (guide,)), _parse_chat_image_reference=lambda _: None)
        control = types.SimpleNamespace(QwenStructureGuide=lambda: types.SimpleNamespace(prepare=lambda *a: (guide,)))
        modules = {PACKAGE: package, PACKAGE + ".nodes": source_module, PACKAGE + ".controlnet": control,
                   PACKAGE + ".pose_inpaint": pose_inpaint}
        entry = {"image": {"filename": "pose.png"}, "guide": {"type": "pose", "strength": .8}}
        with patch.dict(sys.modules, modules):
            with self.assertRaisesRegex(ValueError, "enabled edit mask"):
                nodes.StructureInput().prepare(8, 6, json.dumps(entry), source)
            result = nodes.StructureInput().prepare(8, 6, json.dumps(entry), source, edit_mask=mask)
            self.assertIs(result[2], source); self.assertIs(result[3], mask)
            for change in ({"preserve_background": False}, {"strength": 0}, {"type": "edges"}):
                changed = {**entry, "guide": {**entry["guide"], **change}}
                result = nodes.StructureInput().prepare(8, 6, json.dumps(changed), source)
                self.assertIsNone(result[2]); self.assertIsNone(result[3])
            self.assertIsNone(nodes.StructureInput().prepare(8, 6, json.dumps(entry))[2])

    def test_apply_passes_native_mask_and_source_without_changing_guide(self):
        captured = {}
        class Loader:
            FUNCTION = "load"
            def load(self, name): return ("patch",)
        class Apply:
            FUNCTION = "apply"
            def apply(self, **kwargs): captured.update(kwargs); return (kwargs["model"],)
        modules = {"folder_paths": types.SimpleNamespace(get_filename_list=lambda _: ["union"]),
                   "nodes": types.SimpleNamespace(NODE_CLASS_MAPPINGS={"ModelPatchLoader": Loader, "ZImageFunControlnet": Apply})}
        with patch.dict(sys.modules, modules):
            nodes.ApplyQwenStructure().apply("model", "vae", "guide", .8, "union", "source", "mask")
            self.assertEqual(captured, dict(model="model", vae="vae", image="guide", strength=.8, model_patch="patch", inpaint_image="source", mask="mask"))
            captured.clear()
            nodes.ApplyQwenStructure().apply("model", "vae", "guide", .8, "union")
            self.assertNotIn("mask", captured)
            with self.assertRaisesRegex(ValueError, "both"):
                nodes.ApplyQwenStructure().apply("model", "vae", "guide", .8, "union", "source")

    def test_reviewed_mask_checks_file_digest_and_actual_connected_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (8, 6), "red").save(root / "source.png")
            Image.new("L", (8, 6), 127).save(root / "mask.png")
            source = torch.zeros(1, 6, 8, 3); source[..., 0] = 1
            record = dict(enabled=True, sourceImage={"filename": "source.png"}, image={"filename": "mask.png"},
                          sourceDigest=pose_inpaint.source_info(root / "source.png")["source_digest"])
            module = types.SimpleNamespace(_parse_chat_image_reference=lambda value: (None, root / json.loads(value)["filename"]),
                KCPP_ChatImageInput=lambda: types.SimpleNamespace(load_image=lambda _: (source,)))
            with patch.dict(sys.modules, {PACKAGE: package, PACKAGE + ".nodes": module}):
                mask = pose_inpaint.reviewed_mask(record, source)
                self.assertEqual(tuple(mask.shape), (1, 6, 8))
                self.assertAlmostEqual(float(mask[0, 0, 0]), 127 / 255)
                with self.assertRaisesRegex(ValueError, "another source"):
                    pose_inpaint.reviewed_mask(record, torch.ones_like(source))
                Image.new("RGB", (8, 6), "blue").save(root / "source.png")
                with self.assertRaisesRegex(ValueError, "source changed"):
                    pose_inpaint.reviewed_mask(record, source)


class PoseMigrationTests(unittest.TestCase):
    def test_six_bundles_have_both_native_inpainting_and_composite_wires(self):
        paths = [p for p in (ROOT / "setup" / "workflows").glob("*.json") if is_pose_edit_workflow(p.name)]
        self.assertEqual(len(paths), 6)
        for path in paths:
            workflow = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(upgrade_pose_workflow(workflow), workflow)
            nodes_by_type = {n["type"]: n for n in workflow["nodes"]}
            guide = nodes_by_type["PS_StructureInput"]
            for kind, name, slot in (("PS_ApplyQwenStructure", "inpaint_image", 2), ("PS_ApplyQwenStructure", "inpaint_mask", 3), ("PS_EditMask", "inpaint_mask", 3)):
                node = nodes_by_type[kind]; socket = next(i for i in node["inputs"] if i["name"] == name)
                wire = next(l for l in workflow["links"] if l[0] == socket["link"])
                self.assertEqual(wire[1:3], [guide["id"], slot])
            self.assertTrue(guide["widgets_values_named"]["preserve_background"])
        self.assertFalse(is_pose_edit_workflow("[PS] - QwenImage21 Background Removal base40.json"))

    def test_snapshot_migration_is_idempotent_preserves_inputs_and_refuses_conflicts(self):
        output = {str(i): {"class_type": kind, "inputs": {}} for i, kind in enumerate(("KCPP_ChatImageInput", "PS_StructureInput", "PS_ApplyQwenStructure", "PS_EditMask"))}
        output["sampler"] = {"class_type": "Sampler", "inputs": {"seed": 123, "steps": 40}}
        old = {"output": output}; before = copy.deepcopy(old)
        new = upgrade_pose_snapshot(old)
        self.assertEqual(old, before); self.assertEqual(upgrade_pose_snapshot(new), new)
        self.assertEqual(new["output"]["sampler"], old["output"]["sampler"])
        self.assertEqual(new["output"]["2"]["inputs"]["inpaint_mask"], ["1", 3])
        old["output"]["2"]["inputs"]["inpaint_mask"] = ["custom", 0]
        with self.assertRaisesRegex(ValueError, "manual review"):
            upgrade_pose_snapshot(old)


if __name__ == "__main__":
    unittest.main()
