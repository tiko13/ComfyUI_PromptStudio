import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image
from test_regressions import load_modules


class Tensor:
    def __init__(self, pixels):
        self.pixels = pixels
        self.shape = pixels.shape

    def cpu(self):
        return self

    def numpy(self):
        return self.pixels.astype(np.float32) / 255


class ImageOutputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.nodes, _ = load_modules(self.temp.name)
        self.saver = self.nodes.Save_as_webp_cond()
        self.pixels = np.array([[[20, 40, 60, 0], [80, 100, 120, 128], [140, 160, 180, 255]]], dtype=np.uint8)

    def save(self, **kwargs):
        batch = [Tensor(self.pixels)]
        result = self.saver.Save_as_webp_cond("lossy", 80, batch, kwargs.pop("save", "yes"), "nested/frame", **kwargs)
        self.assertIs(result["result"][0], batch)
        ref = result["ui"]["images"][0]
        return ref, Path(self.temp.name) / ref["subfolder"] / ref["filename"]

    def test_png_preserves_rgba_workflow_and_extra_fields(self):
        workflow = {"nodes": [{"id": 1}], "links": []}
        prompt = {"1": {"class_type": "Example", "inputs": {}}}
        for level, optimize in ((0, False), (9, False), (4, True)):
            with self.subTest(level=level, optimize=optimize):
                ref, path = self.save(format="png", png_compression=level, png_optimize=optimize,
                                      prompt=prompt, extra_pnginfo={"workflow": workflow, "other": {"text": "žltá"}})
                self.assertEqual(path.suffix, ".png")
                self.assertEqual(path.parent, Path(self.temp.name) / "nested" / str(self.nodes.date.today()))
                with Image.open(path) as image:
                    np.testing.assert_array_equal(np.asarray(image), self.pixels)
                    self.assertEqual(json.loads(image.info["workflow"]), workflow)
                    self.assertEqual(json.loads(image.info["prompt"]), prompt)
                    self.assertEqual(json.loads(image.info["other"]), {"text": "žltá"})

    def test_legacy_defaults_webp_and_workflow_is_not_concatenated(self):
        workflow = {"nodes": [], "links": []}
        ref, path = self.save(prompt={"one": 1}, extra_pnginfo={"workflow": workflow, "extra": {"two": 2}})
        self.assertEqual(path.suffix, ".webp")
        with Image.open(path) as image:
            self.assertEqual(json.loads(image.getexif()[0x010E][9:]), workflow)
            self.assertEqual(json.loads(image.getexif()[0x010F][7:]), {"one": 1})
        self.assertFalse(self.nodes.Save_as_webp_cond.INPUT_TYPES()["optional"]["force"][1]["default"])

    def test_png_preview_and_mixed_format_numbering(self):
        first, _ = self.save()
        second, _ = self.save(format="png")
        self.assertEqual(first["filename"], "frame_00001_.webp")
        self.assertEqual(second["filename"], "frame_00002_.png")
        ref, path = self.save(format="png", save="no", force=True)
        self.assertEqual(ref["type"], "temp")
        self.assertEqual(ref["subfolder"], "")
        self.assertEqual(path.parent, Path(self.temp.name))
        self.assertTrue(path.exists())

    def test_transparency_bundles_force_png(self):
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from backend.image_output_migration import force_transparent_png, is_transparency_workflow
        paths = [p for p in (Path(__file__).resolve().parents[1] / "setup" / "workflows").glob("*.json") if is_transparency_workflow(p.name)]
        self.assertEqual(len(paths), 9)
        for path in paths:
            data = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(force_transparent_png(data), data)
            for node in data["nodes"]:
                if node["type"] == "Save_as_webp_cond":
                    self.assertEqual(node["widgets_values"][4], "png")
                    self.assertIs(node["widgets_values"][8], True)


if __name__ == "__main__":
    unittest.main()
