import json
import asyncio
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace

import job_observability as jobs


class JobObservabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "jobs.sqlite3"
        self.now = 1000.0
        self.ledger = jobs.JobLedger(self.path, clock=lambda: self.now)

    def tearDown(self):
        self.ledger.close()
        self.temp.cleanup()

    def test_restart_marks_unfinished_jobs_and_preserves_completion(self):
        self.ledger.start("active", kind="director", studio="video", data={"project_id": "project-1"})
        self.ledger.update("active", studio="video", phase="generation")
        self.ledger.start("done", kind="consult")
        self.ledger.update("done", state="complete")
        self.ledger.close()
        self.ledger = jobs.JobLedger(self.path, clock=lambda: self.now)
        self.assertEqual(self.ledger.get("active", studio="video")["state"], "interrupted")
        self.assertEqual(self.ledger.get("done")["state"], "complete")
        with self.assertRaisesRegex(jobs.JobAlreadyRecorded, "reruns inference"):
            self.ledger.start("active", studio="video")
        self.assertEqual(self.ledger.start("explicit-retry", studio="video")["state"], "queued")

    def test_stage_timing_origin_and_cancel_state_survive_updates(self):
        self.ledger.start("job", kind="extension_plan", studio="video", data={"origin": {"project_id": "project-1"}}, queue_position=2)
        self.now += .25
        self.ledger.update("job", studio="video", phase="intent_classification")
        self.now += .5
        self.ledger.update("job", studio="video", phase="vision_grounding")
        self.now += 1
        self.ledger.update("job", studio="video", state="cancelled", cancellation_requested=True)
        value = self.ledger.get("job", studio="video")
        self.assertEqual(value["stage_ms"], {"queued": 250, "routing": 500, "grounding": 1000})
        self.assertEqual(value["origin"], {"project_id": "project-1"})
        self.assertTrue(value["cancellation_requested"])
        self.assertIsNone(value["queue_position"])
        self.assertEqual(value["retry_action"], "replan")

    def test_prompts_credentials_paths_and_errors_never_enter_storage_or_export(self):
        secret = "SECRET_PRIVATE_CONTENT_012345"
        self.ledger.start(secret, data={"prompt": secret, "messages": [{"content": secret}],
                          "origin": {"chat_id": secret}, "llamacpp_url": "https://user:secret@example.test/", "model": secret})
        self.ledger.update(secret, state="failed", error=RuntimeError(secret))
        encoded = json.dumps(self.ledger.diagnostic_export())
        self.assertNotIn(secret, encoded)
        self.assertNotIn("example.test", encoded)
        self.assertNotIn("prompt", encoded)
        stored = self.ledger._connection.execute("SELECT payload FROM jobs").fetchone()[0]
        self.assertNotIn('"messages"', stored)
        self.assertNotIn('"model"', stored)
        self.assertNotIn("example.test", stored)
        self.assertEqual(self.ledger.get(secret)["error"]["code"], "provider_failed")

    def test_export_validates_allowlist_values_even_for_old_or_tampered_metadata(self):
        self.ledger.start("job")
        record = self.ledger._jobs["image:job"]
        record.update(provider="PRIVATE_SECRET", state="PRIVATE_SECRET", stage_ms={"PRIVATE_SECRET": "PRIVATE_SECRET"})
        record["error"] = {"code": "PRIVATE_SECRET", "message": "PRIVATE_SECRET"}
        self.assertNotIn("PRIVATE_SECRET", json.dumps(self.ledger.diagnostic_export()))

    def test_retention_and_export_are_bounded_without_evicting_active_markers(self):
        with mock.patch.object(jobs, "MAX_JOBS", 3), mock.patch.object(jobs, "MAX_EXPORT_BYTES", 1000):
            self.ledger.start("active")
            for index in range(10):
                self.ledger.start(str(index))
                self.ledger.update(str(index), state="complete")
                self.now += 1
            self.assertEqual(len(self.ledger.snapshot()["jobs"]), 3)
            self.assertIsNotNone(self.ledger.get("active"))
            count = self.ledger._connection.execute("SELECT count(*) FROM jobs").fetchone()[0]
            self.assertEqual(count, 3)
            exported = self.ledger.diagnostic_export()
            self.assertLessEqual(len(json.dumps(exported, separators=(",", ":")).encode()), 1000)
            self.assertTrue(exported["truncated"])

    def test_full_active_ledger_rejects_new_admission(self):
        with mock.patch.object(jobs, "MAX_JOBS", 2):
            self.ledger.start("one")
            self.ledger.start("two")
            with self.assertRaises(jobs.JobMetadataFull):
                self.ledger.start("three")
        self.assertEqual(len(self.ledger.snapshot()["jobs"]), 2)

    def test_completed_output_marker_returns_actionable_legacy_failure_without_output(self):
        self.ledger.start("job", kind="director")
        self.ledger.update("job", state="complete")
        with mock.patch.object(jobs, "shared_job_ledger", return_value=self.ledger):
            body = jobs.shared_job_status("job")
        self.assertEqual(body["status"], "failed")
        self.assertEqual(body["code"], "result_unavailable")
        self.assertIn("Check its saved output", body["error"])
        self.assertNotIn("result", body)


class ImageJobIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_recovered_id_stops_without_replaying_and_new_id_runs(self):
        from test_regressions import load_modules
        with tempfile.TemporaryDirectory() as directory:
            _nodes, routes = load_modules(directory)
            ledger = routes.shared_job_ledger()
            ledger.start("old", kind="consult", data={"origin": {"chat_id": "original"}})
            ledger.update("old", state="interrupted", code="server_restarted")
            try:
                with self.assertRaises(RuntimeError) as raised:
                    routes._start_consult_job({"job_id": "old"})
                self.assertEqual(routes._llm_error_response(raised.exception)[1], 409)
                body, status = await routes.prompt_studio_chat_status(SimpleNamespace(match_info={"job_id": "old"}))
                self.assertEqual(status, 200)
                self.assertEqual(body["job"]["state"], "interrupted")
                self.assertEqual(body["job"]["origin"], {"chat_id": "original"})
                self.assertFalse(routes.CONSULT_TASKS)
                with mock.patch.object(routes, "_consult", return_value="new answer"), \
                     mock.patch.object(routes, "_prepare_shared_gpu_for_llm"):
                    job_id = routes._start_consult_job({"job_id": "fresh", "origin": {"chat_id": "original"}})
                    await routes.CONSULT_JOBS[job_id]["task"]
                self.assertEqual(ledger.get("fresh")["state"], "complete")
                self.assertEqual(routes.CONSULT_JOBS["fresh"]["result"], "new answer")
            finally:
                await routes.shared_llm_shutdown()
                ledger.close()


if __name__ == "__main__":
    unittest.main()
