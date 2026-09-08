import copy
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from prompt_evals import cases, validate_cases
from prompt_evals.__main__ import main
from prompt_evals.adapters import openai_compatible, synthetic_image
from prompt_evals.invariants import check_output, mutated
from prompt_evals.runner import blinded_export, compare, summarize


class PromptEvaluationTests(unittest.TestCase):
    def setUp(self):
        self.matrix = cases()
        self.by_id = {case["id"]: case for case in self.matrix}
        self.baseline = {"version": "baseline-v1", "policy_version": "policy-v1", "prompt": "PRIVATE_BASELINE_PROMPT"}
        self.candidate = {"version": "candidate-v2", "policy_version": "policy-v1", "prompt": "PRIVATE_CANDIDATE_PROMPT"}

    def perfect_adapter(self, case, variant, settings, seed):
        self.assertNotIn("accepted_output", case)
        self.assertNotIn("invariants", case)
        output = self.by_id[case["id"]]["accepted_output"]
        return {"output": output, "first_output": output, "correction_calls": 0}

    def test_versioned_fixtures_and_adversarial_rejections_run_offline(self):
        self.assertGreaterEqual(validate_cases(self.matrix), 16)
        for case in self.matrix:
            self.assertFalse(check_output(case, case["accepted_output"]))
            for mutation in case["rejected_mutations"]:
                self.assertTrue(check_output(case, mutated(case["accepted_output"], mutation)), case["id"])

    def test_default_cli_cannot_contact_a_provider(self):
        with mock.patch("urllib.request.urlopen", side_effect=AssertionError("No network in CI")), mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(main([]), 0)
        self.assertEqual(json.loads(output.getvalue())["inference_calls"], 0)

    def test_control_pairs_use_equal_cases_settings_seeds_and_repetitions(self):
        calls = []

        def adapter(case, variant, settings, seed):
            calls.append((case["id"], variant["version"], copy.deepcopy(settings), seed))
            settings["temperature"] = 99
            return self.perfect_adapter(case, variant, settings, seed)

        common = {"provider": "synthetic", "model": "fake", "temperature": 0.2, "api_key": "PRIVATE_KEY"}
        report = compare(self.matrix[:2], self.baseline, self.candidate, common, seeds=[17, 41], repeats=2, adapter=adapter)
        self.assertEqual(len(calls), 16)
        self.assertTrue(all(item[2]["temperature"] == 0.2 for item in calls))
        self.assertEqual(report["summary"]["baseline"]["success_rate"], 1)
        self.assertEqual(report["summary"]["candidate"]["success_rate"], 1)
        for identifier in (case["id"] for case in self.matrix[:2]):
            for seed in (17, 41):
                for version in ("baseline-v1", "candidate-v2"):
                    self.assertEqual(sum(item[0] == identifier and item[1] == version and item[3] == seed for item in calls), 2)
        serialized = json.dumps(report)
        self.assertNotIn("PRIVATE_KEY", serialized)
        self.assertNotIn("PRIVATE_BASELINE_PROMPT", serialized)
        self.assertEqual(common["temperature"], 0.2)
        self.assertEqual([item[1] for item in calls[:4]], ["baseline-v1", "candidate-v2", "candidate-v2", "baseline-v1"])

    def test_opt_in_cli_saves_local_comparison_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline, candidate, output = root / "baseline.json", root / "candidate.json", root / "results.json"
            baseline.write_text(json.dumps(self.baseline), encoding="utf-8")
            candidate.write_text(json.dumps(self.candidate), encoding="utf-8")
            argv = ["--live", "--case", "image-noop", "--baseline", str(baseline), "--candidate", str(candidate),
                    "--model", "fixture", "--seed", "17", "--repeats", "2", "--output", str(output)]
            with mock.patch("prompt_evals.__main__.openai_compatible", side_effect=self.perfect_adapter) as adapter, mock.patch("sys.stdout", new_callable=io.StringIO):
                self.assertEqual(main(argv), 0)
                self.assertEqual(adapter.call_count, 4)
                with mock.patch("sys.stderr", new_callable=io.StringIO), self.assertRaises(SystemExit):
                    main(argv)
                self.assertEqual(adapter.call_count, 4)
            self.assertEqual(len(json.loads(output.read_text())["records"]), 4)

    def test_main_control_leak_is_detected_even_when_individual_checks_pass(self):
        def adapter(case, variant, settings, seed):
            answer = copy.deepcopy(self.perfect_adapter(case, variant, settings, seed))
            if case["id"].endswith("cinematic"):
                answer["output"]["main_prompt"] = "A cat beside a wooden window looks outside."
            return answer

        report = compare(self.matrix[:2], self.baseline, self.candidate, {}, seeds=[1], repeats=1, adapter=adapter)
        self.assertEqual(report["summary"]["baseline"]["unintended_change_rate"], 1)
        self.assertEqual(report["summary"]["baseline"]["success_rate"], 0)

    def test_unknown_first_pass_and_corrections_are_not_reported_as_success(self):
        report = compare(self.matrix[:1], self.baseline, self.candidate, {}, seeds=[1], repeats=1,
                         adapter=lambda case, *_args: {"output": self.by_id[case["id"]]["accepted_output"]})
        self.assertIsNone(report["summary"]["baseline"]["first_pass_validity"])
        self.assertIsNone(report["summary"]["baseline"]["mean_correction_calls"])

    def test_metrics_include_first_pass_corrections_and_nearest_rank_latency(self):
        rows = [{"failures": [] if index != 3 else [{"kind": "unintended_change"}],
                 "first_pass_valid": index < 2, "correction_calls": index,
                 "latency_seconds": index + 1} for index in range(4)]
        metrics = summarize(rows)
        self.assertEqual(metrics["success_rate"], 0.75)
        self.assertEqual(metrics["unintended_change_rate"], 0.25)
        self.assertEqual(metrics["first_pass_validity"], 0.5)
        self.assertEqual(metrics["total_correction_calls"], 6)
        self.assertEqual(metrics["p50_latency_seconds"], 2)
        self.assertEqual(metrics["p95_latency_seconds"], 4)

    def test_blind_export_requires_opt_in_and_hides_variant_provider_metadata(self):
        report = compare(self.matrix[:1], self.baseline, self.candidate, {"model": "SECRET_MODEL"}, seeds=[1], repeats=1, adapter=self.perfect_adapter)
        with self.assertRaisesRegex(ValueError, "explicit opt-in"):
            blinded_export(report, self.matrix)
        shared = blinded_export(report, self.matrix, allow_sharing=True)
        serialized = json.dumps(shared)
        self.assertNotIn("SECRET_MODEL", serialized)
        self.assertNotIn("baseline", serialized)
        self.assertNotIn("candidate", serialized)
        self.assertEqual({row["blind_id"] for row in shared["rows"]}, {row["blind_id"] for row in report["records"]})

    def test_private_duplicate_or_unknown_rule_fixtures_are_rejected(self):
        private = copy.deepcopy(self.matrix[:1])
        private[0]["synthetic"] = False
        with self.assertRaises(ValueError):
            validate_cases(private)
        with self.assertRaises(ValueError):
            validate_cases(self.matrix[:1] * 2)
        bad = copy.deepcopy(self.matrix[:1])
        bad[0]["invariants"][0]["op"] = "ask_model_judge"
        with self.assertRaises(ValueError):
            validate_cases(bad)

    def test_provider_payload_contains_no_accepted_output_or_oracle(self):
        response = io.StringIO(json.dumps({"model": "tiny", "usage": {"completion_tokens": 12},
                                          "choices": [{"message": {"content": '{"observations":"red and blue"}'}}]}))
        case = self.by_id["image-reference-grounding"]
        public = {key: case[key] for key in ("input", "prior_state", "controls", "product", "attachments")}
        public["output_fields"] = ["observations"]
        with mock.patch("urllib.request.urlopen", return_value=response) as opener:
            result = openai_compatible(public, self.baseline, {
                "provider": "fixture", "model": "tiny", "endpoint": "http://127.0.0.1:9999/v1/chat/completions",
            }, 17)
        payload = json.loads(opener.call_args.args[0].data)
        self.assertEqual(payload["seed"], 17)
        self.assertNotIn("accepted_output", json.dumps(payload))
        self.assertNotIn("invariants", json.dumps(payload))
        self.assertTrue(payload["messages"][1]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,"))
        self.assertEqual(result["token_usage"]["completion_tokens"], 12)
        self.assertEqual(result["correction_calls"], 0)

    def test_synthetic_attachment_is_generated_without_reading_user_media(self):
        with mock.patch("pathlib.Path.open", side_effect=AssertionError("No user image reads")):
            self.assertTrue(synthetic_image([["red", "blue"]]).startswith("data:image/png;base64,"))


if __name__ == "__main__":
    unittest.main()
