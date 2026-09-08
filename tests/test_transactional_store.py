import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

import transactional_store as store
from test_regressions import load_modules


def records(label):
    return [{"id": key, "name": label, "messages": [{"id": "message-1", "text": label}],
             "workflowSnapshot": {"workflow": {"nodes": []}, "output": {"1": {"inputs": {}}}},
             "plotId": "plot-1", "parent_generation_id": "parent-1"} for key in ("a", "b")]


class TransactionalStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name) / "store"
        self.metadata = {"version": 2, "revision": 1, "activeChatId": "b",
                         "deletedChatIds": ["deleted"], "deletedMessageIds": {"a": ["old-message"]}}
        self.first = store.commit_records(self.directory, self.metadata, records("old"), "chatFiles", "chat")

    def tearDown(self):
        self.temp.cleanup()

    def test_failure_at_every_publication_boundary_is_a_complete_old_or_new_revision(self):
        failures = [(stage, record_id) for stage in ("before_record", "after_record") for record_id in ("a", "b")]
        failures += [(stage, None) for stage in (
            "before_backup", "after_backup", "before_commit", "after_commit", "before_cleanup", "after_cleanup")]
        for failure in failures:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                store.commit_records(directory, self.metadata, records("old"), "chatFiles", "chat")
                def fault(stage, record_id=None):
                    if (stage, record_id) == failure:
                        raise OSError("injected failure")
                with self.assertRaisesRegex(OSError, "injected failure"):
                    store.commit_records(directory, {**self.metadata, "revision": 2}, records("new"),
                                         "chatFiles", "chat", fault=fault)
                # A fresh module models restart: no cached in-memory snapshot.
                spec = importlib.util.spec_from_file_location("fresh_transactional_store", store.__file__)
                fresh = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(fresh)
                manifest, restored = fresh.read_snapshot(directory, "chatFiles", "chat")
                expected = "new" if failure[0] in {"after_commit", "before_cleanup", "after_cleanup"} else "old"
                self.assertEqual(restored, records(expected))
                self.assertEqual(manifest["revision"], 2 if expected == "new" else 1)

    def test_real_backup_replace_failure_never_publishes_new_records(self):
        replace = store.os.replace
        def fail_backup(source, destination):
            if Path(destination).name == "index.bak":
                raise OSError("backup replacement failed")
            return replace(source, destination)
        with mock.patch.object(store.os, "replace", side_effect=fail_backup):
            with self.assertRaises(OSError):
                store.commit_records(self.directory, {**self.metadata, "revision": 2}, records("new"), "chatFiles", "chat")
        self.assertEqual(store.read_snapshot(self.directory, "chatFiles", "chat")[1], records("old"))
        self.assertFalse(list(self.directory.rglob("*.tmp")))

    def test_corrupt_record_falls_back_as_one_snapshot_and_requires_explicit_recovery(self):
        second = store.commit_records(self.directory, {**self.metadata, "revision": 2}, records("new"), "chatFiles", "chat")
        damaged = self.directory / second["chatFiles"][1]["file"]
        damaged.write_bytes(b"damaged original")
        manifest, restored = store.read_snapshot(self.directory, "chatFiles", "chat")
        self.assertEqual(restored, records("old"))
        self.assertIn("_recovery", manifest)
        with self.assertRaises(store.RecoveryRequiredError):
            store.commit_records(self.directory, {**self.metadata, "revision": 3}, records("third"), "chatFiles", "chat")
        recovered = store.recover_store(self.directory, "chatFiles", "chat")
        self.assertEqual(recovered["revision"], 3)
        self.assertEqual(damaged.read_bytes(), b"damaged original")
        self.assertTrue(list((self.directory / "_backups").glob("damaged-index-*.json")))
        self.assertNotIn("_recovery", store.read_snapshot(self.directory, "chatFiles", "chat")[0])

    def test_missing_record_and_corrupt_index_recover_without_touching_originals(self):
        second = store.commit_records(self.directory, {**self.metadata, "revision": 2}, records("new"), "chatFiles", "chat")
        (self.directory / second["chatFiles"][0]["file"]).unlink()
        self.assertEqual(store.read_snapshot(self.directory, "chatFiles", "chat")[1], records("old"))
        index = self.directory / "index.json"
        index.write_bytes(b"broken index")
        self.assertIn("_recovery", store.read_manifest(self.directory, "chatFiles", "chat"))
        self.assertEqual(store.recover_store(self.directory, "chatFiles", "chat")["revision"], 3)
        self.assertIn(b"broken index", [path.read_bytes() for path in (self.directory / "_backups").glob("damaged-index-*.json")])

    def test_no_complete_backup_has_actionable_error(self):
        (self.directory / self.first["chatFiles"][0]["file"]).write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(store.RecoveryRequiredError, "transactional_store.py inspect"):
            store.read_snapshot(self.directory, "chatFiles", "chat")

    def test_atomic_cleanup_failure_still_exposes_complete_old_or_new_snapshot(self):
        for target in ("chat_", "index.json."):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                store.commit_records(directory, self.metadata, records("old"), "chatFiles", "chat")
                unlink = store.os.unlink
                def fail_cleanup(path, *args, **kwargs):
                    if Path(path).name.startswith(target) and str(path).endswith(".tmp"):
                        raise PermissionError("injected temporary cleanup failure")
                    return unlink(path, *args, **kwargs)
                with mock.patch.object(store.os, "unlink", side_effect=fail_cleanup):
                    with self.assertRaises(PermissionError):
                        store.commit_records(directory, {**self.metadata, "revision": 2}, records("new"), "chatFiles", "chat")
                manifest, restored = store.read_snapshot(directory, "chatFiles", "chat")
                self.assertEqual(manifest["revision"], 2 if target == "index.json." else 1)
                self.assertEqual(restored, records("new" if target == "index.json." else "old"))

    def test_old_reader_and_selected_record_reads_survive_later_save(self):
        store.commit_records(self.directory, {**self.metadata, "revision": 2}, records("new"), "chatFiles", "chat")
        self.assertEqual(store.read_records(self.directory, self.first, "chatFiles", "chat"), records("old"))
        self.assertEqual(store.read_records(self.directory, self.first, "chatFiles", "chat", ["b"]), [records("old")[1]])

    def test_migration_and_export_preserve_metadata_envelopes_ids_and_tombstones(self):
        with tempfile.TemporaryDirectory() as directory:
            legacy = Path(directory) / "legacy.json"
            value = {**self.metadata, "chats": records("legacy")}
            legacy.write_text(json.dumps(value), encoding="utf-8")
            target = Path(directory) / "migrated"
            original = legacy.read_bytes()
            store.migrate_store(target, "chatFiles", "chat", "chats", legacy)
            result = store.export_snapshot(target, "chatFiles", "chat", "chats", Path(directory) / "export.json")
            self.assertEqual(result, value)
            self.assertEqual(legacy.read_bytes(), original)
            self.assertTrue(list((target / "_backups").glob("legacy_*.json")))

    def test_migration_preserves_existing_split_records(self):
        with tempfile.TemporaryDirectory() as directory:
            original_paths = []
            entries = []
            for record in records("legacy"):
                filename = "chat_" + hashlib.sha256(record["id"].encode()).hexdigest() + ".json"
                path = Path(directory) / filename
                path.write_text(json.dumps(record), encoding="utf-8")
                original_paths.append((path, path.read_bytes()))
                entries.append({"id": record["id"], "file": filename})
            (Path(directory) / "index.json").write_text(json.dumps({**self.metadata, "chatFiles": entries}), encoding="utf-8")
            store.migrate_store(directory, "chatFiles", "chat", "chats")
            for path, original in original_paths:
                self.assertEqual(path.read_bytes(), original)
            self.assertEqual(store.read_snapshot(directory, "chatFiles", "chat")[1], records("legacy"))

    def test_concurrent_readers_never_observe_mixed_revisions(self):
        finished = threading.Event()
        errors = []
        def reader():
            while not finished.is_set():
                try:
                    manifest, value = store.read_snapshot(self.directory, "chatFiles", "chat")
                    names = {record["name"] for record in value}
                    expected = "old" if manifest["revision"] == 1 else str(manifest["revision"])
                    if names != {expected}:
                        errors.append((manifest["revision"], names))
                except Exception as exc:
                    errors.append(exc)
        thread = threading.Thread(target=reader)
        thread.start()
        try:
            for revision in range(2, 12):
                store.commit_records(self.directory, {**self.metadata, "revision": revision}, records(str(revision)), "chatFiles", "chat")
        finally:
            finished.set()
            thread.join(3)
        self.assertFalse(errors)

    def test_cross_process_writers_use_compare_and_swap(self):
        script = """import sys
from transactional_store import commit_records, RevisionConflictError
try:
    commit_records(sys.argv[1], {'version': 2, 'revision': 2}, [{'id': 'a', 'winner': sys.argv[2]}], 'chatFiles', 'chat', expected_revision=1)
except RevisionConflictError:
    raise SystemExit(2)
"""
        processes = [subprocess.Popen([sys.executable, "-B", "-c", script, str(self.directory), str(index)],
                                      cwd=Path(store.__file__).parent, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                     for index in range(2)]
        results = [process.communicate(timeout=15) for process in processes]
        self.assertEqual(sorted(process.returncode for process in processes), [0, 2], results)
        self.assertEqual(store.read_snapshot(self.directory, "chatFiles", "chat")[0]["revision"], 2)

    def test_cli_inspect_is_read_only_and_export_is_a_portable_snapshot(self):
        before = {str(path): path.read_bytes() for path in self.directory.rglob("*") if path.is_file()}
        inspected = subprocess.run([sys.executable, "-B", store.__file__, "inspect", str(self.directory), "--kind", "chat"],
                                   check=True, capture_output=True, text=True, timeout=10)
        self.assertEqual(json.loads(inspected.stdout), {"revision": 1, "records": 2, "recovery": None})
        self.assertEqual(before, {str(path): path.read_bytes() for path in self.directory.rglob("*") if path.is_file()})
        output = Path(self.temp.name) / "export.json"
        subprocess.run([sys.executable, "-B", store.__file__, "export", str(self.directory), str(output), "--kind", "chat"],
                       check=True, capture_output=True, text=True, timeout=10)
        self.assertEqual(json.loads(output.read_text(encoding="utf-8")), {**self.metadata, "chats": records("old")})


class ImageStoreTransactionTests(unittest.TestCase):
    def test_legacy_tombstones_and_metadata_survive_migration_and_later_save(self):
        with tempfile.TemporaryDirectory() as directory:
            _, routes = load_modules(directory)
            routes.CHAT_STORE_PATH = str(Path(directory) / "chats.json")
            routes.CHAT_STORE_DIR = str(Path(directory) / "chats")
            legacy = {"revision": 5, "activeChatId": "b", "chats": records("legacy"),
                      "deletedChatIds": ["deleted"], "deletedMessageIds": {"a": ["gone"]}}
            Path(routes.CHAT_STORE_PATH).write_text(json.dumps(legacy), encoding="utf-8")
            migrated = routes._read_chat_store()
            saved = routes._update_chat_store({"revision": 5, "activeChatId": "a", "chats": records("new")})
            for key in ("deletedChatIds", "deletedMessageIds"):
                self.assertEqual(migrated[key], legacy[key])
                self.assertEqual(saved[key], legacy[key])
            self.assertEqual(json.loads(Path(routes.CHAT_STORE_PATH).read_text()), legacy)

    def test_interrupted_two_chat_save_keeps_both_previous_chats_and_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            _, routes = load_modules(directory)
            routes.CHAT_STORE_PATH = str(Path(directory) / "chats.json")
            routes.CHAT_STORE_DIR = str(Path(directory) / "chats")
            baseline = routes._update_chat_store({"revision": 0, "activeChatId": "b", "chats": records("old")})
            commit = routes.transactional_store.commit_records
            def fault(stage, record_id=None):
                if stage == "before_record" and record_id == "b":
                    raise OSError("second chat failed")
            def interrupted(*args, **kwargs):
                return commit(*args, **kwargs, fault=fault)
            with mock.patch.object(routes.transactional_store, "commit_records", side_effect=interrupted):
                with self.assertRaises(OSError):
                    routes._update_chat_store({**baseline, "chats": records("new")})
            self.assertEqual(routes._read_chat_store(), baseline)


if __name__ == "__main__":
    unittest.main()
