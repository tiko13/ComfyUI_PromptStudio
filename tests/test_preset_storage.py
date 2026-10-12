import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


class PresetStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        spec = importlib.util.spec_from_file_location("preset_storage_test", Path(__file__).resolve().parents[1] / "backend" / "preset_storage.py")
        self.store = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.store)
        self.root = Path(self.temp.name)
        self.store.ROOT = self.root
        self.store.USER_DIR = self.root / "config" / "user"
        self.store.DEFAULTS_DIR = self.root / "config" / "defaults"
        self.store.BACKUP_DIR = self.root / "config" / "migration-backups"
        self.store.DEFAULTS_DIR.mkdir(parents=True)
        for _, _, starter in self.store.FILES.values():
            if starter:
                self.store.write_items(self.store.DEFAULTS_DIR / starter, [{"name": "Starter", "enabled": False}])

    def test_all_legacy_files_migrate_losslessly_once_and_keep_exact_backups(self):
        expected = {}
        originals = {}
        for filename, (legacy, key, _) in self.store.FILES.items():
            items = ["A phrase", "C++"] if key == "protected_words" else [{"name": "Synthetic", "enabled": False, "instruction": " guidance ", "extra": [1]}]
            raw = b"\xef\xbb\xbf# Keep these comments\nA phrase\nC++\n" if key == "protected_words" else json.dumps({key: items}).encode()
            (self.root / legacy).write_bytes(raw)
            originals[legacy] = raw
            expected[filename] = items
        for filename, (legacy, key, _) in self.store.FILES.items():
            path = self.store.USER_DIR / filename
            self.assertEqual(self.store.read_items(path, key), expected[filename])
            self.assertEqual(json.loads(path.read_text()), {"version": 1, "items": expected[filename]})
            self.assertFalse((self.root / legacy).exists())
            backups = list(self.store.BACKUP_DIR.glob(legacy + ".*.bak"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_bytes(), originals[legacy])
            self.store.write_items(path, [])
            self.assertEqual(self.store.read_items(path, key), [])
        self.assertEqual({path.name for path in self.store.USER_DIR.iterdir()}, set(expected))

    def test_new_file_wins_and_older_file_is_archived(self):
        path = self.store.USER_DIR / "styles.json"
        self.store.write_items(path, [{"name": "New settings"}])
        legacy = self.root / "style_templates.additional.json"
        legacy.write_text('{"style_templates": [{"name": "Older settings"}]}')
        self.assertEqual(self.store.read_items(path, "style_templates"), [{"name": "New settings"}])
        self.assertFalse(legacy.exists())
        self.assertEqual(len(list(self.store.BACKUP_DIR.iterdir())), 1)

    def test_malformed_legacy_or_new_files_are_not_replaced(self):
        path = self.store.USER_DIR / "references.json"
        legacy = self.root / "known_references.json"
        legacy.write_text("{broken")
        with self.assertRaises(ValueError):
            self.store.read_items(path, "known_references")
        self.assertFalse(path.exists())
        self.assertEqual(legacy.read_text(), "{broken")
        path.parent.mkdir(parents=True)
        path.write_text('{"version": 2, "items": []}')
        with self.assertRaisesRegex(ValueError, "version"):
            self.store.read_items(path, "known_references")
        self.assertTrue(legacy.exists())

    def test_failed_migration_preserves_original_and_can_retry(self):
        legacy = self.root / "protected_words.txt"
        legacy.write_text("# Original\nA phrase\n")
        path = self.store.USER_DIR / "protected_words.json"
        with mock.patch.object(self.store.os, "replace", side_effect=OSError("disk error")):
            with self.assertRaises(OSError):
                self.store.read_items(path, "protected_words")
        self.assertTrue(legacy.exists())
        self.assertFalse(path.exists())
        self.assertEqual(list(self.store.USER_DIR.glob("*.tmp")), [])
        self.assertEqual(self.store.protected_words(path), ["A phrase"])

    def test_fresh_install_seeds_disabled_examples_and_empty_words(self):
        for filename, (_, key, starter) in self.store.FILES.items():
            path = self.store.USER_DIR / filename
            items = self.store.read_items(path, key)
            self.assertEqual(items, [{"name": "Starter", "enabled": False}] if starter else [])
            self.assertEqual(path.parent, self.root / "config" / "user")
        self.assertFalse(self.store.BACKUP_DIR.exists())

    def test_schema_rejects_wrong_version_and_collection_type(self):
        for data in ([], {"version": True, "items": []}, {"version": 2, "items": []},
                     {"version": 1}, {"version": 1, "items": {}}, {"items": []}):
            with self.subTest(data=data), self.assertRaises(ValueError):
                self.store.items_from_document(data, "profiles")


if __name__ == "__main__":
    unittest.main()
