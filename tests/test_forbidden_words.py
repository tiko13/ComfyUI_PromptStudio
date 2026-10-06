import asyncio
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

from test_regressions import load_modules


class ForbiddenWordsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.nodes, self.routes = load_modules(self.temp.name)
        self.rules = self.routes._forbidden_words
        self.path = Path(self.temp.name) / "forbidden_words.json"
        patcher = mock.patch.object(self.rules, "CONFIG_PATH", self.path)
        patcher.start()
        self.addCleanup(patcher.stop)

    def save(self, *rules):
        self.path.write_text(json.dumps({"forbidden_words": [
            {"name": name, "replacement": replacement} for name, replacement in rules
        ]}), encoding="utf-8")

    def test_case_boundaries_literal_punctuation_and_longest_phrase(self):
        self.save(("art", "painting"), ("fine art", "illustration"), ("C++", "Rust"))
        self.assertEqual(self.rules.enforce("FINE ART, art; cart, artist, C++."),
                         "illustration, painting; cart, artist, Rust.")

    def test_blank_replacement_rephrases_instead_of_deleting_and_fails_closed(self):
        self.save(("dreamlike", ""))
        rewrite = mock.Mock(return_value="A surreal forest")
        self.assertEqual(self.rules.enforce("A dreamlike forest", rewrite=rewrite), "A surreal forest")
        self.assertIn("A dreamlike forest", rewrite.call_args.args[0])
        rewrite = mock.Mock(return_value="A dreamlike forest")
        with self.assertRaisesRegex(ValueError, "dreamlike"):
            self.rules.enforce("A dreamlike forest", rewrite=rewrite)
        self.assertEqual(rewrite.call_count, 2)
        with self.assertRaises(ValueError):
            self.rules.enforce("A dreamlike forest")

    def test_replacement_conflicts_duplicates_and_emerging_phrase(self):
        for entries in ([{"name": "cat", "replacement": "cat"}],
                        [{"name": "cat"}, {"name": "CAT"}],
                        [{"name": "cat", "replacement": "dog"}, {"name": "dog", "replacement": "cat"}]):
            with self.assertRaises(ValueError):
                self.rules.normalize_rules(entries)
        self.save(("red", "blue"), ("blue sky", ""))
        with self.assertRaisesRegex(ValueError, "blue sky"):
            self.rules.enforce("red sky")

    def test_missing_disabled_reload_and_malformed_file(self):
        self.assertEqual(self.rules.enforce("cat"), "cat")
        self.save(("cat", "dog"))
        self.assertEqual(self.rules.enforce("cat"), "dog")
        self.path.write_text('{"forbidden_words":[{"name":"cat","enabled":false}]}', encoding="utf-8")
        self.assertEqual(self.rules.enforce("cat"), "cat")
        self.path.write_text('{broken', encoding="utf-8")
        with self.assertRaises(ValueError):
            self.rules.enforce("cat")

    def test_explicit_modes_and_legacy_migration(self):
        rules = self.rules.normalize_rules([
            {"name": "cinematic", "replacement": "  Filmic  ", "replacement_mode": "verbatim"},
            {"name": "very", "replacement": "", "replacement_mode": "verbatim"},
            {"name": "dreamlike", "replacement": ""},
            {"name": "bright", "replacement": " vivid "},
        ])
        self.assertEqual([r["replacement_mode"] for r in rules], ["verbatim", "verbatim", "guidance", "verbatim"])
        rewrite = mock.Mock(side_effect=AssertionError("Verbatim must not call the LLM"))
        self.assertEqual(self.rules.enforce("CINEMATIC bright", rules=rules, rewrite=rewrite), "  Filmic   vivid")
        rewrite.assert_not_called()
        for mode in ("invalid", "", None):
            with self.assertRaisesRegex(ValueError, "Replacement mode"):
                self.rules.normalize_rules([{"name": "cat", "replacement_mode": mode}])

    def test_empty_replacement_requests_rephrase_in_both_modes(self):
        for mode in ("verbatim", "guidance"):
            for replacement in ("", "   "):
                rules = self.rules.normalize_rules([
                    {"name": "dreamlike", "replacement": replacement, "replacement_mode": mode},
                ])
                self.assertEqual(self.rules.apply_replacements("A dreamlike forest", rules), "A dreamlike forest")
                rewrite = mock.Mock(return_value="A surreal forest")
                self.assertEqual(self.rules.enforce("A dreamlike forest", rules=rules, rewrite=rewrite), "A surreal forest")
                self.assertIn("EITHER mode", rewrite.call_args.args[0])
                with self.assertRaisesRegex(ValueError, "dreamlike"):
                    self.rules.enforce("A dreamlike forest", rules=rules)

    def test_guidance_is_sent_to_llm_and_never_inserted_literally(self):
        guidance = "Describe dreamlike with concrete lighting and atmosphere"
        rules = self.rules.normalize_rules([
            {"name": "dreamlike", "replacement": guidance, "replacement_mode": "guidance"},
            {"name": "cinematic", "replacement": "filmic", "replacement_mode": "verbatim"},
        ])
        self.assertEqual(self.rules.apply_replacements("A dreamlike cinematic forest", rules), "A dreamlike filmic forest")
        rewrite = mock.Mock(return_value="A misty cinematic forest")
        self.assertEqual(self.rules.enforce("A dreamlike cinematic forest", rules=rules, rewrite=rewrite), "A misty filmic forest")
        self.assertIn(guidance, rewrite.call_args.args[0])
        self.assertIn('"replacement_mode": "guidance"', rewrite.call_args.args[0])
        with self.assertRaisesRegex(ValueError, "dreamlike"):
            self.rules.enforce("A dreamlike forest", rules=rules)

    def test_longer_guidance_phrase_is_not_partially_replaced(self):
        rules = self.rules.normalize_rules([
            {"name": "fine art", "replacement": "Describe the medium", "replacement_mode": "guidance"},
            {"name": "art", "replacement": "painting", "replacement_mode": "verbatim"},
        ])
        self.assertEqual(self.rules.apply_replacements("fine art and art", rules), "fine art and painting")

    def test_config_persistence_optional_replacement_revision_and_disabled(self):
        spec = {"path": str(self.path), "collection": "forbidden_words", "text_field": "replacement", "label": "forbidden phrase"}
        with mock.patch.object(self.routes, "MUTATION_CONFIG_SPECS", {"forbidden_words": spec}):
            initial = self.routes._read_mutation_config()
            saved = self.routes._update_mutation_config({"revision": initial["revision"], "category": "forbidden_words",
                "items": [{"name": "dreamlike", "replacement": "Describe dreamlike using light", "replacement_mode": "guidance"},
                          {"name": "cinematic", "replacement": " filmic ", "replacement_mode": "verbatim", "enabled": False}]})
            self.assertEqual(saved["forbidden_words"][0]["replacement_mode"], "guidance")
            self.assertEqual(saved["forbidden_words"][1]["replacement"], " filmic ")
            self.assertFalse(saved["forbidden_words"][1]["enabled"])
            self.assertEqual(saved, self.routes._read_mutation_config())
            self.assertEqual(json.loads(self.path.read_text())["forbidden_words"], saved["forbidden_words"])
            with self.assertRaises(self.routes.StoreConflictError):
                self.routes._update_mutation_config({"revision": initial["revision"], "category": "forbidden_words", "items": []})

    def test_image_final_repair_and_profile_wrapper_check(self):
        self.save(("dreamlike", ""), ("cinematic", "filmic"))
        payload = {"mode": "render", "revision": "a forest", "model_profile": "General Natural Language",
                   "style_preset": "None", "framing_preset": "None", "thinking_mode": "Disabled", "embellishment_level": "None"}
        with mock.patch.object(self.routes, "_generate_kcpp", side_effect=["A dreamlike cinematic forest", "A surreal cinematic forest"]) as generate:
            self.assertEqual(self.routes._revise(payload), "A surreal filmic forest")
            self.assertIn("Forbidden words", generate.call_args_list[0].args[0])
        with self.assertRaises(ValueError):
            self.nodes._apply_profile_wrappers("a forest", {"final_prompt_prefix": "dreamlike "})

    def test_submission_validation_blocks_manual_and_replay_matches(self):
        self.save(("cinematic", "filmic"), ("dreamlike", ""))
        request = types.SimpleNamespace(content_length=100, json=mock.AsyncMock(return_value={"prompts": ["Cinematic forest"]}))
        data, status = asyncio.run(self.routes.prompt_studio_validate_final_prompts(request))
        self.assertEqual((data, status), ({"prompts": ["filmic forest"]}, 200))
        request.json.return_value = {"prompts": ["dreamlike forest"]}
        data, status = asyncio.run(self.routes.prompt_studio_validate_final_prompts(request))
        self.assertEqual(status, 400)
        self.assertIn("dreamlike", data["error"])

    def test_seeded_native_cache_changes_when_rules_change(self):
        before = self.nodes._llm_node_change_token(42)
        self.save(("cat", "dog"))
        self.assertNotEqual(before, self.nodes._llm_node_change_token(42))

    def test_native_amplifier_repairs_and_does_not_return_unresolved_matches(self):
        self.save(("dreamlike", ""))
        arguments = dict(text="a forest", additional_instructions="", model_profile="General Natural Language",
            style_preset="None", style_modifier="", framing_preset="None", framing_modifier="",
            thinking_mode="Disabled", embellishment_level="None", kobold_url="http://localhost:5001",
            max_response_tokens=200, temperature=0.7, top_p=0.9, top_k=40, min_p=0.0, rep_pen=1.0,
            rep_pen_range=256, sampler_seed=42)
        with mock.patch.object(self.nodes, "_generate_kcpp", side_effect=["A dreamlike forest", "A surreal forest"]):
            self.assertEqual(self.nodes.KCPP_PromptAmplify().amplify(**arguments)[0], "A surreal forest")
        with mock.patch.object(self.nodes, "_generate_kcpp", return_value="A dreamlike forest"):
            with self.assertRaises(ValueError):
                self.nodes.KCPP_PromptAmplify().amplify(**arguments)

    def test_prompt_agent_candidate_is_checked_and_repaired(self):
        self.save(("dreamlike", ""))
        payload = {"phase": "architect", "goal": "A forest", "rubric": {
            "summary": "A forest", "criteria": [{"id": "forest", "description": "Trees", "weight": 1, "hard": True}], "forbidden": []}}
        with mock.patch.object(self.routes, "_generate_kcpp", side_effect=[
            json.dumps({"prompt": "A dreamlike forest"}), json.dumps({"prompt": "A surreal forest"}),
        ]):
            self.assertEqual(self.routes._prompt_agent(payload)["candidate"]["prompt"], "A surreal forest")


if __name__ == "__main__":
    unittest.main()
