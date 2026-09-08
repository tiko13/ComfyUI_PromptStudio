import copy
import json
import tempfile
import unittest
from unittest import mock


class PromptAgentJudgingTests(unittest.TestCase):
    def setUp(self):
        from test_regressions import load_modules
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        _, self.routes = load_modules(self.directory.name)
        patch = mock.patch.object(self.routes, "_chat_image_vision_payload", side_effect=lambda value: ("pixels:" + json.loads(value)["filename"], "data:image/png;base64," + json.loads(value)["filename"]))
        patch.start(); self.addCleanup(patch.stop)
        self.payload = {"phase": "evaluate", "goal": "A red mug matching the supplied handle shape", "candidate": {"prompt": "SECRET TEXT MUST NOT EARN SUCCESS"},
                        "rubric": {"summary": "Mug shape", "criteria": [{"id": "shape", "description": "The required handle shape is visible", "weight": 1, "hard": True}], "forbidden": []},
                        "references": [{"purpose": "handle geometry", "image": {"filename": "reference.png", "type": "input", "subfolder": ""}}],
                        "generated_images": [{"filename": "candidate.png", "type": "output", "subfolder": ""}], "max_response_tokens": 1000}

    def evaluation(self, *, status="pass", score=95, evidence="The red mug and round handle are visible"):
        return {"score": score, "confidence": 0.95, "pass": True, "criteria": [{"id": "shape", "status": status, "score": score, "evidence": evidence}], "forbidden": [], "defects": [], "summary": "Visible assessment", "next_revision": "Make the handle match"}

    def test_default_is_one_candidate_only_assessment_without_prompt_leakage(self):
        with mock.patch.object(self.routes, "_generate_kcpp", return_value=json.dumps(self.evaluation())) as generate:
            result = self.routes._prompt_agent(self.payload)
        self.assertEqual(generate.call_count, 1)
        messages = generate.call_args.kwargs["messages_override"]
        self.assertNotIn("SECRET", json.dumps(messages))
        self.assertNotIn("reference.png", json.dumps(messages))
        self.assertIn("candidate.png", json.dumps(messages))
        self.assertTrue(result["evaluation"]["pass"])
        self.assertEqual(result["metrics"]["model_calls"], 1)
        self.assertFalse(result["metrics"]["calibration_measured"])

    def test_opt_in_attaches_labeled_actual_reference_and_candidate_pixels_only_in_second_pass(self):
        with mock.patch.object(self.routes, "_generate_kcpp", side_effect=[json.dumps(self.evaluation()), json.dumps(self.evaluation(status="partial", score=40, evidence="Reference 1 handle is narrow; Generated result 1 handle is round"))]) as generate:
            result = self.routes._prompt_agent({**self.payload, "reference_comparison": True})
        self.assertEqual(generate.call_count, 2)
        first, second = [call.kwargs["messages_override"] for call in generate.call_args_list]
        self.assertNotIn("reference.png", json.dumps(first))
        labels = json.loads(second[1]["content"][0]["text"])["attached_images_in_order"]
        self.assertEqual([label["label"] for label in labels], ["Reference 1", "Generated result 1"])
        self.assertIn("reference.png", second[1]["content"][1]["image_url"]["url"])
        self.assertIn("candidate.png", second[1]["content"][2]["image_url"]["url"])
        self.assertFalse(result["evaluation"]["pass"])
        self.assertEqual(result["evaluation"]["score"], 40)
        self.assertIn("Reference 1", result["evaluation"]["criteria"][0]["reference_evidence"])
        self.assertEqual(result["metrics"]["model_calls"], 2)
        self.assertGreaterEqual(result["metrics"]["elapsed_ms"], 0)

    def test_reference_success_never_rescues_missing_hard_criterion_or_empty_evidence(self):
        for candidate in [self.evaluation(status="fail"), self.evaluation(evidence="")]:
            with self.subTest(candidate=candidate), mock.patch.object(self.routes, "_generate_kcpp", side_effect=[json.dumps(candidate), json.dumps(self.evaluation())]):
                self.assertFalse(self.routes._prompt_agent({**self.payload, "reference_comparison": True})["evaluation"]["pass"])

    def test_reference_pass_keeps_serious_defects_separate_from_criterion_score(self):
        comparison = self.evaluation()
        comparison["defects"] = [{"description": "Handle visibly detached", "location": "right side of mug", "severity": "serious", "confidence": 0.99}]
        with mock.patch.object(self.routes, "_generate_kcpp", side_effect=[json.dumps(self.evaluation()), json.dumps(comparison)]):
            result = self.routes._prompt_agent({**self.payload, "reference_comparison": True})["evaluation"]
        self.assertEqual(result["score"], 95)
        self.assertFalse(result["pass"])
        self.assertIn("Handle visibly detached", result["defects"])

    def test_no_reference_fails_before_spending_a_call_and_cancellation_stops_extra_pass(self):
        with mock.patch.object(self.routes, "_generate_kcpp") as generate:
            with self.assertRaisesRegex(ValueError, "requires at least"):
                self.routes._prompt_agent({**self.payload, "reference_comparison": True, "references": []})
        generate.assert_not_called()
        with mock.patch.object(self.routes, "_generate_kcpp", return_value=json.dumps(self.evaluation())) as generate:
            with self.assertRaisesRegex(RuntimeError, "cancelled"):
                self.routes._prompt_agent({**self.payload, "reference_comparison": True}, cancellation_check=lambda: generate.call_count >= 1)
        self.assertEqual(generate.call_count, 1)

    def test_completion_budget_retry_is_shared_between_the_two_passes(self):
        exhausted = RuntimeError("exhausted the 4096-token completion budget")
        with mock.patch.object(self.routes, "_generate_kcpp", side_effect=[exhausted, json.dumps(self.evaluation()), exhausted]) as generate:
            with self.assertRaisesRegex(RuntimeError, "completion budget"):
                self.routes._prompt_agent({**self.payload, "reference_comparison": True})
        self.assertEqual(generate.call_count, 3)
