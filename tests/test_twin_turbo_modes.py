"""Native Twin Turbo mode transport and shared Image/Video contracts."""
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

from test_regressions import load_modules


MODES = ["Spoon", "Einstein", "XHigh", "Medium", "Low"]
ALL_MODES = MODES + [f"Instruct {mode}" for mode in MODES] + ["Disabled"]


class TwinTurboModeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.nodes, self.routes = load_modules(self.temp.name)
        self.routes.LLAMACPP_CONFIG_DIRECTORY = self.temp.name
        self.profile = Path(self.temp.name) / "twin-turbo.json"
        self.profile.write_text(json.dumps({"llm_profile": {
            "thinking_mode": "XHigh", "thinking_modes": MODES,
            "instruct_modes": MODES + ["Disabled"],
            "temperature": 0.7, "thinking_temperature": 1.0,
            "presence_penalty": 1.5, "thinking_presence_penalty": 0.0,
        }}), encoding="utf-8")

    def test_all_modes_survive_profile_and_shared_wire_validation_with_correct_samplers(self):
        profile = self.routes._llamacpp_config_llm_profile(self.profile.name)
        self.assertEqual(profile["thinking_modes"], MODES)
        self.assertEqual(profile["instruct_modes"], MODES + ["Disabled"])
        self.assertEqual(self.routes._llamacpp_profile_mode_options(profile), ALL_MODES)
        contracts = importlib.import_module("ComfyUI_PromptStudio.wire_contracts")
        for mode in ALL_MODES:
            with self.subTest(mode=mode):
                settings = contracts.normalize_provider_settings({
                    "wire_version": 1, "llm_provider": "llamacpp", "thinking_mode": mode,
                    "llamacpp_config_profile": self.profile.name,
                })
                result = self.routes._llamacpp_configured_generation_data(settings)
                self.assertEqual(result["thinking_mode"], mode)
                self.assertEqual(result["temperature"], 1.0 if mode in MODES else 0.7)
                self.assertEqual(result["presence_penalty"], 0.0 if mode in MODES else 1.5)

    def test_legacy_combined_definitions_and_instruct_only_profiles(self):
        normalize = self.routes._normalize_llamacpp_llm_profile
        legacy = normalize({"thinking_mode": "Instruct Spoon", "thinking_modes": ALL_MODES})
        self.assertEqual(self.routes._llamacpp_profile_mode_options(legacy), ALL_MODES)
        self.assertEqual(legacy["thinking_mode"], "Instruct Spoon")
        explicit = normalize({"thinking_mode": "Instruct Spoon", "thinking_modes": [], "instruct_modes": ["Spoon"]})
        self.assertEqual(self.routes._llamacpp_profile_mode_options(explicit), ["Instruct Spoon"])
        self.assertEqual(explicit["thinking_mode"], "Instruct Spoon")
        for definitions in (
            {"thinking_modes": [], "instruct_modes": []},
            {"thinking_modes": ["Disabled"], "instruct_modes": ["Spoon"]},
            {"thinking_modes": ["Spoon"], "instruct_modes": ["Instruct Spoon"]},
            {"thinking_modes": ["Spoon"], "instruct_modes": ["Unknown"]},
            {"thinking_modes": ["Spoon"], "instruct_modes": "Spoon"},
        ):
            with self.subTest(definitions=definitions), self.assertRaises(ValueError):
                normalize({"thinking_mode": "Spoon", **definitions})

    def test_unsupported_off_is_rejected_in_profile_and_not_used_for_generation(self):
        for definition in ({"thinking_modes": ["High", "Low"], "instruct_modes": []},
                           {"thinking_modes": ["High"]}):
            with self.subTest(definition=definition):
                with self.assertRaises(ValueError):
                    self.routes._normalize_llamacpp_llm_profile({**definition, "thinking_mode": "Disabled"})
                profile = self.routes._normalize_llamacpp_llm_profile({**definition, "thinking_mode": "High"})
                self.assertNotIn("Disabled", self.routes._llamacpp_profile_mode_options(profile))
                self.profile.write_text(json.dumps({"llm_profile": profile}), encoding="utf-8")
                result = self.routes._llamacpp_configured_generation_data({
                    "llm_provider": "llamacpp",
                    "llamacpp_config_profile": self.profile.name, "thinking_mode": "Disabled",
                })
                self.assertEqual(result["thinking_mode"], "High")

    def test_generation_and_token_count_use_identical_native_mode_and_thinking_switch(self):
        response = {"choices": [{"message": {"content": "A forest."}, "finish_reason": "stop"}]}
        for mode in ALL_MODES:
            with (
                self.subTest(mode=mode),
                mock.patch.object(self.nodes, "_post_json", return_value={"input_tokens": 250}) as count,
                mock.patch.object(self.nodes, "_llamacpp_context_length", return_value=8192),
                mock.patch.object(self.nodes, "_post_llamacpp_chat", return_value=response) as post,
            ):
                self.nodes._generate_llamacpp(
                    "Describe a forest", "http://localhost:8080", "twin.gguf",
                    300, 300, 1.0, 0.95, 20, 0.0, 1.0, 360, -1, mode, "", 120,
                    reasoning_budget_tokens=1000,
                )
                payload = post.call_args.args[1]
                token_payload = count.call_args.args[1]
                native = mode.removeprefix("Instruct ").lower() if mode != "Disabled" else "none"
                expected = {"enable_thinking": mode in MODES}
                if native != "none":
                    expected["reasoning_effort"] = native
                self.assertEqual(payload["chat_template_kwargs"], expected)
                self.assertEqual(token_payload["chat_template_kwargs"], expected)
                self.assertEqual(payload["reasoning_effort"], native)
                self.assertEqual(token_payload["reasoning_effort"], native)
                self.assertEqual(payload["max_tokens"], 1300 if mode in MODES else 300)
                if mode in MODES:
                    self.assertEqual(payload["thinking_budget_tokens"], 1000)
                else:
                    self.assertNotIn("thinking_budget_tokens", payload)

    def test_image_revision_accepts_every_profile_mode(self):
        for mode in ALL_MODES:
            with self.subTest(mode=mode), mock.patch.object(
                self.routes, "_generate_llamacpp", return_value="A forest."
            ) as generate:
                result = self.routes._revise({
                    "llm_provider": "llamacpp", "llamacpp_config_profile": self.profile.name,
                    "llamacpp_model": "twin.gguf", "thinking_mode": mode,
                    "model_profile": "General Natural Language", "mode": "render",
                    "style_preset": "None", "framing_preset": "None",
                    "embellishment_level": "None", "revision": "A forest.",
                })
                self.assertEqual(result, "A forest.")
                self.assertEqual(generate.call_args.args[12], mode)

    @unittest.skipUnless(os.environ.get("STUDIO_TEST_VIDEO") == "1", "Video integration is opt-in")
    def test_video_dispatch_preserves_all_modes(self):
        video_root = Path(__file__).resolve().parents[2] / "PromptStudio_Video"
        with mock.patch.object(sys, "path", [str(video_root), *sys.path]):
            adapter = importlib.import_module("video.llm_provider")
        shared = mock.Mock()
        for mode in ALL_MODES:
            with self.subTest(mode=mode), mock.patch.object(adapter, "_primary_routes", return_value=shared):
                adapter.generate_chat({"wire_version": 1, "llm_provider": "llamacpp", "thinking_mode": mode}, [])
                self.assertEqual(shared.shared_llm_generate.call_args.args[0]["thinking_mode"], mode)
