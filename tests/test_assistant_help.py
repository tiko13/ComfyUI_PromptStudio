import copy
import asyncio
import importlib.util
import itertools
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("assistant_help_test", ROOT / "assistant_help.py")
help = importlib.util.module_from_spec(spec)
spec.loader.exec_module(help)


class HelpCatalogTests(unittest.TestCase):
    def test_creation_help_explains_actual_composer_and_generation_toggle(self):
        facts = help.normalize_facts({"send_label": "Send", "auto_generate_label": "Generate after revision",
                                      "auto_generate": False, "llm_amplification": True})
        packet = help.render_packet(help.load_catalog(), facts, ["create-image"])
        self.assertEqual(packet["documents"], ["create-image"])
        instructions = "\n".join(packet["instructions"])
        self.assertIn("message box at the bottom", instructions)
        self.assertIn("Enable Generate after revision", instructions)
        self.assertIn("automatic generation enabled: False", instructions)
        self.assertIn("Current action button: Send", instructions)

    def test_no_workflow_reference_input_keeps_vision_prompt_reference_help(self):
        packet = help.render_packet(help.load_catalog(), help.normalize_facts({"mode":"create", "reference_mode":"none"}), ["references"])
        self.assertEqual(packet["documents"], ["references", "references.none"])
        instructions = "\n".join(packet["instructions"])
        self.assertIn("paste one image with Ctrl+V", instructions)
        self.assertIn("vision LLM to guide the text prompt", instructions)
        self.assertIn("no workflow References tile", instructions)

    def test_catalog_variants_and_all_topic_combinations_fit_budget(self):
        cards = help.load_catalog()
        for mode, expected in [("qwen", "references.qwen"), ("single", "references.single"),
                               ("inputs", "references.inputs"), ("none", "references.none"), ("unknown", None)]:
            facts = help.normalize_facts({"reference_mode": mode, "reference_limit": 9})
            packet = help.render_packet(cards, facts, ["references"])
            self.assertEqual(packet["documents"], ["references"] + ([expected] if expected else []))
            for topics in itertools.combinations([item["topic"] for item in help.topic_index(cards, facts)], 3):
                help.render_packet(cards, facts, list(topics))
        text = help.render_packet(cards, help.normalize_facts({"reference_mode": "qwen", "reference_limit": 7}), ["references"])
        self.assertIn("up to 7 additional", "\n".join(text["instructions"]))

    def test_automatic_discovery_and_invalid_fact_detection(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "new-feature.md"
            header = '---\n{"id":"new","topic":"new-feature","studio":"shared","summary":"A new feature."}\n---\n'
            path.write_text(header + "Current workflow: {workflow}.", encoding="utf-8")
            cards = help.load_catalog((directory,))
            self.assertIn("new-feature", [item["topic"] for item in help.topic_index(cards, help.normalize_facts({}))])
            path.write_text(header + "Use {removed_control}.", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Unknown help fact"):
                help.load_catalog((directory,))

    def test_selector_cannot_inject_arbitrary_files_or_topics(self):
        cards, facts = help.load_catalog(), help.normalize_facts({})
        with self.assertRaises(ValueError):
            help.render_packet(cards, facts, ["../../secrets"])
        packet = help.retrieve([], facts, lambda *_: {"topics": ["invented"]})
        self.assertTrue(packet["unavailable"])
        self.assertEqual(packet["documents"], [])

    def test_lookup_uses_index_without_document_bodies_or_images(self):
        facts = help.normalize_facts({"reference_mode": "qwen"})
        messages = [{"role": "assistant", "text": "Open References."},
                    {"role": "user", "text": "Where is that button?", "images": [{"filename": "private.png"}], "context": {"main_prompt": "private prompt"}}]
        def select(payload, schema):
            serialized = json.dumps(payload)
            self.assertNotIn("private", serialized)
            self.assertNotIn("Custom instruction role", serialized)
            self.assertIn("Where is that button", serialized)
            return {"topics": ["references"]}
        self.assertIn("references.qwen", help.retrieve(messages, facts, select)["documents"])


class HelpRouteTests(unittest.TestCase):
    def setUp(self):
        from test_regressions import load_modules
        self.storage = tempfile.TemporaryDirectory()
        self.addCleanup(self.storage.cleanup)
        self.nodes, self.routes = load_modules(self.storage.name)

    def test_prompting_advice_does_not_read_catalog_or_add_lookup(self):
        with mock.patch.object(self.routes._assistant_help, "load_catalog") as load, mock.patch.object(self.routes, "_consult", return_value='{"message":"Try cap sleeves.","proposal":null}') as consult:
            result = self.routes._studio_discuss({"help_domain": "prompting", "messages": [{"role": "user", "text": "How do I make tiny sleeves?"}]})
        self.assertEqual(result["message"], "Try cap sleeves.")
        load.assert_not_called()
        self.assertEqual(consult.call_count, 1)
        self.assertNotIn("Product documentation", consult.call_args.args[1])

    def test_app_help_removes_vision_and_cannot_offer_prompt_mutation(self):
        request = {"help_domain": "app", "help_context": {"reference_mode": "qwen", "reference_limit": 9},
                   "messages": [{"role": "user", "text": "How do I add references?", "images": [{"filename": "x.png"}], "context": {"main_prompt": "A cat"}}]}
        original = copy.deepcopy(request)
        responses = ['{"topics":["references"]}', '{"message":"Open References.","proposal":{"invalid":"must be ignored"}}']
        with mock.patch.object(self.routes, "_consult", side_effect=responses) as consult:
            result = self.routes._studio_discuss(request)
        self.assertIsNone(result["proposal"])
        self.assertIn("references.qwen", result["help_documents"])
        self.assertEqual(consult.call_args.args[0]["messages"], [{"role": "user", "text": "How do I add references?"}])
        self.assertIn("up to 9 additional", consult.call_args.args[1])
        self.assertEqual(request, original)

    def test_workflow_switch_retrieves_fresh_variant(self):
        for mode, expected in [("qwen", "references.qwen"), ("single", "references.single")]:
            with mock.patch.object(self.routes, "_consult", side_effect=['{"topics":["references"]}', '{"message":"Steps.","proposal":null}']):
                result = self.routes._studio_discuss({"help_domain": "app", "help_context": {"reference_mode": mode}, "messages": [{"role": "user", "text": "And now?"}]})
                self.assertIn(expected, result["help_documents"])

    def test_consultation_classifies_then_loads_only_app_help(self):
        request = {"help_context": {}, "messages": [{"role": "user", "text": "How to change model?"}]}
        router = {"route": "discuss", "confidence": 1, "resolved_instruction": "", "reason": "Help", "help_domain": "app", "app_help_query": "How to change model?"}
        with mock.patch.object(self.routes, "_consult", side_effect=[json.dumps(router), '{"topics":["models"]}', '{"message":"Use the Model section.","proposal":null}']) as consult:
            answer = self.routes._consult_with_help(request)
        self.assertEqual(consult.call_count, 3)
        self.assertEqual(answer["help_documents"], ["models"])
        self.assertNotIn("documentation index", consult.call_args_list[0].args[1])

    def test_both_preserves_creative_context_without_applying_proposal(self):
        request = {"help_domain": "both", "messages": [{"role": "user", "text": "Describe short sleeves and explain model selection.", "context": {"main_prompt": "A shirt"}}]}
        with mock.patch.object(self.routes, "_consult", side_effect=['{"topics":["models"]}', '{"message":"Advice.","proposal":null}']) as consult:
            self.routes._studio_discuss(request)
        self.assertEqual(consult.call_args.args[0]["messages"][0]["context"]["main_prompt"], "A shirt")

    def test_mixed_experiment_answers_help_without_feeding_docs_to_prompt_generation(self):
        request = {"help_context": {}, "experiment_mode": True,
                   "messages": [{"role":"user","text":"Make the shirt red, and how do I change model?"}]}
        routed = {"route":"mutate_now","confidence":1,"resolved_instruction":"Make the shirt red.",
                  "reason":"Mixed request","help_domain":"app","app_help_query":"How do I change model?"}
        with mock.patch.object(self.routes, "_consult", side_effect=[json.dumps(routed), '{"topics":["models"]}',
            '{"message":"Use the Model section.","proposal":null}', "Creative experiment answer."]) as consult:
            result = self.routes._consult_with_help(request)
        self.assertTrue(result["allow_experiment_proposal"])
        self.assertIn("Use the Model section.", result["message"])
        creative_request = consult.call_args.args[0]
        self.assertEqual(creative_request["messages"][-1]["text"], "Make the shirt red.")
        self.assertNotIn("Product documentation", json.dumps(creative_request))

    def test_invalid_help_domain_is_rejected(self):
        with self.assertRaises(ValueError):
            self.routes._studio_discuss({"help_domain": "upload_everything"})

    def test_sync_and_async_consult_endpoints_return_text_not_nested_objects(self):
        result = {"message": "Use the Model section.", "proposal": None, "help_documents": ["models"]}
        class Request:
            content_length = 10
            match_info = {"job_id": "help-job"}
            async def json(self):
                return {"help_context": {}, "messages": [{"role":"user","text":"How do I change model?"}]}
        with mock.patch.object(self.routes, "_run_llm_request", new=mock.AsyncMock(return_value=result)):
            payload, status = asyncio.run(self.routes.prompt_studio_chat(Request()))
        self.assertEqual(status, 200)
        self.assertEqual(payload, result)
        with mock.patch.dict(self.routes.CONSULT_JOBS, {"help-job": {"status":"complete", "result":result}}):
            payload, status = asyncio.run(self.routes.prompt_studio_chat_status(Request()))
        self.assertEqual(payload["result"], result)
        self.assertEqual(self.routes._consult_response_payload("Ordinary answer"), {"message":"Ordinary answer"})


if __name__ == "__main__":
    unittest.main()
