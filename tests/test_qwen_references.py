import json
import tempfile
import unittest
from unittest import mock

import qwen_edit
from test_regressions import load_modules


class QwenReferenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.nodes, self.routes = load_modules(self.temp.name)

    def payload(self, count=9):
        return {"model": "qwen_image_2_1", "user_text": "Use these garments",
                "source_image": {"filename": "base.png"},
                "references": [{"image": {"filename": f"ref-{i}.png"}, "role": "clothing", "instruction": ""} for i in range(count)]}

    def test_ten_images_ordered_and_tags_checked_with_retry(self):
        prompt = "Edit <image1> using " + ", ".join(f"clothing from <image{i}>" for i in range(2, 11)) + "."
        with mock.patch.object(self.routes, "_consult", side_effect=[
            json.dumps({"prompt": "Use <image2> on <image1>.", "clarification": ""}),
            json.dumps({"prompt": prompt, "clarification": ""}),
        ]) as generate:
            self.assertEqual(self.routes._build_qwen_edit_prompt(self.payload()), prompt)
        self.assertEqual(generate.call_count, 2)
        messages = generate.call_args.args[0]["messages"]
        self.assertEqual([image["filename"] for image in messages[0]["images"]], ["base.png"] + [f"ref-{i}.png" for i in range(9)])
        with mock.patch.object(self.routes, "_chat_image_vision_payload", return_value=("base64", "data:image/png;base64,test")):
            for system in [qwen_edit.SYSTEM, generate.call_args.args[1]]:
                self.assertEqual(len(self.routes._consult_provider_messages({"messages": messages}, "llamacpp", system)[1]["content"]), 11)
            with self.assertRaisesRegex(ValueError, "at most 4"):
                self.routes._consult_provider_messages({"messages": messages}, "llamacpp")

    def test_invalid_input_is_rejected_before_llm_call(self):
        cases = [self.payload(10), {**self.payload(), "model": "other"},
                 {**self.payload(), "source_image": None},
                 {**self.payload(), "references": [{"image": {"filename": "x.png"}, "role": "custom", "instruction": ""}]}]
        with mock.patch.object(self.routes, "_consult") as generate:
            for payload in cases:
                with self.subTest(payload=payload), self.assertRaises(ValueError):
                    self.routes._build_qwen_edit_prompt(payload)
            generate.assert_not_called()

    def test_role_only_reference_needs_no_extra_text(self):
        payload = {**self.payload(1), "user_text": "", "request_timeout": 600}
        prompt = "Apply the clothing from <image2> to the subject in <image1>. Preserve everything else."
        with mock.patch.object(self.routes, "_consult", return_value=json.dumps({"prompt": prompt, "clarification": ""})) as generate:
            self.assertEqual(self.routes._build_qwen_edit_prompt(payload), prompt)
        context = json.loads(generate.call_args.args[0]["messages"][0]["text"])
        self.assertEqual(context["user_request"], "")
        self.assertEqual(context["references"][0]["role"], "clothing")
        self.assertEqual(context["references"][0]["instruction"], "")
        with self.assertRaisesRegex(ValueError, "Describe the requested edit"):
            qwen_edit.request_context({**payload, "references": []})

    def test_vision_probe_accepts_generation_timeout_and_caps_probe(self):
        for provider in ("koboldcpp", "ollama", "llamacpp"):
            for timeout, expected in ((None, 10), (5, 5), (60, 60), (120, 60), (600, 60)):
                with self.subTest(provider=provider, timeout=timeout), mock.patch.object(
                    self.routes, "_llm_vision_capability", return_value={"available": True}
                ) as probe:
                    self.assertTrue(self.routes._vision_capability({"llm_provider": provider, "request_timeout": timeout})["available"])
                    self.assertEqual(probe.call_args.kwargs["request_timeout"], expected)
        for timeout in (4, 601, "invalid"):
            with self.subTest(timeout=timeout), mock.patch.object(self.routes, "_llm_vision_capability") as probe:
                with self.assertRaises(ValueError):
                    self.routes._vision_capability({"request_timeout": timeout})
                probe.assert_not_called()

    def test_clarification_and_single_image_tag_policy(self):
        with mock.patch.object(self.routes, "_consult", return_value=json.dumps({"prompt": "", "clarification": "Which jacket?"})):
            with self.assertRaisesRegex(ValueError, "Which jacket"):
                self.routes._build_qwen_edit_prompt(self.payload(1))
        qwen_edit.validate_result({"prompt": "Recolor the jacket in the image.", "clarification": ""}, 1)
        with self.assertRaises(ValueError):
            qwen_edit.validate_result({"prompt": "Recolor <image1>.", "clarification": ""}, 1)

    def test_structure_only_is_analysis_context_without_execution_tag(self):
        for kind in ("pose", "depth", "edges", "sketch"):
            payload = self.payload(1)
            payload["user_text"] = ""
            payload["references"][0].update(use="structure", role="custom", guide={"type": kind, "strength": .8})
            prompt = f"Follow the supplied {kind} guide while preserving the subject in the image."
            with mock.patch(self.routes.__package__+".reference_detection.pose_mapping_clarification",return_value=None), mock.patch.object(self.routes, "_consult", return_value=json.dumps({"prompt": prompt, "clarification": ""})) as generate:
                self.assertEqual(self.routes._build_qwen_edit_prompt(payload), prompt)
            message = generate.call_args.args[0]["messages"][0]
            context = json.loads(message["text"])
            self.assertEqual(len(message["images"]), 2)
            self.assertEqual(context["execution_image_count"], 1)
            self.assertEqual(context["references"], [])
            self.assertEqual(context["structure_guides"][0]["analysis_image_position"], 2)
            self.assertEqual(context["structure_guides"][0]["guide"]["type"], kind)

    def test_detected_ambiguity_prevents_llm_from_inventing_recipient(self):
        with mock.patch(self.routes.__package__+".reference_detection.pose_mapping_clarification",return_value="Select the recipient"),mock.patch.object(self.routes,"_consult") as generate:
            with self.assertRaisesRegex(ValueError,"Select the recipient"):
                self.routes._build_qwen_edit_prompt(self.payload(1))
            generate.assert_not_called()

    def test_mixed_references_keep_execution_numbering_and_targeting(self):
        payload = self.payload(2)
        region = dict(x=.1, y=.2, width=.3, height=.4)
        payload["references"][0].update(use="structure", guide={"type": "pose", "strength": .6}, targeting={"reference": region, "target": region})
        payload["references"][1]["instruction"] = "Use the left person's jacket for the dark-haired person"
        images, context = qwen_edit.request_context(payload)
        self.assertEqual([i["filename"] for i in images], ["base.png", "ref-1.png", "ref-0.png"])
        self.assertEqual(context["execution_image_count"], 2)
        self.assertEqual(context["references"][0]["image"], "<image2>")
        self.assertEqual(context["structure_guides"][0]["targeting"]["target"], region)
        payload["references"][0]["use"] = "both"
        images, context = qwen_edit.request_context(payload)
        self.assertEqual(len(images), 3)
        self.assertEqual(context["execution_image_count"], 3)
        self.assertEqual(context["structure_guides"][0]["analysis_image_position"], 2)

    def test_inactive_guide_and_invalid_targeting_fail_before_llm(self):
        payload = self.payload(1)
        payload["user_text"] = ""
        payload["references"][0].update(use="structure", guide={"type": "pose", "strength": 0})
        with self.assertRaisesRegex(ValueError, "Describe"):
            qwen_edit.request_context(payload)
        payload["user_text"] = "Make the jacket red"
        images, context = qwen_edit.request_context(payload)
        self.assertEqual(len(images), 1)
        self.assertFalse(context["structure_guides"][0]["active"])
        for region in (dict(x=0, y=0, width=2, height=1), dict(x=0, y=0, width=float("nan"), height=1)):
            payload["references"][0]["targeting"] = {"target": region}
            with self.assertRaises(ValueError):
                qwen_edit.request_context(payload)
