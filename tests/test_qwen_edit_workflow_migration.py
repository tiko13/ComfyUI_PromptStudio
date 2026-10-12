import copy
import json
from pathlib import Path
import unittest

from backend.qwen_edit_workflow_migration import (
    is_qwen_edit_workflow, upgrade_qwen_edit_snapshot, upgrade_qwen_edit_workflow,
)

ROOT = Path(__file__).resolve().parents[1]


class QwenEditWorkflowTests(unittest.TestCase):
    def test_all_edit_bundles_keep_encoder_latent_and_lossless_output(self):
        paths = [p for p in (ROOT / "setup" / "workflows").glob("*.json") if is_qwen_edit_workflow(p.name)]
        self.assertGreaterEqual(len(paths), 9)
        for path in paths:
            with self.subTest(workflow=path.name):
                workflow = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(upgrade_qwen_edit_workflow(workflow), workflow)
                nodes = {n["id"]: n for n in workflow["nodes"]}
                encoder = next(n for n in nodes.values() if n["type"] == "TextEncodeQwenImage21")
                self.assertEqual(encoder["widgets_values"][2], 0)
                self.assertEqual(encoder["widgets_values_named"]["resolution"], 0)
                for node in nodes.values():
                    for socket in node.get("inputs", []):
                        if socket["name"] == "latent_image":
                            link = next(link for link in workflow["links"] if link[0] == socket["link"])
                            self.assertEqual(link[1:3], [encoder["id"], 2])
                    if node["type"] == "Save_as_webp_cond":
                        self.assertEqual(node["widgets_values"][1], "lossless")
                        self.assertEqual(node["widgets_values"][4], "png")
                        self.assertIs(node["widgets_values"][8], True)

    def test_migration_preserves_source_mask_sampler_and_unrelated_nodes(self):
        workflow = json.loads((ROOT / "setup" / "workflows" / "[PS] - QwenImage21 Edit base40.json").read_text(encoding="utf-8"))
        old = copy.deepcopy(workflow)
        for node in old["nodes"]:
            if node["type"] == "TextEncodeQwenImage21":
                node["widgets_values"][2] = 1056
                node["widgets_values_named"]["resolution"] = 1056
            elif node["type"] == "Save_as_webp_cond":
                node["widgets_values"][1] = "lossy"
                node["widgets_values"][4] = "webp"
                node["widgets_values"][8] = False
                node["widgets_values_named"].update(mode="lossy", format="webp", force=False)
        before = copy.deepcopy(old)
        self.assertEqual(upgrade_qwen_edit_workflow(old), workflow)
        self.assertEqual(old, before)
        self.assertEqual(upgrade_qwen_edit_workflow({"nodes": [], "links": []}), {"nodes": [], "links": []})

    def test_cached_execution_and_canvas_agree_without_mutating_history(self):
        snapshot = {"output": {
            "source": {"class_type": "KCPP_ChatImageInput", "inputs": {"image_ref": "original"}},
            "encoder": {"class_type": "TextEncodeQwenImage21", "inputs": {"resolution": 1056, "images.image_1": ["source", 0]}},
            "save": {"class_type": "Save_as_webp_cond", "inputs": {"mode": "lossy", "compression": 80, "filename_prefix": "custom"}},
            "sampler": {"class_type": "KCPP_PromptStudioSampler", "inputs": {"latent_image": ["encoder", 2], "seed": 123}},
        }}
        before = copy.deepcopy(snapshot)
        new = upgrade_qwen_edit_snapshot(snapshot)
        self.assertEqual(snapshot, before)
        self.assertEqual(new["output"]["encoder"]["inputs"]["resolution"], 0)
        self.assertEqual(new["output"]["save"]["inputs"], {"mode": "lossless", "format": "png", "force": True, "compression": 80, "filename_prefix": "custom"})
        self.assertEqual(new["output"]["sampler"], snapshot["output"]["sampler"])
        self.assertEqual(upgrade_qwen_edit_snapshot(new), new)
        snapshot["output"]["encoder"]["inputs"]["resolution"] = ["custom", 0]
        with self.assertRaises(ValueError):
            upgrade_qwen_edit_snapshot(snapshot)

    def test_create_bundles_are_unchanged(self):
        path = ROOT / "setup" / "workflows" / "[PS] - QwenImage21 Create base25.json"
        workflow = json.loads(path.read_text(encoding="utf-8"))
        self.assertFalse(is_qwen_edit_workflow(path.name))
        self.assertEqual(upgrade_qwen_edit_workflow(workflow), workflow)


if __name__ == "__main__":
    unittest.main()
