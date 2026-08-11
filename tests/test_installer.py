import importlib.util
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("prompt_studio_installer", ROOT / "installer" / "wizard.py")
INSTALLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALLER)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        INSTALLER.SSL_CONTEXT = None

    def make_comfy(self, root):
        root = Path(root)
        (root / "models").mkdir(parents=True)
        (root / "custom_nodes").mkdir()
        (root / "main.py").write_text("# ComfyUI", encoding="utf-8")
        return root

    def test_comfy_root_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.make_comfy(Path(directory) / "ComfyUI")
            self.assertTrue(INSTALLER.is_comfy_root(root))
            (root / "main.py").unlink()
            self.assertFalse(INSTALLER.is_comfy_root(root))

    def test_comfy_version_falls_back_to_project_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.make_comfy(Path(directory) / "ComfyUI")
            (root / "pyproject.toml").write_text(
                '[project]\nname = "comfyui"\nversion = "1.2.3"\n\n[tool.example]\nvalue = true\n',
                encoding="utf-8",
            )
            self.assertEqual(INSTALLER._read_comfy_version(root), "1.2.3")

    def test_version_comparison(self):
        self.assertTrue(INSTALLER.version_at_least("0.31.0", "0.28.0"))
        self.assertFalse(INSTALLER.version_at_least("0.27.9", "0.28.0"))
        self.assertIsNone(INSTALLER.version_at_least("unknown", "0.28.0"))

    def test_extra_model_path_parser(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            config = base / "extra_model_paths.yaml"
            config.write_text(
                "shared:\n"
                "    base_path: D:\\Models\n"
                "    diffusion_models: diffusion\n"
                "    loras: |\n"
                "        lora\n"
                "        lycoris\n",
                encoding="utf-8",
            )
            result = INSTALLER.parse_extra_model_paths(config)
            self.assertEqual(len(result["diffusion_models"]), 1)
            self.assertEqual(len(result["loras"]), 2)
            self.assertTrue(str(result["diffusion_models"][0]).endswith("Models\\diffusion"))

    def test_asset_detection_accepts_alias(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model_root = root / "loras"
            model_root.mkdir()
            found = model_root / "model.safetensors"
            found.write_bytes(b"1234")
            asset = {
                "category": "loras",
                "relative_path": "nested/model.safetensors",
                "aliases": ["model.safetensors"],
                "size": 4,
            }
            status = INSTALLER.asset_status(asset, {"loras": [model_root]})
            self.assertEqual(status["state"], "present")
            self.assertEqual(Path(status["path"]), found)

    def test_complete_partial_download_is_verified_without_redownloading(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "model.bin"
            partial = target.with_suffix(".bin.part")
            partial.write_bytes(b"tiny")
            asset = {
                "name": "Tiny model",
                "size": 4,
                "sha256": hashlib.sha256(b"tiny").hexdigest(),
                "url": "https://example.invalid/model.bin",
            }
            with mock.patch.object(INSTALLER.urllib.request, "urlopen") as request:
                INSTALLER._download_asset(asset, target)
            request.assert_not_called()
            self.assertEqual(target.read_bytes(), b"tiny")
            self.assertFalse(partial.exists())

    def test_https_requests_use_verified_installer_context(self):
        request = INSTALLER.urllib.request.Request("https://example.invalid/model.bin")
        context = object()
        response = mock.MagicMock()
        with (
            mock.patch.object(INSTALLER, "_ssl_context", return_value=context),
            mock.patch.object(INSTALLER.urllib.request, "urlopen", return_value=response) as urlopen,
        ):
            self.assertIs(INSTALLER._urlopen(request, timeout=12), response)
        urlopen.assert_called_once_with(request, timeout=12, context=context)

    def test_http_requests_do_not_receive_tls_context(self):
        request = INSTALLER.urllib.request.Request("http://127.0.0.1:8188/system_stats")
        response = mock.MagicMock()
        with mock.patch.object(INSTALLER.urllib.request, "urlopen", return_value=response) as urlopen:
            self.assertIs(INSTALLER._urlopen(request, timeout=1), response)
        urlopen.assert_called_once_with(request, timeout=1)

    def test_certificate_failure_retries_with_windows_https(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "model.bin"
            payload = b"secure download"
            asset = {
                "name": "model.bin",
                "size": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
                "url": "https://example.invalid/model.bin",
            }

            def windows_download(_url, partial, _expected_size, _progress=None):
                partial.write_bytes(payload)

            certificate_error = INSTALLER.urllib.error.URLError(
                INSTALLER.ssl.SSLCertVerificationError("CERTIFICATE_VERIFY_FAILED")
            )
            with (
                mock.patch.object(INSTALLER.os, "name", "nt"),
                mock.patch.object(INSTALLER, "_urlopen", side_effect=certificate_error),
                mock.patch.object(
                    INSTALLER, "_download_with_windows_curl", side_effect=windows_download
                ) as fallback,
            ):
                INSTALLER._download_asset(asset, target)

            fallback.assert_called_once()
            self.assertEqual(target.read_bytes(), payload)

    def test_non_certificate_download_failure_is_not_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "model.bin"
            asset = {
                "name": "model.bin",
                "size": 4,
                "sha256": hashlib.sha256(b"tiny").hexdigest(),
                "url": "https://example.invalid/model.bin",
            }
            with (
                mock.patch.object(
                    INSTALLER, "_urlopen", side_effect=INSTALLER.urllib.error.URLError("offline")
                ),
                mock.patch.object(INSTALLER, "_download_with_windows_curl") as fallback,
            ):
                with self.assertRaises(INSTALLER.urllib.error.URLError):
                    INSTALLER._download_asset(asset, target)
            fallback.assert_not_called()

    def test_plan_reuses_present_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.make_comfy(Path(directory) / "ComfyUI")
            pack = {
                "id": "tiny_pack",
                "name": "Tiny pack",
                "workflow_name": "[PS] Tiny.json",
                "assets": [
                    {
                        "id": "tiny_model",
                        "name": "Tiny model",
                        "category": "vae",
                        "relative_path": "tiny.bin",
                        "aliases": [],
                        "size": 4,
                    }
                ],
            }
            catalog = {"version": 1, "packs": [pack]}
            for asset in pack["assets"]:
                target = INSTALLER.choose_download_path(root, asset)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"tiny")
            with mock.patch.object(INSTALLER, "load_catalog", return_value=catalog):
                plan = INSTALLER.build_plan(
                    {"comfy_path": str(root), "pack_ids": [pack["id"]], "download_models": True}
                )
            self.assertEqual(plan["download_bytes"], 0)
            self.assertEqual(sum(action["type"] == "keep_model" for action in plan["actions"]), 1)

    def test_hardware_recommendation_reserves_large_models_for_second_gpu(self):
        recommendations = [
            {"model": "small", "size": 2_000, "min_ram": 8, "min_vram": 4},
            {"model": "medium", "size": 6_000_000_000, "min_ram": 16, "min_vram": 8},
            {"model": "large", "size": 20_000_000_000, "min_ram": 32, "min_vram": 20},
        ]
        one_gpu = {"ram_total": 64, "gpus": [{"vram_total": 32}]}
        two_gpus = {"ram_total": 64, "gpus": [{"vram_total": 32}, {"vram_total": 32}]}
        self.assertEqual(INSTALLER.recommended_llm_model(one_gpu, recommendations), "medium")
        self.assertEqual(INSTALLER.recommended_llm_model(two_gpus, recommendations), "large")

    def test_fresh_plan_provisions_before_installing_models(self):
        with tempfile.TemporaryDirectory() as directory:
            install_dir = Path(directory) / "Portable"
            release = {
                "name": "ComfyUI_windows_portable_nvidia.7z",
                "release": "v9.9.9",
                "size": 1234,
                "sha256": "a" * 64,
                "url": "https://example.invalid/comfy.7z",
            }
            with (
                mock.patch.object(INSTALLER, "_github_release_asset", return_value=release),
                mock.patch.object(INSTALLER, "_vc_runtime_installed", return_value=False),
            ):
                plan = INSTALLER.build_plan(
                    {
                        "comfy_mode": "fresh",
                        "comfy_install_dir": str(install_dir),
                        "comfy_variant": "nvidia",
                        "pack_ids": ["krea2_turbo"],
                        "download_models": True,
                        "llm_provider": "none",
                    }
                )
            self.assertEqual(plan["comfy"]["path"], str(install_dir / "ComfyUI"))
            self.assertEqual(plan["actions"][0]["type"], "install_vc_runtime")
            self.assertEqual(plan["actions"][1]["type"], "provision_comfy")
            self.assertIn("install_prompt_studio", [action["type"] for action in plan["actions"]])
            self.assertIn("create_launcher", [action["type"] for action in plan["actions"]])
            model_bytes = sum(asset["size"] for asset in INSTALLER.load_catalog()["packs"][0]["assets"])
            self.assertEqual(plan["download_bytes"], release["size"] + model_bytes)

    def test_fresh_retry_reuses_completed_portable_install(self):
        with tempfile.TemporaryDirectory() as directory:
            install_dir = Path(directory) / "Portable"
            root = self.make_comfy(install_dir / "ComfyUI")
            (root / "pyproject.toml").write_text(
                '[project]\nname = "comfyui"\nversion = "0.31.0"\n', encoding="utf-8"
            )
            with (
                mock.patch.object(INSTALLER, "_vc_runtime_installed", return_value=False),
                mock.patch.object(INSTALLER, "_github_release_asset") as release_lookup,
            ):
                plan = INSTALLER.build_plan(
                    {
                        "comfy_mode": "fresh",
                        "comfy_install_dir": str(install_dir),
                        "comfy_variant": "nvidia",
                        "pack_ids": ["krea2_turbo"],
                        "download_models": True,
                        "llm_provider": "none",
                    }
                )
            release_lookup.assert_not_called()
            action_types = [action["type"] for action in plan["actions"]]
            self.assertEqual(action_types[0], "install_vc_runtime")
            self.assertNotIn("provision_comfy", action_types)
            self.assertIn("verify_comfy", action_types)

    def test_vc_runtime_detection_requires_all_torch_runtime_dlls(self):
        with tempfile.TemporaryDirectory() as directory:
            system32 = Path(directory) / "System32"
            system32.mkdir()
            with (
                mock.patch.object(INSTALLER.os, "name", "nt"),
                mock.patch.dict(INSTALLER.os.environ, {"SystemRoot": directory}),
            ):
                self.assertFalse(INSTALLER._vc_runtime_installed())
                for name in INSTALLER.VC_RUNTIME_DLLS:
                    (system32 / name).write_bytes(b"runtime")
                self.assertTrue(INSTALLER._vc_runtime_installed())

    def test_microsoft_prerequisite_requires_valid_authenticode_signer(self):
        valid = mock.Mock(
            returncode=0,
            stdout=json.dumps({"Status": "Valid", "Subject": "CN=Microsoft Corporation, O=Microsoft Corporation"}),
            stderr="",
        )
        with mock.patch.object(INSTALLER.subprocess, "run", return_value=valid):
            signer = INSTALLER._verify_microsoft_authenticode(Path("vc_redist.x64.exe"))
        self.assertIn("Microsoft Corporation", signer)

        invalid = mock.Mock(
            returncode=0,
            stdout=json.dumps({"Status": "NotSigned", "Subject": ""}),
            stderr="",
        )
        with mock.patch.object(INSTALLER.subprocess, "run", return_value=invalid):
            with self.assertRaisesRegex(RuntimeError, "Refusing to run"):
                INSTALLER._verify_microsoft_authenticode(Path("vc_redist.x64.exe"))

    def test_vc_runtime_installer_downloads_verifies_and_elevates(self):
        completed = mock.Mock(returncode=0, stdout="", stderr="")
        with (
            mock.patch.object(INSTALLER, "_vc_runtime_installed", side_effect=[False, True]),
            mock.patch.object(INSTALLER, "_download_prerequisite") as download,
            mock.patch.object(
                INSTALLER, "_verify_microsoft_authenticode", return_value="CN=Microsoft Corporation"
            ) as verify,
            mock.patch.object(INSTALLER.subprocess, "run", return_value=completed) as run,
        ):
            message = INSTALLER._install_vc_runtime({"url": "https://example.invalid/vc.exe"})
        download.assert_called_once()
        verify.assert_called_once()
        self.assertIn("Start-Process", run.call_args.args[0][4])
        self.assertIn("Installed", message)

    def test_fresh_plan_adds_managed_ollama_when_no_runtime_exists(self):
        with tempfile.TemporaryDirectory() as directory:
            install_dir = Path(directory) / "Portable"
            comfy_release = {
                "name": "ComfyUI_windows_portable_nvidia.7z",
                "release": "v9.9.9",
                "size": 1234,
                "sha256": "a" * 64,
                "url": "https://example.invalid/comfy.7z",
            }
            ollama_release = {
                "name": "ollama-windows-amd64.zip",
                "release": "v8.8.8",
                "size": 5678,
                "sha256": "b" * 64,
                "url": "https://example.invalid/ollama.zip",
            }

            def release_for(_config, name):
                return ollama_release if name.startswith("ollama") else comfy_release

            with (
                mock.patch.object(INSTALLER, "_github_release_asset", side_effect=release_for),
                mock.patch.object(INSTALLER, "_find_ollama_executable", return_value=None),
            ):
                plan = INSTALLER.build_plan(
                    {
                        "comfy_mode": "fresh",
                        "comfy_install_dir": str(install_dir),
                        "comfy_variant": "nvidia",
                        "pack_ids": ["krea2_turbo"],
                        "download_models": True,
                        "llm_provider": "ollama",
                        "llm_management": "managed",
                        "llm_model": "qwen3-vl:4b",
                        "ollama_installed_models": [],
                    }
                )
            action_types = [action["type"] for action in plan["actions"]]
            self.assertIn("install_ollama", action_types)
            self.assertIn("pull_ollama_model", action_types)
            self.assertGreater(plan["required_free"], plan["download_bytes"])

    def test_portable_provisioning_validates_extracted_layout(self):
        with tempfile.TemporaryDirectory() as directory:
            install_dir = Path(directory) / "Portable"
            action = {
                "target": str(install_dir),
                "asset": {
                    "name": "ComfyUI.7z",
                    "size": 4,
                    "sha256": "a" * 64,
                    "url": "https://example.invalid/ComfyUI.7z",
                },
            }

            def fake_extract(command, **_kwargs):
                staging = Path(command[command.index("-C") + 1])
                self.make_comfy(staging / "ComfyUI_windows_portable" / "ComfyUI")
                return mock.Mock(returncode=0, stdout="", stderr="")

            with (
                mock.patch.object(INSTALLER, "_download_asset", return_value="downloaded"),
                mock.patch.object(INSTALLER.shutil, "which", return_value="tar.exe"),
                mock.patch.object(INSTALLER.subprocess, "run", side_effect=fake_extract),
            ):
                message = INSTALLER._provision_comfy(action)
            self.assertTrue(INSTALLER.is_comfy_root(install_dir / "ComfyUI"))
            self.assertIn("Installed official ComfyUI", message)

    def test_comfy_startup_reports_early_process_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.make_comfy(Path(directory) / "Portable" / "ComfyUI")
            python = root.parent / "python_embeded" / "python.exe"
            python.parent.mkdir()
            python.write_bytes(b"")
            startup_log = root / "prompt-studio-startup.log"
            startup_log.write_text("ModuleNotFoundError: missing dependency", encoding="utf-8")
            process = mock.Mock()
            process.poll.return_value = 1
            with (
                mock.patch.object(INSTALLER, "_probe_comfy_endpoints", return_value=[]),
                mock.patch.object(INSTALLER, "_visible_process", return_value=process),
                mock.patch.object(INSTALLER.time, "sleep"),
            ):
                with self.assertRaisesRegex(RuntimeError, "ModuleNotFoundError"):
                    INSTALLER._start_comfy(root, 8188)

    def test_comfy_startup_explains_visual_cpp_prerequisite(self):
        with tempfile.TemporaryDirectory() as directory:
            startup_log = Path(directory) / "prompt-studio-startup.log"
            startup_log.write_text(
                "Microsoft Visual C++ Redistributable is not installed\n"
                "OSError: [WinError 126] Error loading c10.dll",
                encoding="utf-8",
            )
            error = INSTALLER._comfy_startup_failure(1, startup_log)
            self.assertIn("Visual C++ 2015-2022 Redistributable (x64)", str(error))
            self.assertIn("vc_redist.x64.exe", str(error))

    def test_comfy_startup_reports_wait_progress(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.make_comfy(Path(directory) / "Portable" / "ComfyUI")
            python = root.parent / "python_embeded" / "python.exe"
            python.parent.mkdir()
            python.write_bytes(b"")
            process = mock.Mock()
            process.poll.return_value = None
            progress = mock.Mock()
            with (
                mock.patch.object(INSTALLER, "_probe_comfy_endpoints", return_value=[]),
                mock.patch.object(INSTALLER, "_visible_process", return_value=process),
                mock.patch.object(INSTALLER.time, "sleep"),
                mock.patch.object(INSTALLER, "_request_json", return_value={}),
            ):
                INSTALLER._start_comfy(root, 8188, progress)
            progress.assert_called_once_with(1, 180)

    def test_generated_launcher_shows_only_comfy_terminal_and_carries_setup_choice(self):
        with tempfile.TemporaryDirectory() as directory:
            portable = Path(directory) / "Portable"
            root = self.make_comfy(portable / "ComfyUI")
            python = portable / "python_embeded" / "python.exe"
            python.parent.mkdir()
            python.write_bytes(b"")
            browser = Path(directory) / "Browser" / "msedge.exe"
            browser.parent.mkdir()
            browser.write_bytes(b"")
            plan = {
                "llm_provider": "ollama",
                "llm_model": "qwen3-vl:4b",
                "ollama_executable": str(portable / "ollama.exe"),
                "ollama_gpu": "",
                "kobold_url": "",
            }
            (portable / "ollama.exe").write_bytes(b"")
            with mock.patch.object(INSTALLER, "_preferred_browser_executable", return_value=browser):
                INSTALLER._write_launcher(root, plan, 8188)
            text = (root / "Start Prompt Studio.vbs").read_text(encoding="utf-8-sig")
            self.assertIn("shell.Run", text)
            self.assertIn(", 0, False", text)
            self.assertIn(", 1, False", text)
            self.assertIn("promptstudio_setup=1", text)
            self.assertIn("qwen3-vl%3A4b", text)
            self.assertIn("msedge.exe", text)

    def test_setup_browser_uses_an_installed_executable_without_http_association(self):
        browser = Path("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
        with (
            mock.patch.object(INSTALLER, "_preferred_browser_executable", return_value=browser),
            mock.patch.object(INSTALLER.subprocess, "Popen") as launch,
            mock.patch.object(INSTALLER.webbrowser, "open") as protocol,
        ):
            self.assertTrue(INSTALLER._open_browser_url("http://127.0.0.1:1234/"))
        self.assertEqual(launch.call_args.args[0], [str(browser), "http://127.0.0.1:1234/"])
        protocol.assert_not_called()

    def test_registered_http_browser_precedes_fallback_browser(self):
        default = Path("C:/Default/browser.exe")
        fallback = Path("C:/Fallback/browser.exe")
        with (
            mock.patch.object(INSTALLER, "_default_http_browser_executable", return_value=default),
            mock.patch.object(INSTALLER, "_find_browser_executable", return_value=fallback) as find_fallback,
        ):
            self.assertEqual(INSTALLER._preferred_browser_executable(), default)
        find_fallback.assert_not_called()

    def test_folder_browse_uses_native_windows_picker(self):
        with (
            mock.patch.object(INSTALLER.os, "name", "nt"),
            mock.patch.object(
                INSTALLER, "_browse_folder_windows", return_value=r"C:\ComfyUI"
            ) as picker,
        ):
            self.assertEqual(INSTALLER.browse_folder("existing"), r"C:\ComfyUI")
        picker.assert_called_once_with("Select the ComfyUI folder containing main.py")
        source = (ROOT / "installer" / "wizard.py").read_text(encoding="utf-8")
        self.assertNotIn("System.Windows.Forms.FolderBrowserDialog", source)

    def test_existing_folder_browse_immediately_inspects_selection(self):
        self.assertIn(
            'if(data.path){$("#comfy-path").value=data.path;state.comfy=null;'
            "validateNext();await inspectComfyPath(data.path)}",
            INSTALLER.HTML,
        )

    def test_catalog_is_self_consistent(self):
        catalog = INSTALLER.load_catalog()
        for pack in catalog["packs"]:
            workflow = ROOT / "installer" / pack["workflow_file"]
            self.assertTrue(workflow.is_file(), workflow)
            json.loads(workflow.read_text(encoding="utf-8"))
            for asset in pack["assets"]:
                self.assertEqual(len(asset["sha256"]), 64)
                self.assertGreater(asset["size"], 0)
                self.assertTrue(asset["url"].startswith("https://"))


if __name__ == "__main__":
    unittest.main()
