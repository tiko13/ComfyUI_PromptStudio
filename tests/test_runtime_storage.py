from pathlib import Path
import tempfile
import unittest

from backend.runtime_storage import IMAGE_STATE, VIDEO_STATE, migrate_legacy_state


class RuntimeStorageTests(unittest.TestCase):
    def test_migration_preserves_store_bytes_backups_and_is_repeatable(self):
        for names in (IMAGE_STATE, VIDEO_STATE):
            with self.subTest(names=names), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                expected = {}
                for name in names:
                    for suffix in ("", ".bak", ".tmp"):
                        path = root / (name + suffix)
                        data = (name + suffix + "\r\nprivate data ☃").encode()
                        path.write_bytes(data)
                        expected[path.name] = data
                migrate_legacy_state(root, names)
                migrate_legacy_state(root, names)
                self.assertEqual({p.name: p.read_bytes() for p in (root / "user-data").iterdir()}, expected)
                self.assertEqual(list(root.iterdir()), [root / "user-data"])

    def test_directory_move_keeps_nested_records_and_leaves_templates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = root / "prompt_studio_chats"
            (store / "_backups").mkdir(parents=True)
            (store / "_backups" / "record.json").write_bytes(b"exact bytes")
            template = root / "style_templates.additional.json"
            template.write_bytes(b"user template")
            migrate_legacy_state(root, IMAGE_STATE)
            self.assertEqual((root / "user-data" / store.name / "_backups" / "record.json").read_bytes(), b"exact bytes")
            self.assertEqual(template.read_bytes(), b"user template")

    def test_conflict_preserves_all_sources_before_any_move(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "user-data").mkdir()
            (root / "a.json").write_bytes(b"a")
            (root / "b.json").write_bytes(b"old")
            (root / "user-data" / "b.json").write_bytes(b"new")
            with self.assertRaises(FileExistsError):
                migrate_legacy_state(root, ("a.json", "b.json"))
            self.assertEqual((root / "a.json").read_bytes(), b"a")
            self.assertEqual((root / "b.json").read_bytes(), b"old")
            self.assertEqual((root / "user-data" / "b.json").read_bytes(), b"new")

    def test_rejects_paths_using_either_separator(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in ("../outside", "..\\outside", ".", "..", "user-data"):
                with self.subTest(name=name), self.assertRaises(ValueError):
                    migrate_legacy_state(directory, (name,))

    def test_new_install_does_not_create_empty_storage(self):
        with tempfile.TemporaryDirectory() as directory:
            migrate_legacy_state(directory, IMAGE_STATE)
            self.assertEqual(list(Path(directory).iterdir()), [])
