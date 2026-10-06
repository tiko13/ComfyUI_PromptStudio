"""CPU numerical coverage runs separately from ComfyUI's mocked runtime tests."""
import subprocess
import sys
import unittest
from pathlib import Path


class QwenTurboTests(unittest.TestCase):
    def test_reference_schedule_hooks_and_cleanup(self):
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('qwen_turbo_cpu.py'))],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
