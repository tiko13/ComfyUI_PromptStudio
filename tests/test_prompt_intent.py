import copy
import asyncio
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
import tempfile
from unittest import mock

SPEC = importlib.util.spec_from_file_location("image_prompt_intent_test", Path(__file__).resolve().parents[1] / "prompt_intent.py")
intent = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(intent)


class PromptIntentTests(unittest.TestCase):
    def removal(self):
        main = "A cat beside a window."
        final = "A cat beside a window, beside a brass lamp."
        delta = {"version": 1, "base_revision": 0,
                 "edit_scope": {"kind": "final_only", "targets": ["lamp"], "evidence": "Remove the lamp"},
                 "operations": [{"op": "exclude", "id": "prop-lamp", "text": "lamp", "aliases": ["lamps"],
                                 "evidence": "Remove the lamp", "reference": {"stage": "final", "text": "brass lamp"}}]}
        return main, intent.apply_user_intent_delta(None, delta, user_text="Remove the lamp", turn_id="u2", current_main=main, current_final=final)

    def test_removed_auto_prop_stays_removed_after_final_rebuild_without_negative_main(self):
        main, metadata = self.removal()
        original = copy.deepcopy(metadata)
        for _ in range(2):
            resolved = intent.resolve_final_sources(metadata, [{"id": "style-decor", "source": "style", "text": "a brass lamp"}, {"id": "light", "source": "embellishment", "text": "soft daylight"}])
            self.assertEqual([item["id"] for item in resolved["additions"]], ["light"])
            self.assertEqual(resolved["warnings"][0]["constraint_id"], "prop-lamp")
            metadata = resolved["intent"]
            self.assertTrue(intent.validate_prompt_preservation(main, main, metadata, stage="main")["valid"])
            self.assertTrue(intent.validate_prompt_preservation(main, main + " Soft daylight.", metadata, stage="final", enforce_scope=False)["valid"])
            self.assertFalse(intent.validate_prompt_preservation(main, main + " No lamp.", metadata, stage="main")["valid"])
            self.assertFalse(intent.validate_prompt_preservation(main, main + " A brass lamp.", metadata, stage="final", enforce_scope=False)["valid"])
        self.assertEqual(original["source_tags"], [])
        self.assertNotIn("soft daylight", intent.build_intent_prompt_context(metadata, stage="main"))

    def test_local_revision_preserves_literals_and_all_unrelated_bytes(self):
        before = 'Alice wears a blue coat beside a sign reading "Zostaň tu!". A dog sleeps.'
        user = 'Make the coat red. Keep Alice and "Zostaň tu!".'
        start = before.index("blue")
        delta = {"version": 1, "base_revision": 0,
                 "edit_scope": {"kind": "local", "targets": ["coat-color"], "evidence": "Make the coat red",
                                "spans": [{"stage": "main", "start": start, "end": start + 4, "text": "blue", "target": "coat-color"}]},
                 "operations": [{"op": "lock", "id": "name", "kind": "name", "text": "Alice", "evidence": "Keep Alice"},
                                {"op": "lock", "id": "sign", "kind": "visible_text", "text": "Zostaň tu!", "evidence": '"Zostaň tu!"'}]}
        metadata = intent.apply_user_intent_delta(None, delta, user_text=user, turn_id="u2", current_main=before)
        proposal = {"base_hash": hashlib.sha256(before.encode()).hexdigest(), "edits": [{"start": start, "end": start + 4, "before": "blue", "after": "red", "target": "coat-color"}]}
        result = intent.apply_scoped_edits(before, proposal, metadata)
        self.assertEqual(result, before.replace("blue", "red"))
        self.assertTrue(intent.validate_prompt_preservation(before, result, metadata, stage="main", proposal=proposal)["valid"])
        self.assertFalse(intent.validate_prompt_preservation(before, result.replace("dog", "cat"), metadata, stage="main", proposal=proposal)["valid"])
        broad = {"base_hash": proposal["base_hash"], "edits": [{"start": 0, "end": len(before), "before": before, "after": "Red coat", "target": "coat-color"}]}
        with self.assertRaisesRegex(intent.IntentValidationError, "exceeds"):
            intent.apply_scoped_edits(before, broad, metadata)

    def test_user_evidence_and_contextual_reference_are_required_without_english_authority_regex(self):
        delta = {"version": 1, "base_revision": 0, "operations": [{"op": "exclude", "id": "lamp", "text": "lamp", "evidence": "Odstráň ju", "reference": {"stage": "final", "text": "brass lamp"}}]}
        metadata = intent.apply_user_intent_delta(None, delta, user_text="Odstráň ju", turn_id="u1", current_final="A brass lamp.")
        self.assertEqual(metadata["exclusions"][0]["text"], "lamp")
        with self.assertRaisesRegex(intent.IntentValidationError, "current user"):
            intent.apply_user_intent_delta(None, delta, user_text="Keep everything", turn_id="u2", current_final="A brass lamp.")
        with self.assertRaisesRegex(intent.IntentValidationError, "saved prompt"):
            intent.apply_user_intent_delta(None, delta, user_text="Odstráň ju", turn_id="u1", current_final="A candle.")

    def test_latest_explicit_allow_and_unlock_override_previous_constraints(self):
        _, metadata = self.removal()
        allowed = intent.apply_user_intent_delta(metadata, {"version": 1, "base_revision": metadata["revision"], "operations": [{"op": "allow", "id": "prop-lamp", "evidence": "Bring the lamp back"}]}, user_text="Bring the lamp back", turn_id="u3")
        self.assertEqual(allowed["exclusions"], [])
        self.assertEqual(len(metadata["exclusions"]), 1)
        self.assertEqual(intent.resolve_final_sources(allowed, [{"id": "style", "source": "style", "text": "brass lamp"}])["warnings"], [])
        with self.assertRaisesRegex(intent.IntentValidationError, "stale"):
            intent.apply_user_intent_delta(allowed, {"version": 1, "base_revision": 1, "operations": []}, user_text="Change lighting", turn_id="u4")

    def test_control_sources_cannot_be_promoted_to_main_and_conflicts_are_named(self):
        main, metadata = self.removal()
        result = intent.resolve_final_sources(metadata, [{"id": "framing-camera", "source": "framing", "text": "telephoto compression"}])
        check = intent.validate_prompt_preservation(main, main + " telephoto compression", result["intent"], stage="main", enforce_scope=False)
        self.assertEqual(check["violations"][0]["code"], "control_leaked_into_main")
        with self.assertRaises(intent.IntentValidationError):
            intent.resolve_final_sources(metadata, [{"id": "bad", "source": "user", "text": "control data"}])
        conflicting = intent.resolve_final_sources(metadata, [{"id": "reference-detail", "source": "known_reference", "text": "the character's customary accessory", "conflicts_with": ["prop-lamp"]}])
        self.assertEqual(conflicting["additions"], [])
        self.assertIn("known_reference", conflicting["warnings"][0]["message"])

    def test_old_records_and_manual_final_are_not_inferred_or_rewritten(self):
        self.assertIsNone(intent.normalize_intent(None))
        self.assertEqual(intent.validate_prompt_preservation("Old", "Old", None, stage="main"), {"valid": True, "metadata_available": False, "violations": []})
        metadata = intent.empty_intent()
        metadata["manual_final"] = {"source": "manual_final", "text": "My exact hand-edited Final."}
        self.assertEqual(intent.normalize_intent(metadata)["manual_final"], metadata["manual_final"])

    def test_task14_multilingual_literal_fixture_is_enforced_without_translation(self):
        from prompt_evals.cases import cases
        case = next(case for case in cases() if case["id"] == "image-visible-text")
        metadata = intent.apply_user_intent_delta(None, {"version": 1, "base_revision": 0, "operations": [{"op": "lock", "id": "sign", "kind": "visible_text", "text": "Zostaň tu!", "evidence": '"Zostaň tu!"'}]}, user_text=case["input"]["chat"], turn_id="eval-u1")
        self.assertTrue(intent.validate_prompt_preservation("", case["accepted_output"]["final_prompt"], metadata, stage="final")["valid"])
        self.assertFalse(intent.validate_prompt_preservation("", case["rejected_mutations"][0]["value"], metadata, stage="final")["valid"])


class PromptIntentProductionTests(unittest.TestCase):
    def setUp(self):
        from test_regressions import load_modules
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.nodes, self.routes = load_modules(self.directory.name)
        self.patch = mock.patch.object(self.routes, "_llamacpp_configured_generation_data", side_effect=lambda data: data)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_public_revision_response_carries_the_sidecar_from_a_copied_job_payload(self):
        _, metadata = PromptIntentTests().removal()
        payload = {"mode": "render", "revision": "A cat beside a window.", "intent_provenance": metadata,
                   "secondary_instructions": "brass lamp", "embellishment_level": "None"}
        class Request:
            content_length = None
            async def json(self):
                return payload
        async def queued(data, priority, operation):
            return operation(dict(data))
        with mock.patch.object(self.routes, "_run_llm_request", side_effect=queued), mock.patch.object(self.routes, "_generate_kcpp", return_value="A cat beside a window."), mock.patch.object(self.routes, "_needs_expansion_retry", return_value=False):
            response, status = asyncio.run(self.routes.prompt_studio_revise(Request()))
        self.assertEqual(status, 200)
        self.assertEqual(response["intent_provenance"]["exclusions"], metadata["exclusions"])
        self.assertEqual(response["suppressed_controls"], ["secondary_instructions"])
        self.assertIn("secondary", response["warning"])

    def test_final_only_removal_returns_unchanged_main_without_calling_generation(self):
        delta = {"version": 1, "base_revision": 0, "needs_clarification": False, "edit_scope": {"kind": "final_only", "targets": ["lamp"], "evidence": "Remove the lamp", "spans": [{"stage": "final", "text": " beside a brass lamp", "target": "lamp"}]},
                 "operations": [{"op": "exclude", "id": "lamp", "text": "lamp", "evidence": "Remove the lamp", "reference": {"stage": "final", "text": "brass lamp"}}]}
        data = {"mode": "revise_main", "current_prompt": "A cat.", "current_final_prompt": "A cat beside a brass lamp.", "revision": "Remove the lamp", "intent_tracking": True, "intent_turn_id": "u2"}
        with mock.patch.object(self.routes, "_consult_json_object", return_value=("{}", delta)), mock.patch.object(self.routes, "_generate_kcpp") as generate:
            self.assertEqual(self.routes._revise(data), "A cat.")
        generate.assert_not_called()
        self.assertEqual(data["_promptstudio_intent_result"]["intent_provenance"]["exclusions"][0]["text"], "lamp")
        final = {**data, "mode": "revise", "current_prompt": data["current_final_prompt"],
                 "intent_provenance": data["_promptstudio_intent_result"]["intent_provenance"]}
        with mock.patch.object(self.routes, "_consult", return_value=json.dumps({"replacements": [{"span": 0, "text": ""}]})):
            self.assertEqual(self.routes._revise(final), "A cat.")

    def test_rebuild_consumes_persisted_exclusion_and_reports_suppressed_passthrough(self):
        _, metadata = PromptIntentTests().removal()
        data = {"mode": "render", "revision": "A cat beside a window.", "intent_provenance": metadata,
                "style_modifier": "Ornate brass lamp decor", "secondary_instructions": "brass lamp", "embellishment_level": "None"}
        with mock.patch.object(self.routes, "_generate_kcpp", return_value="A cat beside a window.") as generate, mock.patch.object(self.routes, "_needs_expansion_retry", return_value=False), mock.patch.object(self.routes, "_consult_json_object") as classify:
            self.assertEqual(self.routes._revise(data), "A cat beside a window.")
        classify.assert_not_called()
        self.assertNotIn("Ornate brass lamp decor", generate.call_args.args[0])
        self.assertIn("Omit excluded content", generate.call_args.args[0])
        result = data["_promptstudio_intent_result"]
        self.assertEqual(set(result["suppressed_controls"]), {"style_modifier", "secondary_instructions"})
        self.assertEqual(len(result["intent_provenance"]["suppressed_sources"]), 2)
        with mock.patch.object(self.routes, "_generate_kcpp", return_value="A cat beside a brass lamp."), mock.patch.object(self.routes, "_needs_expansion_retry", return_value=False):
            with self.assertRaisesRegex(ValueError, "existing prompts were kept"):
                self.routes._revise(data)

    def test_semantic_control_conflict_suppresses_indirect_literal_override(self):
        metadata = intent.apply_user_intent_delta(None, {"version": 1, "base_revision": 0, "operations": [{"op": "lock", "id": "sign", "kind": "visible_text", "text": "OPEN", "evidence": "OPEN"}]}, user_text='A sign reads "OPEN"', turn_id="u1")
        data = {"mode": "render", "revision": 'A sign reads "OPEN".', "intent_provenance": metadata, "style_modifier": 'Make signage say CLOSED', "embellishment_level": "None"}
        review = {"conflicts": [{"source_id": "style_modifier", "constraint_ids": ["sign"]}]}
        with mock.patch.object(self.routes, "_consult_json_object", return_value=("{}", review)), mock.patch.object(self.routes, "_generate_kcpp", return_value='A sign reads "OPEN".') as generate, mock.patch.object(self.routes, "_needs_expansion_retry", return_value=False):
            self.routes._revise(data)
        self.assertNotIn("Make signage say CLOSED", generate.call_args.args[0])
        self.assertEqual(data["_promptstudio_intent_result"]["suppressed_controls"], ["style_modifier"])

    def test_local_response_edits_only_the_authorized_span(self):
        before = "A blue mug on a wooden table."
        delta = {"version": 1, "base_revision": 0, "edit_scope": {"kind": "local", "targets": ["mug-color"], "evidence": "Make the mug red", "spans": [{"stage": "main", "text": "blue", "target": "mug-color"}]}, "operations": []}
        data = {"mode": "revise_main", "current_prompt": before, "revision": "Make the mug red", "intent_tracking": True, "intent_delta": delta}
        with mock.patch.object(self.routes, "_consult", return_value=json.dumps({"replacements": [{"span": 0, "text": "red"}]})):
            self.assertEqual(self.routes._revise(data), "A red mug on a wooden table.")
        with mock.patch.object(self.routes, "_consult", return_value=json.dumps({"replacements": [{"span": 1, "text": "steel"}]})):
            with self.assertRaisesRegex(ValueError, "span index"):
                self.routes._revise(data)

    def blonde_delta(self):
        return {"version": 1, "base_revision": 0, "needs_clarification": False,
                "edit_scope": {"kind": "local", "targets": ["hair"], "evidence": "make her blonde", "spans": [
                    {"stage": "main", "text": "young woman", "target": "hair"},
                    {"stage": "final", "text": "young woman", "target": "hair"}]}, "operations": []}

    def test_first_change_retries_bad_evidence_and_keeps_both_prompts_outside_span_exact(self):
        main = "A young woman standing in an office."
        final = "A young woman in a blouse in an office, holding papers. Flat light."
        valid = self.blonde_delta()
        for invalid in (None, "", {"quote": "make her blonde"}, "x" * 8193, "Make the woman blonde."):
            with self.subTest(evidence=repr(invalid)[:60]):
                malformed = copy.deepcopy(valid)
                malformed["edit_scope"]["evidence"] = invalid
                responses = [malformed, valid, {"replacements": [{"span": 0, "text": "blonde young woman"}]},
                             {"replacements": [{"span": 0, "text": "blonde young woman"}]}]
                data = {"intent_tracking": True, "intent_turn_id": "u2", "intent_user_text": "make her blonde",
                        "revision": "Make the woman blonde.", "mode": "revise_main", "current_prompt": main,
                        "current_main_prompt": main, "current_final_prompt": final}
                with mock.patch.object(self.routes, "_consult", side_effect=[json.dumps(item) for item in responses]) as consult:
                    self.assertEqual(self.routes._revise(data), main.replace("young woman", "blonde young woman"))
                    metadata = data["_promptstudio_intent_result"]["intent_provenance"]
                    self.assertEqual(metadata["revision"], 1)
                    self.assertEqual(metadata["edit_scope"]["evidence"]["quote"], "make her blonde")
                    self.assertEqual(metadata["locked_literals"], [])
                    second = {**data, "mode": "revise", "current_prompt": final, "intent_provenance": metadata}
                    self.assertEqual(self.routes._revise(second), final.replace("young woman", "blonde young woman"))
                self.assertEqual(consult.call_count, 4, "Final must reuse the classified turn")
                self.assertIn("Validation error:", consult.call_args_list[1].args[1])
                main_args = consult.call_args_list[2].args
                main_context = (main_args[0]["messages"], main_args[1])
                self.assertNotIn("holding papers", str(main_context), "Final content must not enter the Main writer")
                self.assertEqual(json.loads(main_args[0]["messages"][0]["text"])["instruction"], "make her blonde")

    def test_classifier_exhaustion_preserves_input_and_never_calls_prompt_writer(self):
        data = {"intent_tracking": True, "intent_provenance": intent.empty_intent(), "revision": "make her blonde"}
        before = copy.deepcopy(data)
        bad = self.blonde_delta()
        bad["edit_scope"]["evidence"] = None
        with mock.patch.object(self.routes, "_consult", return_value=json.dumps(bad)) as consult:
            with self.assertRaisesRegex(ValueError, "after retrying; your existing prompts were kept"):
                self.routes._prepare_image_intent(data, "revise_main", "A young woman.", "A young woman.", "make her blonde")
        self.assertEqual(consult.call_count, 2)
        self.assertEqual(data, before)

    def test_classifier_retries_ambiguous_spans_and_stale_revision(self):
        valid = self.blonde_delta()
        for change in (lambda d: d.update(base_revision=99),
                       lambda d: d["edit_scope"]["spans"][0].update(text="her hair"),
                       lambda d: d["edit_scope"]["spans"].pop(),
                       lambda d: d["edit_scope"].update(kind=[]),
                       lambda d: d.update(needs_clarification="false")):
            invalid = copy.deepcopy(valid)
            change(invalid)
            with mock.patch.object(self.routes, "_consult", side_effect=[json.dumps(invalid), json.dumps(valid)]) as consult:
                result = self.routes._prepare_image_intent({"intent_tracking": True}, "revise_main", "A young woman.", "A young woman.", "make her blonde")
            self.assertEqual(result["revision"], 1)
            self.assertEqual(consult.call_count, 2)

    def test_clarification_is_not_retried_or_applied(self):
        response = {"needs_clarification": True}
        with mock.patch.object(self.routes, "_consult", return_value=json.dumps(response)) as consult:
            with self.assertRaisesRegex(ValueError, "needs clarification"):
                self.routes._prepare_image_intent({"intent_tracking": True}, "revise_main", "A woman.", "A woman.", "change it")
        self.assertEqual(consult.call_count, 1)

    def test_scoped_replacement_retries_literal_violation_without_reclassifying(self):
        delta = self.blonde_delta()
        metadata = intent.apply_classified_delta(None, delta, mode="revise_main", user_text="make her blonde", turn_id="u2",
                                                  current_main="A young woman.", current_final="A young woman.")
        metadata["locked_literals"] = [{"id": "legacy-subject", "kind": "name", "text": "young woman",
                                        "evidence": {"source": "user", "turn_id": "u1", "quote": "young woman"}}]
        responses = [{"replacements": [{"span": 0, "text": "young blonde woman"}]},
                     {"replacements": [{"span": 0, "text": "blonde young woman"}]}]
        data = {"mode": "revise_main", "current_prompt": "A young woman.", "revision": "make her blonde",
                "intent_turn_id": "u2", "intent_provenance": metadata}
        with mock.patch.object(self.routes, "_consult", side_effect=[json.dumps(item) for item in responses]) as consult:
            self.assertEqual(self.routes._revise(data), "A blonde young woman.")
        self.assertEqual(consult.call_count, 2)
        self.assertIn("locked_literal_changed", consult.call_args.args[1])

    def test_removal_cannot_silently_omit_the_persistent_exclusion(self):
        valid = {"version": 1, "base_revision": 0, "needs_clarification": False,
                 "edit_scope": {"kind": "final_only", "action": "remove", "targets": ["lamp"], "evidence": "Remove the lamp",
                                "spans": [{"stage": "final", "text": " beside a lamp", "target": "lamp"}]},
                 "operations": [{"op": "exclude", "id": "lamp", "text": "lamp", "evidence": "Remove the lamp"}]}
        invalid = {**valid, "operations": []}
        with mock.patch.object(self.routes, "_consult", side_effect=[json.dumps(invalid), json.dumps(valid)]) as consult:
            result = self.routes._prepare_image_intent({"intent_tracking": True}, "revise_main", "A cat.", "A cat beside a lamp.", "Remove the lamp")
        self.assertEqual(result["exclusions"][0]["text"], "lamp")
        self.assertIn("future rebuilds", consult.call_args.args[1])

    def test_existing_literal_cannot_be_split_by_an_attribute_edit_span(self):
        metadata = intent.empty_intent()
        metadata["locked_literals"] = [{"id": "legacy", "kind": "name", "text": "young woman",
                                        "evidence": {"source": "user", "turn_id": "u1", "quote": "young woman"}}]
        valid = self.blonde_delta()
        invalid = copy.deepcopy(valid)
        invalid["edit_scope"]["spans"][0]["text"] = "woman"
        with mock.patch.object(self.routes, "_consult", side_effect=[json.dumps(invalid), json.dumps(valid)]) as consult:
            result = self.routes._prepare_image_intent({"intent_provenance": metadata}, "revise_main", "A young woman.", "A young woman.", "make her blonde")
        self.assertEqual(result["edit_scope"]["spans"][0]["text"], "young woman")
        self.assertIn("select the entire literal", consult.call_args.args[1])

    def test_control_review_retries_unknown_constraints(self):
        _, metadata = PromptIntentTests().removal()
        bad = {"conflicts": [{"source_id": "decor", "constraint_ids": ["invented"]}]}
        valid = {"conflicts": [{"source_id": "decor", "constraint_ids": ["prop-lamp"]}]}
        with mock.patch.object(self.routes, "_consult", side_effect=[json.dumps(bad), json.dumps(valid)]) as consult:
            result = self.routes._resolve_image_intent_controls({}, metadata, [{"id": "decor", "source": "style", "text": "Decorative lighting fixture"}])
        self.assertEqual(result["additions"], [])
        self.assertEqual(consult.call_count, 2)

    def test_repeated_subject_edit_resolves_occurrence_without_model_character_offsets(self):
        main = "A woman in a blue coat stands left. A woman in a blue coat stands right."
        final = main + " Soft light."
        delta = {"version": 1, "base_revision": 0, "needs_clarification": False,
                 "edit_scope": {"kind": "local", "action": "modify", "targets": ["right coat"],
                                "evidence": "Make only the right coat red", "spans": [
                                    {"stage": stage, "text": "blue", "occurrence": 1, "target": "right-coat-color"}
                                    for stage in ("main", "final")]}, "operations": []}
        data = {"mode": "revise_main", "current_prompt": main, "current_main_prompt": main, "current_final_prompt": final,
                "revision": "Make only the right coat red", "intent_tracking": True, "intent_turn_id": "right", "intent_delta": delta}
        replacement = {"replacements": [{"span": 0, "text": "red"}]}
        with mock.patch.object(self.routes, "_consult", return_value=json.dumps(replacement)):
            self.assertEqual(self.routes._revise(data), "A woman in a blue coat stands left. A woman in a red coat stands right.")
            metadata = data["_promptstudio_intent_result"]["intent_provenance"]
            final_result = self.routes._revise({**data, "mode": "revise", "current_prompt": final, "intent_provenance": metadata})
        self.assertEqual(final_result, "A woman in a blue coat stands left. A woman in a red coat stands right. Soft light.")
        self.assertEqual(metadata["edit_scope"]["targets"], ["right-coat-color"])

    def test_compound_edits_can_rewrite_clauses_and_remove_final_only_details_together(self):
        main = 'Alice hands a red folder to Bob. A sign reads "OPEN".'
        final = main + " A lamp glows. Soft daylight."
        user = "Have Bob give Alice a blue folder and remove the lamp. Keep the sign unchanged."
        delta = {"version": 1, "base_revision": 0, "needs_clarification": False,
                 "edit_scope": {"kind": "local", "action": "remove", "targets": ["handoff", "lamp"], "evidence": user,
                                "spans": [{"stage": stage, "text": "Alice hands a red folder to Bob.", "target": "handoff"} for stage in ("main", "final")]
                                         + [{"stage": "final", "text": " A lamp glows.", "target": "lamp"}]},
                 "operations": [{"op": "exclude", "id": "lamp", "text": "lamp", "evidence": "remove the lamp"},
                                {"op": "lock", "id": "sign", "kind": "visible_text", "text": "OPEN", "evidence": "Keep the sign unchanged",
                                 "reference": {"stage": "main", "text": 'A sign reads "OPEN".'}}]}
        data = {"mode": "revise_main", "current_prompt": main, "current_main_prompt": main, "current_final_prompt": final,
                "revision": user, "intent_tracking": True, "intent_turn_id": "compound", "intent_delta": delta}
        responses = [{"replacements": [{"span": 0, "text": "Bob gives Alice a blue folder."}]},
                     {"replacements": [{"span": 1, "text": ""}, {"span": 0, "text": "Bob gives Alice a blue folder."}]}]
        with mock.patch.object(self.routes, "_consult", side_effect=[json.dumps(value) for value in responses]):
            self.assertEqual(self.routes._revise(data), 'Bob gives Alice a blue folder. A sign reads "OPEN".')
            metadata = data["_promptstudio_intent_result"]["intent_provenance"]
            self.assertEqual(self.routes._revise({**data, "mode": "revise", "current_prompt": final, "intent_provenance": metadata}),
                             'Bob gives Alice a blue folder. A sign reads "OPEN". Soft daylight.')
        self.assertEqual(metadata["exclusions"][0]["text"], "lamp")

    def test_conversation_router_retries_invalid_confidence(self):
        valid = {"route": "mutate_now", "confidence": 1, "resolved_instruction": "Make the woman blonde.", "reason": "Explicit change"}
        with mock.patch.object(self.routes, "_consult", side_effect=[json.dumps({**valid, "confidence": True}), json.dumps(valid)]) as consult:
            self.assertEqual(self.routes._studio_turn_route({"user_text": "make her blonde"})["route"], "mutate_now")
        self.assertEqual(consult.call_count, 2)

    def test_legacy_caller_keeps_existing_response_and_does_not_run_intent_classifier(self):
        with mock.patch.object(self.routes, "_consult_json_object") as classify, mock.patch.object(self.routes, "_generate_kcpp", return_value="A cat."):
            self.assertEqual(self.routes._revise({"mode": "create_main", "revision": "A cat"}), "A cat.")
        classify.assert_not_called()
