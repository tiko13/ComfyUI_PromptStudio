import json
import tempfile
import unittest
from unittest import mock

import edit_grounding as grounding
from test_regressions import load_modules


GROUNDING = {
    "observations": "The requested dress is green, sleeveless, with a square neckline and a satin-like sheen.",
    "resolved_instruction": "Replace the woman's dress with a green sleeveless dress with a square neckline and a satin-like sheen.",
    "edit_instruction": "Replace the woman's dress in image 1 with the dress in image 2. Preserve her face, pose, and background.",
    "uncertainty": "The back of the dress is not visible.",
    "needs_clarification": False,
    "already_satisfied": False,
}


class EditGroundingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.nodes, self.routes = load_modules(self.temp.name)
        self.review = mock.patch.object(self.routes, "_check_reference_prompt")
        self.review.start()
        self.addCleanup(self.review.stop)

    def test_two_images_are_ordered_and_only_scene_facts_reach_writers(self):
        base, ref = {"filename": "base.png"}, {"filename": "dress.png"}
        with mock.patch.object(self.routes, "_consult", return_value=json.dumps(GROUNDING)) as call:
            result = self.routes._ground_edit_reference({"user_text": "Use that dress", "clarification_question": "Which dress?", "source_image": base, "reference_image": ref})
        self.assertEqual(call.call_args.args[0]["messages"][0]["images"], [base, ref])
        message = json.loads(call.call_args.args[0]["messages"][0]["text"])
        self.assertEqual(message["clarification_question"], "Which dress?")
        self.assertEqual(message["user_text"], "Use that dress")
        self.assertEqual(call.call_args.args[0]["thinking_mode"], "Disabled")
        context = grounding.writer_context(result)
        self.assertIn(GROUNDING["observations"], context)
        self.assertIn(GROUNDING["resolved_instruction"], context)
        self.assertNotIn(GROUNDING["edit_instruction"], context)

    def test_invalid_analysis_retries_and_ambiguity_never_becomes_a_revision(self):
        bad = {**GROUNDING, "resolved_instruction": "She wears the dress from image 2."}
        with mock.patch.object(self.routes, "_consult", side_effect=[json.dumps(bad), json.dumps(GROUNDING)]) as call:
            result = self.routes._ground_edit_reference({"user_text": "Use that dress", "source_image": {}, "reference_image": {}})
        self.assertEqual(call.call_count, 2)
        self.assertEqual(result, GROUNDING)
        with self.assertRaisesRegex(ValueError, "Which dress"):
            grounding.writer_context({**GROUNDING, "needs_clarification": True, "uncertainty": "Which dress should be transferred?"})

    def test_scene_pointer_check_preserves_explicit_literal_text(self):
        for text in ["She wears a dress from image 2", "She wears the reference dress", "It looks like the reference image"]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                grounding.standalone(text)
        grounding.standalone('A sign reading "Image 2".', ["Image 2"])
        grounding.standalone('Copy the sign wording "Image 2" onto the poster.')
        grounding.standalone("A green sleeveless dress with a square neckline.")

    def test_main_and_final_receive_the_same_grounded_change(self):
        for mode in ("revise_main", "revise"):
            with self.subTest(mode=mode), mock.patch.object(self.routes, "_generate_kcpp", return_value="A woman wears a green sleeveless dress beside a red book.") as call:
                result = self.routes._revise({
                    "mode": mode, "revision": "Replace her dress with the dress in image 2",
                    "current_prompt": "A woman wears a red dress beside a red book.",
                    "embellishment_level": "None", "reference_grounding": GROUNDING,
                })
                self.assertIn("green sleeveless dress", result)
                self.assertIn(GROUNDING["observations"], call.call_args.args[0])
                self.assertNotIn(GROUNDING["edit_instruction"], call.call_args.args[0])
        with mock.patch.object(self.routes, "_generate_kcpp", return_value="A woman wears the dress from image 2."):
            with self.assertRaisesRegex(ValueError, "depends on a reference"):
                self.routes._revise({"mode": "revise_main", "revision": "Use that dress", "current_prompt": "A woman wears a red dress.", "reference_grounding": GROUNDING})

    def test_scoped_writers_cannot_modify_unrelated_details_and_retry_pointers(self):
        before = "A woman in a red dress beside a red book."
        start = before.index("red dress")
        metadata = self.routes._image_intent.empty_intent()
        metadata["edit_scope"] = {"kind": "local", "targets": ["dress"], "spans": [
            {"stage": "main", "target": "dress", "start": start, "end": start + len("red dress"), "text": "red dress"}]}
        with mock.patch.object(self.routes, "_consult", side_effect=[
            json.dumps({"replacements": [{"span": 0, "text": "dress from image 2"}]}),
            json.dumps({"replacements": [{"span": 0, "text": "green sleeveless dress"}]}),
        ]) as call:
            result, _ = self.routes._revise_scoped_image_prompt({"reference_grounding": GROUNDING}, before, "Use that dress", metadata, "main")
        self.assertEqual(result, "A woman in a green sleeveless dress beside a red book.")
        self.assertEqual(call.call_count, 2)
        self.assertIn(GROUNDING["observations"], call.call_args.args[1])

    def test_analysis_failure_and_missing_images_do_not_return_guessed_facts(self):
        with self.assertRaisesRegex(ValueError, "base and reference"):
            self.routes._ground_edit_reference({"user_text": "Use that dress"})
        with mock.patch.object(self.routes, "_consult", side_effect=RuntimeError("Vision unavailable")):
            with self.assertRaisesRegex(RuntimeError, "Vision unavailable"):
                self.routes._ground_edit_reference({"user_text": "Use that dress", "source_image": {}, "reference_image": {}})

    def test_addition_keeps_the_original_object_and_placement_in_both_prompts(self):
        before = "A blue mug on a table beside a book."
        facts = {**GROUNDING, "observations": "The second mug is green with a round handle.",
                 "resolved_instruction": "Add a green mug next to the original blue mug; keep the blue mug.",
                 "edit_instruction": "Add the green mug from image 2 next to the blue mug in image 1. Keep the original mug and all other objects."}
        for stage in ("main", "final"):
            with self.subTest(stage=stage):
                metadata = self.routes._image_intent.empty_intent()
                metadata["edit_scope"] = {"kind": "local", "targets": ["mugs"], "spans": [
                    {"stage": stage, "target": "mugs", "start": 0, "end": len("A blue mug"), "text": "A blue mug"}]}
                with mock.patch.object(self.routes, "_consult", return_value=json.dumps({"replacements": [
                    {"span": 0, "text": "A blue mug and a green mug next to it"}]})) as call:
                    result, _ = self.routes._revise_scoped_image_prompt({"reference_grounding": facts}, before,
                        "Add the mug next to the original", metadata, stage)
                self.assertEqual(result, "A blue mug and a green mug next to it on a table beside a book.")
                self.assertIn(facts["resolved_instruction"], call.call_args.args[1])

    def test_semantic_review_retries_a_writer_that_drops_requested_placement(self):
        self.review.stop()
        before = "A blue mug on a table."
        metadata = self.routes._image_intent.empty_intent()
        metadata["edit_scope"] = {"kind": "local", "targets": ["mugs"], "spans": [
            {"stage": "main", "target": "mugs", "start": 0, "end": 10, "text": "A blue mug"}]}
        responses = [
            {"replacements": [{"span": 0, "text": "A blue mug and a green mug"}]},
            {"satisfied": False, "issue": "Express that the green mug is next to the blue mug."},
            {"replacements": [{"span": 0, "text": "A blue mug with a green mug next to it"}]},
            {"satisfied": True, "issue": ""},
        ]
        with mock.patch.object(self.routes, "_consult", side_effect=[json.dumps(item) for item in responses]) as call:
            result, _ = self.routes._revise_scoped_image_prompt({"reference_grounding": GROUNDING}, before,
                "Add this mug next to the blue one", metadata, "main")
        self.assertEqual(result, "A blue mug with a green mug next to it on a table.")
        self.assertEqual(call.call_count, 4)
        self.assertIn("Express that the green mug is next to the blue mug", call.call_args_list[2].args[1])

    def test_analysis_retries_an_edit_instruction_that_changes_the_requested_operation(self):
        self.review.stop()
        facts = {**GROUNDING, "observations": "The reference mug is green; the base mug is blue.",
                 "resolved_instruction": "Add a green mug next to the blue mug.",
                 "edit_instruction": "Replace the blue mug with the green mug from image 2."}
        fixed = {**facts, "edit_instruction": "Add the green mug from image 2 next to the blue mug in image 1. Keep the blue mug."}
        responses = [facts, {"satisfied": False, "issue": "The edit instruction must add a second mug and keep the original."},
                     fixed, {"satisfied": True, "issue": ""}]
        with mock.patch.object(self.routes, "_consult", side_effect=[json.dumps(item) for item in responses]) as call:
            result = self.routes._ground_edit_reference({"user_text": "Place this mug next to the blue one",
                "source_image": {}, "reference_image": {}})
        self.assertEqual(result["edit_instruction"], fixed["edit_instruction"])
        self.assertEqual(call.call_count, 4)

    def test_full_scene_repair_checks_the_second_candidate_before_returning(self):
        self.review.stop()
        with mock.patch.object(self.routes, "_generate_kcpp", side_effect=["A blue mug and a green mug.", "A blue mug with a green mug next to it."]) as writer:
            with mock.patch.object(self.routes, "_consult", side_effect=[
                json.dumps({"satisfied": False, "issue": "Preserve that the mugs are next to each other."}),
                json.dumps({"satisfied": True, "issue": ""})]):
                result = self.routes._revise({"mode": "revise_main", "revision": "Place this mug next to the blue one",
                    "current_prompt": "A blue mug.", "reference_grounding": GROUNDING})
        self.assertEqual(result, "A blue mug with a green mug next to it.")
        self.assertEqual(writer.call_count, 2)

    def test_reference_text_is_bound_to_both_user_authority_and_observed_wording(self):
        intent = self.routes._image_intent
        delta = {"version": 1, "base_revision": 0, "operations": [{"op": "lock", "id": "sign",
            "kind": "visible_text", "text": "Image 2", "evidence": "Copy this sign's wording",
            "reference": {"stage": "reference", "text": 'The sign reads "Image 2".'}}]}
        observed = 'The sign reads "Image 2".'
        metadata = intent.apply_user_intent_delta(None, delta, user_text="Copy this sign's wording", turn_id="copy-sign",
            reference_observations=observed)
        self.assertEqual(metadata["locked_literals"][0]["text"], "Image 2")
        self.assertEqual(metadata["locked_literals"][0]["evidence"]["source"], "user")
        self.assertEqual(metadata["locked_literals"][0]["reference"]["text"], observed)
        with self.assertRaises(intent.IntentValidationError):
            intent.apply_user_intent_delta(None, delta, user_text="Copy this sign's wording", turn_id="copy-sign", reference_observations="Unreadable text")
        with self.assertRaises(intent.IntentValidationError):
            intent.apply_user_intent_delta(None, delta, user_text="Change the mug", turn_id="different-request", reference_observations=observed)

    def test_already_matching_targets_are_valid_but_empty_clarifications_are_not(self):
        facts = {**GROUNDING, "already_satisfied": True, "observations": "Both images show the same short curly hairstyle.",
                 "resolved_instruction": "Keep the woman's short curly hairstyle.",
                 "edit_instruction": "Keep the woman's current hairstyle; it already matches image 2."}
        self.assertTrue(grounding.normalize(facts)["already_satisfied"])
        with self.assertRaisesRegex(ValueError, "specific question"):
            grounding.normalize({**GROUNDING, "needs_clarification": True, "uncertainty": ""})

    def test_local_replacement_repairs_an_article_at_the_unchanged_boundary(self):
        before = "A mug and a potted plant."
        start = before.index("potted")
        metadata = self.routes._image_intent.empty_intent()
        metadata["edit_scope"] = {"kind": "local", "targets": ["pot"], "spans": [
            {"stage": "main", "target": "pot", "start": start, "end": len(before) - 1, "text": "potted plant"}]}
        responses = [{"replacements": [{"span": 0, "text": text}]} for text in (
            "a plant in a green pot", "plant in a green pot")]
        with mock.patch.object(self.routes, "_consult", side_effect=[json.dumps(item) for item in responses]) as call:
            result, _ = self.routes._revise_scoped_image_prompt({"reference_grounding": GROUNDING}, before,
                "Make the pot green", metadata, "main")
        self.assertEqual(result, "A mug and a plant in a green pot.")
        self.assertEqual(call.call_count, 2)
