import copy
import json
from pathlib import Path
import statistics
import tempfile
import time
import unittest
from unittest import mock

from test_regressions import load_modules


def synthetic_chats(count):
    return [{"id": f"chat-{index:04d}", "title": f"Chat {index}", "createdAt": index,
             "messages": [{"id": "user", "role": "user", "createdAt": index, "text": "Prompt"},
                          {"id": "result", "role": "assistant", "createdAt": index,
                           "workflowSnapshot": {"workflow": {"nodes": [], "payload": "x" * 16384}, "output": {"1": {"inputs": {}}}}}]}
            for index in range(count)]


class HistoryPagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        _, self.routes = load_modules(self.temp.name)
        self.routes.CHAT_STORE_PATH = str(Path(self.temp.name) / "chats.json")
        self.routes.CHAT_STORE_DIR = str(Path(self.temp.name) / "chats")
        self.chats = synthetic_chats(100)
        self.routes._write_split_chat_store({"version": 2, "revision": 1, "activeChatId": "chat-0000", "chats": self.chats})

    def tearDown(self):
        self.temp.cleanup()

    def reads(self):
        service = self.routes.transactional_store
        return mock.patch.object(service, "_read_record_bytes", wraps=service._read_record_bytes)

    def test_revision_poll_and_summary_page_open_no_histories(self):
        with self.reads() as reads:
            result, status = self.routes._read_chat_query({"revision": "1"})
            self.assertEqual(status, 204)
            result, status = self.routes._read_chat_query({"summaries": "1", "limit": "20"})
        self.assertEqual(status, 200)
        self.assertEqual(len(result["summaries"]), 20)
        self.assertEqual(result["chats"], [])
        self.assertFalse(result["summaries"][0]["isEmpty"])
        reads.assert_not_called()

    def test_detail_and_full_page_read_only_requested_records(self):
        with self.reads() as reads:
            detail, _ = self.routes._read_chat_query({"chat_id": "chat-0003"})
            self.assertEqual(reads.call_count, 1)
            reads.reset_mock()
            page, _ = self.routes._read_chat_query({"limit": "20", "include_active": "1"})
            self.assertEqual(reads.call_count, 21)
        self.assertEqual(detail["chats"], [self.chats[3]])
        self.assertEqual(page["chats"][-1]["id"], "chat-0000")

    def test_partial_edit_opens_one_chat_and_retains_unrelated_snapshots(self):
        changed = copy.deepcopy(self.chats[3])
        changed["title"] = "Changed"
        before = self.routes._read_chat_index()
        with self.reads() as reads:
            saved = self.routes._update_chat_store({"revision": 1, "partial": True, "activeChatId": "chat-0003", "chats": [changed]})
        self.assertEqual(reads.call_count, 1)
        self.assertEqual(saved["revision"], 2)
        after = self.routes._read_chat_index()
        self.assertEqual(before["chatFiles"][4], after["chatFiles"][4])
        self.assertNotEqual(before["chatFiles"][3]["file"], after["chatFiles"][3]["file"])

    def test_initial_page_also_hydrates_older_pending_jobs(self):
        changed = copy.deepcopy(self.chats[3])
        changed["messages"][1]["generationState"] = "queued"
        self.routes._update_chat_store({"revision": 1, "partial": True, "chats": [changed]})
        page, _ = self.routes._read_chat_query({"limit": "20", "include_active": "1", "include_pending": "1"})
        self.assertEqual(len(page["chats"]), 22)
        self.assertIn("chat-0003", [chat["id"] for chat in page["chats"]])

    def test_cursor_remains_stable_after_deletion(self):
        page, _ = self.routes._read_chat_query({"limit": "20", "summaries": "1"})
        self.routes._update_chat_store({"revision": 1, "partial": True, "chats": [], "deletedChatIds": ["chat-0090"]})
        cursor = page["nextCursor"]
        next_page, _ = self.routes._read_chat_query({"limit": "20", "summaries": "1", "before_activity": str(cursor["activity"]),
                                                    "before_created": str(cursor["createdAt"]), "before_id": cursor["id"]})
        self.assertFalse({item["id"] for item in page["summaries"]} & {item["id"] for item in next_page["summaries"]})
        self.assertEqual(next_page["summaries"][0]["id"], "chat-0079")

    def test_bounded_maintenance_builds_missing_summaries_explicitly(self):
        index_path = Path(self.routes.CHAT_STORE_DIR) / "index.json"
        index = json.loads(index_path.read_text(encoding="utf-8"))
        for entry in index["chatFiles"]:
            entry.pop("summary")
        index_path.write_text(json.dumps(index), encoding="utf-8")
        with self.reads() as reads:
            result, status = self.routes._read_chat_query({"summaries": "1", "limit": "20"})
        self.assertEqual(status, 202)
        self.assertTrue(result["maintenance_required"])
        reads.assert_not_called()
        with self.reads() as reads, mock.patch.object(self.routes, "_relink_plot_chats", side_effect=lambda data: (data, False)):
            maintained = self.routes._maintain_chat_store(0, 20)
        self.assertEqual(reads.call_count, 20)
        self.assertEqual(maintained["processed"], 20)
        self.assertTrue(maintained["hasMore"])

    def test_get_does_not_prune_or_relink(self):
        with mock.patch.object(self.routes, "_prune_consult_history") as prune, mock.patch.object(self.routes, "_relink_plot_chats") as relink:
            self.routes._read_chat_query({"limit": "20"})
        prune.assert_not_called()
        relink.assert_not_called()

    def test_corrupt_detail_retains_whole_snapshot_recovery_contract(self):
        changed = copy.deepcopy(self.chats[3])
        changed["title"] = "Changed"
        self.routes._update_chat_store({"revision": 1, "partial": True, "chats": [changed]})
        index = self.routes._read_chat_index()
        entry = next(entry for entry in index["chatFiles"] if entry["id"] == changed["id"])
        (Path(self.routes.CHAT_STORE_DIR) / entry["file"]).write_bytes(b"corrupt")
        detail, status = self.routes._read_chat_query({"chat_id": changed["id"]})
        self.assertEqual(status, 200)
        self.assertEqual(detail["revision"], 1)
        self.assertIn("recovery", detail)
        self.assertEqual(detail["chats"], [self.chats[3]])

    def test_synthetic_100_and_1000_history_measurements(self):
        measurements = []
        for count in (100, 1000):
            with tempfile.TemporaryDirectory() as directory:
                self.routes.CHAT_STORE_DIR = str(Path(directory) / "chats")
                chats = synthetic_chats(count)
                data = {"version": 2, "revision": 1, "activeChatId": chats[0]["id"], "chats": chats}
                self.routes._write_split_chat_store(data)
                self.routes._read_chat_query({"summaries": "1", "limit": "20"})
                timings = []
                with self.reads() as reads:
                    for _ in range(25):
                        started = time.perf_counter()
                        page, _ = self.routes._read_chat_query({"summaries": "1", "limit": "20"})
                        timings.append((time.perf_counter() - started) * 1000)
                self.assertEqual(reads.call_count, 0)
                self.assertEqual(len(page["summaries"]), 20)
                partial = {"revision": 1, "partial": True, "chats": [chats[0]]}
                measurements.append({"records": count, "summary_records_opened": reads.call_count,
                                     "summary_response_bytes": len(json.dumps(page).encode()),
                                     "single_edit_request_bytes": len(json.dumps(partial).encode()),
                                     "full_store_request_bytes": len(json.dumps(data).encode()),
                                     "summary_p50_ms": round(statistics.median(timings), 3),
                                     "summary_p95_ms": round(sorted(timings)[23], 3)})
        print("IMAGE_HISTORY_BENCHMARK " + json.dumps(measurements))


if __name__ == "__main__":
    unittest.main()
