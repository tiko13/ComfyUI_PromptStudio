import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend import qwen_edit
from backend import reference_nodes
from backend.reference_workflow_migration import upgrade_reference_workflow
from test_regressions import load_modules


class ReferenceNodeTests(unittest.TestCase):
    def test_collection_capacity_and_optional_items(self):
        refs = [{"image": {"filename": f"{i}.png"}} for i in range(16)]
        self.assertEqual(reference_nodes.ReferenceCollection().collect(0, 16, "texture", json.dumps(refs))[0], refs)
        with self.assertRaises(ValueError):
            reference_nodes.ReferenceCollection().collect(0, 2, "texture", json.dumps(refs))
        with self.assertRaises(ValueError):
            reference_nodes.ReferenceCollection().collect(2, 16, "texture", "[]")
        self.assertEqual(reference_nodes.ReferenceItem().load([], 1), (None, None))
        self.assertEqual(reference_nodes.StructureInput().prepare(512, 512), (None, 0.0, None, None))
        model, image = object(), object()
        self.assertIs(reference_nodes.ApplyQwenStructure().apply(model, None, None, 0, "not-installed")[0], model)
        self.assertIs(reference_nodes.EditMask().composite(image, None)[0], image)

    def test_settings_are_canvas_passthrough(self):
        value = reference_nodes.ReferencePrompt().configure("literal prompt", "edit_instruction", "R{index}", 0, "canvas", "guidance")
        self.assertEqual(value, ("literal prompt",))

    def test_workflow_contract_formats_custom_tokens_and_bounds(self):
        contract = {"limit": 16, "minimum": 0, "firstImage": 0, "token": "[ref-{index}]", "sourceToken": "[canvas]", "roles": {"texture": "texture"}}
        payload = {"model": "workflow", "reference_contract": contract, "user_text": "Apply materials.", "source_image": {"filename": "base.png"},
                   "references": [{"image": {"filename": f"{i}.png"}, "role": "texture"} for i in range(16)]}
        images, context = qwen_edit.request_context(payload)
        self.assertEqual(len(images), 17)
        self.assertEqual(context["execution_image_count"], 17)
        self.assertEqual(qwen_edit.format_reference_prompt("Edit <image1> with <image17>.", 17, qwen_edit.reference_contract(payload)), "Edit [canvas] with [ref-15].")
        for patch in ({"limit": 2}, {"token": "missing-index"}, {"firstImage": -1}, {"roles": {}}, {"limit": 65}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                qwen_edit.request_context({**payload, "reference_contract": {**contract, **patch}})

    def test_sixteen_image_analysis_does_not_raise_public_consult_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            _, routes = load_modules(directory)
            payload = {"model": "workflow", "reference_contract": {"limit": 16, "roles": {"texture": "texture"}},
                       "source_image": {"filename": "base.png"}, "user_text": "Use textures",
                       "references": [{"image": {"filename": f"{i}.png"}, "role": "texture"} for i in range(16)]}
            prompt = "Edit <image1> using " + ", ".join(f"<image{i}>" for i in range(2, 18)) + "."
            with mock.patch.object(routes, "_consult", return_value=json.dumps({"prompt": prompt, "clarification": ""})) as consult:
                self.assertEqual(routes._build_qwen_edit_prompt(payload), prompt)
            request, system = consult.call_args.args[:2]
            with mock.patch.object(routes, "_chat_image_vision_payload", return_value=("base64", "data:image/png;base64,test")):
                self.assertEqual(len(routes._consult_provider_messages(request, "llamacpp", system)[1]["content"]), 18)
                with self.assertRaisesRegex(ValueError, "at most 4"):
                    routes._consult_provider_messages(request, "llamacpp")

    def test_required_named_reference_is_enforced_on_canvas(self):
        with tempfile.TemporaryDirectory() as directory:
            nodes, _ = load_modules(directory)
            node = nodes.KCPP_ChatImageReference()
            self.assertEqual(node.load_image(""), (None, None))
            with self.assertRaisesRegex(ValueError, "Identity is required"):
                node.load_image("", "Identity", required=True)
            self.assertEqual(node.VALIDATE_INPUTS("", "Identity", required=True), "Identity is required")


def legacy_workflow():
    nodes = [
        dict(id=1, type="KCPP_PromptSlot", inputs=[], outputs=[{"links": [1]}, {"links": []}, {"links": []}, {"links": []}]),
        dict(id=2, type="TextEncodeQwenImage21", inputs=[dict(name="prompt", link=1)], outputs=[]),
        dict(id=3, type="VAELoader", inputs=[], outputs=[{"links": [2]}]),
        dict(id=4, type="VAEDecode", inputs=[dict(name="vae", link=2)], outputs=[{"links": []}]),
        dict(id=5, type="CustomModelLoader", inputs=[], outputs=[{"links": [3]}], widgets_values=["my-model.safetensors"]),
        dict(id=6, type="KCPP_PromptStudioSampler", inputs=[dict(name="model", link=3)], outputs=[]),
    ]
    return dict(nodes=nodes, links=[[1, 1, 0, 2, 0, "STRING"], [2, 3, 0, 4, 0, "VAE"], [3, 5, 0, 6, 0, "MODEL"]])


class ReferenceMigrationTests(unittest.TestCase):
    def test_migration_is_idempotent_preserves_models_and_refuses_prewired_donors(self):
        source = legacy_workflow(); before = copy.deepcopy(source)
        migrated = upgrade_reference_workflow(source)
        self.assertEqual(source, before)
        self.assertEqual(upgrade_reference_workflow(migrated), migrated)
        self.assertEqual(next(n for n in migrated["nodes"] if n["id"] == 5)["widgets_values"], ["my-model.safetensors"])
        self.assertEqual(sum(n["type"] == "PS_ReferenceItem" for n in migrated["nodes"]), 10)
        source["nodes"][1]["inputs"].append(dict(name="images.image_2", link=9))
        self.assertEqual(upgrade_reference_workflow(source), source)

    def test_setup_upgrades_only_equivalent_old_bundle_and_keeps_backup(self):
        from backend.setup_service import SetupService
        service = SetupService(None, {})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); path = root / "workflows" / "[PS] Old.json"
            path.parent.mkdir(); old = legacy_workflow(); path.write_text(json.dumps(old), encoding="utf-8")
            pack = {"file": path.name, "role": "create", "id": "test", "name": "test"}
            migrated = upgrade_reference_workflow(old)
            result = service._install_workflow(root, pack, migrated)
            self.assertEqual(json.loads(path.read_text()), migrated)
            self.assertEqual(json.loads(path.with_name(path.name + ".pre-reference-nodes.bak").read_text()), old)
            # A custom model edit must not be overwritten by a later bundle.
            custom = copy.deepcopy(migrated); custom["nodes"][4]["widgets_values"] = ["another-model.safetensors"]
            path.write_text(json.dumps(custom), encoding="utf-8")
            service._install_workflow(root, pack, migrated)
            self.assertEqual(json.loads(path.read_text()), custom)
            self.assertTrue((path.parent / "[PS] Old (Setup 1).json").exists())
