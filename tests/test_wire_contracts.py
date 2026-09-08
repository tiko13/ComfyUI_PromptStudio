import json
from pathlib import Path
import unittest
from typing import get_args

import wire_contracts as contracts


class WireContractsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = json.loads((Path(__file__).resolve().parents[1] / "web/js/prompt-studio/core/wire-contract-fixtures.json").read_text(encoding="utf-8"))

    def test_typed_enums_match_canonical_data(self):
        self.assertEqual(get_args(contracts.LlmProvider), contracts.PROVIDERS)
        self.assertEqual(get_args(contracts.JobStatus), contracts.JOB_STATUSES)

    def test_legacy_fixtures(self):
        for kind, normalize in (("provider", contracts.normalize_provider_settings), ("job", contracts.normalize_job_wire), ("snapshot", contracts.normalize_snapshot_wire)):
            for fixture in self.fixtures[kind + "_legacy"]:
                with self.subTest(kind=kind, fixture=fixture):
                    before = json.dumps(fixture["input"], sort_keys=True)
                    result = normalize(fixture["input"])
                    if kind == "provider":
                        for key, expected in fixture["expected"].items():
                            self.assertEqual(result[key], expected)
                    else:
                        self.assertEqual(result, fixture["expected"])
                    self.assertEqual(json.dumps(fixture["input"], sort_keys=True), before)

    def test_provider_version_enum_unknown_fields_and_bad_numbers(self):
        for data in ({"wire_version": 2}, {"wire_version": True}, {"wire_version": 1, "llm_provider": "typo"}, {"temperature": None}, {"temperature": float("nan")}, {"temperature": 6}):
            with self.subTest(data=data), self.assertRaises(ValueError):
                contracts.normalize_provider_settings(data)
        with self.assertRaisesRegex(ValueError, "Unknown provider fields"):
            contracts.normalize_provider_settings({"llm_provder": "ollama"}, strict=True)

    def test_new_snapshot_envelope_is_required_and_copy_is_immutable(self):
        for snapshot in ({"workflow": {}}, {"output": {}}, {"workflow": [], "output": {}}):
            with self.subTest(snapshot=snapshot), self.assertRaises(ValueError):
                contracts.normalize_snapshot_wire({"wire_version": 1, "kind": "workflow_snapshot", "snapshot": snapshot})
        original = self.fixtures["snapshot_legacy"][0]["input"]
        result = contracts.normalize_snapshot_wire(original)
        result["snapshot"]["custom"]["keep"] = False
        self.assertTrue(original["custom"]["keep"])

    def test_all_job_transitions_and_terminal_payloads(self):
        for previous in contracts.JOB_STATUSES:
            for following in contracts.JOB_STATUSES:
                if following in contracts.JOB_TRANSITIONS[previous]:
                    contracts.assert_job_transition(previous, following)
                else:
                    with self.assertRaises(ValueError):
                        contracts.assert_job_transition(previous, following)
        for status in ("complete", "failed", "misspelled"):
            with self.assertRaises(ValueError):
                contracts.normalize_job_wire({"job_id": "job", "status": status})
