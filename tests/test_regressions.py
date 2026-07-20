import importlib.util
import json
import math
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image


REPO_ROOT = Path(__file__).resolve().parents[1]


class FakeTensor:
    def __init__(self, array):
        self.array = np.asarray(array)

    def __getitem__(self, key):
        return FakeTensor(self.array[key])

    def __rsub__(self, value):
        return FakeTensor(value - self.array)


def install_runtime_stubs(storage_root):
    torch = types.ModuleType("torch")
    torch.float32 = np.float32
    torch.from_numpy = lambda value: FakeTensor(value)
    torch.zeros = lambda shape, dtype=None: FakeTensor(np.zeros(shape, dtype=dtype or np.float32))
    torch.cat = lambda values, dim=0: FakeTensor(np.concatenate([value.array for value in values], axis=dim))
    sys.modules["torch"] = torch

    folder_paths = types.ModuleType("folder_paths")
    folder_paths.get_input_directory = lambda: storage_root
    folder_paths.get_output_directory = lambda: storage_root
    folder_paths.get_temp_directory = lambda: storage_root
    sys.modules["folder_paths"] = folder_paths

    aiohttp = types.ModuleType("aiohttp")
    aiohttp.web = types.SimpleNamespace(json_response=lambda value, status=200: (value, status))
    sys.modules["aiohttp"] = aiohttp

    class Routes:
        @staticmethod
        def _decorator(path):
            return lambda function: function

        get = _decorator
        put = _decorator
        post = _decorator

    server = types.ModuleType("server")
    server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=Routes()))
    sys.modules["server"] = server


def load_modules(storage_root):
    install_runtime_stubs(storage_root)
    package = types.ModuleType("ComfyUI_LLLM")
    package.__path__ = [str(REPO_ROOT)]
    sys.modules["ComfyUI_LLLM"] = package

    nodes_spec = importlib.util.spec_from_file_location("ComfyUI_LLLM.nodes", REPO_ROOT / "nodes.py")
    nodes = importlib.util.module_from_spec(nodes_spec)
    sys.modules[nodes_spec.name] = nodes
    nodes_spec.loader.exec_module(nodes)

    routes_spec = importlib.util.spec_from_file_location("ComfyUI_LLLM.routes", REPO_ROOT / "routes.py")
    routes = importlib.util.module_from_spec(routes_spec)
    sys.modules[routes_spec.name] = routes
    routes_spec.loader.exec_module(routes)
    return nodes, routes


class RegressionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.nodes, self.routes = load_modules(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_random_seed_invalidates_llm_nodes(self):
        self.assertTrue(math.isnan(self.nodes.KCPP_PromptAmplify.IS_CHANGED(sampler_seed=-1)))
        self.assertTrue(math.isnan(self.nodes.KCPP_Apply.IS_CHANGED(sampler_seed=-1)))
        self.assertTrue(math.isnan(self.nodes.KCPP_Ideogram4.IS_CHANGED(sampler_seed=-1)))
        self.assertEqual(self.nodes.KCPP_Apply.IS_CHANGED(sampler_seed=42), 42)

    def test_profile_wrappers_are_idempotent(self):
        profile = {"final_prompt_prefix": "PRE[", "final_prompt_suffix": "]SUF"}
        once = self.nodes._apply_profile_wrappers("prompt.", profile)
        twice = self.nodes._apply_profile_wrappers(once, profile)
        self.assertEqual(once, "PRE[prompt.]SUF")
        self.assertEqual(twice, once)

    def test_known_profile_wrappers_are_removed_when_switching_profiles(self):
        old_profile = {"final_prompt_prefix": "OLD[", "final_prompt_suffix": "]OLD"}
        new_profile = {"final_prompt_prefix": "NEW[", "final_prompt_suffix": "]NEW"}
        wrapped = "NEW[OLD[prompt]OLD]NEW"
        self.assertEqual(
            self.nodes._remove_known_profile_wrappers(wrapped, [old_profile, new_profile]),
            "prompt",
        )

    def test_response_cleanup_preserves_terminal_punctuation(self):
        self.assertEqual(self.nodes._strip_response("Final prompt: A quiet landscape."), "A quiet landscape.")
        self.assertEqual(self.nodes._strip_response('Final prompt: "STOP."'), '"STOP."')
        self.assertEqual(self.nodes._strip_apply_response('  "exact output"  '), '"exact output"')

    def test_bundled_profile_and_preset_files_are_valid_and_unambiguous(self):
        self.assertTrue(self.nodes._load_profiles())
        self.assertTrue(self.nodes._load_style_templates())
        framing_names = [item["name"] for item in self.nodes._load_framing_templates()]
        self.assertIn("First-Person Downward View", framing_names)
        self.assertEqual(len(framing_names), len({name.casefold() for name in framing_names}))

    def test_kobold_url_is_local_by_default_and_remote_is_explicit(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(self.nodes._clean_base_url("localhost:5001"), "http://localhost:5001")
            with self.assertRaises(ValueError):
                self.nodes._clean_base_url("https://example.com")
            with self.assertRaisesRegex(ValueError, "invalid port"):
                self.nodes._clean_base_url("http://localhost:99999")
        with mock.patch.dict(os.environ, {"LLLM_KOBOLD_ALLOWED_HOSTS": "example.com"}, clear=True):
            self.assertEqual(self.nodes._clean_base_url("https://example.com"), "https://example.com")

    def test_image_reference_rejects_directory_escape(self):
        reference = json.dumps({"filename": "image.png", "subfolder": "..", "type": "output"})
        with self.assertRaisesRegex(ValueError, "cannot leave"):
            self.nodes._parse_chat_image_reference(reference)

    def test_palette_transparency_produces_a_mask(self):
        path = Path(self.temp.name) / "palette.png"
        image = Image.new("P", (2, 2), color=0)
        image.putpalette([0, 0, 0, 255, 255, 255] + [0, 0, 0] * 254)
        image.save(path, transparency=0)
        reference = json.dumps({"filename": path.name, "subfolder": "", "type": "output"})
        _, mask = self.nodes.KCPP_ChatImageInput().load_image(reference)
        self.assertTrue(np.allclose(mask.array, 1.0))

    def test_chat_store_detects_stale_writes_and_keeps_backup(self):
        chat_path = str(Path(self.temp.name) / "chats.json")
        with mock.patch.object(self.routes, "CHAT_STORE_PATH", chat_path):
            first = self.routes._update_chat_store({"revision": 0, "activeChatId": None, "chats": []})
            self.assertEqual(first["revision"], 1)
            with self.assertRaises(self.routes.StoreConflictError):
                self.routes._update_chat_store({"revision": 0, "activeChatId": None, "chats": []})
            second = self.routes._update_chat_store({"revision": 1, "activeChatId": None, "chats": []})
            self.assertEqual(second["revision"], 2)
            backup = json.loads(Path(chat_path + ".bak").read_text(encoding="utf-8"))
            self.assertEqual(backup["revision"], 1)

    def test_workflow_store_validates_snapshots_and_detects_conflicts(self):
        workflow_path = str(Path(self.temp.name) / "workflows.json")
        profile = {
            "id": "profile-1",
            "name": "Create",
            "kind": "create",
            "promptNodeId": "1",
            "imageNodeId": "",
            "snapshot": {"output": {"1": {"class_type": "KCPP_PromptSlot", "inputs": {}}}},
        }
        with mock.patch.object(self.routes, "WORKFLOW_STORE_PATH", workflow_path):
            saved = self.routes._update_workflow_store({"revision": 0, "profiles": [profile]})
            self.assertEqual(saved["revision"], 1)
            with self.assertRaises(self.routes.StoreConflictError):
                self.routes._update_workflow_store({"revision": 0, "profiles": [profile]})
            invalid = {**profile, "id": "profile-2", "promptNodeId": "missing"}
            with self.assertRaisesRegex(ValueError, "prompt node"):
                self.routes._write_workflow_store({"revision": 1, "profiles": [invalid]}, 1)
            incompatible = {
                **profile,
                "id": "profile-2",
                "snapshot": {"output": {"1": {"class_type": "SaveImage", "inputs": {}}}},
            }
            with self.assertRaisesRegex(ValueError, "incompatible class"):
                self.routes._write_workflow_store({"revision": 1, "profiles": [incompatible]}, 1)


if __name__ == "__main__":
    unittest.main()
