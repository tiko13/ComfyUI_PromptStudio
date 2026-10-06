import copy
import asyncio
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock

import transactional_store as store


class StorageRetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "chats"
        self.now = datetime(2026, 10, 5, 12, tzinfo=timezone.utc).timestamp()

    def tearDown(self):
        self.temp.cleanup()

    def save(self, revision, timestamp=None, label=None):
        records = [{"id": "one", "text": label or str(revision), "workflow": {"exact": "é ☃ " * 4096}},
                   {"id": "two", "text": "unchanged"}]
        result = store.commit_records(self.root, {"revision": revision, "activeChatId": "one"}, records, "chatFiles", "chat")
        timestamp = self.now if timestamp is None else timestamp
        os.utime(self.root / "index.json", (timestamp, timestamp))
        return result

    def optimize(self, **kwargs):
        return store.maintain_storage(self.root, "chatFiles", "chat", now=self.now, **kwargs)

    def make_legacy(self):
        # Convert a fixture into the actual previous uncompressed storage format.
        indexes = [self.root / "index.json", *store._backup_candidates(self.root)]
        for path in indexes:
            manifest = store._parse_manifest(path, "chatFiles")
            entries = []
            for entry in manifest["chatFiles"]:
                name = entry["file"].removesuffix(".gz")
                (self.root / name).write_bytes(store._read_record_bytes(self.root / entry["file"]))
                entries.append({**entry, "file": name})
            target = path.with_suffix("") if path.suffix == ".gz" else path
            stamp = path.stat().st_mtime
            target.write_bytes(store._encoded({**manifest, "chatFiles": entries, "storage_format": "immutable-json-v1"}))
            os.utime(target, (stamp, stamp))
            if target != path:
                path.unlink()
        for path in self.root.glob("chat_*.gz"):
            path.unlink()

    def test_compression_roundtrip_and_legacy_migration_preserve_exact_library(self):
        self.save(1)
        self.save(2)
        self.make_legacy()
        original = store.read_snapshot(self.root, "chatFiles", "chat")[1]
        before = sum(path.stat().st_size for path in self.root.rglob("*") if path.is_file())
        result = self.optimize()
        current, records = store.read_snapshot(self.root, "chatFiles", "chat")
        self.assertEqual(records, original)
        self.assertEqual(current["revision"], 2)
        self.assertTrue(all(entry["file"].endswith(".json.gz") for entry in current["chatFiles"]))
        after = sum(path.stat().st_size for path in self.root.rglob("*") if path.is_file())
        self.assertLess(after, before / 5)
        self.assertEqual(result["checkpoints"], 1)
        self.assertFalse(list(self.root.glob("chat_*.json")))

    def test_daily_weekly_recent_retention_and_shared_records(self):
        for revision in range(1, 81):
            self.save(revision, self.now - (80 - revision) * 43200)
        original = store.read_snapshot(self.root, "chatFiles", "chat")[1]
        self.optimize()
        catalog = store._checkpoint_catalog(self.root)
        self.assertLessEqual(len(catalog), 14)
        self.assertTrue({77, 78, 79}.issubset({item["revision"] for item in catalog}))
        self.assertEqual(store.read_snapshot(self.root, "chatFiles", "chat")[1], original)
        referenced = {entry["file"] for entry in store.read_manifest(self.root, "chatFiles", "chat")["chatFiles"]}
        for item in catalog:
            value = store._parse_manifest(item["path"], "chatFiles")
            store.read_records(self.root, value, "chatFiles", "chat")
            referenced.update(entry["file"] for entry in value["chatFiles"])
        self.assertEqual({path.name for path in self.root.glob("chat_*")}, referenced)
        # Unchanged second chat is shared across every checkpoint.
        self.assertEqual(len(referenced), len(catalog) + 2)

    def test_budget_preserves_current_and_newest_fallback_even_when_too_small(self):
        for revision in range(1, 6):
            self.save(revision)
        result = self.optimize(budget_bytes=1)
        self.assertTrue(result["budget_exceeded"])
        self.assertEqual([item["revision"] for item in store._checkpoint_catalog(self.root)], [4])
        self.assertEqual(store.read_snapshot(self.root, "chatFiles", "chat")[0]["revision"], 5)

    def test_faults_leave_complete_snapshots_and_migration_resumes(self):
        for stage in ("before_publish", "after_publish", "before_cleanup", "after_cleanup"):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as temporary:
                self.root = Path(temporary) / "chats"
                for revision in range(1, 7):
                    self.save(revision)
                self.make_legacy()
                def fault(actual):
                    if actual == stage:
                        raise OSError("interrupted")
                with self.assertRaisesRegex(OSError, "interrupted"):
                    self.optimize(fault=fault)
                self.assertEqual(store.read_snapshot(self.root, "chatFiles", "chat")[0]["revision"], 6)
                self.optimize()
                for item in store._checkpoint_catalog(self.root):
                    store.read_records(self.root, store._parse_manifest(item["path"], "chatFiles"), "chatFiles", "chat")

    def test_cleanup_interruption_does_not_leave_dangling_checkpoint(self):
        for revision in range(1, 12):
            self.save(revision)
        remove = store._safe_remove
        def interrupted(root, path):
            if Path(path).name.startswith("chat_"):
                raise OSError("cleanup interrupted")
            remove(root, path)
        with mock.patch.object(store, "_safe_remove", side_effect=interrupted):
            with self.assertRaises(OSError):
                self.optimize()
        for item in store._checkpoint_catalog(self.root):
            store.read_records(self.root, store._parse_manifest(item["path"], "chatFiles"), "chatFiles", "chat")
        self.optimize()

    def test_damage_aborts_cleanup_and_recovery_keeps_revision_high_water(self):
        self.save(1)
        current = self.save(2)
        (self.root / "_backups" / "revision_r900.json").write_text('{"revision":900}')
        self.optimize()
        self.assertFalse(list((self.root / "_backups").glob("revision_r*.json")))
        (self.root / current["chatFiles"][0]["file"]).write_bytes(b"broken")
        before = {path.name for path in self.root.rglob("*")}
        with self.assertRaises(store.RecoveryRequiredError):
            self.optimize()
        self.assertEqual(before, {path.name for path in self.root.rglob("*")})
        restored = store.recover_store(self.root, "chatFiles", "chat")
        self.assertEqual(restored["revision"], 901)

    def test_stale_reader_retries_current_after_cleanup(self):
        oldest = self.save(1)
        for revision in range(2, 7):
            self.save(revision)
        self.optimize()
        index, records = store.read_selected_snapshot(self.root, oldest, "chatFiles", "chat", ["one"])
        self.assertEqual(index["revision"], 6)
        self.assertEqual(records[0]["text"], "6")
        self.assertNotIn("_recovery", index)

    def test_active_reader_finishes_before_cleanup(self):
        self.save(1)
        entered, release, done = threading.Event(), threading.Event(), threading.Event()
        read = store._read_record_bytes
        def delayed(path):
            if threading.current_thread().name == "reader":
                entered.set()
                release.wait(5)
            return read(path)
        errors = []
        def reader():
            try:
                store.read_snapshot(self.root, "chatFiles", "chat")
            except Exception as exc:
                errors.append(exc)
        with mock.patch.object(store, "_read_record_bytes", side_effect=delayed):
            thread = threading.Thread(target=reader, name="reader")
            thread.start()
            self.assertTrue(entered.wait(3))
            cleanup = threading.Thread(target=lambda: (self.optimize(), done.set()))
            cleanup.start()
            self.assertFalse(done.wait(.05))
            release.set()
            thread.join(5)
            cleanup.join(5)
        self.assertTrue(done.is_set())
        self.assertFalse(errors)

    def test_individual_restore_preserves_unrelated_records_and_checks_revision(self):
        self.save(1, label="original")
        current = self.save(2, label="edited")
        summary = lambda record: {"title": record["id"]}
        with self.assertRaises(store.RevisionConflictError):
            store.restore_record(self.root, "chatFiles", "chat", 1, "one", 1, summary_builder=summary)
        restored = store.restore_record(self.root, "chatFiles", "chat", 1, "one", 2, summary_builder=summary)
        self.assertEqual(restored["chatFiles"][1], current["chatFiles"][1])
        records = store.read_snapshot(self.root, "chatFiles", "chat")[1]
        self.assertEqual(records[0]["text"], "original")
        with self.assertRaisesRegex(ValueError, "unfinished"):
            store.restore_record(self.root, "chatFiles", "chat", 2, "one", 3, summary_builder=lambda _: {"pendingCount": 1})

    def test_legacy_archives_expire_and_unknown_files_survive(self):
        self.save(1)
        backups = self.root / "_backups"
        (backups / "legacy_store.bak").write_bytes(b"original backup")
        (backups / "user-notes.txt").write_text("keep")
        self.optimize()
        self.assertEqual(store._json_bytes(backups / "legacy_store.bak.gz"), b"original backup")
        self.now += 8 * 86400
        self.optimize()
        self.assertFalse((backups / "legacy_store.bak.gz").exists())
        self.assertTrue((backups / "user-notes.txt").exists())

    def test_automatic_migration_covers_all_records_and_runs_once(self):
        self.save(1)
        self.save(2)
        self.make_legacy()
        legacy = self.root.with_suffix(".json")
        legacy.write_text(json.dumps({"chats": [{"id": "old"}]}))
        with mock.patch.object(store, "maintain_storage", wraps=store.maintain_storage) as maintenance:
            store.schedule_maintenance(self.root, "chatFiles", "chat", legacy)
            deadline = time.monotonic() + 8
            while str(self.root.resolve()) in store._MAINTENANCE_RUNNING and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertNotIn(str(self.root.resolve()), store._MAINTENANCE_RUNNING)
            self.assertNotIn("error", store._maintenance_state(self.root))
            self.assertFalse(legacy.exists())
            store.schedule_maintenance(self.root, "chatFiles", "chat", legacy)
            self.assertEqual(maintenance.call_count, 1)
        self.assertEqual(len(store.read_snapshot(self.root, "chatFiles", "chat")[1]), 2)

    def test_backend_startup_schedules_both_entire_libraries_without_opening_them(self):
        from test_regressions import load_modules
        _, routes = load_modules(self.temp.name)
        with mock.patch.object(routes.transactional_store, "schedule_maintenance") as schedule:
            asyncio.run(routes._optimize_history_on_startup(None))
        self.assertEqual(schedule.call_count, 2)
        self.assertEqual(schedule.call_args_list[0].args[1:3], ("chatFiles", "chat"))
        video = schedule.call_args_list[1].args
        self.assertEqual(video[0], Path(routes.BASE_DIR).parent / "PromptStudio_Video" / "promptstudio_video_projects")
        self.assertEqual(video[1:3], ("projectFiles", "project"))
        self.assertIn(routes._optimize_history_on_startup, routes.PromptServer.instance.app.on_startup)

    def test_automatic_migration_also_handles_an_unsplit_monolith(self):
        legacy = self.root.with_suffix(".json")
        original = {"version": 2, "revision": 20, "activeChatId": "old", "chats": [{"id": "old", "messages": [{"text": "Exact é"}]}]}
        legacy.write_text(json.dumps(original), encoding="utf-8")
        store.schedule_maintenance(self.root, "chatFiles", "chat", legacy)
        deadline = time.monotonic() + 8
        while str(self.root.resolve()) in store._MAINTENANCE_RUNNING and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertNotIn(str(self.root.resolve()), store._MAINTENANCE_RUNNING)
        self.assertNotIn("error", store._maintenance_state(self.root))
        self.assertEqual(store.read_snapshot(self.root, "chatFiles", "chat")[1], original["chats"])
        self.assertFalse(legacy.exists())

    def test_corrupt_retained_checkpoint_prevents_any_deletion(self):
        first = self.save(1)
        self.save(2)
        (self.root / first["chatFiles"][0]["file"]).write_bytes(b"broken")
        before = {path for path in self.root.rglob("*") if path.is_file()}
        with self.assertRaises(store.RecoveryRequiredError):
            self.optimize()
        self.assertTrue(all(path.exists() for path in before))


if __name__ == "__main__":
    unittest.main()
