import asyncio
import base64
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

    class FakeResponse:
        def __init__(self, text=None, content_type=None, status=200, headers=None):
            self.text = text
            self.content_type = content_type
            self.status = status
            self.headers = dict(headers or {})
            self.cookies = {}

        def set_cookie(self, name, value, **kwargs):
            self.cookies[name] = {"value": value, **kwargs}

        def del_cookie(self, name, **kwargs):
            self.cookies[name] = {"value": "", "deleted": True, **kwargs}

    aiohttp = types.ModuleType("aiohttp")
    aiohttp.web = types.SimpleNamespace(
        Response=FakeResponse,
        json_response=lambda value, status=200: (value, status),
        middleware=lambda function: function,
    )
    sys.modules["aiohttp"] = aiohttp

    class Routes:
        @staticmethod
        def _decorator(path):
            return lambda function: function

        get = _decorator
        put = _decorator
        post = _decorator

    server = types.ModuleType("server")
    server.PromptServer = types.SimpleNamespace(
        instance=types.SimpleNamespace(routes=Routes(), app=types.SimpleNamespace(middlewares=[]))
    )
    sys.modules["server"] = server


def load_modules(storage_root):
    install_runtime_stubs(storage_root)
    package = types.ModuleType("ComfyUI_PromptStudio")
    package.__path__ = [str(REPO_ROOT)]
    sys.modules["ComfyUI_PromptStudio"] = package

    nodes_spec = importlib.util.spec_from_file_location("ComfyUI_PromptStudio.nodes", REPO_ROOT / "nodes.py")
    nodes = importlib.util.module_from_spec(nodes_spec)
    sys.modules[nodes_spec.name] = nodes
    nodes_spec.loader.exec_module(nodes)

    routes_spec = importlib.util.spec_from_file_location("ComfyUI_PromptStudio.routes", REPO_ROOT / "routes.py")
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

    def test_lan_access_address_scope_is_private_only(self):
        for address in ("192.168.1.25", "10.2.3.4", "172.16.0.8", "169.254.10.20", "fd12::42", "fe80::1"):
            with self.subTest(address=address):
                self.assertTrue(self.routes._is_lan_client(address))
        for address in ("8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "100.64.1.2", None, "invalid"):
            with self.subTest(address=address):
                self.assertFalse(self.routes._is_lan_client(address))
        self.assertTrue(self.routes._is_loopback_client("127.0.0.1"))
        self.assertTrue(self.routes._is_loopback_client("::1"))
        self.assertTrue(self.routes._is_loopback_client("::ffff:127.0.0.1"))
        self.assertFalse(self.routes._is_lan_client("127.0.0.1"))

    def test_lan_session_tokens_are_signed_and_expire(self):
        token = self.routes._session_token(now=1000)
        self.assertTrue(self.routes._valid_session_token(token, now=1001))
        self.assertFalse(self.routes._valid_session_token(token, now=1000 + self.routes.LAN_SESSION_SECONDS + 1))
        self.assertFalse(self.routes._valid_session_token(token + "changed", now=1001))
        self.assertFalse(self.routes._valid_session_token(None, now=1001))

    def test_lan_password_supports_base64_environment_transport(self):
        password = "correct horse battery staple & 100% ��"
        encoded = base64.b64encode(password.encode("utf-8")).decode("ascii")
        with mock.patch.dict(
            os.environ,
            {self.routes.LAN_PASSWORD_BASE64_ENV: encoded},
            clear=True,
        ):
            self.assertEqual(self.routes._password_from_environment(), password)
        with mock.patch.dict(
            os.environ,
            {
                self.routes.LAN_PASSWORD_ENV: "plain password wins",
                self.routes.LAN_PASSWORD_BASE64_ENV: encoded,
            },
            clear=True,
        ):
            self.assertEqual(self.routes._password_from_environment(), "plain password wins")

    def test_lan_login_redirects_remain_same_origin(self):
        default = "/extensions/ComfyUI_PromptStudio/prompt_studio.html"
        self.assertEqual(self.routes._safe_next_path("/extensions/example.html?mode=studio#ignored"), "/extensions/example.html?mode=studio")
        self.assertEqual(self.routes._safe_next_path("https://example.com/steal"), default)
        self.assertEqual(self.routes._safe_next_path("//example.com/steal"), default)
        self.assertEqual(self.routes._safe_next_path("/%2f/example.com/steal"), default)
        self.assertEqual(self.routes._safe_next_path("/\\example.com/steal"), default)
        self.assertEqual(self.routes._safe_next_path("not-a-path"), default)

    def test_lan_gate_allows_cross_site_navigation_but_not_cross_origin_actions(self):
        request = types.SimpleNamespace(
            method="GET",
            scheme="http",
            host="192.168.1.10:8188",
            headers={"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate"},
        )
        self.assertTrue(self.routes._same_origin_request(request))

        request.method = "POST"
        request.headers["Origin"] = "http://malicious.example"
        self.assertFalse(self.routes._same_origin_request(request))

        request.method = "GET"
        request.headers["Sec-Fetch-Mode"] = "websocket"
        self.assertFalse(self.routes._same_origin_request(request))

    def test_lan_login_failures_are_throttled_per_client(self):
        remote = "192.168.1.50"
        self.routes.LAN_LOGIN_FAILURES.clear()
        for index in range(self.routes.LAN_LOGIN_FAILURE_LIMIT):
            self.assertTrue(self.routes._login_attempt_allowed(remote, now=index))
            self.routes._record_login_failure(remote, now=index)
        self.assertFalse(self.routes._login_attempt_allowed(remote, now=10))
        self.assertTrue(
            self.routes._login_attempt_allowed(
                remote,
                now=self.routes.LAN_LOGIN_FAILURE_WINDOW + self.routes.LAN_LOGIN_FAILURE_LIMIT,
            )
        )

    def test_lan_middleware_denies_public_and_authenticates_private_clients(self):
        class Request:
            def __init__(self, remote, path="/", method="GET", headers=None, cookies=None, form=None):
                self.remote = remote
                self.path = path
                self.method = method
                self.headers = headers or {}
                self.cookies = cookies or {}
                self.query = {}
                self.rel_url = path
                self.host = "192.168.1.10:8188"
                self.scheme = "http"
                self.secure = False
                self.content_length = None
                self.form = form or {}

            async def post(self):
                return self.form

        async def handler(_request):
            return "allowed"

        public = asyncio.run(self.routes._lan_access_middleware(Request("8.8.8.8"), handler))
        self.assertEqual(public.status, 403)

        private = Request("192.168.1.50", headers={"Accept": "text/html"})
        unauthenticated = asyncio.run(self.routes._lan_access_middleware(private, handler))
        self.assertEqual(unauthenticated.status, 303)
        self.assertTrue(unauthenticated.headers["Location"].startswith(self.routes.LAN_LOGIN_PATH))

        login = Request(
            "192.168.1.50",
            path=self.routes.LAN_LOGIN_PATH,
            method="POST",
            headers={"Origin": "http://different-lan-name:8188", "Sec-Fetch-Site": "cross-site"},
            form={"password": "correct horse battery staple", "next": "/extensions/studio.html"},
        )
        with mock.patch.object(self.routes, "LAN_PASSWORD", "correct horse battery staple"):
            signed_in = asyncio.run(self.routes._lan_access_middleware(login, handler))
        self.assertEqual(signed_in.status, 303)
        self.assertEqual(signed_in.headers["Location"], "/extensions/studio.html")
        cookie = signed_in.cookies[self.routes.LAN_SESSION_COOKIE]
        self.assertTrue(cookie["httponly"])
        self.assertEqual(cookie["samesite"], "Strict")

        private.cookies[self.routes.LAN_SESSION_COOKIE] = cookie["value"]
        authenticated = asyncio.run(self.routes._lan_access_middleware(private, handler))
        self.assertEqual(authenticated, "allowed")

        login.form["password"] = "incorrect-��-password"
        with mock.patch.object(self.routes, "LAN_PASSWORD", "correct horse battery staple"):
            rejected = asyncio.run(self.routes._lan_access_middleware(login, handler))
        self.assertEqual(rejected.status, 401)

    def test_prompt_nodes_match_comfyui_resolution_selector(self):
        self.assertEqual(self.nodes._calculate_resolution("1:1 (Square)", 1.0, 8), (1024, 1024))
        self.assertEqual(self.nodes._calculate_resolution("16:9 (Widescreen)", 1.0, 64), (1344, 768))
        self.assertEqual(self.nodes._calculate_resolution("2:3 (Portrait Photo)", 2.0, 8), (1184, 1776))

        prompt, secondary, width, height = self.nodes.KCPP_PromptSlot().get_prompt(
            "A lighthouse",
            secondary_instructions="negative prompt",
            aspect_ratio="21:9 (Ultrawide)",
            megapixels=1.5,
            multiple=32,
        )
        self.assertEqual((prompt, secondary), ("A lighthouse", "negative prompt"))
        self.assertEqual((width, height), self.nodes._calculate_resolution("21:9 (Ultrawide)", 1.5, 32))

        _, _, edit_width, edit_height = self.nodes.KCPP_PromptSlot().get_prompt(
            "Edit the lighthouse",
            aspect_ratio="1:1 (Square)",
            megapixels=1.0,
            multiple=8,
            resolution_width=1237,
            resolution_height=811,
        )
        self.assertEqual((edit_width, edit_height), (1237, 811))

    def test_prompt_resolution_inputs_and_outputs_are_backward_compatible(self):
        slot_inputs = self.nodes.KCPP_PromptSlot.INPUT_TYPES()
        amplify_inputs = self.nodes.KCPP_PromptAmplify.INPUT_TYPES()
        self.assertNotIn("aspect_ratio", slot_inputs["optional"])
        for resolution_inputs in (slot_inputs["hidden"], amplify_inputs["optional"]):
            self.assertEqual(resolution_inputs["aspect_ratio"][1]["default"], "1:1 (Square)")
            self.assertEqual(resolution_inputs["megapixels"][1]["default"], 1.0)
            self.assertEqual(resolution_inputs["multiple"][1]["default"], 8)

        for node_class in (self.nodes.KCPP_PromptSlot, self.nodes.KCPP_PromptAmplify):
            hidden = node_class.INPUT_TYPES()["hidden"]
            self.assertEqual(hidden["resolution_width"][1]["default"], 0)
            self.assertEqual(hidden["resolution_height"][1]["default"], 0)
            self.assertEqual(node_class.RETURN_TYPES[-2:], ("INT", "INT"))
            self.assertEqual(node_class.RETURN_NAMES[-2:], ("width", "height"))

        self.assertEqual(
            self.nodes.KCPP_PromptSlot().get_prompt("legacy prompt"),
            ("legacy prompt", "", 1024, 1024),
        )

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

    def test_chat_budget_adds_reasoning_space_to_the_final_answer_allowance(self):
        self.assertEqual(self.nodes._chat_generation_budget(300, "Disabled"), (300, None))
        self.assertEqual(self.nodes._chat_generation_budget(300, "Minimal"), (334, None))
        self.assertEqual(self.nodes._chat_generation_budget(300, "Low"), (429, None))
        self.assertEqual(self.nodes._chat_generation_budget(300, "Medium"), (750, None))
        self.assertEqual(self.nodes._chat_generation_budget(300, "High"), (4396, 4096))
        self.assertEqual(self.nodes._chat_generation_budget(300, "High", 900), (900, 600))

    def test_high_thinking_length_failure_is_not_retried_without_thinking(self):
        response = {
            "choices": [
                {
                    "message": {"content": "", "reasoning_content": "unfinished reasoning"},
                    "finish_reason": "length",
                }
            ]
        }
        with (
            mock.patch.object(self.nodes, "_server_capabilities", return_value={"jinja": True}),
            mock.patch.object(self.nodes, "_server_context_length", return_value=8192),
            mock.patch.object(self.nodes, "_kobold_token_count", return_value=250),
            mock.patch.object(self.nodes, "_post_json", return_value=response) as post,
            self.assertRaisesRegex(RuntimeError, "4396-token completion budget"),
        ):
            self.nodes._generate_kcpp(
                "Rewrite this prompt",
                "http://localhost:5001",
                0,
                300,
                0.25,
                0.8,
                40,
                0.0,
                1.05,
                360,
                -1,
                "High",
                "",
                120,
                include_default_continuation_stops=True,
            )

        self.assertEqual(post.call_count, 1)
        self.assertEqual(post.call_args.args[1]["reasoning_effort"], "high")
        self.assertEqual(post.call_args.args[1]["thinking_budget_tokens"], 4096)
        self.assertEqual(post.call_args.args[1]["stop"], [])

    def test_chat_generation_uses_profile_default_as_final_answer_allowance(self):
        response = {
            "choices": [
                {
                    "message": {"content": "A finished image prompt.", "reasoning_content": "private"},
                    "finish_reason": "stop",
                }
            ]
        }
        with (
            mock.patch.object(self.nodes, "_server_capabilities", return_value={"jinja": True}),
            mock.patch.object(self.nodes, "_server_context_length", return_value=8192),
            mock.patch.object(self.nodes, "_kobold_token_count", return_value=250),
            mock.patch.object(self.nodes, "_post_json", return_value=response) as post,
        ):
            result = self.nodes._generate_kcpp(
                "Rewrite this prompt",
                "http://localhost:5001",
                0,
                300,
                0.25,
                0.8,
                40,
                0.0,
                1.05,
                360,
                -1,
                "Medium",
                "",
                120,
            )

        self.assertEqual(result, "A finished image prompt.")
        request_url, payload, timeout = post.call_args.args
        self.assertTrue(request_url.endswith("/v1/chat/completions"))
        self.assertEqual(timeout, 120)
        self.assertEqual(payload["max_tokens"], 750)
        self.assertEqual(payload["reasoning_effort"], "medium")
        self.assertTrue(payload["chat_template_kwargs"]["enable_thinking"])

    def test_raw_generation_keeps_one_total_continuation_limit(self):
        response = {"results": [{"text": "raw continuation", "finish_reason": "stop"}]}
        with (
            mock.patch.object(self.nodes, "_server_context_length", return_value=8192),
            mock.patch.object(self.nodes, "_kobold_token_count", return_value=250),
            mock.patch.object(self.nodes, "_post_json", return_value=response) as post,
        ):
            result = self.nodes._generate_kcpp_raw(
                "Complete this raw text",
                "http://localhost:5001",
                0,
                300,
                0.25,
                0.8,
                40,
                0.0,
                1.05,
                360,
                -1,
                "Medium",
                "",
                120,
            )

        self.assertEqual(result, "raw continuation")
        request_url, payload, timeout = post.call_args.args
        self.assertTrue(request_url.endswith("/api/v1/generate"))
        self.assertEqual(timeout, 120)
        self.assertEqual(payload["max_length"], 300)

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
        with mock.patch.dict(os.environ, {"PROMPT_STUDIO_KOBOLD_ALLOWED_HOSTS": "example.com"}, clear=True):
            self.assertEqual(self.nodes._clean_base_url("https://example.com"), "https://example.com")

    def test_image_reference_rejects_directory_escape(self):
        reference = json.dumps({"filename": "image.png", "subfolder": "..", "type": "output"})
        with self.assertRaisesRegex(ValueError, "cannot leave"):
            self.nodes._parse_chat_image_reference(reference)

    def test_chat_image_dimensions_reads_the_stored_image_size(self):
        path = Path(self.temp.name) / "sized.png"
        Image.new("RGB", (1237, 811), color="navy").save(path)
        reference = json.dumps({"filename": path.name, "subfolder": "", "type": "output"})
        self.assertEqual(self.nodes._chat_image_dimensions(reference), (1237, 811))

    def test_prompt_studio_upscale_node_loads_image_and_calculates_target_size(self):
        path = Path(self.temp.name) / "upscale.png"
        Image.new("RGB", (640, 360), color="navy").save(path)
        reference = json.dumps({"filename": path.name, "subfolder": "", "type": "output"})
        result = self.nodes.KCPP_PromptStudioUpscale().prepare_upscale(
            reference,
            upscale_factor=2.5,
            prompt="A navy frame",
            secondary_instructions="Preserve texture",
        )
        image, width, height, factor, prompt, secondary = result
        self.assertEqual(image.array.shape, (1, 360, 640, 3))
        self.assertEqual((width, height, factor), (1600, 900, 2.5))
        self.assertEqual((prompt, secondary), ("A navy frame", "Preserve texture"))
        self.assertEqual(
            self.nodes.KCPP_PromptStudioUpscale.RETURN_NAMES,
            ("image", "width", "height", "upscale_factor", "prompt", "secondary_instructions"),
        )

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
        template = {
            "id": "[PS] Create.json",
            "path": "[PS] Create.json",
            "name": "[PS] Create",
            "kind": "create",
            "promptNodeId": "1",
            "imageNodeId": "",
            "resultNodeIds": ["2"],
            "resultFields": ["images", "gifs"],
            "snapshot": {"output": {
                "1": {"class_type": "KCPP_PromptSlot", "inputs": {}},
                "2": {"class_type": "SaveImage", "inputs": {}},
            }},
        }
        with mock.patch.object(self.routes, "WORKFLOW_STORE_PATH", workflow_path):
            saved = self.routes._update_workflow_store({"revision": 0, "templates": [template]})
            self.assertEqual(saved["revision"], 1)
            with self.assertRaises(self.routes.StoreConflictError):
                self.routes._update_workflow_store({"revision": 0, "templates": [template]})
            invalid = {**template, "path": "[PS] Invalid.json", "id": "[PS] Invalid.json", "promptNodeId": "missing"}
            with self.assertRaisesRegex(ValueError, "prompt node"):
                self.routes._write_workflow_store({"revision": 1, "templates": [invalid]}, 1)
            incompatible = {
                **template,
                "path": "[PS] Incompatible.json",
                "id": "[PS] Incompatible.json",
                "snapshot": {"output": {
                    "1": {"class_type": "SaveImage", "inputs": {}},
                    "2": {"class_type": "SaveImage", "inputs": {}},
                }},
            }
            with self.assertRaisesRegex(ValueError, "incompatible class"):
                self.routes._write_workflow_store({"revision": 1, "templates": [incompatible]}, 1)
            missing_image_source = {
                **template,
                "path": "[PS] Edit.json",
                "id": "[PS] Edit.json",
                "kind": "edit",
            }
            with self.assertRaisesRegex(ValueError, "image source"):
                self.routes._write_workflow_store({"revision": 1, "templates": [missing_image_source]}, 1)
            upscale = {
                **template,
                "path": "[PS] Upscale.json",
                "id": "[PS] Upscale.json",
                "name": "[PS] Upscale",
                "kind": "upscale",
                "promptNodeId": "",
                "imageNodeId": "",
                "upscaleNodeId": "1",
                "snapshot": {"output": {
                    "1": {"class_type": "KCPP_PromptStudioUpscale", "inputs": {}},
                    "2": {"class_type": "SaveImage", "inputs": {}},
                }},
            }
            self.routes._validate_workflow_templates([upscale])
            missing_upscale_node = {**upscale, "upscaleNodeId": ""}
            with self.assertRaisesRegex(ValueError, "upscale node"):
                self.routes._validate_workflow_templates([missing_upscale_node])
            multiple_outputs = {**template, "resultNodeIds": ["1", "2"]}
            with self.assertRaisesRegex(ValueError, "exactly one image output"):
                self.routes._write_workflow_store({"revision": 1, "templates": [multiple_outputs]}, 1)
            manual_workflow = {**template, "path": "Manual.json", "id": "Manual.json"}
            with self.assertRaisesRegex(ValueError, r"\[PS\]"):
                self.routes._write_workflow_store({"revision": 1, "templates": [manual_workflow]}, 1)

    def test_legacy_workflow_profiles_are_not_used_as_live_templates(self):
        workflow_path = Path(self.temp.name) / "legacy-workflows.json"
        workflow_path.write_text(json.dumps({"version": 1, "revision": 7, "profiles": [{}]}), encoding="utf-8")
        with mock.patch.object(self.routes, "WORKFLOW_STORE_PATH", str(workflow_path)):
            loaded = self.routes._read_workflow_store()
        self.assertEqual(loaded, {"version": 3, "revision": 7, "templates": []})


if __name__ == "__main__":
    unittest.main()
