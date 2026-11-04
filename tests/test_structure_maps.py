import unittest
import sys
import json
from types import SimpleNamespace
from unittest import mock
import torch
import torch.nn.functional as functional
from backend.structure_maps import prepare_map, validate_slot
from backend.reference_nodes import StructureInput


class StructureMapTests(unittest.TestCase):
    def setUp(self):
        # Legacy node tests replace sys.modules with lightweight runtime stubs.
        # Scope real tensor modules to this test and restore the previous state.
        modules = mock.patch.dict(sys.modules, {"torch": torch, "torch.nn": torch.nn, "torch.nn.functional": functional})
        modules.start()
        self.addCleanup(modules.stop)

    def test_color_resize_never_creates_region_colors(self):
        image = torch.zeros(1, 8, 16, 3)
        image[:, :, :8, 0] = 1
        image[:, :, 8:, 1] = 1
        for mode in ("fit", "crop", "stretch"):
            result = prepare_map(image, "color", 32, 48, mode)
            self.assertEqual(tuple(result.shape), (1, 48, 32, 3))
            self.assertTrue(all(tuple(p.tolist()) in {(1., 0., 0.), (0., 1., 0.), (0., 0., 0.)}
                                for p in torch.unique(result.reshape(-1, 3), dim=0)))

    def test_depth_interpolates_and_inverts_before_padding(self):
        image = torch.zeros(1, 2, 2, 3)
        image[:, :, 1] = 1
        depth = prepare_map(image, "depth", 16, 32)
        inverted = prepare_map(image, "depth", 16, 32, invert=True)
        self.assertTrue(bool(((depth > 0) & (depth < 1)).any()))
        self.assertTrue(torch.allclose(depth[:, 8:24] + inverted[:, 8:24], torch.ones(1, 16, 16, 3)))
        self.assertEqual(float(inverted[:, :8].sum()), 0.)

    def test_invalid_inputs_fail_and_named_empty_slots_remain_optional(self):
        image = torch.ones(1, 4, 4, 3)
        for args in [("color", 0, 16), ("unknown", 16, 16)]:
            with self.assertRaises(ValueError): prepare_map(image, *args)
        image[:, 0, 0] = float("nan")
        with self.assertRaises(ValueError): prepare_map(image, "depth", 16, 16)
        for key in ("Bad", "a/b", "with space"):
            with self.assertRaises(ValueError): validate_slot(key, "depth")
        self.assertEqual(StructureInput().prepare(1024, 1024, control_key="depth", guide_types="depth"), (None, 0., None, None))

    def test_existing_widget_positions_remain_compatible(self):
        schema = StructureInput.INPUT_TYPES()
        widgets = [name for group in ("required", "optional") for name, spec in schema[group].items()
                   if spec[0] in ("INT", "STRING", "BOOLEAN")]
        self.assertEqual(widgets[:4], ["width", "height", "reference_json", "preserve_background"])
        self.assertEqual(widgets[4:], ["control_key", "guide_types"])

    def test_named_slots_use_the_shared_image_loader_and_optional_depth_extractor(self):
        image = torch.ones(1, 16, 32, 3)
        loader = mock.Mock()
        loader.return_value.load_image.return_value = (image, None)
        with mock.patch.dict(sys.modules, {"backend.nodes": SimpleNamespace(KCPP_ChatImageInput=loader)}):
            entry = {"image": {"filename": "guide.png"}, "guide": {"type": "color", "input": "prepared", "fit": "crop"}}
            output = StructureInput().prepare(32, 32, json.dumps(entry), control_key="regions", guide_types="color")
            self.assertEqual(tuple(output[0].shape), (1, 32, 32, 3))
            self.assertEqual(json.loads(loader.return_value.load_image.call_args.args[0]), entry["image"])
            entry["guide"]["input"] = "photo"
            with self.assertRaisesRegex(ValueError, "prepared map"):
                StructureInput().prepare(32, 32, json.dumps(entry), control_key="regions", guide_types="color")
            entry["guide"]["type"] = "depth"
            with mock.patch("backend.controlnet.QwenStructureGuide.prepare", return_value=(image,)) as extract:
                result = StructureInput().prepare(32, 32, json.dumps(entry), control_key="depth", guide_types="depth")
                self.assertEqual(tuple(result[0].shape), (1, 32, 32, 3))
                self.assertEqual(extract.call_args.args[1:], ("depth", "photo", "fit", 32, 16))
