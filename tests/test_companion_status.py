import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("companion_status", Path(__file__).resolve().parents[1] / "companion_status.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CompanionStatusTests(unittest.TestCase):
    def test_loaded_does_not_depend_on_directory_name_or_disk(self):
        self.assertEqual(module.video_installation_status([], loaded=True),
                         {"installed": True, "loaded": True, "state": "loaded"})

    def test_absence_and_renamed_or_disabled_install_in_multiple_roots(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first, second = root / "one", root / "two"
            first.mkdir()
            second.mkdir()
            self.assertEqual(module.video_installation_status([first, second])["state"], "missing")
            package = second / "renamed-companion.disabled"
            for relative in (Path("__init__.py"), Path("video") / "contracts.py",
                             Path("web") / "js" / "promptstudio_video_studio.js"):
                path = package / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("", encoding="utf-8")
            self.assertEqual(module.video_installation_status([first, second]),
                             {"installed": True, "loaded": False, "state": "not_loaded"})

    def test_unreadable_roots_are_unknown_not_missing(self):
        with mock.patch.object(Path, "iterdir", side_effect=PermissionError):
            self.assertIsNone(module.video_installation_status([Path("custom_nodes")])["installed"])


if __name__ == "__main__":
    unittest.main()
