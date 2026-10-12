"""Temporary live-test adapter; never imported by production nodes.

Source and MIT license are pinned in test-results/pose-reference-strength.
The upstream algorithm is unchanged. Registration is removed after the trial.
"""
import importlib.util
from pathlib import Path

_path = Path(__file__).resolve().parents[1] / "test-results" / "pose-reference-strength" / "upstream_masked.py"
_spec = importlib.util.spec_from_file_location("pose_trial_upstream", _path)
_upstream = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_upstream)


class PoseReferenceExperiment:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",), "mask": ("MASK",),
            "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 64.0}),
            "mask_behavior": (["focus_only", "zero_unmasked_tokens"],),
            "mask_threshold": ("FLOAT", {"default": 0.1, "min": 0.0, "max": 1.0}),
        }}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "apply"
    CATEGORY = "testing/pose"

    def apply(self, model, mask, strength, mask_behavior, mask_threshold):
        result = _upstream.QwenImage21ReferenceStrengthMasked.execute(
            model, mask, reference_index=1, strength=strength,
            mask_behavior=mask_behavior, mask_threshold=mask_threshold,
            mask_resize_method="lanczos",
        )
        return result.result
