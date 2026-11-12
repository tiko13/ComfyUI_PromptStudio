import importlib.util
import unittest
import subprocess
import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

spec = importlib.util.spec_from_file_location("choice_under_test", Path(__file__).resolve().parents[1] / "backend" / "intermediate.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ChoiceTests(unittest.TestCase):
    def setUp(self):
        import torch
        self.image = torch.arange(48, dtype=torch.float32).reshape(1, 4, 4, 3)
        self.latent = {"samples": torch.ones(1, 4, 2, 2), "noise_mask": torch.zeros(1, 2, 2)}
        self.store = module.ChoiceStore()

    def test_tensor_roundtrip_and_mutation_isolation(self):
        import torch
        token = self.store.reserve()
        expected = self.image.clone()
        self.store.capture(token, self.image, self.latent, ["Refine", "Upscale"])
        self.image.zero_()
        ticket = self.store.claim(token, 1)
        image, latent = self.store.read(token, ticket)
        self.assertTrue(torch.equal(image, expected))
        self.assertEqual(image.device.type, "cpu")
        latent["samples"].zero_()
        self.assertEqual(self.store.read(token, ticket)[1]["samples"].sum().item(), 16)
        with self.assertRaises(ValueError): self.store.read(token, "wrong ticket")
        self.store.release(token)
        with self.assertRaises(ValueError): self.store.read(token, ticket)

    def test_claim_is_atomic_and_invalid_choices_do_not_consume(self):
        token = self.store.reserve()
        self.store.capture(token, self.image, None, ["Refine"])
        with self.assertRaises(ValueError): self.store.claim(token, 1)
        def claim(_):
            try: return self.store.claim(token, 0)
            except ValueError: return None
        with ThreadPoolExecutor(max_workers=8) as executor:
            self.assertEqual(sum(bool(result) for result in executor.map(claim, range(8))), 1)

    def test_cancelled_capture_expiry_and_memory_budget(self):
        now = [0]
        store = module.ChoiceStore(max_bytes=1, ttl=10, clock=lambda: now[0])
        token = store.reserve()
        with self.assertRaisesRegex(ValueError, "memory budget"): store.capture(token, self.image, None, ["Go"])
        now[0] = 11
        self.assertEqual(store.status(token), "expired")
        token = store.reserve()
        store.release(token)
        with self.assertRaisesRegex(ValueError, "expired"): store.capture(token, self.image, None, ["Go"])

    def test_canvas_cannot_execute_through_gate(self):
        with self.assertRaisesRegex(ValueError, "Studio"):
            module.IntermediateChoice().pause(self.image, "Continue?", "Refine")
        self.assertEqual(module.choice_labels("Refine\n\n Upscale "), ["Refine", "Upscale"])
        with self.assertRaises(ValueError): module.choice_labels("")


def load_tests(loader, tests, pattern):
    if __name__ == "__main__":
        return tests
    # Regression fixtures replace torch in sys.modules. Exercise real tensors in
    # an isolated VENV process without mutating those fixtures or skipping checks.
    class RealTensorSuite(unittest.TestCase):
        def runTest(self):
            result = subprocess.run([sys.executable, "-B", str(Path(__file__).resolve())],
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
    return unittest.TestSuite([RealTensorSuite()])


if __name__ == "__main__":
    unittest.main()
