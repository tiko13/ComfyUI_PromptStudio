import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class StudioSwitchContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.panel = (ROOT / "web" / "js" / "prompt_studio.js").read_text(encoding="utf-8")
        cls.constants = (
            ROOT / "web" / "js" / "prompt-studio" / "core" / "constants.js"
        ).read_text(encoding="utf-8")
        cls.shell = (ROOT / "web" / "js" / "prompt_studio_shell.js").read_text(encoding="utf-8")
        cls.page = (ROOT / "web" / "prompt_studio.html").read_text(encoding="utf-8")
        cls.styles = (ROOT / "web" / "css" / "prompt_studio.css").read_text(encoding="utf-8")

    def test_switch_is_always_rendered_in_standalone_headers(self):
        self.assertGreaterEqual(self.panel.count('data-promptstudio-studio-mode="image"'), 2)
        self.assertGreaterEqual(self.panel.count('data-promptstudio-studio-mode="video"'), 2)
        self.assertIn("promptstudio-standalone-only", self.panel)

    def test_wide_standalone_header_keeps_brand_and_actions_on_one_row(self):
        self.assertIn("flex: 1 1 auto;", self.styles)
        self.assertIn("flex: 0 0 auto;\n  width: auto;", self.styles)

    def test_shell_preserves_separate_image_and_video_mounts(self):
        self.assertIn('if (document.querySelector("#promptstudio-popout-mount"))', self.shell)
        self.assertIn('id="promptstudio-image-mount"', self.page)
        self.assertIn('id="promptstudio-video-mount"', self.page)
        self.assertIn("imageMount.hidden = activeMode !== \"image\"", self.shell)
        self.assertIn("videoMount.hidden = activeMode !== \"video\"", self.shell)
        self.assertIn("setStandaloneVisibility", self.shell)

    def test_missing_video_is_clickable_and_offers_manager_install(self):
        self.assertIn('data-available="false"', self.panel)
        self.assertIn('id="promptstudio-video-install-dialog"', self.page)
        self.assertIn('id="promptstudio-video-install"', self.page)
        self.assertIn('"/customnode/install/git_url"', self.shell)
        self.assertIn('"https://github.com/tiko13/PromptStudio_Video"', self.shell)
        self.assertIn('["/v2/manager/reboot", "/manager/reboot"]', self.shell)
        self.assertIn("![404, 405].includes(response.status)", self.shell)
        self.assertIn("window.confirm", self.shell)
        self.assertIn('cursor: help', self.styles)

    def test_restart_uses_manager_v4_with_a_legacy_fallback(self):
        self.assertIn('["/v2/manager/reboot", "/manager/reboot"]', self.constants)
        for source in (self.panel, self.shell):
            self.assertIn("for (const endpoint of COMFY_RESTART_ENDPOINTS)", source)
            self.assertIn("![404, 405].includes(response.status)", source)


if __name__ == "__main__":
    unittest.main()
