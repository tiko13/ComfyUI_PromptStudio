import subprocess
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


class PlotModelTests(unittest.TestCase):
    def test_lora_strength_axis_contract(self):
        subprocess.run(
            ["node", str(REPO_ROOT / "tests" / "test_plot_model.mjs")],
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )


if __name__ == "__main__":
    unittest.main()
