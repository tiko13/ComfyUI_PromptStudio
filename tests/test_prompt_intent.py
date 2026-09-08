import copy
import asyncio
import hashlib
import importlib.util
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
        delta = {"version": 1, "base_revision": 0, "edit_scope": {"kind": "final_only", "targets": ["lamp"], "evidence": "Remove the lamp"},
                 "operations": [{"op": "exclude", "id": "lamp", "text": "lamp", "evidence": "Remove the lamp", "reference": {"stage": "final", "text": "brass lamp"}}]}
        data = {"mode": "revise_main", "current_prompt": "A cat.", "current_final_prompt": "A cat beside a brass lamp.", "revision": "Remove the lamp", "intent_tracking": True, "intent_turn_id": "u2"}
        with mock.patch.object(self.routes, "_consult_json_object", return_value=("{}", delta)), mock.patch.object(self.routes, "_generate_kcpp") as generate:
            self.assertEqual(self.routes._revise(data), "A cat.")
        generate.assert_not_called()
        self.assertEqual(data["_promptstudio_intent_result"]["intent_provenance"]["exclusions"][0]["text"], "lamp")

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

    def test_local_full_text_response_is_restricted_to_router_authorized_span(self):
        before = "A blue mug on a wooden table."
        delta = {"version": 1, "base_revision": 0, "edit_scope": {"kind": "local", "targets": ["mug-color"], "evidence": "Make the mug red", "spans": [{"stage": "main", "text": "blue", "target": "mug-color"}]}, "operations": []}
        data = {"mode": "revise_main", "current_prompt": before, "revision": "Make the mug red", "intent_tracking": True, "intent_delta": delta}
        with mock.patch.object(self.routes, "_generate_kcpp", return_value="A red mug on a wooden table."):
            self.assertEqual(self.routes._revise(data), "A red mug on a wooden table.")
        with mock.patch.object(self.routes, "_generate_kcpp", return_value="A red mug on a steel table."):
            with self.assertRaisesRegex(ValueError, "outside the authorized"):
                self.routes._revise(data)

    def test_legacy_caller_keeps_existing_response_and_does_not_run_intent_classifier(self):
        with mock.patch.object(self.routes, "_consult_json_object") as classify, mock.patch.object(self.routes, "_generate_kcpp", return_value="A cat."):
            self.assertEqual(self.routes._revise({"mode": "create_main", "revision": "A cat"}), "A cat.")
        classify.assert_not_called()
