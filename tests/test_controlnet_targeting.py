"""CPU-only guide geometry; no models, preprocessing downloads or live queue."""
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

import torch
import qwen_edit

ROOT = Path(__file__).resolve().parents[1]
package = types.ModuleType("guide_geometry_test")
package.__path__ = [str(ROOT)]
spec = importlib.util.spec_from_file_location("guide_geometry_test.controlnet", ROOT / "controlnet.py")
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
