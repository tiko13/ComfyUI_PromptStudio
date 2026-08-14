"""Source-readable local browser installer for ComfyUI Prompt Studio.

The helper deliberately uses only Python's standard library. It binds to loopback,
requires a random per-run token, and performs mutations only after the browser has
shown and submitted the install review.
"""

from __future__ import annotations

import argparse
import ctypes
import datetime as dt
import hashlib
import json
import os
import platform
import re
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


INSTALLER_DIR = Path(__file__).resolve().parent
SOURCE_ROOT = INSTALLER_DIR.parent
CATALOG_PATH = INSTALLER_DIR / "catalog.json"
LOG_PATH = INSTALLER_DIR / "prompt-studio-setup.log"
LOOPBACK = "127.0.0.1"
DEFAULT_COMFY_PORTS = (8188, 8189, 8190)
TOKEN = os.environ.get("PROMPT_STUDIO_SETUP_TOKEN") or secrets.token_urlsafe(32)
JOBS = {}
JOBS_LOCK = threading.Lock()
MANAGED_PROCESSES = []
SSL_CONTEXT = None
SSL_CONTEXT_LOCK = threading.Lock()
VC_RUNTIME_DLLS = ("vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll")

CATEGORY_DIRS = {
    "diffusion_models": "diffusion_models",
    "text_encoders": "text_encoders",
    "vae": "vae",
    "loras": "loras",
}


def _log(message):
    stamp = dt.datetime.now().isoformat(timespec="seconds")
    line = "[{}] {}\n".format(stamp, message)
    try:
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(line)
    except OSError:
        pass


def load_catalog():
    with CATALOG_PATH.open("r", encoding="utf-8") as handle:
        catalog = json.load(handle)
    if catalog.get("version") != 1 or not isinstance(catalog.get("packs"), list):
        raise RuntimeError("Unsupported installer catalog")
    return catalog


def _ssl_context():
    """Return a verified TLS context augmented with the Windows root store.

    Python's OpenSSL bundle can differ from the roots trusted by Windows. That is
    especially common on managed networks whose HTTPS inspection certificate is
    installed in Windows but not in Python's CA bundle.
    """
    global SSL_CONTEXT
    if SSL_CONTEXT is not None:
        return SSL_CONTEXT
    with SSL_CONTEXT_LOCK:
        if SSL_CONTEXT is not None:
            return SSL_CONTEXT
        context = ssl.create_default_context()
        if os.name == "nt" and hasattr(ssl, "enum_certificates"):
            server_auth = "1.3.6.1.5.5.7.3.1"
            certificates = []
            try:
                for certificate, encoding, trust in ssl.enum_certificates("ROOT"):
                    trusted_for_server = trust is True or (
                        isinstance(trust, (set, frozenset)) and server_auth in trust
                    )
                    if encoding == "x509_asn" and trusted_for_server:
                        certificates.append(ssl.DER_cert_to_PEM_cert(certificate))
                if certificates:
                    context.load_verify_locations(cadata="".join(certificates))
                    _log("Loaded {} trusted Windows root certificates for HTTPS".format(len(certificates)))
            except (OSError, ssl.SSLError, TypeError) as exc:
                _log("Could not augment HTTPS trust from the Windows root store: {}".format(exc))
        SSL_CONTEXT = context
        return SSL_CONTEXT


def _urlopen(request, timeout):
    url = request.full_url if isinstance(request, urllib.request.Request) else str(request)
    options = {"timeout": timeout}
    if urllib.parse.urlsplit(url).scheme.lower() == "https":
        options["context"] = _ssl_context()
    return urllib.request.urlopen(request, **options)


def _request_json(url, timeout=1.5, method="GET", payload=None):
    data = None
    headers = {"User-Agent": "PromptStudioSetup/0.1"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with _urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _github_release_asset(config, asset_name):
    """Resolve an official GitHub release asset and require its published SHA-256."""
    try:
        release = _request_json(config["release_api"], timeout=12)
        for item in release.get("assets", []):
            if item.get("name") != asset_name:
                continue
            digest = str(item.get("digest") or "")
            if not digest.startswith("sha256:") or len(digest) != 71:
                raise RuntimeError("The official release did not publish a usable SHA-256 for {}.".format(asset_name))
            return {
                "name": asset_name,
                "release": str(release.get("tag_name") or "latest"),
                "size": int(item["size"]),
                "sha256": digest.split(":", 1)[1].lower(),
                "url": item["browser_download_url"],
            }
    except Exception as exc:
        _log("Latest release lookup failed for {}: {}".format(asset_name, exc))
    fallback = config.get("fallback") or {}
    assets = fallback.get("assets") if isinstance(fallback.get("assets"), dict) else None
    if assets:
        for value in assets.values():
            if value.get("name") == asset_name:
                return {**value, "release": fallback.get("tag", "verified fallback")}
    if fallback.get("name") == asset_name:
        return {**fallback, "release": fallback.get("tag", "verified fallback")}
    raise RuntimeError("Could not resolve the official release asset {}. Check the internet connection and retry.".format(asset_name))


def _human_bytes(value):
    value = float(value or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1000 or unit == "TB":
            return "{:.1f} {}".format(value, unit)
        value /= 1000


def _ram_bytes():
    if os.name == "nt":
        class MemoryStatus(ctypes.Structure):
            _fields_ = [
                ("length", ctypes.c_ulong),
                ("memory_load", ctypes.c_ulong),
                ("total_physical", ctypes.c_ulonglong),
                ("available_physical", ctypes.c_ulonglong),
                ("total_page_file", ctypes.c_ulonglong),
                ("available_page_file", ctypes.c_ulonglong),
                ("total_virtual", ctypes.c_ulonglong),
                ("available_virtual", ctypes.c_ulonglong),
                ("available_extended_virtual", ctypes.c_ulonglong),
            ]

        status = MemoryStatus()
        status.length = ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return int(status.total_physical), int(status.available_physical)
    try:
        page_size = os.sysconf("SC_PAGE_SIZE")
        return int(page_size * os.sysconf("SC_PHYS_PAGES")), int(page_size * os.sysconf("SC_AVPHYS_PAGES"))
    except (AttributeError, OSError, ValueError):
        return 0, 0


def _nvidia_gpus():
    command = [
        "nvidia-smi",
        "--query-gpu=index,name,memory.total,memory.free,driver_version",
        "--format=csv,noheader,nounits",
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=4, check=True)
    except (OSError, subprocess.SubprocessError):
        return []
    gpus = []
    for line in result.stdout.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 5:
            continue
        try:
            gpus.append(
                {
                    "index": int(parts[0]),
                    "name": parts[1],
                    "vram_total": int(parts[2]) * 1024 * 1024,
                    "vram_free": int(parts[3]) * 1024 * 1024,
                    "driver": parts[4],
                    "backend": "CUDA",
                }
            )
        except ValueError:
            continue
    return gpus


def _display_adapters():
    if os.name != "nt":
        return []
    script = "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command", script],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def hardware_snapshot():
    total_ram, available_ram = _ram_bytes()
    gpus = _nvidia_gpus()
    return {
        "os": platform.platform(),
        "system": platform.system(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "cpu": platform.processor() or os.environ.get("PROCESSOR_IDENTIFIER", "Unknown CPU"),
        "ram_total": total_ram,
        "ram_available": available_ram,
        "gpus": gpus,
        "display_adapters": _display_adapters(),
    }


def _vc_runtime_installed():
    if os.name != "nt":
        return True
    system_root = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    system32 = system_root / "System32"
    return all((system32 / name).is_file() for name in VC_RUNTIME_DLLS)


def recommended_comfy_variant(hardware):
    if hardware.get("gpus"):
        return "nvidia"
    names = " ".join(hardware.get("display_adapters") or []).lower()
    if any(token in names for token in ("radeon", " amd ", "rx ")):
        return "amd"
    if any(token in names for token in ("intel", "arc")):
        return "intel"
    return "nvidia"  # The NVIDIA portable also has an explicit CPU launcher.


def recommended_llm_model(hardware, recommendations):
    gpus = hardware.get("gpus") or []
    ram = int(hardware.get("ram_total") or 0)
    if len(gpus) > 1:
        available = int(gpus[1].get("vram_total") or 0)
    elif gpus:
        available = int(gpus[0].get("vram_total") or 0)
    else:
        available = 0
    eligible = [
        item for item in recommendations
        if ram >= int(item.get("min_ram") or 0) and (not available or available >= int(item.get("min_vram") or 0))
    ]
    if not eligible:
        return recommendations[0]["model"] if recommendations else ""
    # Reserve the largest profiles for a separate GPU; a single GPU is released between LLM and image work.
    if len(gpus) < 2:
        eligible = [item for item in eligible if int(item.get("size") or 0) <= 6_500_000_000] or eligible[:1]
    return eligible[-1]["model"]


def is_comfy_root(path):
    path = Path(path)
    return path.is_dir() and (path / "main.py").is_file() and (path / "models").is_dir() and (path / "custom_nodes").is_dir()


def _process_comfy_paths():
    if os.name != "nt":
        return []
    script = (
        "Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -match 'main\\.py'} | "
        "Select-Object -ExpandProperty CommandLine"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command", script],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    found = []
    for line in result.stdout.splitlines():
        for match in re.finditer(r'(?i)(?:^|\s)["\']?([^"\']*?main\.py)', line):
            candidate = Path(match.group(1).strip()).expanduser()
            if not candidate.is_absolute():
                continue
            found.append(candidate.parent)
    return found


def discover_comfy_paths(extra_paths=None):
    candidates = []
    for ancestor in [SOURCE_ROOT] + list(SOURCE_ROOT.parents):
        candidates.append(ancestor)
    for name in ("COMFYUI_PATH", "COMFYUI_ROOT"):
        if os.environ.get(name):
            candidates.append(Path(os.environ[name]))
    home = Path.home()
    candidates.extend(
        [
            home / "ComfyUI",
            home / "Documents" / "ComfyUI",
            home / "Downloads" / "ComfyUI_windows_portable" / "ComfyUI",
            Path("C:/ComfyUI"),
            Path("C:/EasyDiffusion/ComfyUI"),
        ]
    )
    candidates.extend(_process_comfy_paths())
    candidates.extend(Path(value) for value in (extra_paths or []) if value)
    resolved = []
    seen = set()
    for candidate in candidates:
        try:
            candidate = candidate.resolve()
        except OSError:
            continue
        key = os.path.normcase(str(candidate))
        if key in seen or not is_comfy_root(candidate):
            continue
        seen.add(key)
        resolved.append(candidate)
    return resolved


def _read_comfy_version(root):
    for path in (root / "comfy_version.py", root / "comfy" / "comfy_version.py"):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        match = re.search(r'__version__\s*=\s*["\']([^"\']+)', text)
        if match:
            return match.group(1)
    try:
        text = (root / "pyproject.toml").read_text(encoding="utf-8")
    except OSError:
        return "unknown"
    project = re.search(r"(?ms)^\[project\]\s*(.*?)(?=^\[|\Z)", text)
    if project:
        match = re.search(r'^version\s*=\s*["\']([^"\']+)', project.group(1), re.MULTILINE)
        if match:
            return match.group(1)
    return "unknown"


def _comfy_kind(root):
    if (root.parent / "python_embeded" / "python.exe").is_file():
        return "Portable"
    if (root / ".venv" / "Scripts" / "python.exe").is_file():
        return "Desktop / venv"
    if (root / "venv" / "Scripts" / "python.exe").is_file():
        return "Manual / venv"
    return "Manual"


def _version_key(value):
    numbers = re.findall(r"\d+", str(value or ""))
    return tuple(int(number) for number in numbers[:3]) if numbers else ()


def version_at_least(current, required):
    current_key = _version_key(current)
    required_key = _version_key(required)
    if not current_key or not required_key:
        return None
    width = max(len(current_key), len(required_key))
    return current_key + (0,) * (width - len(current_key)) >= required_key + (0,) * (width - len(required_key))


def _version_key(value):
    numbers = re.findall(r"\d+", str(value or ""))
    return tuple(int(number) for number in numbers[:3]) if numbers else ()


def version_at_least(current, required):
    current_key = _version_key(current)
    required_key = _version_key(required)
    if not current_key or not required_key:
        return None
    width = max(len(current_key), len(required_key))
    return current_key + (0,) * (width - len(current_key)) >= required_key + (0,) * (width - len(required_key))


def parse_extra_model_paths(config_path):
    """Parse the deliberately small YAML subset used by ComfyUI path configs."""
    config_path = Path(config_path)
    try:
        lines = config_path.read_text(encoding="utf-8-sig").splitlines()
    except OSError:
        return {}
    sections = []
    current = None
    multiline_key = None
    for raw in lines:
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        text = line.strip()
        if indent == 0 and text.endswith(":"):
            current = {"name": text[:-1].strip(), "base_path": "", "paths": {}}
            sections.append(current)
            multiline_key = None
            continue
        if current is None:
            continue
        if indent <= 4 and ":" in text:
            key, value = [part.strip() for part in text.split(":", 1)]
            value = value.strip('"\'')
            if key == "base_path":
                current["base_path"] = value
                multiline_key = None
            elif value == "|":
                current["paths"].setdefault(key, [])
                multiline_key = key
            elif value:
                current["paths"].setdefault(key, []).append(value)
                multiline_key = None
            continue
        if multiline_key and indent > 4:
            current["paths"].setdefault(multiline_key, []).append(text.strip('"\''))

    result = {}
    for section in sections:
        base_text = os.path.expandvars(os.path.expanduser(section["base_path"]))
        base = Path(base_text) if base_text else config_path.parent
        if not base.is_absolute():
            base = config_path.parent / base
        for category, values in section["paths"].items():
            normalized = "diffusion_models" if category == "unet" else category
            for value in values:
                expanded = os.path.expandvars(os.path.expanduser(value))
                target = Path(expanded)
                if not target.is_absolute():
                    target = base / target
                result.setdefault(normalized, []).append(target.resolve())
    return result


def model_roots(root):
    result = {category: [root / "models" / directory] for category, directory in CATEGORY_DIRS.items()}
    for name in ("extra_model_paths.yaml", "extra_model_paths.yml"):
        extra = parse_extra_model_paths(root / name)
        for category, paths in extra.items():
            if category in result:
                result[category].extend(paths)
    for category, paths in result.items():
        unique = []
        seen = set()
        for path in paths:
            key = os.path.normcase(str(path))
            if key not in seen:
                seen.add(key)
                unique.append(path)
        result[category] = unique
    return result


def _asset_candidates(asset, roots):
    names = [asset["relative_path"]] + list(asset.get("aliases") or [])
    for root in roots.get(asset["category"], []):
        for name in names:
            yield root / Path(name.replace("/", os.sep).replace("\\", os.sep))


def asset_status(asset, roots):
    wrong_size = []
    for candidate in _asset_candidates(asset, roots):
        try:
            size = candidate.stat().st_size
        except OSError:
            continue
        if size == int(asset["size"]):
            return {"state": "present", "path": str(candidate), "size": size}
        wrong_size.append({"path": str(candidate), "size": size})
    return {"state": "invalid" if wrong_size else "missing", "wrong_size": wrong_size}


def _probe_comfy_endpoints():
    endpoints = []
    for port in DEFAULT_COMFY_PORTS:
        url = "http://127.0.0.1:{}".format(port)
        try:
            stats = _request_json(url + "/system_stats", timeout=0.7)
        except Exception:
            continue
        endpoints.append({"url": url, "system_stats": stats})
    return endpoints


def _probe_llms():
    ollama = {"reachable": False, "url": "http://127.0.0.1:11434", "models": []}
    try:
        version = _request_json(ollama["url"] + "/api/version")
        tags = _request_json(ollama["url"] + "/api/tags")
        ollama.update(
            {
                "reachable": True,
                "version": version.get("version", "unknown"),
                "models": [item.get("name") or item.get("model") for item in tags.get("models", [])],
            }
        )
    except Exception as exc:
        ollama["error"] = str(exc)

    kobold = {"reachable": False, "url": "http://127.0.0.1:5001"}
    try:
        version = _request_json(kobold["url"] + "/api/extra/version")
        kobold.update({"reachable": True, "version": version.get("version", version)})
    except Exception as exc:
        kobold["error"] = str(exc)
    return {"ollama": ollama, "koboldcpp": kobold}


def _find_ollama_executable(managed_dir=None):
    candidates = []
    if managed_dir:
        candidates.append(Path(managed_dir) / "ollama.exe")
    found = shutil.which("ollama.exe") or shutil.which("ollama")
    if found:
        candidates.append(Path(found))
    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidates.append(Path(local) / "Programs" / "Ollama" / "ollama.exe")
    for candidate in candidates:
        try:
            if candidate.is_file():
                return candidate.resolve()
        except OSError:
            continue
    return None


def _default_http_browser_executable():
    if os.name != "nt":
        return None
    try:
        assoc_query = ctypes.windll.shlwapi.AssocQueryStringW
        assoc_query.argtypes = [
            ctypes.c_uint,
            ctypes.c_uint,
            ctypes.c_wchar_p,
            ctypes.c_wchar_p,
            ctypes.c_wchar_p,
            ctypes.POINTER(ctypes.c_ulong),
        ]
        assoc_query.restype = ctypes.c_long
        length = ctypes.c_ulong(0)
        assoc_query(0, 2, "http", None, None, ctypes.byref(length))  # ASSOCSTR_EXECUTABLE
        if length.value <= 1:
            return None
        buffer = ctypes.create_unicode_buffer(length.value)
        result = assoc_query(0, 2, "http", None, buffer, ctypes.byref(length))
        if result != 0:
            return None
        candidate = Path(os.path.expandvars(buffer.value))
        return candidate.resolve() if candidate.is_file() else None
    except (AttributeError, OSError, ValueError):
        return None


def _find_browser_executable():
    """Find a usable fallback browser when the Windows HTTP association is broken."""
    candidates = []
    for command in ("msedge.exe", "chrome.exe", "firefox.exe"):
        found = shutil.which(command)
        if found:
            candidates.append(Path(found))
    locations = [
        ("PROGRAMFILES(X86)", "Microsoft/Edge/Application/msedge.exe"),
        ("PROGRAMFILES", "Microsoft/Edge/Application/msedge.exe"),
        ("LOCALAPPDATA", "Microsoft/Edge/Application/msedge.exe"),
        ("PROGRAMFILES", "Google/Chrome/Application/chrome.exe"),
        ("PROGRAMFILES(X86)", "Google/Chrome/Application/chrome.exe"),
        ("LOCALAPPDATA", "Google/Chrome/Application/chrome.exe"),
        ("PROGRAMFILES", "Mozilla Firefox/firefox.exe"),
        ("PROGRAMFILES(X86)", "Mozilla Firefox/firefox.exe"),
    ]
    for variable, relative in locations:
        base = os.environ.get(variable)
        if base:
            candidates.append(Path(base) / Path(relative))
    for candidate in candidates:
        try:
            if candidate.is_file():
                return candidate.resolve()
        except OSError:
            continue
    return None


def _preferred_browser_executable():
    return _default_http_browser_executable() or _find_browser_executable()


def _open_browser_url(url):
    browser = _preferred_browser_executable() if os.name == "nt" else None
    if browser:
        subprocess.Popen(
            [str(browser), str(url)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
        return True
    return webbrowser.open(url)


def _nearest_existing_path(path):
    candidate = Path(path).expanduser()
    while not candidate.exists() and candidate != candidate.parent:
        candidate = candidate.parent
    if not candidate.exists():
        raise ValueError("The selected destination is not on an available drive.")
    return candidate


def _disk_usage_for(path):
    return shutil.disk_usage(_nearest_existing_path(path))


def inspect_comfy(root, catalog=None):
    root = Path(root).resolve()
    if not is_comfy_root(root):
        raise ValueError("That folder is not a ComfyUI root (main.py, models and custom_nodes are required).")
    roots = model_roots(root)
    usage = shutil.disk_usage(root)
    prompt_studio_path = root / "custom_nodes" / "ComfyUI_PromptStudio"
    workflows = []
    for profile_dir in (root / "user").glob("*/workflows") if (root / "user").is_dir() else []:
        workflows.append(profile_dir)
    if not workflows:
        workflows.append(root / "user" / "default" / "workflows")
    info = {
        "path": str(root),
        "name": root.parent.name + " / " + root.name,
        "kind": _comfy_kind(root),
        "version": _read_comfy_version(root),
        "disk_free": usage.free,
        "disk_total": usage.total,
        "prompt_studio": {
            "installed": (prompt_studio_path / "__init__.py").is_file(),
            "path": str(prompt_studio_path),
            "is_source": os.path.normcase(str(prompt_studio_path)) == os.path.normcase(str(SOURCE_ROOT)),
        },
        "workflow_dirs": [str(path) for path in workflows],
        "model_roots": {key: [str(path) for path in values] for key, values in roots.items()},
        "packs": {},
    }
    for pack in (catalog or load_catalog())["packs"]:
        info["packs"][pack["id"]] = {
            "assets": {asset["id"]: asset_status(asset, roots) for asset in pack["assets"]},
            "workflow": next(
                (
                    str(directory / pack["workflow_name"])
                    for directory in workflows
                    if (directory / pack["workflow_name"]).is_file()
                ),
                None,
            ),
        }
    return info


def scan_system(extra_paths=None):
    catalog = load_catalog()
    hardware = hardware_snapshot()
    paths = discover_comfy_paths(extra_paths)
    comfy = []
    for path in paths:
        try:
            comfy.append(inspect_comfy(path, catalog))
        except (OSError, ValueError) as exc:
            _log("Could not inspect {}: {}".format(path, exc))
    llms = _probe_llms()
    ollama_exe = _find_ollama_executable()
    llms["ollama"]["installed_executable"] = str(ollama_exe) if ollama_exe else ""
    return {
        "hardware": hardware,
        "comfy": comfy,
        "running_comfy": _probe_comfy_endpoints(),
        "llms": llms,
        "recommended_comfy_variant": recommended_comfy_variant(hardware),
        "recommended_llm_model": recommended_llm_model(hardware, catalog.get("llm_recommendations") or []),
        "default_fresh_dir": str(Path.home() / "PromptStudio" / "ComfyUI_windows_portable"),
        "source_root": str(SOURCE_ROOT),
    }


def choose_download_path(root, asset):
    directory = root / "models" / CATEGORY_DIRS[asset["category"]]
    relative = Path(asset["relative_path"].replace("/", os.sep).replace("\\", os.sep))
    return directory / relative


def build_plan(data):
    catalog = load_catalog()
    mode = str(data.get("comfy_mode") or "existing")
    if mode not in {"existing", "fresh"}:
        raise ValueError("Choose an existing or fresh ComfyUI installation.")
    actions = []
    total_download = 0
    if os.name == "nt" and not _vc_runtime_installed():
        runtime = catalog["provisioning"]["vc_runtime"]
        actions.append(
            {
                "type": "install_vc_runtime",
                "label": "Install required {}".format(runtime["name"]),
                "target": "Windows system runtime",
                "bytes": 0,
                "url": runtime["url"],
            }
        )
    if mode == "fresh":
        if os.name != "nt":
            raise ValueError("Fresh portable ComfyUI provisioning is currently available on Windows only.")
        install_dir_text = str(data.get("comfy_install_dir") or "").strip()
        if not install_dir_text:
            raise ValueError("Choose where the fresh ComfyUI portable folder should be installed.")
        install_dir = Path(install_dir_text).expanduser().resolve()
        root = install_dir / "ComfyUI"
        if install_dir.exists() and not install_dir.is_dir():
            raise ValueError("The fresh ComfyUI destination is a file, not a folder: {}".format(install_dir))
        if install_dir.is_relative_to(SOURCE_ROOT) or SOURCE_ROOT.is_relative_to(install_dir):
            raise ValueError("Choose a fresh destination outside the Prompt Studio setup source folder.")
        existing_portable = is_comfy_root(root)
        if install_dir.exists() and any(install_dir.iterdir()) and not existing_portable:
            raise ValueError("The fresh ComfyUI destination must be new or empty: {}".format(install_dir))
        variant = str(data.get("comfy_variant") or "nvidia")
        comfy_config = catalog["provisioning"]["comfyui"]
        asset_name = comfy_config["assets"].get(variant)
        if not asset_name:
            raise ValueError("Choose a supported official ComfyUI portable build.")
        if existing_portable:
            comfy = inspect_comfy(root, catalog)
        else:
            release_asset = _github_release_asset(comfy_config, asset_name)
            usage = _disk_usage_for(install_dir)
            total_download += int(release_asset["size"])
            actions.append(
                {
                    "type": "provision_comfy",
                    "label": "Install official ComfyUI {} ({})".format(release_asset["release"], variant.replace("_", " ")),
                    "target": str(install_dir),
                    "bytes": int(release_asset["size"]),
                    "asset": release_asset,
                }
            )
            comfy = {
                "path": str(root),
                "kind": "Portable",
                "version": release_asset["release"].lstrip("v"),
                "disk_free": usage.free,
                "disk_total": usage.total,
                "prompt_studio": {"installed": False, "is_source": False, "path": str(root / "custom_nodes" / "ComfyUI_PromptStudio")},
                "workflow_dirs": [str(root / "user" / "default" / "workflows")],
                "packs": {
                    pack["id"]: {
                        "assets": {asset["id"]: {"state": "missing"} for asset in pack["assets"]},
                        "workflow": None,
                    }
                    for pack in catalog["packs"]
                },
            }
    else:
        root = Path(str(data.get("comfy_path", ""))).expanduser().resolve()
        comfy = inspect_comfy(root, catalog)
    selected = set(data.get("pack_ids") or [])
    packs = [pack for pack in catalog["packs"] if pack["id"] in selected]
    if not packs:
        raise ValueError("Select at least one workflow pack.")
    for pack in packs:
        compatible = version_at_least(comfy["version"], pack.get("minimum_comfy_version"))
        if compatible is False:
            raise ValueError(
                "{} requires ComfyUI {} or newer; the selected installation is {}.".format(
                    pack["name"], pack["minimum_comfy_version"], comfy["version"]
                )
            )
    actions.append(
        {
            "type": "verify_comfy",
            "label": "Use {} ComfyUI {}".format(comfy["kind"], comfy["version"]),
            "bytes": 0,
        }
    )
    if not comfy["prompt_studio"]["installed"]:
        actions.append({"type": "install_prompt_studio", "label": "Install Prompt Studio custom node", "bytes": 0})
    elif comfy["prompt_studio"]["is_source"]:
        actions.append({"type": "keep_prompt_studio", "label": "Use this Prompt Studio source checkout", "bytes": 0})
    else:
        actions.append({"type": "update_prompt_studio", "label": "Safely update Prompt Studio (with rollback backup)", "bytes": 0})

    download_models = bool(data.get("download_models", True))
    for pack in packs:
        status = comfy["packs"][pack["id"]]
        workflow_target = Path(comfy["workflow_dirs"][0]) / pack["workflow_name"]
        actions.append(
            {
                "type": "install_workflow",
                "pack_id": pack["id"],
                "label": ("Update" if workflow_target.is_file() else "Install") + " " + pack["workflow_name"],
                "target": str(workflow_target),
                "bytes": 0,
            }
        )
        for asset in pack["assets"]:
            current = status["assets"][asset["id"]]
            if current["state"] == "present":
                actions.append(
                    {
                        "type": "keep_model",
                        "asset_id": asset["id"],
                        "label": "Reuse " + asset["name"],
                        "target": current["path"],
                        "bytes": 0,
                    }
                )
            elif download_models:
                target = choose_download_path(root, asset)
                total_download += int(asset["size"])
                actions.append(
                    {
                        "type": "download_model",
                        "pack_id": pack["id"],
                        "asset_id": asset["id"],
                        "label": "Download " + asset["name"],
                        "target": str(target),
                        "bytes": int(asset["size"]),
                    }
                )
            else:
                actions.append(
                    {
                        "type": "missing_model",
                        "asset_id": asset["id"],
                        "label": "Still required: " + asset["name"],
                        "target": str(choose_download_path(root, asset)),
                        "bytes": 0,
                    }
                )
    llm_provider = str(data.get("llm_provider") or "none")
    llm_model = str(data.get("llm_model") or "").strip()
    llm_management = str(data.get("llm_management") or "existing")
    ollama_exe = _find_ollama_executable(root.parent / "PromptStudio_Ollama")
    managed_ollama_target = root.parent / "PromptStudio_Ollama"
    if llm_provider == "ollama":
        if not llm_model:
            raise ValueError("Choose an Ollama model.")
        if llm_management == "managed" and not ollama_exe:
            ollama_asset = _github_release_asset(
                catalog["provisioning"]["ollama"],
                catalog["provisioning"]["ollama"]["asset"],
            )
            total_download += int(ollama_asset["size"])
            actions.append(
                {
                    "type": "install_ollama",
                    "label": "Install official Ollama {} standalone runtime".format(ollama_asset["release"]),
                    "target": str(managed_ollama_target),
                    "bytes": int(ollama_asset["size"]),
                    "asset": ollama_asset,
                }
            )
            ollama_exe = managed_ollama_target / "ollama.exe"
        installed_models = set(data.get("ollama_installed_models") or [])
        if llm_model not in installed_models:
            recommendation = next(
                (item for item in catalog.get("llm_recommendations", []) if item["model"] == llm_model),
                None,
            )
            estimate = int((recommendation or {}).get("size") or 0)
            total_download += estimate
            actions.append(
                {
                    "type": "pull_ollama_model",
                    "label": "Download Ollama model {}".format(llm_model),
                    "model": llm_model,
                    "bytes": estimate,
                }
            )
    elif llm_provider == "koboldcpp" and not data.get("kobold_url"):
        raise ValueError("Enter the KoboldCpp endpoint, or choose no LLM for now.")

    actions.append(
        {
            "type": "create_launcher",
            "label": "Create a terminal-free Start Prompt Studio launcher",
            "target": str(root / "Start Prompt Studio.vbs"),
            "bytes": 0,
        }
    )
    extraction_overhead = 2_000_000_000
    extraction_overhead += sum(
        int(action.get("bytes") or 0) * (3 if action["type"] == "provision_comfy" else 2)
        for action in actions
        if action["type"] in {"provision_comfy", "install_ollama"}
    )
    required_free = total_download + extraction_overhead
    return {
        "comfy_mode": mode,
        "comfy": comfy,
        "pack_ids": [pack["id"] for pack in packs],
        "actions": actions,
        "download_bytes": total_download,
        "disk_free": comfy["disk_free"],
        "required_free": required_free,
        "enough_space": comfy["disk_free"] > required_free,
        "llm_provider": llm_provider,
        "llm_model": llm_model,
        "llm_management": llm_management,
        "ollama_executable": str(ollama_exe) if ollama_exe else "",
        "ollama_gpu": data.get("ollama_gpu", ""),
        "kobold_url": str(data.get("kobold_url") or "http://127.0.0.1:5001"),
    }


def _job_update(job_id, **changes):
    with JOBS_LOCK:
        job = JOBS[job_id]
        job.update(changes)
        job["updated_at"] = time.time()


def _copy_prompt_studio(root, update=False):
    target = root / "custom_nodes" / "ComfyUI_PromptStudio"
    if target.resolve() == SOURCE_ROOT.resolve():
        return "Using the current Prompt Studio checkout."
    valid_existing = (target / "__init__.py").is_file()
    if valid_existing and not update:
        return "An existing Prompt Studio installation was preserved."
    if target.exists() and not valid_existing:
        raise RuntimeError("The Prompt Studio target exists but is not a valid installation: {}".format(target))
    temporary = target.with_name(target.name + ".installing-" + uuid.uuid4().hex[:8])

    ignored_anywhere = {
        ".git",
        ".runtime",
        "__pycache__",
        "prompt-studio-setup.log",
    }
    ignored_at_root = {".github", ".agents", ".codex", "docs", "installer", "tests", "AGENTS.md"}

    def ignore(directory, names):
        ignored = [name for name in names if name in ignored_anywhere or name.endswith(".pyc")]
        if Path(directory).resolve() == SOURCE_ROOT.resolve():
            ignored.extend(name for name in names if name in ignored_at_root)
        return ignored

    backup = None
    try:
        shutil.copytree(SOURCE_ROOT, temporary, ignore=ignore)
        if valid_existing:
            for name in (
                "prompt_studio_chats",
                "prompt_studio_chats.json",
                "prompt_studio_workflows.json",
                "style_templates.additional.json",
                "framing_templates.additional.json",
            ):
                source = target / name
                destination = temporary / name
                if source.is_dir():
                    shutil.copytree(source, destination, dirs_exist_ok=True)
                elif source.is_file():
                    shutil.copy2(source, destination)
            stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
            backup = root / "user" / "prompt_studio_setup_backups" / ("ComfyUI_PromptStudio-" + stamp)
            backup.parent.mkdir(parents=True, exist_ok=True)
            os.replace(target, backup)
        os.replace(temporary, target)
    except Exception:
        if temporary.exists():
            shutil.rmtree(temporary, ignore_errors=True)
        if backup and backup.exists() and not target.exists():
            os.replace(backup, target)
        raise
    if backup:
        return "Updated Prompt Studio; rollback backup saved to {}".format(backup)
    return "Installed Prompt Studio to {}".format(target)


def _install_workflow(root, pack, target=None):
    source = INSTALLER_DIR / pack["workflow_file"]
    if not source.is_file():
        raise RuntimeError("Bundled workflow is missing: {}".format(source))
    target = Path(target) if target else root / "user" / "default" / "workflows" / pack["workflow_name"]
    workflow_dir = target.parent
    workflow_dir.mkdir(parents=True, exist_ok=True)
    backup = None
    if target.is_file():
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = target.with_suffix(target.suffix + ".backup-" + stamp)
        shutil.copy2(target, backup)
    temporary = target.with_suffix(target.suffix + ".installing")
    shutil.copy2(source, temporary)
    os.replace(temporary, target)
    message = "Installed workflow to {}".format(target)
    if backup:
        message += " (previous copy backed up to {})".format(backup.name)
    return message


def _sha256(path, progress=None):
    digest = hashlib.sha256()
    total = path.stat().st_size
    done = 0
    with path.open("rb") as handle:
        while True:
            block = handle.read(8 * 1024 * 1024)
            if not block:
                break
            digest.update(block)
            done += len(block)
            if progress:
                progress(done, total, "Verifying")
    return digest.hexdigest()


def _is_certificate_error(exc):
    pending = [exc]
    seen = set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, ssl.SSLCertVerificationError):
            return True
        if "CERTIFICATE_VERIFY_FAILED" in str(current).upper():
            return True
        for nested in (getattr(current, "reason", None), getattr(current, "__cause__", None)):
            if isinstance(nested, BaseException):
                pending.append(nested)
    return False


def _windows_curl():
    if os.name != "nt":
        return None
    system_root = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    native = system_root / "System32" / "curl.exe"
    if native.is_file():
        return str(native)
    return shutil.which("curl.exe")


def _download_with_windows_curl(url, partial, expected_size, progress=None):
    curl = _windows_curl()
    if not curl:
        raise RuntimeError(
            "Python could not verify the HTTPS certificate and Windows curl.exe is unavailable. "
            "Install current Windows updates or the network's trusted root certificate, then retry."
        )
    command = [
        curl,
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--retry",
        "3",
        "--retry-delay",
        "2",
        "--continue-at",
        "-",
        "--output",
        str(partial),
        url,
    ]
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    process = subprocess.Popen(
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        creationflags=creation_flags,
    )
    while process.poll() is None:
        if progress:
            done = partial.stat().st_size if partial.is_file() else 0
            progress(done, expected_size, "Downloading with Windows HTTPS")
        time.sleep(0.25)
    _stdout, stderr = process.communicate()
    if process.returncode:
        detail = (stderr or "Windows HTTPS download failed").strip()
        raise RuntimeError("Windows curl.exe could not download the file: {}".format(detail))
    if progress:
        done = partial.stat().st_size if partial.is_file() else 0
        progress(done, expected_size, "Downloading with Windows HTTPS")


def _download_prerequisite(url, target, progress=None):
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + ".part")
    partial.unlink(missing_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "PromptStudioSetup/0.2"})
    try:
        with _urlopen(request, timeout=60) as response:
            total = int(response.headers.get("Content-Length") or 0)
            done = 0
            with partial.open("wb") as handle:
                while True:
                    block = response.read(1024 * 1024)
                    if not block:
                        break
                    handle.write(block)
                    done += len(block)
                    if progress:
                        progress(done, total, "Downloading prerequisite")
    except (urllib.error.URLError, ssl.SSLError) as exc:
        if not _is_certificate_error(exc) or os.name != "nt":
            raise
        _log("Python HTTPS verification failed for prerequisite; using Windows curl.exe: {}".format(exc))
        _download_with_windows_curl(url, partial, 0, progress)
    if not partial.is_file() or partial.stat().st_size == 0:
        raise RuntimeError("The prerequisite download was empty.")
    os.replace(partial, target)
    return target


def _verify_microsoft_authenticode(path):
    script = (
        "$signature=Get-AuthenticodeSignature -LiteralPath $env:PROMPT_STUDIO_VERIFY_PATH;"
        "[PSCustomObject]@{Status=[string]$signature.Status;"
        "Subject=[string]$signature.SignerCertificate.Subject} | ConvertTo-Json -Compress"
    )
    env = os.environ.copy()
    env["PROMPT_STUDIO_VERIFY_PATH"] = str(Path(path).resolve())
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
        env=env,
    )
    if result.returncode:
        raise RuntimeError(
            "Could not verify the Microsoft prerequisite signature: {}".format(
                result.stderr.strip() or result.stdout.strip() or "PowerShell failed"
            )
        )
    try:
        signature = json.loads(result.stdout.lstrip("\ufeff").strip())
    except (TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Windows returned an unreadable Authenticode signature result.") from exc
    status = str(signature.get("Status") or "")
    subject = str(signature.get("Subject") or "")
    if status.casefold() != "valid" or "microsoft corporation" not in subject.casefold():
        raise RuntimeError(
            "Refusing to run the prerequisite because its Microsoft Authenticode signature is not valid "
            "(status: {}; signer: {}).".format(status or "missing", subject or "missing")
        )
    return subject


def _install_vc_runtime(action, progress=None):
    if _vc_runtime_installed():
        return "Verified the Microsoft Visual C++ x64 runtime."
    download = Path(tempfile.gettempdir()) / "PromptStudioSetup" / "vc_redist.x64.exe"
    _download_prerequisite(action["url"], download, progress)
    signer = _verify_microsoft_authenticode(download)
    if progress:
        progress(0, 0, "Waiting for Windows approval")
    script = (
        "$process=Start-Process -FilePath $env:PROMPT_STUDIO_VC_RUNTIME "
        "-ArgumentList @('/install','/passive','/norestart') -Verb RunAs -Wait -PassThru;"
        "exit $process.ExitCode"
    )
    env = os.environ.copy()
    env["PROMPT_STUDIO_VC_RUNTIME"] = str(download.resolve())
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        timeout=900,
        check=False,
        env=env,
    )
    if result.returncode not in {0, 1638, 3010}:
        raise RuntimeError(
            "Microsoft Visual C++ runtime setup failed or elevation was declined (exit code {}). {}".format(
                result.returncode, result.stderr.strip() or result.stdout.strip()
            ).strip()
        )
    if not _vc_runtime_installed():
        if result.returncode == 3010:
            raise RuntimeError("Windows must be restarted to finish installing the Visual C++ runtime, then setup can be retried.")
        raise RuntimeError("Microsoft setup finished, but the required x64 Visual C++ runtime files are still unavailable.")
    return "Installed the Microsoft Visual C++ x64 runtime (verified signer: {}).".format(signer)


def _download_asset(asset, target, progress=None):
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + ".part")
    expected_size = int(asset["size"])
    if target.is_file() and target.stat().st_size == expected_size:
        if _sha256(target, progress) == asset["sha256"]:
            return "Verified existing {}".format(target)
        raise RuntimeError("Existing model checksum does not match: {}".format(target))

    offset = partial.stat().st_size if partial.is_file() else 0
    if offset > expected_size:
        partial.unlink()
        offset = 0
    elif offset == expected_size:
        if _sha256(partial, progress) == asset["sha256"]:
            os.replace(partial, target)
            return "Installed {} to {}".format(asset["name"], target)
        partial.unlink()
        offset = 0
    headers = {"User-Agent": "PromptStudioSetup/0.1"}
    if offset:
        headers["Range"] = "bytes={}-".format(offset)
    request = urllib.request.Request(asset["url"], headers=headers)
    try:
        with _urlopen(request, timeout=60) as response:
            status = getattr(response, "status", 200)
            if offset and status != 206:
                offset = 0
            mode = "ab" if offset else "wb"
            done = offset
            with partial.open(mode) as handle:
                while True:
                    block = response.read(1024 * 1024)
                    if not block:
                        break
                    handle.write(block)
                    done += len(block)
                    if progress:
                        progress(done, expected_size, "Downloading")
    except (urllib.error.URLError, ssl.SSLError) as exc:
        if not _is_certificate_error(exc) or os.name != "nt":
            raise
        _log("Python HTTPS verification failed; retrying securely with Windows curl.exe: {}".format(exc))
        _download_with_windows_curl(asset["url"], partial, expected_size, progress)
    actual_size = partial.stat().st_size
    if actual_size != expected_size:
        raise RuntimeError(
            "Download ended at {} but {} requires {}.".format(_human_bytes(actual_size), asset["name"], _human_bytes(expected_size))
        )
    if _sha256(partial, progress) != asset["sha256"]:
        partial.unlink(missing_ok=True)
        raise RuntimeError("Downloaded checksum did not match for {}".format(asset["name"]))
    os.replace(partial, target)
    return "Installed {} to {}".format(asset["name"], target)


def _portable_download_path(install_dir, asset):
    return install_dir.parent / (install_dir.name + ".setup-downloads") / asset["name"]


def _provision_comfy(action, progress=None):
    install_dir = Path(action["target"])
    if is_comfy_root(install_dir / "ComfyUI"):
        return "Verified existing fresh ComfyUI at {}".format(install_dir)
    if install_dir.exists() and any(install_dir.iterdir()):
        raise RuntimeError("ComfyUI destination became non-empty during setup: {}".format(install_dir))
    asset = action["asset"]
    archive = _portable_download_path(install_dir, asset)
    _download_asset(asset, archive, progress)
    tar = shutil.which("tar.exe") or shutil.which("tar")
    if not tar:
        raise RuntimeError("Windows archive support (tar.exe) is unavailable. Install current Windows updates and retry.")
    staging = install_dir.with_name(install_dir.name + ".extracting-" + uuid.uuid4().hex[:8])
    staging.mkdir(parents=True)
    try:
        result = subprocess.run(
            [tar, "-xf", str(archive), "-C", str(staging)],
            capture_output=True,
            text=True,
            timeout=1800,
            check=False,
        )
        if result.returncode:
            raise RuntimeError("Could not extract the official ComfyUI archive: {}".format(result.stderr.strip() or result.stdout.strip()))
        roots = [path for path in staging.rglob("ComfyUI") if is_comfy_root(path)]
        if len(roots) != 1:
            raise RuntimeError("The official ComfyUI archive had an unexpected folder layout.")
        portable_root = roots[0].parent
        if install_dir.exists():
            install_dir.rmdir()  # Already proven empty above.
        os.replace(portable_root, install_dir)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
    archive.unlink(missing_ok=True)
    try:
        archive.parent.rmdir()
    except OSError:
        pass
    if not is_comfy_root(install_dir / "ComfyUI"):
        raise RuntimeError("ComfyUI extraction completed but validation failed.")
    return "Installed official ComfyUI portable to {}".format(install_dir)


def _install_ollama(action, progress=None):
    target = Path(action["target"])
    existing = _find_ollama_executable(target)
    if existing and os.path.normcase(str(existing.parent)) == os.path.normcase(str(target.resolve())):
        return "Verified managed Ollama at {}".format(existing)
    if target.exists() and any(target.iterdir()):
        raise RuntimeError("Managed Ollama destination is not empty: {}".format(target))
    asset = action["asset"]
    archive = target.parent / (target.name + ".setup-downloads") / asset["name"]
    _download_asset(asset, archive, progress)
    staging = target.with_name(target.name + ".extracting-" + uuid.uuid4().hex[:8])
    try:
        shutil.unpack_archive(str(archive), str(staging), "zip")
        executables = list(staging.rglob("ollama.exe"))
        if len(executables) != 1:
            raise RuntimeError("The official Ollama archive had an unexpected folder layout.")
        runtime_root = executables[0].parent
        if target.exists():
            target.rmdir()
        if runtime_root == staging:
            os.replace(staging, target)
        else:
            os.replace(runtime_root, target)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
    archive.unlink(missing_ok=True)
    try:
        archive.parent.rmdir()
    except OSError:
        pass
    if not (target / "ollama.exe").is_file():
        raise RuntimeError("Ollama extraction completed but ollama.exe was not found.")
    return "Installed managed Ollama to {}".format(target)


def _port_open(port, timeout=0.4):
    try:
        with socket.create_connection((LOOPBACK, int(port)), timeout=timeout):
            return True
    except OSError:
        return False


def _hidden_process(command, cwd=None, env=None, output_path=None):
    creationflags = 0
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
    output_handle = None
    try:
        if output_path:
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_handle = output_path.open("wb")
        process = subprocess.Popen(
            command,
            cwd=str(cwd) if cwd else None,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=output_handle or subprocess.DEVNULL,
            stderr=subprocess.STDOUT if output_handle else subprocess.DEVNULL,
            creationflags=creationflags,
            close_fds=True,
        )
    finally:
        if output_handle:
            output_handle.close()
    MANAGED_PROCESSES.append(process)
    return process


def _visible_process(command, cwd=None, env=None, output_path=None):
    creationflags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0) if os.name == "nt" else 0
    output_handle = None
    try:
        if output_path:
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_handle = output_path.open("wb")
        process = subprocess.Popen(
            command,
            cwd=str(cwd) if cwd else None,
            env=env,
            stdout=output_handle or None,
            stderr=subprocess.STDOUT if output_handle else None,
            creationflags=creationflags,
            close_fds=True,
        )
    finally:
        if output_handle:
            output_handle.close()
    MANAGED_PROCESSES.append(process)
    return process


def _start_ollama(executable, gpu_index=""):
    if _probe_llms()["ollama"]["reachable"]:
        return "Connected to the running Ollama service."
    executable = Path(executable)
    if not executable.is_file():
        raise RuntimeError("Ollama is not running and its executable could not be found.")
    env = os.environ.copy()
    env["OLLAMA_HOST"] = "127.0.0.1:11434"
    env["OLLAMA_KEEP_ALIVE"] = "0"
    if str(gpu_index).strip():
        env["CUDA_VISIBLE_DEVICES"] = str(gpu_index).strip()
    _hidden_process([str(executable), "serve"], cwd=executable.parent, env=env)
    for _ in range(60):
        time.sleep(0.5)
        if _probe_llms()["ollama"]["reachable"]:
            return "Started Ollama locally with immediate model unloading."
    raise RuntimeError("Ollama did not become ready on http://127.0.0.1:11434.")


def _pull_ollama_model(model, progress=None, estimated_size=0):
    payload = json.dumps({"model": model, "stream": True}).encode("utf-8")
    request = urllib.request.Request(
        "http://127.0.0.1:11434/api/pull",
        data=payload,
        headers={"Content-Type": "application/json", "User-Agent": "PromptStudioSetup/0.2"},
        method="POST",
    )
    last_status = "Preparing model"
    with _urlopen(request, timeout=1800) as response:
        for raw in response:
            if not raw.strip():
                continue
            item = json.loads(raw.decode("utf-8"))
            if item.get("error"):
                raise RuntimeError("Ollama model download failed: {}".format(item["error"]))
            last_status = str(item.get("status") or last_status)
            total = int(item.get("total") or estimated_size or 0)
            done = int(item.get("completed") or (total if last_status == "success" else 0))
            if progress:
                progress(done, total, last_status.capitalize())
    models = _probe_llms()["ollama"].get("models") or []
    if model not in models:
        raise RuntimeError("Ollama finished the pull but {} was not listed by the service.".format(model))
    return "Installed Ollama model {}".format(model)


def _comfy_python(root):
    candidates = [
        root.parent / "python_embeded" / "python.exe",
        root / ".venv" / "Scripts" / "python.exe",
        root / "venv" / "Scripts" / "python.exe",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def _choose_comfy_port():
    for port in DEFAULT_COMFY_PORTS:
        if not _port_open(port):
            return port
    raise RuntimeError("ComfyUI ports 8188 through 8190 are already in use.")


def _studio_url(port, plan):
    query = {
        "promptstudio_setup": "1",
        "provider": plan["llm_provider"],
        "model": plan.get("llm_model") or "",
        "kobold_url": plan.get("kobold_url") or "",
    }
    return "http://{}:{}/extensions/ComfyUI_PromptStudio/prompt_studio.html?{}".format(
        LOOPBACK, port, urllib.parse.urlencode(query)
    )


def _vbs_quote(value):
    return '"{}"'.format(str(value).replace('"', '""'))


def _write_launcher(root, plan, port):
    root = Path(root)
    python = _comfy_python(root)
    if not python:
        raise RuntimeError("Could not identify the Python runtime used by this ComfyUI installation.")
    ollama = Path(plan["ollama_executable"]) if plan.get("ollama_executable") else None
    url = _studio_url(port, plan)
    browser = _preferred_browser_executable()
    browser_command = '"{}" "{}"'.format(browser, url) if browser else url
    args = [str(python)]
    if root.parent.joinpath("python_embeded", "python.exe").is_file():
        args.extend(["-s", str(root / "main.py"), "--windows-standalone-build"])
    else:
        args.append(str(root / "main.py"))
    args.extend(["--listen", LOOPBACK, "--port", str(port)])
    command = " ".join('"{}"'.format(item.replace('"', '""')) for item in args)
    lines = [
        "Option Explicit",
        "Dim shell, http, i",
        'Set shell = CreateObject("WScript.Shell")',
        'shell.Environment("Process")("OLLAMA_KEEP_ALIVE") = "0"',
        'shell.Environment("Process")("OLLAMA_HOST") = "127.0.0.1:11434"',
    ]
    if str(plan.get("ollama_gpu") or "").strip():
        lines.append('shell.Environment("Process")("CUDA_VISIBLE_DEVICES") = {}'.format(_vbs_quote(plan["ollama_gpu"])))
    if plan["llm_provider"] == "ollama" and ollama and ollama.is_file():
        lines.append("shell.Run {}, 0, False".format(_vbs_quote('"{}" serve'.format(ollama))))
        lines.append("WScript.Sleep 1000")
    lines.extend(
        [
            "shell.Run {}, 1, False".format(_vbs_quote(command)),
            "For i = 1 To 180",
            "  WScript.Sleep 1000",
            "  On Error Resume Next",
            '  Set http = CreateObject("MSXML2.XMLHTTP")',
            "  http.Open \"GET\", {}, False".format(_vbs_quote("http://{}:{}/system_stats".format(LOOPBACK, port))),
            "  http.Send",
            "  If Err.Number = 0 Then",
            "    If http.Status = 200 Then",
            "      shell.Run {}".format(_vbs_quote(browser_command)),
            "      WScript.Quit 0",
            "    End If",
            "  End If",
            "  Err.Clear",
            "  On Error GoTo 0",
            "Next",
            'MsgBox "ComfyUI did not become ready. Open prompt-studio-setup.log for details.", 48, "Prompt Studio"',
        ]
    )
    target = root / "Start Prompt Studio.vbs"
    target.write_text("\r\n".join(lines) + "\r\n", encoding="utf-8-sig")
    return "Created launcher with a visible ComfyUI terminal at {}".format(target)


def _log_tail(path, limit=4000):
    try:
        with Path(path).open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - limit))
            return handle.read().decode("utf-8", errors="replace").strip()
    except OSError:
        return ""


def _comfy_startup_failure(return_code, startup_log):
    tail = _log_tail(startup_log)
    normalized = tail.lower()
    if "visual c++ redistributable is not installed" in normalized or (
        "winerror 126" in normalized and "c10.dll" in normalized
    ):
        return RuntimeError(
            "Microsoft Visual C++ 2015-2022 Redistributable (x64) is required by PyTorch. "
            "Install it inside this Windows environment from "
            "https://aka.ms/vs/17/release/vc_redist.x64.exe, then retry setup. "
            "Full startup output: {}".format(startup_log)
        )
    detail = "\n\nLast startup output:\n{}".format(tail) if tail else ""
    return RuntimeError(
        "ComfyUI exited during startup with code {}. Full output: {}{}".format(
            return_code, startup_log, detail
        )
    )


def _start_comfy(root, port, progress=None):
    for endpoint in _probe_comfy_endpoints():
        if endpoint["url"].endswith(":" + str(port)):
            return "Connected to ComfyUI already running on port {}.".format(port)
    python = _comfy_python(root)
    if not python:
        raise RuntimeError("Could not identify the Python runtime used by this ComfyUI installation.")
    command = [str(python)]
    if root.parent.joinpath("python_embeded", "python.exe").is_file():
        command.extend(["-s", str(root / "main.py"), "--windows-standalone-build"])
    else:
        command.append(str(root / "main.py"))
    command.extend(["--listen", LOOPBACK, "--port", str(port)])
    startup_log = root / "prompt-studio-startup.log"
    process = _visible_process(command, cwd=root, output_path=startup_log)
    for waited in range(1, 181):
        time.sleep(1)
        return_code = process.poll()
        if return_code is not None:
            raise _comfy_startup_failure(return_code, startup_log)
        if progress and (waited == 1 or waited % 5 == 0):
            progress(waited, 180)
        try:
            _request_json("http://{}:{}/system_stats".format(LOOPBACK, port), timeout=0.8)
            return "Started ComfyUI on port {}.".format(port)
        except Exception:
            continue
    tail = _log_tail(startup_log)
    detail = " Last startup output: {}".format(tail) if tail else ""
    raise RuntimeError(
        "ComfyUI did not become ready within three minutes. Full output: {}.{}".format(startup_log, detail)
    )


def _run_install(job_id, request_data, plan):
    current_action = None
    messages = []
    try:
        _job_update(job_id, state="running", message="Preparing installation", started_at=time.time())
        root = Path(plan["comfy"]["path"])
        running_endpoints = _probe_comfy_endpoints()
        was_running = bool(running_endpoints) and plan.get("comfy_mode") == "existing"
        if was_running:
            comfy_port = int(urllib.parse.urlsplit(running_endpoints[0]["url"]).port)
        else:
            comfy_port = _choose_comfy_port()
        catalog = load_catalog()
        packs = {pack["id"]: pack for pack in catalog["packs"]}
        assets = {asset["id"]: asset for pack in packs.values() for asset in pack["assets"]}
        actions = plan["actions"]
        for index, action in enumerate(actions):
            current_action = action
            label = action["label"]
            _job_update(
                job_id,
                action_index=index,
                action_count=len(actions),
                action=label,
                action_done=0,
                action_total=action.get("bytes", 0),
                phase="Working",
                message=label,
            )
            if action["type"] == "install_vc_runtime":
                def report(done, total, phase):
                    _job_update(job_id, action_done=done, action_total=total, phase=phase, message=label)

                messages.append(_install_vc_runtime(action, report))
            elif action["type"] == "provision_comfy":
                def report(done, total, phase):
                    _job_update(job_id, action_done=done, action_total=total, phase=phase, message=label)

                messages.append(_provision_comfy(action, report))
            elif action["type"] == "verify_comfy":
                if not is_comfy_root(root):
                    raise RuntimeError("ComfyUI validation failed after provisioning: {}".format(root))
                messages.append(label)
            elif action["type"] == "install_prompt_studio":
                messages.append(_copy_prompt_studio(root))
            elif action["type"] == "update_prompt_studio":
                messages.append(_copy_prompt_studio(root, update=True))
            elif action["type"] == "install_workflow":
                messages.append(_install_workflow(root, packs[action["pack_id"]], action.get("target")))
            elif action["type"] == "download_model":
                asset = assets[action["asset_id"]]

                def report(done, total, phase):
                    _job_update(job_id, action_done=done, action_total=total, phase=phase, message=label)

                messages.append(_download_asset(asset, Path(action["target"]), report))
            elif action["type"] == "install_ollama":
                def report(done, total, phase):
                    _job_update(job_id, action_done=done, action_total=total, phase=phase, message=label)

                messages.append(_install_ollama(action, report))
                plan["ollama_executable"] = str(Path(action["target"]) / "ollama.exe")
            elif action["type"] == "pull_ollama_model":
                messages.append(_start_ollama(plan.get("ollama_executable"), plan.get("ollama_gpu", "")))

                def report(done, total, phase):
                    _job_update(job_id, action_done=done, action_total=total, phase=phase, message=label)

                messages.append(_pull_ollama_model(action["model"], report, action.get("bytes", 0)))
            elif action["type"] == "create_launcher":
                messages.append(_write_launcher(root, plan, comfy_port))
            elif action["type"] == "missing_model":
                messages.append("Manual model still required: {}".format(action["target"]))
            else:
                messages.append(label)
            _job_update(job_id, messages=list(messages))
        requires_restart = was_running and any(
            action["type"] in {"install_prompt_studio", "update_prompt_studio"} for action in actions
        )
        if not was_running:
            _job_update(job_id, phase="Starting", message="Starting ComfyUI and Prompt Studio")

            def report_startup(waited, timeout):
                _job_update(
                    job_id,
                    phase="Starting",
                    message="Waiting for ComfyUI: {} / {} seconds".format(waited, timeout),
                )

            messages.append(_start_comfy(root, comfy_port, report_startup))
        prompt_studio_url = _studio_url(comfy_port, plan)
        _job_update(
            job_id,
            state="complete",
            phase="Complete",
            message=(
                "Setup is complete. Close the running ComfyUI and double-click the new launcher once to load the update."
                if requires_restart
                else "Prompt Studio is installed and ready."
            ),
            messages=messages,
            prompt_studio_url=prompt_studio_url,
            launcher_path=str(root / "Start Prompt Studio.vbs"),
            requires_restart=requires_restart,
            finished_at=time.time(),
        )
    except Exception as exc:
        _log("Install failed: {}\n{}".format(exc, traceback.format_exc()))
        recovery = "Retry setup; verified files and partial downloads will be reused."
        if current_action and current_action.get("type") in {"download_model", "provision_comfy", "install_ollama"}:
            asset = current_action.get("asset")
            if not asset and current_action.get("asset_id"):
                catalog = load_catalog()
                asset = next(
                    (
                        item
                        for pack in catalog["packs"]
                        for item in pack["assets"]
                        if item["id"] == current_action["asset_id"]
                    ),
                    None,
                )
            if asset:
                recovery = "If retry still fails, download {} and save it exactly as {}.".format(
                    asset["url"], current_action["target"]
                )
        elif current_action and current_action.get("type") == "pull_ollama_model":
            recovery = "Keep Ollama running, then retry the model pull for {}.".format(current_action["model"])
        _job_update(
            job_id,
            state="failed",
            phase="Failed",
            message=str(exc),
            error=recovery,
            messages=messages,
        )


def start_install(data):
    plan = build_plan(data)
    if not plan["enough_space"]:
        raise ValueError("The selected drive does not have enough free space for this plan.")
    if not data.get("accepted_licenses"):
        raise ValueError("Review and accept the required software and model licenses before installing.")
    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {
            "id": job_id,
            "state": "queued",
            "phase": "Queued",
            "message": "Waiting to start",
            "created_at": time.time(),
            "action_index": 0,
            "action_count": len(plan["actions"]),
            "action_done": 0,
            "action_total": 0,
        }
    threading.Thread(target=_run_install, args=(job_id, data, plan), daemon=True).start()
    return JOBS[job_id]


def _guid(value):
    """Build the little-endian GUID representation expected by Windows COM."""

    parsed = uuid.UUID(value)

    class GUID(ctypes.Structure):
        _fields_ = [
            ("data1", ctypes.c_uint32),
            ("data2", ctypes.c_uint16),
            ("data3", ctypes.c_uint16),
            ("data4", ctypes.c_ubyte * 8),
        ]

    raw = parsed.bytes_le
    return GUID(
        int.from_bytes(raw[0:4], "little"),
        int.from_bytes(raw[4:6], "little"),
        int.from_bytes(raw[6:8], "little"),
        (ctypes.c_ubyte * 8).from_buffer_copy(raw[8:]),
    )


def _browse_folder_windows(title):
    """Show the modern Explorer folder picker through Windows IFileOpenDialog."""

    ole32 = ctypes.windll.ole32
    clsid_file_open_dialog = _guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")
    iid_i_file_open_dialog = _guid("D57C7288-D4AD-4768-BE02-9D969532D960")
    dialog = ctypes.c_void_p()
    initialized = False

    # Every HTTP request has its own thread, so initialize that thread as an STA
    # before creating the shell dialog.
    result = ole32.CoInitializeEx(None, 0x2)  # COINIT_APARTMENTTHREADED
    if result in (0, 1):  # S_OK or S_FALSE
        initialized = True
    elif ctypes.c_uint32(result).value != 0x80010106:  # RPC_E_CHANGED_MODE
        raise OSError("Could not initialize the Windows folder picker (0x{:08X}).".format(
            ctypes.c_uint32(result).value
        ))

    def method(interface, index, restype, *argtypes):
        vtable = ctypes.cast(
            interface, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))
        ).contents
        return ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)(vtable[index])

    try:
        result = ole32.CoCreateInstance(
            ctypes.byref(clsid_file_open_dialog),
            None,
            0x1,  # CLSCTX_INPROC_SERVER
            ctypes.byref(iid_i_file_open_dialog),
            ctypes.byref(dialog),
        )
        if result < 0:
            raise OSError("Could not create the Windows folder picker (0x{:08X}).".format(
                ctypes.c_uint32(result).value
            ))

        get_options = method(dialog, 10, ctypes.c_long, ctypes.POINTER(ctypes.c_uint32))
        set_options = method(dialog, 9, ctypes.c_long, ctypes.c_uint32)
        set_title = method(dialog, 17, ctypes.c_long, ctypes.c_wchar_p)
        show = method(dialog, 3, ctypes.c_long, ctypes.c_void_p)
        get_result = method(dialog, 20, ctypes.c_long, ctypes.POINTER(ctypes.c_void_p))

        options = ctypes.c_uint32()
        if get_options(dialog, ctypes.byref(options)) < 0:
            raise OSError("Could not read the Windows folder-picker options.")
        # FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST
        if set_options(dialog, options.value | 0x20 | 0x40 | 0x800) < 0:
            raise OSError("Could not configure the Windows folder picker.")
        set_title(dialog, title)

        result = show(dialog, None)
        if ctypes.c_uint32(result).value == 0x800704C7:  # ERROR_CANCELLED
            return ""
        if result < 0:
            raise OSError("The Windows folder picker failed (0x{:08X}).".format(
                ctypes.c_uint32(result).value
            ))

        shell_item = ctypes.c_void_p()
        result = get_result(dialog, ctypes.byref(shell_item))
        if result < 0:
            raise OSError("Could not read the selected folder.")
        try:
            get_display_name = method(
                shell_item, 5, ctypes.c_long, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)
            )
            display_name = ctypes.c_void_p()
            # SIGDN_FILESYSPATH returns a normal local filesystem path.
            result = get_display_name(shell_item, 0x80058000, ctypes.byref(display_name))
            if result < 0:
                raise OSError("The selected item is not a filesystem folder.")
            try:
                return ctypes.wstring_at(display_name)
            finally:
                ole32.CoTaskMemFree(display_name)
        finally:
            method(shell_item, 2, ctypes.c_ulong)(shell_item)
    finally:
        if dialog.value:
            method(dialog, 2, ctypes.c_ulong)(dialog)
        if initialized:
            ole32.CoUninitialize()


def browse_folder(purpose="existing"):
    if os.name != "nt":
        raise RuntimeError("The folder picker is currently available on Windows only.")
    title = (
        "Select an empty parent folder for the new ComfyUI portable installation"
        if purpose == "fresh"
        else "Select the ComfyUI folder containing main.py"
    )
    return _browse_folder_windows(title)


HTML = r'''<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Prompt Studio Setup</title>
  <style>
    :root{color-scheme:dark;--bg:#0a0b12;--panel:#111420;--soft:#181c2b;--line:#2a3042;--text:#f5f7ff;--muted:#9ca6bd;--purple:#a98bff;--cyan:#62d9ff;--green:#72e0a1;--amber:#ffc86b;--red:#ff7e8e;--shadow:0 28px 80px rgba(0,0,0,.42)}
    *{box-sizing:border-box} body{margin:0;min-height:100vh;background:radial-gradient(circle at 18% 5%,rgba(126,81,255,.18),transparent 32rem),radial-gradient(circle at 92% 18%,rgba(62,205,255,.13),transparent 30rem),var(--bg);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;color:var(--text)}
    button,input,select{font:inherit} button{cursor:pointer}.shell{width:min(1180px,calc(100% - 32px));margin:28px auto;display:grid;grid-template-columns:245px 1fr;min-height:calc(100vh - 56px);background:rgba(17,20,32,.91);border:1px solid rgba(255,255,255,.09);border-radius:28px;overflow:hidden;box-shadow:var(--shadow);backdrop-filter:blur(24px)}
    aside{padding:30px 22px;border-right:1px solid var(--line);background:rgba(8,10,17,.52)}.brand{display:flex;gap:12px;align-items:center;margin:0 8px 34px}.logo{width:42px;height:42px;border-radius:14px;background:linear-gradient(135deg,var(--purple),var(--cyan));display:grid;place-items:center;color:#0b0d14;font-weight:900;box-shadow:0 8px 24px rgba(113,100,255,.35)}.brand strong{display:block;font-size:16px}.brand small{color:var(--muted)}
    .steps{display:grid;gap:8px}.step{display:grid;grid-template-columns:30px 1fr;gap:10px;align-items:center;padding:10px;border-radius:13px;color:var(--muted)}.step .num{width:28px;height:28px;border:1px solid var(--line);border-radius:50%;display:grid;place-items:center;font-size:12px}.step.active{background:var(--soft);color:var(--text)}.step.active .num{border-color:var(--purple);background:rgba(169,139,255,.16);color:#d9ccff}.step.done .num{background:var(--green);border-color:var(--green);color:#08110d}.trust{margin-top:34px;padding:14px;border:1px solid var(--line);border-radius:14px;color:var(--muted);font-size:12px}.trust strong{color:var(--green);display:block;margin-bottom:4px}
    main{display:flex;flex-direction:column;min-width:0}.content{padding:42px 46px;flex:1}.page{display:none}.page.active{display:block}.eyebrow{color:var(--cyan);font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}h1{font-size:36px;letter-spacing:-.04em;line-height:1.1;margin:9px 0 10px}h2{font-size:20px;margin:28px 0 12px}.lead{color:var(--muted);font-size:16px;max-width:720px;margin:0 0 28px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.card{background:var(--soft);border:1px solid var(--line);border-radius:18px;padding:18px;position:relative}.card.selectable{cursor:pointer;transition:.16s ease}.card.selectable:hover{border-color:#4d5772;transform:translateY(-1px)}.card.selected{border-color:var(--purple);box-shadow:inset 0 0 0 1px var(--purple)}.card h3{margin:0 0 5px;font-size:16px}.card p{margin:0;color:var(--muted)}.metric{font-size:24px;font-weight:750;letter-spacing:-.03em}.kicker{font-size:12px;color:var(--muted)}
    .status{display:inline-flex;align-items:center;gap:7px;padding:5px 9px;border-radius:999px;background:#22283a;color:var(--muted);font-size:12px}.status.good{background:rgba(67,205,132,.13);color:var(--green)}.status.warn{background:rgba(255,190,85,.13);color:var(--amber)}.dot{width:7px;height:7px;border-radius:50%;background:currentColor}.row{display:flex;gap:12px;align-items:center;justify-content:space-between}.stack{display:grid;gap:12px}.path{font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;color:#bfc8dd;overflow-wrap:anywhere}.choice{display:flex;gap:12px;align-items:flex-start}.choice input{margin-top:4px;accent-color:var(--purple)}.choice strong{display:block}.choice small{color:var(--muted)}
    .asset{display:grid;grid-template-columns:1fr auto;gap:6px 14px;padding:11px 0;border-top:1px solid var(--line)}.asset:first-child{border-top:0}.asset small{color:var(--muted)}.form-row{display:flex;gap:10px}.form-row input,.form-row select{flex:1;min-width:0;background:#0d101a;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:11px 12px}.secondary,.primary{border-radius:12px;padding:11px 16px;border:1px solid var(--line);color:var(--text);background:#1c2130}.primary{border:0;background:linear-gradient(135deg,#9878ff,#5bbfff);color:#090b11;font-weight:800}.primary:disabled,.secondary:disabled{opacity:.45;cursor:not-allowed}.footer{padding:18px 46px;border-top:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;background:rgba(8,10,17,.32)}.footer small{color:var(--muted)}
    .review{display:grid;gap:8px}.review-item{display:grid;grid-template-columns:28px 1fr auto;gap:10px;align-items:center;padding:12px 14px;background:var(--soft);border:1px solid var(--line);border-radius:13px}.review-item .icon{color:var(--green)}.review-item small{color:var(--muted)}.alert{padding:13px 15px;border-radius:13px;border:1px solid rgba(255,190,85,.28);background:rgba(255,190,85,.08);color:#ffdaa0}.progress{height:9px;border-radius:99px;background:#22283a;overflow:hidden;margin:14px 0}.progress>i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--purple),var(--cyan));transition:width .25s}.log{max-height:220px;overflow:auto;background:#0b0e16;border:1px solid var(--line);border-radius:14px;padding:12px;font:12px/1.6 ui-monospace,Consolas,monospace;color:#bac4da}.hidden{display:none!important}.spinner{width:18px;height:18px;border:2px solid #3c4357;border-top-color:var(--cyan);border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
    @media(max-width:850px){.shell{grid-template-columns:1fr;margin:0;width:100%;min-height:100vh;border-radius:0}aside{display:none}.content{padding:28px 20px}.footer{padding:16px 20px}.grid{grid-template-columns:1fr}h1{font-size:30px}}
  </style>
</head>
<body>
<div class="shell">
  <aside>
    <div class="brand"><div class="logo">PS</div><div><strong>Prompt Studio</strong><small>Setup wizard</small></div></div>
    <div class="steps" id="steps"></div>
    <div class="trust"><strong>● Private and local</strong>This wizard listens only on your computer. Every file and destination is shown before installation.</div>
  </aside>
  <main>
    <div class="content">
      <section class="page active" data-page="0"><div class="eyebrow">System scan</div><h1>Let’s see what is already here.</h1><p class="lead">We’ll detect hardware, ComfyUI, model files and local LLM services before asking you to choose anything.</p><div id="scan"><div class="card row"><div><h3>Scanning this computer</h3><p>Checking only common locations and running local services.</p></div><div class="spinner"></div></div></div></section>
      <section class="page" data-page="1"><div class="eyebrow">ComfyUI</div><h1>Use what is here, or start clean.</h1><p class="lead">The official portable build is the most reliable fresh-machine option. Existing installations and shared model folders are preserved.</p><div id="comfy-mode" class="grid"></div><div id="existing-comfy"><h2>Detected installations</h2><div id="comfy-list" class="stack"></div><h2>Another location</h2><div class="form-row"><input id="comfy-path" placeholder="C:\path\to\ComfyUI"/><button class="secondary" id="browse">Browse…</button><button class="secondary" id="inspect">Check</button></div></div><div id="fresh-comfy" class="hidden"><h2>Fresh installation folder</h2><div class="form-row"><input id="fresh-dir" placeholder="C:\PromptStudio\ComfyUI_windows_portable"/><button class="secondary" id="browse-fresh">Browse…</button></div><h2>Hardware build</h2><div class="form-row"><select id="comfy-variant"><option value="nvidia">NVIDIA 20-series or newer / CPU</option><option value="nvidia_legacy">NVIDIA 10-series or older (CUDA 12.6)</option><option value="amd">AMD Radeon</option><option value="intel">Intel Arc</option></select></div><p class="lead" style="margin-top:12px">Downloaded directly from the official ComfyUI release and SHA-256 verified before extraction.</p></div><p id="path-error" class="alert hidden"></p></section>
      <section class="page" data-page="2"><div class="eyebrow">Workflow packs</div><h1>Start with Krea 2 Turbo.</h1><p class="lead">The bundled workflow is based on your live setup: selectable Krea models and LoRAs, Prompt Studio controls, and WebP output.</p><div id="packs" class="stack"></div></section>
      <section class="page" data-page="3"><div class="eyebrow">Local language model</div><h1>Connect the prompt brain.</h1><p class="lead">Prompt Studio hands shared GPU memory between the local LLM and ComfyUI only when work switches from one service to the other.</p><div id="llms" class="grid"></div><div id="ollama-options" class="hidden"><h2>Ollama model</h2><div id="ollama-models" class="stack"></div><div id="ollama-placement"></div></div><div id="kobold-options" class="hidden"><h2>KoboldCpp endpoint</h2><div class="form-row"><input id="kobold-url" value="http://127.0.0.1:5001"/></div><p class="lead" style="margin-top:10px">Shared-GPU unloading requires KoboldCpp Admin Mode and an Admin Directory. Prompt Studio restores the initial model automatically when LLM work resumes.</p></div></section>
      <section class="page" data-page="4"><div class="eyebrow">Review</div><h1>Everything stays predictable.</h1><p class="lead">Nothing is changed until you press Install. Existing model files are reused, and an existing workflow is backed up.</p><div id="review" class="review"></div><label class="choice card" style="margin-top:14px"><input id="licenses" type="checkbox"/><span><strong>I reviewed and accept the required software and model licenses</strong><small id="license-links"></small></span></label><p id="review-error" class="alert hidden"></p></section>
      <section class="page" data-page="5"><div class="eyebrow">Installation</div><h1 id="install-title">Ready when you are.</h1><p class="lead" id="install-copy">Downloads resume if interrupted. Large files are checksum-verified before they become visible to ComfyUI.</p><button class="primary" id="install">Install Prompt Studio</button><div id="job" class="hidden"><div class="row"><strong id="job-phase">Preparing</strong><span id="job-count" class="status"></span></div><div class="progress"><i id="job-bar"></i></div><p id="job-message" class="lead"></p><div id="job-log" class="log"></div><a id="open-studio" class="primary hidden" href="http://127.0.0.1:8188/PromptStudio" target="_blank" style="display:inline-block;text-decoration:none;margin-top:16px">Open Prompt Studio</a></div></section>
    </div>
    <div class="footer"><button class="secondary" id="back">Back</button><small id="footnote">No changes have been made.</small><button class="primary" id="next">Continue</button></div>
  </main>
</div>
<script>
const labels=["Scan","ComfyUI","Workflow","Local LLM","Review","Install"];
const token=new URLSearchParams(location.search).get("token")||sessionStorage.getItem("psSetupToken");
if(token) sessionStorage.setItem("psSetupToken",token);
const state={page:0,scan:null,catalog:null,comfy:null,comfyMode:"existing",freshDir:"",comfyVariant:"nvidia",packs:new Set(["krea2_turbo"]),llmChoice:"none",llmModel:"",ollamaGpu:"",plan:null,job:null};
const $=s=>document.querySelector(s); const $$=s=>[...document.querySelectorAll(s)];
const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const bytes=value=>{let n=Number(value||0),u="B";for(const x of ["B","KB","MB","GB","TB"]){u=x;if(n<1000||x==="TB")break;n/=1000}return `${n.toFixed(n<10?1:0)} ${u}`};
async function api(path,options={}){const headers={"X-PromptStudio-Token":token,...(options.headers||{})};if(options.body)headers["Content-Type"]="application/json";const response=await fetch(path,{...options,headers});const data=await response.json();if(!response.ok)throw new Error(data.error||`Request failed (${response.status})`);return data}
function steps(){ $("#steps").innerHTML=labels.map((label,i)=>`<div class="step ${i===state.page?"active":i<state.page?"done":""}"><div class="num">${i<state.page?"✓":i+1}</div><span>${label}</span></div>`).join("") }
function showPage(page){state.page=Math.max(0,Math.min(labels.length-1,page));$$(`.page`).forEach((el,i)=>el.classList.toggle("active",i===state.page));steps();$("#back").disabled=state.page===0||state.job;$("#next").classList.toggle("hidden",state.page===5);validateNext()}
function validateNext(){let ok=true;if(state.page===0)ok=!!state.scan;if(state.page===1)ok=state.comfyMode==="fresh"?!!$("#fresh-dir")?.value.trim():!!state.comfy;if(state.page===2)ok=state.packs.size>0;if(state.page===3&&state.llmChoice.startsWith("ollama"))ok=!!state.llmModel;if(state.page===4)ok=!!state.plan;$("#next").disabled=!ok}
function cardStatus(good,text){return `<span class="status ${good?"good":"warn"}"><i class="dot"></i>${esc(text)}</span>`}
function renderScan(){const h=state.scan.hardware;const gpu=h.gpus?.[0];const adapter=gpu?.name||h.display_adapters?.[0]||"CPU mode available";$("#scan").innerHTML=`<div class="grid"><div class="card"><div class="kicker">Processor</div><div class="metric" style="font-size:17px">${esc(h.cpu)}</div><p>${esc(h.os)}</p></div><div class="card"><div class="kicker">Memory</div><div class="metric">${bytes(h.ram_total)}</div><p>${bytes(h.ram_available)} currently available</p></div><div class="card"><div class="kicker">Graphics</div><div class="metric" style="font-size:17px">${esc(adapter)}</div><p>${gpu?`${bytes(gpu.vram_total)} VRAM · ${bytes(gpu.vram_free)} currently free`:"Official AMD, Intel and CPU-capable builds are available"}</p></div><div class="card"><div class="kicker">Detected</div><div class="metric">${state.scan.comfy.length} ComfyUI</div><p>${state.scan.running_comfy.length} currently running · ${state.scan.llms.ollama.reachable||state.scan.llms.koboldcpp.reachable?"local LLM found":"fresh LLM setup available"}</p></div></div>`;validateNext()}
function renderComfy(){const modes=[{id:"existing",name:"Use existing ComfyUI",copy:state.scan.comfy.length?`${state.scan.comfy.length} installation(s) detected`:"Browse to an installation"},{id:"fresh",name:"Install fresh ComfyUI",copy:"Official portable build · recommended for a clean machine"}];$("#comfy-mode").innerHTML=modes.map(x=>`<div class="card selectable ${state.comfyMode===x.id?"selected":""}" data-comfy-mode="${x.id}"><h3>${x.name}</h3><p>${esc(x.copy)}</p></div>`).join("");$$(`[data-comfy-mode]`).forEach(el=>el.onclick=()=>{state.comfyMode=el.dataset.comfyMode;renderComfy();renderPacks();validateNext()});$("#existing-comfy").classList.toggle("hidden",state.comfyMode!=="existing");$("#fresh-comfy").classList.toggle("hidden",state.comfyMode!=="fresh");const list=$("#comfy-list");list.innerHTML=state.scan.comfy.length?state.scan.comfy.map((item,i)=>`<div class="card selectable ${state.comfy?.path===item.path?"selected":""}" data-comfy="${i}"><div class="row"><div><h3>${esc(item.kind)} · ComfyUI ${esc(item.version)}</h3><div class="path">${esc(item.path)}</div></div>${cardStatus(item.prompt_studio.installed,item.prompt_studio.installed?"Prompt Studio found":"Ready to install")}</div><p style="margin-top:10px">${bytes(item.disk_free)} free on this drive</p></div>`).join(""):`<div class="alert">No existing ComfyUI was detected. Choose Install fresh ComfyUI above, or browse to a custom location.</div>`;$$(`[data-comfy]`).forEach(el=>el.onclick=()=>{state.comfy=state.scan.comfy[Number(el.dataset.comfy)];state.comfyMode="existing";renderComfy();renderPacks();validateNext()});if(!$("#fresh-dir").value)$("#fresh-dir").value=state.freshDir||state.scan.default_fresh_dir;$("#comfy-variant").value=state.comfyVariant;validateNext()}
function assetView(asset,status){const good=status?.state==="present";return `<div class="asset"><div><strong>${esc(asset.name)}</strong><small>${good?esc(status.path):esc(asset.relative_path)}</small></div>${cardStatus(good,good?"Detected":bytes(asset.size))}</div>`}
function renderPacks(){const selected=state.comfyMode==="existing"?(state.comfy?.packs||{}):{};$("#packs").innerHTML=state.catalog.packs.map(pack=>{const on=state.packs.has(pack.id);const status=selected[pack.id];return `<label class="card selectable ${on?"selected":""}"><div class="choice"><input type="checkbox" data-pack="${esc(pack.id)}" ${on?"checked":""}/><span><strong>${esc(pack.name)} ${pack.recommended?'<span class="status good">Recommended</span>':""}</strong><small>${esc(pack.description)}</small></span></div><div style="margin-top:14px">${pack.assets.map(asset=>assetView(asset,status?.assets?.[asset.id])).join("")}</div></label>`}).join("");$$(`[data-pack]`).forEach(input=>input.onchange=()=>{input.checked?state.packs.add(input.dataset.pack):state.packs.delete(input.dataset.pack);renderPacks();validateNext()})}
function renderLlms(){const llms=state.scan.llms;const cards=[{id:"ollama_managed",name:"Set up Ollama",copy:llms.ollama.installed_executable?"Use the installed runtime and add the selected model":"Install the official standalone runtime and selected model",good:true},{id:"ollama_existing",name:"Use running Ollama",copy:llms.ollama.reachable?`${llms.ollama.models.length} installed model(s) · ${llms.ollama.version}`:"No service detected on port 11434",good:llms.ollama.reachable},{id:"koboldcpp",name:"Use KoboldCpp",copy:llms.koboldcpp.reachable?`Running · ${JSON.stringify(llms.koboldcpp.version)}`:"Configure a loopback endpoint",good:llms.koboldcpp.reachable},{id:"none",name:"No LLM for now",copy:"Use direct prompts and configure a provider later.",good:true}];$("#llms").innerHTML=cards.map(x=>`<div class="card selectable ${state.llmChoice===x.id?"selected":""}" data-llm="${x.id}"><div class="row"><h3>${x.name}</h3>${cardStatus(x.good,x.good?"Available":"Offline")}</div><p>${esc(x.copy)}</p></div>`).join("");$$(`[data-llm]`).forEach(el=>el.onclick=()=>{if(el.dataset.llm==="ollama_existing"&&!llms.ollama.reachable)return;state.llmChoice=el.dataset.llm;if(!state.llmChoice.startsWith("ollama"))state.llmModel="";else if(!state.llmModel)state.llmModel=state.scan.recommended_llm_model;renderLlms();validateNext()});const useOllama=state.llmChoice.startsWith("ollama");$("#ollama-options").classList.toggle("hidden",!useOllama);$("#kobold-options").classList.toggle("hidden",state.llmChoice!=="koboldcpp");if(!useOllama)return;const installed=new Set(llms.ollama.models||[]);const recs=state.catalog.llm_recommendations||[];$("#ollama-models").innerHTML=recs.map(item=>`<label class="card selectable ${state.llmModel===item.model?"selected":""}"><div class="choice"><input type="radio" name="ollama-model" value="${esc(item.model)}" ${state.llmModel===item.model?"checked":""}/><span><strong>${esc(item.model)} ${item.model===state.scan.recommended_llm_model?'<span class="status good">Hardware pick</span>':""}</strong><small>${esc(item.tier)} · about ${bytes(item.size)}${installed.has(item.model)?" · already installed":""}</small></span></div></label>`).join("");$$(`input[name=ollama-model]`).forEach(input=>input.onchange=()=>{state.llmModel=input.value;renderLlms();validateNext()});const gpus=state.scan.hardware.gpus||[];if(gpus.length>1){const second=gpus[1];$("#ollama-placement").innerHTML=`<h2>GPU placement</h2><div class="form-row"><select id="ollama-gpu"><option value="${second.index}">${esc(second.name)} · ${bytes(second.vram_total)} · separate from image GPU</option><option value="">Automatic across available hardware</option></select></div><p class="lead" style="margin-top:10px">The second GPU is recommended so ComfyUI keeps the primary GPU. Enable Keep models loaded later only when the services stay on separate GPUs.</p>`;$("#ollama-gpu").value=state.ollamaGpu||String(second.index);$("#ollama-gpu").onchange=e=>state.ollamaGpu=e.target.value}else{$("#ollama-placement").innerHTML=`<div class="alert" style="margin-top:14px">Single-GPU mode: Prompt Studio unloads Ollama before ComfyUI work and unloads ComfyUI only when the next LLM operation begins.</div>`}}
function requestBody(){const choice=state.llmChoice;return {comfy_mode:state.comfyMode,comfy_path:state.comfy?.path||"",comfy_install_dir:$("#fresh-dir")?.value.trim()||state.freshDir,comfy_variant:$("#comfy-variant")?.value||state.comfyVariant,pack_ids:[...state.packs],download_models:true,llm_provider:choice.startsWith("ollama")?"ollama":choice,llm_management:choice==="ollama_managed"?"managed":"existing",llm_model:state.llmModel,ollama_installed_models:state.scan.llms.ollama.models||[],ollama_gpu:$("#ollama-gpu")?.value??state.ollamaGpu,kobold_url:$("#kobold-url")?.value.trim()||"http://127.0.0.1:5001"}}
async function prepareReview(){state.plan=null;$("#next").disabled=true;$("#footnote").textContent="Resolving official release files…";state.plan=await api("/api/plan",{method:"POST",body:JSON.stringify(requestBody())});const p=state.plan;$("#review").innerHTML=p.actions.map(action=>`<div class="review-item"><span class="icon">${action.type==="missing_model"?"!":"✓"}</span><div><strong>${esc(action.label)}</strong>${action.target?`<small class="path">${esc(action.target)}</small>`:""}</div><small>${action.bytes?bytes(action.bytes):""}</small></div>`).join("")+`<div class="review-item"><span class="icon">↓</span><div><strong>Total download</strong><small>${bytes(p.disk_free)} free · ${bytes(p.required_free)} required including extraction room</small></div><strong>${bytes(p.download_bytes)}</strong></div>`;const licenses=state.catalog.packs.filter(pack=>state.packs.has(pack.id)).flatMap(pack=>pack.licenses||[]);if(p.actions.some(action=>action.type==="install_vc_runtime"))licenses.push({name:state.catalog.provisioning.vc_runtime.license_name,url:state.catalog.provisioning.vc_runtime.license_url});if(state.comfyMode==="fresh")licenses.push({name:state.catalog.provisioning.comfyui.license_name,url:state.catalog.provisioning.comfyui.license_url});if(state.llmChoice==="ollama_managed")licenses.push({name:state.catalog.provisioning.ollama.license_name,url:state.catalog.provisioning.ollama.license_url});if(state.llmChoice.startsWith("ollama"))licenses.push({name:state.catalog.provisioning.ollama.model_license_name,url:state.catalog.provisioning.ollama.model_license_url});$("#license-links").innerHTML=licenses.map(item=>`<a href="${esc(item.url)}" target="_blank" style="color:var(--cyan)">${esc(item.name)}</a>`).join(" · ");$("#review-error").classList.toggle("hidden",p.enough_space);$("#review-error").textContent=p.enough_space?"":`This drive needs ${bytes(p.required_free)} free for downloads and extraction.`;$("#footnote").textContent="No changes have been made.";validateNext()}
async function startJob(){const body={...requestBody(),accepted_licenses:$("#licenses").checked};try{state.job=await api("/api/install",{method:"POST",body:JSON.stringify(body)});$("#install").classList.add("hidden");$("#job").classList.remove("hidden");$("#back").disabled=true;pollJob()}catch(error){$("#install-copy").textContent=error.message}}
async function pollJob(){if(!state.job)return;try{state.job=await api(`/api/jobs/${state.job.id}`);const j=state.job;$("#job-phase").textContent=j.phase;$("#job-count").textContent=`${Math.min((j.action_index||0)+1,j.action_count||0)} / ${j.action_count||0}`;const own=j.action_total?j.action_done/j.action_total:0;const total=(j.action_index+own)/Math.max(1,j.action_count);$("#job-bar").style.width=`${Math.max(2,Math.min(100,total*100))}%`;$("#job-message").textContent=j.message;$("#job-log").textContent=(j.messages||[]).join("\n")+(j.error?`\n${j.error}`:"");if(j.state==="complete"){state.job=null;$("#job-bar").style.width="100%";$("#install-title").textContent="Ready for Prompt Studio.";$("#open-studio").href=j.prompt_studio_url;if(!j.requires_restart){$("#open-studio").classList.remove("hidden");$("#footnote").textContent="Opening Prompt Studio…";setTimeout(()=>location.href=j.prompt_studio_url,1200)}else{$("#footnote").textContent=`Close ComfyUI, then double-click ${j.launcher_path}`};return}if(j.state==="failed"){state.job=null;$("#install-title").textContent="Setup needs attention.";$("#install-copy").textContent="Correct the issue and retry. Completed downloads will be reused.";$("#install").textContent="Retry setup";$("#install").classList.remove("hidden");$("#back").disabled=false;return}setTimeout(pollJob,700)}catch(error){$("#job-message").textContent=error.message;setTimeout(pollJob,1500)}}
async function next(){if(state.page===3){try{await prepareReview()}catch(error){alert(error.message);return}}showPage(state.page+1)}
$("#next").onclick=next;$("#back").onclick=()=>showPage(state.page-1);$("#install").onclick=startJob;
async function inspectComfyPath(path){const item=await api("/api/inspect",{method:"POST",body:JSON.stringify({path})});const existing=state.scan.comfy.findIndex(x=>x.path===item.path);if(existing>=0)state.scan.comfy[existing]=item;else state.scan.comfy.push(item);state.comfy=item;$("#path-error").classList.add("hidden");renderComfy();validateNext()}
function showPathError(error){$("#path-error").textContent=error.message;$("#path-error").classList.remove("hidden");validateNext()}
$("#browse").onclick=async()=>{try{const data=await api("/api/browse",{method:"POST",body:JSON.stringify({purpose:"existing"})});if(data.path){$("#comfy-path").value=data.path;state.comfy=null;validateNext();await inspectComfyPath(data.path)}}catch(error){showPathError(error)}};
$("#browse-fresh").onclick=async()=>{try{const data=await api("/api/browse",{method:"POST",body:JSON.stringify({purpose:"fresh"})});if(data.path){$("#fresh-dir").value=`${data.path}\\ComfyUI_windows_portable`;state.freshDir=$("#fresh-dir").value;validateNext()}}catch(error){$("#path-error").textContent=error.message;$("#path-error").classList.remove("hidden")}};
$("#fresh-dir").oninput=()=>{state.freshDir=$("#fresh-dir").value;validateNext()};$("#comfy-variant").onchange=()=>state.comfyVariant=$("#comfy-variant").value;
$("#inspect").onclick=async()=>{state.comfy=null;validateNext();try{await inspectComfyPath($("#comfy-path").value)}catch(error){showPathError(error)}};
async function init(){steps();try{[state.catalog,state.scan]=await Promise.all([api("/api/catalog"),api("/api/scan")]);state.comfy=state.scan.comfy[0]||null;state.comfyMode=state.comfy?"existing":"fresh";state.freshDir=state.scan.default_fresh_dir;state.comfyVariant=state.scan.recommended_comfy_variant||"nvidia";if(state.scan.llms.ollama.reachable){state.llmChoice="ollama_existing";state.llmModel=state.scan.llms.ollama.models[0]||state.scan.recommended_llm_model}else if(state.scan.llms.koboldcpp.reachable)state.llmChoice="koboldcpp";else{state.llmChoice="ollama_managed";state.llmModel=state.scan.recommended_llm_model}const gpus=state.scan.hardware.gpus||[];if(gpus.length>1)state.ollamaGpu=String(gpus[1].index);renderScan();renderComfy();renderPacks();renderLlms()}catch(error){$("#scan").innerHTML=`<div class="alert">${esc(error.message)}</div>`}}
init();
</script>
</body>
</html>'''


class WizardHandler(BaseHTTPRequestHandler):
    server_version = "PromptStudioSetup/0.1"

    def log_message(self, _format, *_args):
        return

    def _parsed(self):
        return urllib.parse.urlsplit(self.path)

    def _authorized(self):
        parsed = self._parsed()
        supplied = self.headers.get("X-PromptStudio-Token", "")
        if parsed.path == "/":
            supplied = urllib.parse.parse_qs(parsed.query).get("token", [""])[0]
        return secrets.compare_digest(supplied, TOKEN)

    def _send(self, payload, status=HTTPStatus.OK, content_type="application/json; charset=utf-8"):
        body = payload if isinstance(payload, bytes) else payload.encode("utf-8")
        self.send_response(int(status))
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, payload, status=HTTPStatus.OK):
        self._send(json.dumps(payload, ensure_ascii=False), status)

    def _body(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length > 1024 * 1024:
            raise ValueError("Request is too large")
        return json.loads(self.rfile.read(length).decode("utf-8")) if length else {}

    def _error(self, exc):
        _log("Request failed: {}\n{}".format(exc, traceback.format_exc()))
        self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def do_GET(self):
        if not self._authorized():
            self._json({"error": "Invalid setup session"}, HTTPStatus.FORBIDDEN)
            return
        path = self._parsed().path
        try:
            if path == "/":
                self._send(HTML, content_type="text/html; charset=utf-8")
            elif path == "/api/catalog":
                self._json(load_catalog())
            elif path == "/api/scan":
                self._json(scan_system())
            elif path.startswith("/api/jobs/"):
                job_id = path.rsplit("/", 1)[-1]
                with JOBS_LOCK:
                    job = JOBS.get(job_id)
                    if not job:
                        self._json({"error": "Install job was not found"}, HTTPStatus.NOT_FOUND)
                        return
                    snapshot = dict(job)
                self._json(snapshot)
                if snapshot.get("state") == "complete":
                    threading.Timer(12, self.server.shutdown).start()
            else:
                self._json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
        except Exception as exc:
            self._error(exc)

    def do_POST(self):
        if not self._authorized():
            self._json({"error": "Invalid setup session"}, HTTPStatus.FORBIDDEN)
            return
        path = self._parsed().path
        try:
            data = self._body()
            if path == "/api/inspect":
                self._json(inspect_comfy(data.get("path", "")))
            elif path == "/api/browse":
                self._json({"path": browse_folder(str(data.get("purpose") or "existing"))})
            elif path == "/api/plan":
                self._json(build_plan(data))
            elif path == "/api/install":
                self._json(start_install(data), HTTPStatus.ACCEPTED)
            else:
                self._json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
        except Exception as exc:
            self._error(exc)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Prompt Studio local browser setup")
    parser.add_argument("--port", type=int, default=0, help="Loopback port; 0 chooses a free port")
    parser.add_argument("--no-browser", action="store_true", help="Do not open the default browser")
    parser.add_argument("--scan-only", action="store_true", help="Print detection JSON and exit")
    parser.add_argument("--comfy-path", action="append", default=[], help="Additional ComfyUI path to inspect")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if args.scan_only:
        print(json.dumps(scan_system(args.comfy_path), ensure_ascii=False, indent=2))
        return 0
    server = ThreadingHTTPServer((LOOPBACK, args.port), WizardHandler)
    url = "http://{}:{}/?token={}".format(LOOPBACK, server.server_port, urllib.parse.quote(TOKEN))
    _log("Wizard started on loopback port {}".format(server.server_port))
    if not args.no_browser:
        def open_setup():
            try:
                if not _open_browser_url(url):
                    _log("No installed browser or HTTP handler could open the setup URL: {}".format(url))
            except Exception as exc:
                _log("Could not open the setup browser: {}".format(exc))

        threading.Timer(0.35, open_setup).start()
    try:
        server.serve_forever(poll_interval=0.4)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
