"""CPU-only guide geometry; no models, preprocessing downloads or live queue."""
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

import torch
from backend import qwen_edit
ROOT = Path(__file__).resolve().parents[1]
package = types.ModuleType("guide_geometry_test")
package.__path__ = [str(ROOT / "backend")]
spec = importlib.util.spec_from_file_location("guide_geometry_test.controlnet", ROOT / "backend" / "controlnet.py")
controlnet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controlnet)


class GuideGeometryTests(unittest.TestCase):
    def test_reference_crop_and_target_placement_preserve_canvas(self):
        utils = types.ModuleType("comfy.utils")
        utils.common_upscale = lambda pixels, w, h, *args: torch.nn.functional.interpolate(pixels, size=(h, w), mode="bilinear", align_corners=False)
        comfy = types.ModuleType("comfy")
        comfy.utils = utils
        image = torch.zeros((1, 20, 40, 3))
        image[:, :, :20] = 1
        regions = {"reference": dict(x=0, y=0, width=.5, height=1), "target": dict(x=.5, y=.25, width=.25, height=.5)}
        modules = {"guide_geometry_test": package, "guide_geometry_test.qwen_edit": qwen_edit,
                   "comfy": comfy, "comfy.utils": utils, "nodes": types.ModuleType("nodes"), "torch": torch}
        with patch.dict(sys.modules, modules):
            for kind, background in (("pose", 0), ("sketch", 1)):
                result = controlnet.QwenStructureGuide().prepare(image, kind, "prepared", "fit", 80, 40, json.dumps(regions))[0]
                self.assertEqual(tuple(result.shape), (1, 40, 80, 3))
                self.assertTrue(bool((result[:, 10:30, 40:60] == 1).all()))
                self.assertTrue(bool((result[:, :, :40] == background).all()))
            with self.assertRaises(ValueError):
                controlnet.QwenStructureGuide().prepare(image, "pose", "prepared", "fit", 80, 40, '{"reference":{"x":0,"y":0,"width":2,"height":1}}')

    def test_tiny_regions_stay_inside_pixel_bounds(self):
        self.assertEqual(controlnet.region_pixels(dict(x=.999, y=.999, width=.001, height=.001), 10, 10), (9, 9, 1, 1))

    def test_editable_extraction_returns_unframed_joints_and_exact_crop(self):
        utils = types.ModuleType("comfy.utils")
        utils.common_upscale = lambda pixels, w, h, *args: torch.nn.functional.interpolate(pixels, size=(h, w), mode="bilinear", align_corners=False)
        comfy = types.ModuleType("comfy")
        comfy.utils = utils
        nodes = types.ModuleType("nodes")
        data = [{"canvas_width": 10, "canvas_height": 20, "people": [{"pose_keypoints_2d": [5, 10, 1]}]}]
        class Detector:
            FUNCTION = "detect"
            def detect(self, image, **kwargs):
                self_shape = tuple(image.shape)
                assert self_shape == (1, 20, 10, 3)
                return {"result": (torch.ones_like(image), data)}
        nodes.NODE_CLASS_MAPPINGS = {"DWPreprocessor": Detector}
        modules = {"guide_geometry_test": package, "guide_geometry_test.qwen_edit": qwen_edit,
                   "comfy": comfy, "comfy.utils": utils, "nodes": nodes, "torch": torch}
        with patch.dict(sys.modules, modules), patch.object(controlnet, "capabilities", return_value={"methods": {"pose": {"ready": True}}}):
            result = controlnet.QwenStructureGuide().prepare(torch.ones(1, 20, 40, 3), "pose", "photo", "fit", 80, 40,
                json.dumps({"reference": dict(x=.25, y=0, width=.25, height=1)}), emit_pose=True)
            exported = json.loads(result["ui"]["pose_json"][0])
            self.assertEqual(exported["data"], data)
            self.assertEqual(exported["sourceRegion"], dict(x=.25, y=0, width=.25, height=1))
            self.assertEqual(tuple(result["result"][0].shape), (1, 40, 80, 3))
            with self.assertRaisesRegex(ValueError, "requires a pose photo"):
                controlnet.QwenStructureGuide().prepare(torch.ones(1, 20, 40, 3), "pose", "prepared", "fit", 80, 40, emit_pose=True)
