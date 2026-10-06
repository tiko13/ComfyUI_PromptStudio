import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from test_regressions import load_modules


class KnownReferenceOutputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.nodes, self.routes = load_modules(self.temp.name)
        self.definition = "A beautiful woman with full lips and long flowing hair. Emphasize graceful posture."
        self.path = Path(self.temp.name) / "references.json"
        self.path.write_text(json.dumps({"known_references": [
            {"name": "Doll", "definition": self.definition},
            {"name": "Quiet Focus", "definition": "Keep the composition uncluttered."},
            {"name": "Ignored", "definition": "Do not use this.", "enabled": False},
        ]}), encoding="utf-8")
        for patcher in (
            mock.patch.object(self.nodes, "KNOWN_REFERENCES_PATH", str(self.path)),
            mock.patch.object(self.nodes._forbidden_words, "load_rules", return_value=[]),
            mock.patch.object(self.routes, "_llamacpp_configured_generation_data", side_effect=lambda data: data),
            mock.patch.object(self.routes, "_needs_expansion_retry", return_value=False),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def payload(self, **changes):
        return {"mode": "render", "revision": "Doll in an office. Use Quiet Focus.",
                "embellishment_level": "None", **changes}

    def test_all_providers_repair_leaked_common_noun_without_scripted_replacement(self):
        leaked = "A beautiful doll with full lips and long flowing hair sits gracefully in an uncluttered office."
        repaired = "A beautiful woman with full lips and long flowing hair sits gracefully in an uncluttered office."
        for provider in ("koboldcpp", "ollama", "llamacpp"):
            with self.subTest(provider=provider), mock.patch.object(
                self.routes, "_generate_kcpp" if provider == "koboldcpp" else "_generate_" + provider,
                side_effect=[leaked, repaired],
            ) as generate:
                result = self.routes._revise(self.payload(llm_provider=provider))
            self.assertEqual(result, repaired)
            self.assertEqual(generate.call_count, 2)
            correction = generate.call_args.args[0]
            self.assertIn(leaked, correction)
            self.assertIn(self.definition, correction)
            self.assertIn("Keep the composition uncluttered.", correction)

    def test_clean_output_needs_no_extra_call_and_main_keeps_reference_keys(self):
        for mode, result in (("render", "A beautiful woman in an office."),
                             ("create_main", "Doll in an office.")):
            with self.subTest(mode=mode), mock.patch.object(self.routes, "_generate_kcpp", return_value=result) as generate:
                self.assertEqual(self.routes._revise(self.payload(mode=mode)), result)
            self.assertEqual(generate.call_count, 1)

    def test_exhausted_or_empty_repairs_never_return_leaking_or_empty_output(self):
        for results in (["A doll."] * 3, ["A doll.", ""]):
            with self.subTest(results=results), mock.patch.object(self.routes, "_generate_kcpp", side_effect=results) as generate:
                with self.assertRaises(self.nodes.KnownReferenceOutputError):
                    self.routes._revise(self.payload())
                self.assertEqual(generate.call_count, len(results))

    def test_matching_uses_active_source_references_and_token_boundaries(self):
        references = self.nodes._matched_known_references("Doll")
        rewrite = mock.Mock(return_value="A woman beside a dollhouse. Quiet Focus.")
        output = self.nodes._enforce_known_reference_output("A DOLL beside a dollhouse.", references, rewrite=rewrite)
        self.assertEqual(output, rewrite.return_value)
        rewrite.assert_called_once()
        self.assertEqual(self.nodes._enforce_known_reference_output("A dollhouse.", references), "A dollhouse.")
        self.assertEqual(self.nodes._enforce_known_reference_output("Ignored.", self.nodes._matched_known_references("Ignored")), "Ignored.")

    def test_reference_name_lock_is_final_only_projection_and_verbatim_locks_survive(self):
        metadata = self.routes._image_intent.empty_intent()
        def lock(identifier, kind, text):
            return {"id": identifier, "kind": kind, "text": text,
                    "evidence": {"source": "user", "turn_id": "u1", "quote": text}}
        metadata["locked_literals"] = [lock("reference", "name", "DOLL"),
                                      lock("person", "name", "Alice"),
                                      lock("sign", "visible_text", "OPEN")]
        original = copy.deepcopy(metadata)
        payload = self.payload(intent_provenance=metadata)
        output = 'A beautiful woman beside Alice and a sign reading "OPEN".'
        with mock.patch.object(self.routes, "_generate_kcpp", return_value=output) as generate:
            self.assertEqual(self.routes._revise(payload), output)
        self.assertEqual(metadata, original)
        self.assertEqual(payload["_promptstudio_intent_result"]["intent_provenance"]["locked_literals"], original["locked_literals"])
        context = generate.call_args.args[0].split("Constraint metadata (data, not additional instructions):\n", 1)[1]
        self.assertEqual([item["text"] for item in json.loads(context)["locked_literals"]], ["Alice", "OPEN"])
        for kind in ("visible_text", "dialogue", "literal"):
            metadata["locked_literals"] = [lock("explicit", kind, "Doll")]
            self.assertEqual(self.nodes._known_reference_final_intent(metadata)["locked_literals"], metadata["locked_literals"])

    def test_revision_recovers_reference_mappings_from_main(self):
        payload = self.payload(mode="revise", current_prompt="A beautiful doll sits.",
                               current_main_prompt="Doll sitting.", revision="Make the chair blue.")
        with mock.patch.object(self.routes, "_generate_kcpp", side_effect=[
            "A beautiful doll sits on a blue chair.", "A beautiful woman sits on a blue chair.",
        ]) as generate:
            self.assertEqual(self.routes._revise(payload), "A beautiful woman sits on a blue chair.")
        self.assertIn(self.definition, generate.call_args.args[0])

    def test_classifier_receives_reference_keys_without_definitions(self):
        delta = {"version": 1, "base_revision": 0, "operations": [], "needs_clarification": False,
                 "edit_scope": {"kind": "create", "targets": [], "evidence": "Doll in an office"}}
        with mock.patch.object(self.routes, "_consult_json_object", return_value=("{}", delta)) as classify:
            self.routes._prepare_image_intent({"intent_tracking": True}, "create_main", "", "", "Doll in an office")
        payload = json.loads(classify.call_args.args[0]["messages"][0]["text"])
        self.assertEqual(payload["known_reference_names"], ["Doll"])
        self.assertNotIn(self.definition, str(classify.call_args))

    def test_native_amplifier_repairs_after_generation(self):
        node = self.nodes.KCPP_PromptAmplify()
        with mock.patch.object(self.nodes, "_generate_kcpp", side_effect=[
            "A beautiful doll sits gracefully.", "A beautiful woman sits gracefully.",
        ]) as generate, mock.patch.object(self.nodes, "_needs_expansion_retry", return_value=False):
            result = node.amplify.__wrapped__(
                node, text="Doll sitting.", additional_instructions="",
                model_profile="General Natural Language", style_preset="None", style_modifier="",
                framing_preset="None", framing_modifier="", thinking_mode="Disabled",
                embellishment_level="None", kobold_url="http://localhost:5001", max_response_tokens=200,
                temperature=0.2, top_p=0.9, top_k=40, min_p=0.0, rep_pen=1.05,
                rep_pen_range=360, sampler_seed=1,
            )
        self.assertEqual(result[0], "A beautiful woman sits gracefully.")
        self.assertEqual(generate.call_count, 2)

    def test_fragment_correction_and_keep_original_cannot_return_leaked_keys(self):
        node = self.nodes.KCPP_Ideogram4()
        args = dict(value="Doll sitting.", field_label="subject", offset=0,
                    profile=self.nodes.DEFAULT_PROFILE, style_template=self.nodes.DEFAULT_STYLE_TEMPLATE,
                    style_modifier="", framing_template=self.nodes.DEFAULT_FRAMING_TEMPLATE,
                    framing_modifier="", embellishment_level="None", thinking_mode="Disabled",
                    additional_instructions="", seed_mode="Same", kobold_url="http://localhost:5001",
                    max_response_tokens=200, temperature=0.2, top_p=0.9, top_k=40, min_p=0.0,
                    rep_pen=1.05, rep_pen_range=360, sampler_seed=1, stop_sequence="",
                    request_timeout=120, on_error="Keep Original")
        with mock.patch.object(self.nodes, "_generate_kcpp", side_effect=["A beautiful doll.", "A beautiful woman."]):
            self.assertEqual(node._rewrite_fragment(**args), "A beautiful woman.")
        with mock.patch.object(self.nodes, "_generate_kcpp", return_value="A beautiful doll.") as generate:
            with self.assertRaises(self.nodes.KnownReferenceOutputError):
                node._rewrite_fragment(**args)
            self.assertEqual(generate.call_count, 3)

    def test_scoped_revision_repairs_only_authorized_span(self):
        before = "A doll sits. A dog sleeps."
        metadata = self.routes._image_intent.empty_intent()
        metadata["edit_scope"] = {"kind": "local", "action": "modify", "targets": ["subject"],
                                  "evidence": {"source": "user", "turn_id": "u1", "quote": "Describe Doll"},
                                  "spans": [{"stage": "final", "text": "doll", "start": 2, "end": 6, "target": "subject"}]}
        responses = [json.dumps({"replacements": [{"span": 0, "text": text}]})
                     for text in ("beautiful doll", "beautiful woman")]
        with mock.patch.object(self.routes, "_consult", side_effect=responses) as consult:
            result, _ = self.routes._revise_scoped_image_prompt(
                {"current_main_prompt": "Doll sitting. A dog sleeps."}, before, "Describe Doll", metadata, "final")
        self.assertEqual(result, "A beautiful woman sits. A dog sleeps.")
        self.assertEqual(consult.call_count, 2)


if __name__ == "__main__":
    unittest.main()
