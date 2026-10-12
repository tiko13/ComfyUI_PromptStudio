import json
import tempfile
import unittest
from unittest import mock

from backend import qwen_edit
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

    def test_edited_pose_and_appearance_use_separate_analysis_images(self):
        payload = self.payload(1)
        edited = {"filename": "edited-pose.png"}
        payload["references"][0].update(use="both", guide={"type": "pose", "input": "prepared"}, pose={"image": edited})
        images, context = qwen_edit.request_context(payload)
        self.assertEqual(images, [payload["source_image"], payload["references"][0]["image"], edited])
        self.assertEqual(context["execution_image_count"], 2)
        self.assertEqual(context["structure_guides"][0]["analysis_image_position"], 3)
        payload = self.payload(9)
        payload["references"][0].update(use="both", guide={"type": "pose", "input": "prepared"}, pose={"image": edited})
        images, context = qwen_edit.request_context(payload)
        self.assertEqual(len(images), 11)
        self.assertEqual(context["execution_image_count"], 10)
        with mock.patch.object(self.routes, "_chat_image_vision_payload", return_value=("base64", "data:image/png;base64,test")):
            messages = self.routes._consult_provider_messages({"messages": [{"role": "user", "text": "Edit", "images": images}]}, "llamacpp", qwen_edit.SYSTEM)
            self.assertEqual(len(messages[1]["content"]), 12)

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

    def test_edited_legs_reach_prompt_builder_as_geometry_not_just_pixels(self):
        # Same failure shape as the reported session: arms out, both legs moved
        # down-left, while the original stance had knees/ankles down-right.
        original = [0, 0, 0] * 18
        for i, x, y in ((2, 1000, 350), (3, 800, 380), (4, 600, 390),
                        (8, 1058, 756), (9, 1105, 1048), (10, 1150, 1344),
                        (11, 1187, 756), (12, 1230, 1053), (13, 1357, 1344)):
            original[i*3:i*3+3] = [x, y, 1]
        edited = original.copy()
        for i, x, y in ((9, 872, 981), (10, 663, 1126), (12, 1044, 994), (13, 847, 1139)):
            edited[i*3:i*3+3] = [x, y, 1]
        data = lambda points: {"canvas_width": 2728, "canvas_height": 1536,
                               "people": [{"pose_keypoints_2d": points}]}
        payload = self.payload(1)
        payload["user_text"] = ""
        payload["references"][0].update(use="structure", role="custom", guide={"type": "pose", "input": "prepared"},
            pose={"image": {"filename": "edited.png"}, "data": data(edited), "original": data(original)})
        prompt = "Move both legs diagonally toward the left of the image, following the pose guide."
        with mock.patch.object(self.routes, "_consult", return_value=json.dumps({"prompt": prompt, "clarification": ""})) as generate:
            self.assertEqual(self.routes._build_qwen_edit_prompt(payload), prompt)
        context = json.loads(generate.call_args.args[0]["messages"][0]["text"])
        person = context["structure_guides"][0]["edited_pose"]["people"][0]
        self.assertEqual(person["changed_joints"], ["right knee", "right ankle", "left knee", "left ankle"])
        self.assertNotIn("left arm", [limb["limb"] for limb in person["limbs"]])  # Missing points stay missing.
        self.assertFalse(person["limbs"][0]["changed"])
        for limb in person["limbs"][1:]:
            self.assertTrue(limb["changed"])
            self.assertTrue(all(segment.endswith("down and image-left") for segment in limb["segments"]))
        self.assertEqual(context["execution_image_count"], 1)
        self.assertEqual(person["joints"]["right ankle"], [round(663/2728, 4), round(1126/1536, 4)])
        payload["references"][0]["guide"]["strength"] = 0
        payload["user_text"] = "Change the background"
        _, context = qwen_edit.request_context(payload)
        self.assertNotIn("edited_pose", context["structure_guides"][0])

    def test_shallow_leg_spread_is_not_rounded_to_straight_down(self):
        # Reported 2048px pose: the old nearest-45-degree bins called every
        # leg segment "down", prompting the model to keep the legs together.
        points = [0, 0, 0] * 18
        for i, x, y in ((8, 897, 1016), (9, 756, 1473), (10, 618, 1899),
                        (11, 1116, 1006), (12, 1302, 1515), (13, 1451, 1916)):
            points[i*3:i*3+3] = [x, y, 1]
        data = {"canvas_width": 2048, "canvas_height": 2048,
                "people": [{"pose_keypoints_2d": points}]}
        person = qwen_edit.edited_pose_context({"data": data})["people"][0]
        right, left = person["limbs"]
        self.assertTrue(all(s.endswith("down and image-left") for s in right["segments"]))
        self.assertTrue(all(s.endswith("down and image-right") for s in left["segments"]))

    def test_pose_directions_ignore_jitter_and_use_pixel_not_normalized_angles(self):
        for endpoint, direction in (((105, 500), "down"), ((105, 0), "up"),
                                    ((500, 105), "image-right"), ((0, 105), "image-left"),
                                    ((150, 500), "down and image-right")):
            points = [0, 0, 0] * 18
            points[8*3:8*3+3] = [100, 100, 1]
            points[9*3:9*3+3] = [*endpoint, 1]
            data = {"canvas_width": 4096, "canvas_height": 512,
                    "people": [{"pose_keypoints_2d": points}]}
            with self.subTest(endpoint=endpoint):
                limb = qwen_edit.edited_pose_context({"data": data})["people"][0]["limbs"][0]
                self.assertEqual(limb["segments"], ["right hip to right knee extends " + direction])

    def test_edited_pose_geometry_rejects_invalid_values(self):
        for data in ({"canvas_width": 0, "canvas_height": 1024, "people": []},
                     {"canvas_width": 768, "canvas_height": 1024, "people": [{"pose_keypoints_2d": [float("nan"), 0, 1]*18}]},
                     {"canvas_width": 768, "canvas_height": 1024, "people": [{"pose_keypoints_2d": [900, 0, 1]*18}]}):
            with self.subTest(data=data), self.assertRaises(ValueError):
                qwen_edit.edited_pose_context({"data": data})

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
