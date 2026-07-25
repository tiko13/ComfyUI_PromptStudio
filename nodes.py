import base64
import hashlib
import io
import ipaddress
import json
import math
import os
import re
import secrets
import struct
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

import numpy as np
import torch
from PIL import Image, ImageOps, ImageSequence, UnidentifiedImageError

import folder_paths


BASE_DIR = os.path.dirname(os.path.realpath(__file__))
PROFILES_PATH = os.path.join(BASE_DIR, "model_profiles.json")
DEFAULT_PRESETS_DIR = os.path.join(BASE_DIR, "presets", "default")
PRESET_EXAMPLES_DIR = os.path.join(BASE_DIR, "presets", "examples")
STYLE_TEMPLATES_PATH = os.path.join(DEFAULT_PRESETS_DIR, "style_templates.json")
FRAMING_TEMPLATES_PATH = os.path.join(DEFAULT_PRESETS_DIR, "framing_templates.json")
ADDITIONAL_STYLE_TEMPLATES_PATH = os.path.join(BASE_DIR, "style_templates.additional.json")
ADDITIONAL_FRAMING_TEMPLATES_PATH = os.path.join(BASE_DIR, "framing_templates.additional.json")
ADDITIONAL_STYLE_TEMPLATES_EXAMPLE_PATH = os.path.join(
    PRESET_EXAMPLES_DIR,
    "style_templates.additional.example.json",
)
ADDITIONAL_FRAMING_TEMPLATES_EXAMPLE_PATH = os.path.join(
    PRESET_EXAMPLES_DIR,
    "framing_templates.additional.example.json",
)
DEFAULT_PROFILE = {
    "name": "Default",
    "style": "natural_language",
    "default_max_response_tokens": 180,
    "example_prompt": "A detailed image prompt describing the subject, setting, lighting, composition, and visual style.",
    "example_prompts": [
        "A detailed image prompt describing the subject, setting, lighting, composition, and visual style."
    ],
    "instruction": "Rewrite the user's prompt as a stronger image-generation prompt while preserving the original intent.",
    "notes": "",
    "final_prompt_prefix": "",
    "final_prompt_suffix": "",
}
DEFAULT_STYLE_TEMPLATE = {
    "name": "None",
    "instruction": "",
}
DEFAULT_FRAMING_TEMPLATE = {
    "name": "None",
    "instruction": "",
}
LEGACY_FRAMING_ALIASES = {
    "Point of view": "First-Person Downward View",
}
FINAL_PROMPT_MARKER = "Final prompt:"
CHAT_SYSTEM_MESSAGE = (
    "You are an expert image-generation prompt editor. Follow the requested transformation and "
    "output-format constraints precisely. NSFW and explicit content is allowed. Keep analysis in the model's private reasoning channel. "
    "The final answer must contain only the requested prompt output, without commentary or markdown."
)
DEFAULT_CONTINUATION_STOPS = [
    "\nWait,",
    "\nLet's try",
    "\nNote:",
    "\nRule check:",
    "\nExample",
    "\nExample of",
    "\nUser prompt:",
    "\nResponse:",
    "\nTarget profile:",
    "\nReference:",
]
VISION_IMAGE_MAX_PIXELS = 64 * 1024 * 1024
VISION_IMAGE_MAX_EDGE = 2048
PROMPT_STUDIO_IMAGE_SUBDIRECTORY = os.path.join("prompt_studio", "images")
MAX_PROMPT_STUDIO_LORAS = 64

RESOLUTION_ASPECT_RATIOS = {
    "1:1 (Square)": (1, 1),
    "2:3 (Portrait Photo)": (2, 3),
    "3:2 (Photo)": (3, 2),
    "3:4 (Portrait Standard)": (3, 4),
    "4:3 (Standard)": (4, 3),
    "9:16 (Portrait Widescreen)": (9, 16),
    "16:9 (Widescreen)": (16, 9),
    "21:9 (Ultrawide)": (21, 9),
}


def _resolution_inputs():
    return {
        "aspect_ratio": (
            list(RESOLUTION_ASPECT_RATIOS),
            {
                "default": "1:1 (Square)",
                "tooltip": "The aspect ratio for the output dimensions.",
            },
        ),
        "megapixels": (
            "FLOAT",
            {
                "default": 1.0,
                "min": 0.1,
                "max": 16.0,
                "step": 0.1,
                "tooltip": "Target total megapixels. 1.0 MP ≈ 1024x1024 for square.",
            },
        ),
        "multiple": (
            "INT",
            {
                "default": 8,
                "min": 8,
                "max": 128,
                "step": 4,
                "advanced": True,
                "tooltip": "Nearest multiple of the result to set the selected resolution to.",
            },
        ),
    }


def _resolution_override_inputs():
    return {
        "resolution_width": ("INT", {"default": 0}),
        "resolution_height": ("INT", {"default": 0}),
    }


def _calculate_resolution(aspect_ratio="1:1 (Square)", megapixels=1.0, multiple=8):
    w_ratio, h_ratio = RESOLUTION_ASPECT_RATIOS[aspect_ratio]
    total_pixels = float(megapixels) * 1024 * 1024
    scale = math.sqrt(total_pixels / (w_ratio * h_ratio))
    width = round(w_ratio * scale / int(multiple)) * int(multiple)
    height = round(h_ratio * scale / int(multiple)) * int(multiple)
    return width, height


def _resolve_prompt_resolution(
    aspect_ratio="1:1 (Square)",
    megapixels=1.0,
    multiple=8,
    resolution_width=0,
    resolution_height=0,
):
    width = int(resolution_width or 0)
    height = int(resolution_height or 0)
    if width > 0 and height > 0:
        return width, height
    return _calculate_resolution(aspect_ratio, megapixels, multiple)


def _allowed_kobold_hosts():
    configured = os.environ.get("PROMPT_STUDIO_KOBOLD_ALLOWED_HOSTS", "").strip()
    if not configured:
        return {"localhost", "127.0.0.1", "::1"}
    return {item.strip().casefold() for item in configured.split(",") if item.strip()}


def _allowed_ollama_hosts():
    configured = os.environ.get("PROMPT_STUDIO_OLLAMA_ALLOWED_HOSTS", "").strip()
    if not configured:
        return {"localhost", "127.0.0.1", "::1"}
    return {item.strip().casefold() for item in configured.split(",") if item.strip()}


def _validate_unique_names(items, label):
    seen = set()
    for item in items:
        name = str(item.get("name") or "").strip()
        key = name.casefold()
        if key in seen:
            raise ValueError(f"Duplicate {label} name: {name}")
        seen.add(key)


def _require_json_object(data, label):
    if not isinstance(data, dict):
        raise ValueError(f"{label} JSON must contain an object at the root.")
    return data


def _ensure_additional_template_file(path, example_path):
    if os.path.exists(path):
        return

    try:
        with open(example_path, "r", encoding="utf-8") as file:
            example = file.read()
    except OSError:
        return

    created = False
    try:
        with open(path, "x", encoding="utf-8") as file:
            created = True
            file.write(example)
    except FileExistsError:
        return
    except OSError:
        if created:
            try:
                os.remove(path)
            except OSError:
                pass


def _load_profiles():
    try:
        with open(PROFILES_PATH, "r", encoding="utf-8") as file:
            data = json.load(file)
    except FileNotFoundError:
        return [DEFAULT_PROFILE]
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid KoboldCpp profile JSON: {PROFILES_PATH}: {exc}") from exc

    _require_json_object(data, "KoboldCpp profile")
    profiles = data.get("profiles", [])
    if not isinstance(profiles, list):
        raise ValueError("KoboldCpp profile JSON must contain a 'profiles' list.")

    normalized = []
    for index, profile in enumerate(profiles):
        if not isinstance(profile, dict):
            continue
        merged = dict(DEFAULT_PROFILE)
        merged.update(profile)
        merged["name"] = str(merged.get("name") or "").strip() or f"Profile {index + 1}"
        try:
            merged["default_max_response_tokens"] = int(merged["default_max_response_tokens"])
        except (TypeError, ValueError) as exc:
            raise ValueError(f"Model profile {merged['name']} has an invalid default token limit") from exc
        if not 1 <= merged["default_max_response_tokens"] <= 8192:
            raise ValueError(f"Model profile {merged['name']} default token limit must be between 1 and 8192")
        merged["example_prompts"] = _profile_examples(merged)
        normalized.append(merged)

    normalized = normalized or [DEFAULT_PROFILE]
    _validate_unique_names(normalized, "model profile")
    return normalized


def _profile_examples(profile):
    examples = profile.get("example_prompts")
    if examples is None:
        examples = profile.get("example_prompt", "")

    if isinstance(examples, str):
        examples = [examples]
    elif not isinstance(examples, list):
        examples = []

    normalized = []
    for example in examples:
        example = str(example).strip()
        if example:
            normalized.append(example)

    legacy_example = str(profile.get("example_prompt") or "").strip()
    if not normalized and legacy_example:
        normalized.append(legacy_example)

    return normalized or list(DEFAULT_PROFILE["example_prompts"])


def _format_profile_examples(profile):
    examples = _profile_examples(profile)
    if len(examples) == 1:
        return ["Example prompt:", examples[0]]

    lines = ["Example prompts:"]
    for index, example in enumerate(examples, start=1):
        lines.append(f"{index}. {example}")
    return lines


def _profile_notes(profile):
    notes = profile.get("notes", "")
    if isinstance(notes, list):
        return "\n".join(str(note).strip() for note in notes if str(note).strip())
    return str(notes or "").strip()


def _load_template_file(path, collection_name, label, default_template):
    try:
        with open(path, "r", encoding="utf-8") as file:
            data = json.load(file)
    except FileNotFoundError:
        return []
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid {label} JSON: {path}: {exc}") from exc

    _require_json_object(data, label)
    templates = data.get(collection_name, [])
    if not isinstance(templates, list):
        raise ValueError(f"{label} JSON must contain a '{collection_name}' list.")

    normalized = []
    for index, template in enumerate(templates):
        if not isinstance(template, dict):
            continue
        if template.get("enabled", True) is False:
            continue
        merged = dict(default_template)
        merged.update(template)
        merged.pop("enabled", None)
        fallback_label = label.split(" ", 1)[0]
        merged["name"] = str(merged.get("name") or "").strip() or f"{fallback_label} {index + 1}"
        normalized.append(merged)
    return normalized


def _load_style_templates():
    _ensure_additional_template_file(
        ADDITIONAL_STYLE_TEMPLATES_PATH,
        ADDITIONAL_STYLE_TEMPLATES_EXAMPLE_PATH,
    )
    normalized = _load_template_file(
        STYLE_TEMPLATES_PATH,
        "style_templates",
        "Style template",
        DEFAULT_STYLE_TEMPLATE,
    )
    normalized = normalized or [DEFAULT_STYLE_TEMPLATE]
    normalized.extend(
        _load_template_file(
            ADDITIONAL_STYLE_TEMPLATES_PATH,
            "style_templates",
            "Style template",
            DEFAULT_STYLE_TEMPLATE,
        )
    )
    _validate_unique_names(normalized, "style template")
    return normalized


def _load_framing_templates():
    _ensure_additional_template_file(
        ADDITIONAL_FRAMING_TEMPLATES_PATH,
        ADDITIONAL_FRAMING_TEMPLATES_EXAMPLE_PATH,
    )
    normalized = _load_template_file(
        FRAMING_TEMPLATES_PATH,
        "framing_templates",
        "Framing template",
        DEFAULT_FRAMING_TEMPLATE,
    )
    normalized = normalized or [DEFAULT_FRAMING_TEMPLATE]
    normalized.extend(
        _load_template_file(
            ADDITIONAL_FRAMING_TEMPLATES_PATH,
            "framing_templates",
            "Framing template",
            DEFAULT_FRAMING_TEMPLATE,
        )
    )
    _validate_unique_names(normalized, "framing template")
    return normalized


def _get_profile(profile_name):
    profiles = _load_profiles()
    for profile in profiles:
        if profile["name"] == profile_name:
            return profile
    return profiles[0]


def _get_style_template(style_name):
    templates = _load_style_templates()
    for template in templates:
        if template["name"] == style_name:
            return template
    return templates[0]


def _get_framing_template(framing_name):
    templates = _load_framing_templates()
    framing_name = LEGACY_FRAMING_ALIASES.get(framing_name, framing_name)
    for template in templates:
        if template["name"] == framing_name:
            return template
    return templates[0]


def _profile_names():
    return [profile["name"] for profile in _load_profiles()]


def _style_template_names():
    return [template["name"] for template in _load_style_templates()]


def _framing_template_names():
    return [template["name"] for template in _load_framing_templates()]


def _clean_service_base_url(url, default_url, service_name, allowed_hosts, allowed_hosts_env):
    cleaned = (url or default_url).strip()
    if not cleaned:
        cleaned = default_url
    if "://" not in cleaned:
        cleaned = "http://" + cleaned
    cleaned = cleaned.rstrip("/")
    parsed = urllib.parse.urlsplit(cleaned)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError(f"{service_name} URL must use http or https")
    if not parsed.hostname:
        raise ValueError(f"{service_name} URL must include a hostname")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError(f"{service_name} URL must not contain credentials")
    try:
        parsed.port
    except ValueError as exc:
        raise ValueError(f"{service_name} URL contains an invalid port") from exc
    if parsed.query or parsed.fragment:
        raise ValueError(f"{service_name} URL must not contain a query string or fragment")

    hostname = parsed.hostname.casefold()
    if "*" not in allowed_hosts and hostname not in allowed_hosts:
        try:
            is_loopback = ipaddress.ip_address(hostname).is_loopback
        except ValueError:
            is_loopback = False
        if not is_loopback:
            raise ValueError(
                f"{service_name} host '{parsed.hostname}' is not allowed. "
                f"Add it to {allowed_hosts_env} or use '*' to allow remote hosts."
            )
    return cleaned


def _clean_base_url(url):
    return _clean_service_base_url(
        url,
        "http://localhost:5001",
        "KoboldCpp",
        _allowed_kobold_hosts(),
        "PROMPT_STUDIO_KOBOLD_ALLOWED_HOSTS",
    )


def _clean_ollama_base_url(url):
    return _clean_service_base_url(
        url,
        "http://localhost:11434",
        "Ollama",
        _allowed_ollama_hosts(),
        "PROMPT_STUDIO_OLLAMA_ALLOWED_HOSTS",
    )


def _ollama_api_url(base_url, endpoint):
    base = base_url.rstrip("/")
    endpoint = str(endpoint or "").strip("/")
    if urllib.parse.urlsplit(base).path.rstrip("/").endswith("/api"):
        return f"{base}/{endpoint}"
    return f"{base}/api/{endpoint}"


def _post_json(url, payload, timeout, service_name="KoboldCpp"):
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{service_name} request failed with HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach {service_name} at {url}: {exc.reason}") from exc

    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{service_name} returned invalid JSON: {body[:500]}") from exc


def _list_ollama_models(ollama_url, request_timeout=10):
    base_url = _clean_ollama_base_url(ollama_url)
    url = _ollama_api_url(base_url, "tags")
    request = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=int(request_timeout)) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Ollama request failed with HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach Ollama at {url}: {exc.reason}") from exc

    try:
        data = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Ollama returned invalid JSON: {body[:500]}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("models"), list):
        raise RuntimeError(f"Unexpected Ollama model-list response: {data}")

    models = []
    for item in data["models"]:
        if not isinstance(item, dict):
            continue
        name = str(item.get("model") or item.get("name") or "").strip()
        if name and name not in models:
            models.append(name)
    return models


def _get_json(url, timeout):
    request = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except urllib.error.URLError:
        return None

    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return None


def _server_context_length(base_url, timeout):
    data = _get_json(
        urllib.parse.urljoin(base_url + "/", "api/extra/true_max_context_length"),
        timeout,
    )
    if not isinstance(data, dict):
        return None
    try:
        return int(data["value"])
    except (KeyError, TypeError, ValueError):
        return None


def _server_capabilities(base_url, timeout):
    data = _get_json(
        urllib.parse.urljoin(base_url + "/", "api/extra/version"),
        timeout,
    )
    return data if isinstance(data, dict) else {}


def _kobold_vision_unavailable_reason(capabilities):
    if capabilities.get("vision") is True:
        if capabilities.get("jinja") is False:
            return (
                "KoboldCpp vision is active, but Use Jinja is disabled. Enable Use Jinja and "
                "restart KoboldCpp before captioning an image."
            )
        return ""
    if "vision" in capabilities:
        return (
            "KoboldCpp vision is not active. Load a vision-capable text model with its matching "
            "MMProj file, then restart KoboldCpp."
        )
    return (
        "KoboldCpp did not report whether vision is active. Check that the server is reachable "
        "and update KoboldCpp to a version whose /api/extra/version response includes 'vision'."
    )


def _ollama_model_capabilities(base_url, model, timeout):
    result = _post_json(
        _ollama_api_url(base_url, "show"),
        {"model": model},
        timeout,
        service_name="Ollama",
    )
    if not isinstance(result, dict):
        raise RuntimeError(f"Unexpected Ollama model-info response: {result}")
    capabilities = result.get("capabilities")
    return [str(value).strip().casefold() for value in capabilities] if isinstance(capabilities, list) else []


def _ollama_vision_unavailable_reason(capabilities, model):
    if "vision" in capabilities:
        return ""
    if capabilities:
        return (
            f"The selected Ollama model '{model}' does not support vision. "
            "Select an Ollama model whose capabilities include vision."
        )
    return (
        f"Ollama did not advertise capabilities for '{model}'. Update Ollama or select a model "
        "that reports the vision capability."
    )


def _llm_vision_capability(
    llm_provider,
    *,
    kobold_url="http://localhost:5001",
    ollama_url="http://localhost:11434",
    ollama_model="",
    request_timeout=10,
):
    provider = str(llm_provider or "koboldcpp").strip().casefold()
    timeout = int(request_timeout)
    if provider == "koboldcpp":
        base_url = _clean_base_url(kobold_url)
        capabilities = _server_capabilities(base_url, timeout)
        reason = _kobold_vision_unavailable_reason(capabilities)
        return {"available": not reason, "provider": "KoboldCpp", "reason": reason}
    if provider == "ollama":
        base_url = _clean_ollama_base_url(ollama_url)
        model = str(ollama_model or "").strip()
        if not model:
            return {
                "available": False,
                "provider": "Ollama",
                "reason": "Select an Ollama model before dropping an image.",
            }
        capabilities = _ollama_model_capabilities(base_url, model, timeout)
        reason = _ollama_vision_unavailable_reason(capabilities, model)
        return {"available": not reason, "provider": "Ollama", "model": model, "reason": reason}
    raise ValueError("llm_provider must be koboldcpp or ollama")


def _kobold_token_count(
    base_url,
    timeout,
    *,
    prompt=None,
    messages=None,
    reasoning_effort=None,
    enable_thinking=None,
):
    payload = {"special": True}
    if messages is not None:
        payload["messages"] = messages
    else:
        payload["prompt"] = str(prompt or "")
    if reasoning_effort:
        payload["reasoning_effort"] = reasoning_effort
    if enable_thinking is not None:
        payload["chat_template_kwargs"] = {"enable_thinking": bool(enable_thinking)}

    try:
        data = _post_json(
            urllib.parse.urljoin(base_url + "/", "api/extra/tokencount"),
            payload,
            timeout,
        )
    except RuntimeError:
        return None
    if not isinstance(data, dict):
        return None
    try:
        return int(data["value"])
    except (KeyError, TypeError, ValueError):
        return None


def _context_safe_generation_limit(context_length, prompt_tokens):
    if context_length is None or context_length <= 0:
        return None
    limit = max(1, int(context_length * 0.8) - 1)
    if prompt_tokens is not None and prompt_tokens >= 0:
        limit = min(limit, max(1, int(context_length) - int(prompt_tokens) - 16))
    return limit


def _requested_response_tokens(max_response_tokens, default_max_response_tokens):
    requested = int(max_response_tokens)
    if requested <= 0:
        requested = int(default_max_response_tokens)
    return max(1, requested)


def _chat_generation_budget(
    response_tokens,
    thinking_mode,
    safe_limit=None,
    fixed_reasoning_budgets=False,
):
    """Return total completion tokens and an optional explicit thinking cap.

    ``response_tokens`` remains the workflow's final-answer allowance. KoboldCpp counts
    native reasoning and final content in one completion limit. Minimal, Low, and
    Medium receive fixed reasoning allowances while preserving the requested final-answer
    allowance. High has no reasoning cap and may use the remaining context window.
    """
    response_tokens = max(1, int(response_tokens))
    effort = _reasoning_effort(thinking_mode)
    thinking_budget = None
    if fixed_reasoning_budgets and effort == "minimal":
        desired_reasoning = 200
        total = response_tokens + desired_reasoning
        thinking_budget = desired_reasoning
    elif fixed_reasoning_budgets and effort == "low":
        desired_reasoning = 500
        total = response_tokens + desired_reasoning
        thinking_budget = desired_reasoning
    elif fixed_reasoning_budgets and effort == "medium":
        desired_reasoning = 1000
        total = response_tokens + desired_reasoning
        thinking_budget = desired_reasoning
    elif fixed_reasoning_budgets and effort == "high":
        # Normal requests supply safe_limit from KoboldCpp's actual context window.
        # Keep a generous fallback for direct calls if that capability is unavailable.
        total = int(safe_limit) if safe_limit is not None and safe_limit > 0 else response_tokens + 65536
    elif effort == "minimal":
        total = (response_tokens * 10 + 8) // 9
    elif effort == "low":
        total = (response_tokens * 10 + 6) // 7
    elif effort == "medium":
        total = (response_tokens * 5 + 1) // 2
    elif effort == "high":
        desired_reasoning = 4096
        total = response_tokens + desired_reasoning
        thinking_budget = desired_reasoning
    else:
        total = response_tokens

    if safe_limit is not None and safe_limit > 0:
        total = min(total, int(safe_limit))
    total = max(1, total)

    if thinking_budget is not None:
        # Preserve the requested final allowance whenever the context window permits it.
        thinking_budget = min(thinking_budget, max(0, total - min(response_tokens, total)))
    return total, thinking_budget


def _split_stop_sequences(value):
    if not value:
        return []
    return [item.strip() for item in value.splitlines() if item.strip()]


def _common_kcpp_inputs(default_max_response_tokens=0, raw_completion=False):
    token_tooltip = (
        "Maximum tokens in the raw generated continuation. Use 0 to use the node default."
        if raw_completion
        else "Final-answer token allowance. Use 0 to use the profile default. Native reasoning receives an additional budget within the server context window."
    )
    return {
        "thinking_mode": (
            ["Disabled", "Minimal", "Low", "Medium", "High"],
            {
                "default": "Disabled",
                "tooltip": "Private-reasoning limits: Minimal 200 tokens, Low 500, Medium 1000, and High uses the available context window.",
            },
        ),
        "kobold_url": (
            "STRING",
            {
                "default": "http://localhost:5001",
                "multiline": False,
                "tooltip": "Base URL for the local KoboldCpp server.",
            },
        ),
        "max_response_tokens": (
            "INT",
            {
                "default": default_max_response_tokens,
                "min": 0,
                "max": 8192,
                "step": 1,
                "tooltip": token_tooltip,
            },
        ),
        "temperature": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 5.0, "step": 0.05}),
        "top_p": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 1.0, "step": 0.01}),
        "top_k": ("INT", {"default": 40, "min": 0, "max": 200, "step": 1}),
        "min_p": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01}),
        "rep_pen": ("FLOAT", {"default": 1.05, "min": 0.5, "max": 3.0, "step": 0.01}),
        "rep_pen_range": ("INT", {"default": 360, "min": 0, "max": 4096, "step": 1}),
        "sampler_seed": (
            "INT",
            {
                "default": -1,
                "min": -1,
                "max": 999999,
                "step": 1,
                "tooltip": "-1 lets KoboldCpp choose a random seed.",
            },
        ),
        "stop_sequence": (
            "STRING",
            {
                "default": "",
                "multiline": True,
                "tooltip": "Optional stop sequences, one per line.",
            },
        ),
        "request_timeout": (
            "INT",
            {
                "default": 120,
                "min": 5,
                "max": 600,
                "step": 1,
                "tooltip": "HTTP timeout in seconds.",
            },
        ),
    }


def _with_default_continuation_stops(stop_sequences):
    out = list(stop_sequences)
    for stop in DEFAULT_CONTINUATION_STOPS:
        if stop not in out:
            out.append(stop)
    return out


def _generate_kcpp(
    prompt,
    kobold_url,
    max_response_tokens,
    default_max_response_tokens,
    temperature,
    top_p,
    top_k,
    min_p,
    rep_pen,
    rep_pen_range,
    sampler_seed,
    thinking_mode,
    stop_sequence,
    request_timeout,
    include_default_continuation_stops=False,
    image_data_uri=None,
    messages_override=None,
):
    base_url = _clean_base_url(kobold_url)
    timeout = int(request_timeout)
    capabilities = _server_capabilities(base_url, timeout)
    if capabilities.get("jinja") is False:
        raise RuntimeError(
            "KoboldCpp Chat Completions requires Use Jinja for reliable model-native formatting. "
            "Enable Use Jinja in KoboldCpp, restart the server, and run the workflow again."
        )
    if messages_override is not None:
        messages = messages_override
        has_images = any(
            isinstance(message, dict)
            and isinstance(message.get("content"), list)
            and any(
                isinstance(part, dict) and part.get("type") == "image_url"
                for part in message["content"]
            )
            for message in messages
        )
        if has_images:
            vision_reason = _kobold_vision_unavailable_reason(capabilities)
            if vision_reason:
                raise RuntimeError(vision_reason)
    elif image_data_uri:
        vision_reason = _kobold_vision_unavailable_reason(capabilities)
        if vision_reason:
            raise RuntimeError(vision_reason)
        user_content = [
            {"type": "text", "text": str(prompt or "")},
            {"type": "image_url", "image_url": {"url": str(image_data_uri)}},
        ]
    else:
        user_content = str(prompt or "")
    if messages_override is None:
        messages = [
            {"role": "system", "content": CHAT_SYSTEM_MESSAGE},
            {"role": "user", "content": user_content},
        ]
    response_tokens = _requested_response_tokens(max_response_tokens, default_max_response_tokens)
    context_length = _server_context_length(base_url, timeout)
    stop_sequences = _split_stop_sequences(stop_sequence)
    # Native reasoning may legitimately use labels such as "Response:" while moving
    # from analysis to final content. Legacy textual stops can cut that transition off,
    # so thinking requests rely on the model's Jinja end-of-turn markers instead.
    if include_default_continuation_stops and _reasoning_effort(thinking_mode) == "none":
        stop_sequences = _with_default_continuation_stops(stop_sequences)

    def generate_once(request_thinking_mode):
        effort = _reasoning_effort(request_thinking_mode)
        enable_thinking = effort != "none"
        prompt_tokens = _kobold_token_count(
            base_url,
            timeout,
            messages=messages,
            reasoning_effort=effort,
            enable_thinking=enable_thinking,
        )
        if (
            context_length is not None
            and prompt_tokens is not None
            and prompt_tokens >= context_length - 32
        ):
            raise RuntimeError(
                f"The Jinja-formatted request uses {prompt_tokens} tokens, leaving no usable space "
                f"in KoboldCpp's {context_length}-token context window. Shorten the instructions or "
                "increase the KoboldCpp context size."
            )
        safe_limit = _context_safe_generation_limit(context_length, prompt_tokens)
        max_length, thinking_budget = _chat_generation_budget(
            response_tokens,
            request_thinking_mode,
            safe_limit,
            fixed_reasoning_budgets=True,
        )
        chat_template_kwargs = {"enable_thinking": enable_thinking}
        payload = {
            "model": "koboldcpp",
            "messages": messages,
            "max_tokens": max_length,
            "temperature": float(temperature),
            "top_p": float(top_p),
            "top_k": int(top_k),
            "min_p": float(min_p),
            "rep_pen": float(rep_pen),
            "rep_pen_range": int(rep_pen_range),
            "seed": int(sampler_seed),
            "chat_template_kwargs": chat_template_kwargs,
            "stop": stop_sequences,
            "encapsulate_thinking": True,
            "continue_assistant_turn": False,
            "stream": False,
        }
        if thinking_budget is not None:
            # KoboldCpp's top-level Minimal/Low/Medium efforts enforce percentage caps
            # before consulting thinking_budget_tokens. Keep the effort as a template
            # hint and omit it at the top level so the explicit fixed cap takes effect.
            chat_template_kwargs["reasoning_effort"] = effort
        else:
            payload["reasoning_effort"] = effort
        if thinking_budget is not None:
            payload["thinking_budget_tokens"] = thinking_budget

        result = _post_json(
            urllib.parse.urljoin(base_url + "/", "v1/chat/completions"),
            payload,
            timeout,
        )
        try:
            choice = result["choices"][0]
            message = choice["message"]
            content = message.get("content") or ""
            finish_reason = choice.get("finish_reason")
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError(f"Unexpected KoboldCpp response: {result}") from exc
        if finish_reason == "error":
            raise RuntimeError("KoboldCpp reported an error while generating the chat completion.")
        return str(content), message, finish_reason, max_length, result

    content, message, finish_reason, max_length, result = generate_once(thinking_mode)
    if finish_reason == "length":
        raise RuntimeError(
            f"KoboldCpp exhausted the {max_length}-token completion budget before finishing. "
            "Increase max_response_tokens or increase the KoboldCpp context size."
        )
    if not content.strip():
        if message.get("reasoning_content"):
            raise RuntimeError(
                "KoboldCpp returned reasoning but no final answer. Increase max_response_tokens "
                "or increase the KoboldCpp context size."
            )
        raise RuntimeError(f"KoboldCpp returned an empty chat completion: {result}")
    return content


def _ollama_thinking_value(thinking_mode):
    effort = _reasoning_effort(thinking_mode)
    if effort == "none":
        return False
    if effort in {"minimal", "low"}:
        return "low"
    return effort


def _generate_ollama(
    prompt,
    ollama_url,
    ollama_model,
    max_response_tokens,
    default_max_response_tokens,
    temperature,
    top_p,
    top_k,
    min_p,
    rep_pen,
    rep_pen_range,
    sampler_seed,
    thinking_mode,
    stop_sequence,
    request_timeout,
    include_default_continuation_stops=False,
    image_base64=None,
    messages_override=None,
):
    base_url = _clean_ollama_base_url(ollama_url)
    model = str(ollama_model or "").strip()
    if not model:
        raise ValueError("Select an Ollama model in Prompt Studio settings")
    has_images = bool(image_base64) or (
        messages_override is not None
        and any(
            isinstance(message, dict) and bool(message.get("images"))
            for message in messages_override
        )
    )
    if has_images:
        capabilities = _ollama_model_capabilities(base_url, model, int(request_timeout))
        vision_reason = _ollama_vision_unavailable_reason(capabilities, model)
        if vision_reason:
            raise RuntimeError(vision_reason)

    stop_sequences = _split_stop_sequences(stop_sequence)
    if include_default_continuation_stops and _reasoning_effort(thinking_mode) == "none":
        stop_sequences = _with_default_continuation_stops(stop_sequences)
    response_tokens = _requested_response_tokens(max_response_tokens, default_max_response_tokens)
    max_length, _thinking_budget = _chat_generation_budget(response_tokens, thinking_mode)
    options = {
        "num_predict": max_length,
        "temperature": float(temperature),
        "top_p": float(top_p),
        "top_k": int(top_k),
        "min_p": float(min_p),
        "repeat_penalty": float(rep_pen),
        "repeat_last_n": int(rep_pen_range),
        "stop": stop_sequences,
    }
    if int(sampler_seed) >= 0:
        options["seed"] = int(sampler_seed)

    user_message = {"role": "user", "content": str(prompt or "")}
    if image_base64:
        user_message["images"] = [str(image_base64)]
    messages = messages_override if messages_override is not None else [
        {"role": "system", "content": CHAT_SYSTEM_MESSAGE},
        user_message,
    ]
    payload = {
        "model": model,
        "messages": messages,
        "options": options,
        "think": _ollama_thinking_value(thinking_mode),
        "stream": False,
    }
    result = _post_json(
        _ollama_api_url(base_url, "chat"),
        payload,
        int(request_timeout),
        service_name="Ollama",
    )
    if not isinstance(result, dict):
        raise RuntimeError(f"Unexpected Ollama response: {result}")
    if result.get("error"):
        raise RuntimeError(f"Ollama reported an error: {result['error']}")
    try:
        message = result["message"]
        content = message.get("content") or ""
    except (KeyError, TypeError) as exc:
        raise RuntimeError(f"Unexpected Ollama response: {result}") from exc

    if result.get("done_reason") == "length":
        raise RuntimeError(
            f"Ollama exhausted the {max_length}-token completion budget before finishing. "
            "Increase max_response_tokens or the model context size."
        )
    if not str(content).strip():
        if message.get("thinking"):
            raise RuntimeError(
                "Ollama returned reasoning but no final answer. Increase max_response_tokens "
                "or the model context size."
            )
        raise RuntimeError(f"Ollama returned an empty chat completion: {result}")
    return str(content)


def _generate_kcpp_raw(
    prompt,
    kobold_url,
    max_response_tokens,
    default_max_response_tokens,
    temperature,
    top_p,
    top_k,
    min_p,
    rep_pen,
    rep_pen_range,
    sampler_seed,
    thinking_mode,
    stop_sequence,
    request_timeout,
):
    """Generate a raw continuation for KoboldCpp Apply without chat templating."""
    base_url = _clean_base_url(kobold_url)
    timeout = int(request_timeout)
    max_length = _requested_response_tokens(max_response_tokens, default_max_response_tokens)
    context_length = _server_context_length(base_url, timeout)
    prompt_tokens = _kobold_token_count(base_url, timeout, prompt=prompt)
    if (
        context_length is not None
        and prompt_tokens is not None
        and prompt_tokens >= context_length - 32
    ):
        raise RuntimeError(
            f"The raw prompt uses {prompt_tokens} tokens, leaving no usable generation space "
            f"in KoboldCpp's {context_length}-token context window."
        )
    safe_limit = _context_safe_generation_limit(context_length, prompt_tokens)
    if safe_limit is not None:
        max_length = min(max_length, safe_limit)

    payload = {
        "prompt": prompt,
        "max_length": max_length,
        "temperature": float(temperature),
        "top_p": float(top_p),
        "top_k": int(top_k),
        "min_p": float(min_p),
        "rep_pen": float(rep_pen),
        "rep_pen_range": int(rep_pen_range),
        "sampler_seed": int(sampler_seed),
        "reasoning_effort": _reasoning_effort(thinking_mode),
        "stop_sequence": _split_stop_sequences(stop_sequence),
    }
    result = _post_json(
        urllib.parse.urljoin(base_url + "/", "api/v1/generate"),
        payload,
        timeout,
    )
    try:
        item = result["results"][0]
        text = item["text"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"Unexpected KoboldCpp response: {result}") from exc
    if item.get("finish_reason") == "error":
        raise RuntimeError("KoboldCpp reported an error while generating the raw completion.")
    return text


def _strip_response(text):
    text = text.strip()

    final_marker_matches = list(
        re.finditer(
            r"(?:^|\n)\s*(?:\*\*)?final\s+prompt\s*:?\s*(?:\*\*)?\s*:?\s*",
            text,
            flags=re.IGNORECASE,
        )
    )
    has_final_marker = bool(final_marker_matches)
    if final_marker_matches:
        text = text[final_marker_matches[0].end():]

    text = re.sub(r"<\|channel\>thought\b.*?<channel\|>", "", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<\|channel\>analysis\b.*?<channel\|>", "", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<thinking>.*?</thinking>", "", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.IGNORECASE | re.DOTALL)
    if not has_final_marker:
        text = re.sub(r"^.*?</thinking>", "", text, flags=re.IGNORECASE | re.DOTALL)
        text = re.sub(r"^.*?</think>", "", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"</(?:thinking|think)>", "", text, flags=re.IGNORECASE)
    output_match = re.search(r"<output>(.*?)(?:</output>|$)", text, flags=re.IGNORECASE | re.DOTALL)
    if output_match:
        text = output_match.group(1)
    text = re.sub(r"```(?:text|prompt)?", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)
    text = re.sub(r"</?(?:output|final_prompt)>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^(?:rewritten prompt|amplified prompt|prompt)\s*:\s*", "", text, flags=re.IGNORECASE)
    text = re.split(r"\n\s*\((?:note|reasoning|explanation)\s*:", text, maxsplit=1, flags=re.IGNORECASE)[0]
    text = re.split(
        r"\n\s*\n\s*(?=(?:the user (?:wants|asked|requested)|i (?:need|should|will|have to)|this (?:edit|revision|change)|the current prompt (?:has|contains)|to satisfy (?:the|this) request)\b)",
        text,
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0]
    text = re.split(r"<(?:\|channel\>|channel\|)", text, maxsplit=1, flags=re.IGNORECASE)[0]
    text = re.split(
        r"\n\s*(?:wait,|let's\s+try\b|note\s*:|rule\s+check\s*:|example\s*:|example\s+of\b|user\s+prompt\s*:|response\s*:|reasoning\s*:|target\s+profile\s*:|final\s+prompt\s*:)",
        text,
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0]
    return text.strip()


def _strip_apply_response(text):
    text = text.strip()
    text = re.sub(r"<\|channel\>thought\b.*?<channel\|>", "", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<\|channel\>analysis\b.*?<channel\|>", "", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<thinking>.*?</thinking>", "", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"^.*?</thinking>", "", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"^.*?</think>", "", text, flags=re.IGNORECASE | re.DOTALL)
    output_match = re.search(r"<output>(.*?)(?:</output>|$)", text, flags=re.IGNORECASE | re.DOTALL)
    if output_match:
        text = output_match.group(1)
    text = re.sub(r"</?output>", "", text, flags=re.IGNORECASE)
    text = re.split(r"<(?:\|channel\>|channel\|)", text, maxsplit=1, flags=re.IGNORECASE)[0]
    return text.strip()


def _reasoning_effort(thinking_mode):
    mode = str(thinking_mode or "Disabled").strip().lower()
    if mode == "disabled":
        return "none"
    if mode in {"minimal", "low", "medium", "high"}:
        return mode
    return "none"


def _profile_wrappers(profile):
    return (
        str(profile.get("final_prompt_prefix") or ""),
        str(profile.get("final_prompt_suffix") or ""),
    )


def _remove_profile_wrappers(text, profile):
    value = str(text or "")
    prefix, suffix = _profile_wrappers(profile)
    while prefix and value.startswith(prefix):
        value = value[len(prefix):]
    while suffix and value.endswith(suffix):
        value = value[:-len(suffix)]
    return value


def _remove_known_profile_wrappers(text, profiles=None):
    value = str(text or "")
    known_profiles = profiles if profiles is not None else _load_profiles()
    while True:
        previous = value
        for profile in known_profiles:
            value = _remove_profile_wrappers(value, profile)
        if value == previous:
            return value


def _apply_profile_wrappers(text, profile):
    prefix, suffix = _profile_wrappers(profile)
    return prefix + _remove_profile_wrappers(text, profile) + suffix


def _llm_node_change_token(sampler_seed):
    try:
        seed = int(sampler_seed)
    except (TypeError, ValueError):
        return float("nan")
    return float("nan") if seed < 0 else seed


def _thinking_instruction(thinking_mode):
    effort = _reasoning_effort(thinking_mode)
    focus = {
        "minimal": "Briefly check the central subject and requested output format.",
        "low": "Check the subject, setting, composition, and requested output format.",
        "medium": "Check the subject, setting, composition, concrete visible details, and active constraints.",
        "high": "Carefully verify every preserved detail, active style and framing constraint, forbidden addition, and output-format requirement.",
    }.get(effort, "")
    if not focus:
        return "Do not expose analysis, reasoning, scratchpad notes, or thinking tags in the final answer."
    return (
        f"Use the model's private reasoning channel before answering. {focus} "
        "Do not repeat or summarize that reasoning in the final answer."
    )


def _embellishment_instruction(embellishment_level, profile):
    level = str(embellishment_level or "Clean").strip().lower()
    style = str(profile.get("style") or "").lower()
    tag_mode = "tag" in style

    if tag_mode:
        instructions = {
            "none": "Convert only the user's stated content into the required tag syntax. Add no new visible details or incidental tags; include only terms strictly required by the active style or framing controls.",
            "minimal": "Keep the tag output very short. Only convert the user's prompt into essential tags. Do not add new details.",
            "clean": "Use a concise tag set with clear subject, action, setting, and important visible details. Add little or no new content.",
            "detailed": "Use a fuller tag set with useful visible details such as subject attributes, pose/action, setting, materials, and composition. Aim for roughly 8 to 14 relevant tags.",
            "rich": "Use a dense tag set with strong visual specificity, composition, materials, and style-relevant tags where appropriate. Aim for roughly 14 to 24 relevant tags. Do not add mood, lighting, quality, camera, medium, props, landmarks, extra subjects, abstract filler tags, or duplicate tags unless they match the selected style and are implied by the input.",
            "maximum": "Use a very dense tag set with extensive visible detail, environment, composition, materials, and style-appropriate tags while preserving the user's intent. Aim for roughly 18 to 30 relevant tags. Use concrete visual tags only; do not introduce a different style, new focal objects, abstract filler tags, or duplicate tags.",
            "ultra maximum": "Use a very dense tag set with extensive visible detail, environment, composition, materials, and style-appropriate tags while preserving the user's intent. Aim for roughly 24 to 40 relevant tags. Expand with attributes, textures, pose, expression, sub-details of existing subjects, and plausible non-focal setting details. Use concrete visual tags only; do not introduce a different style, new characters, new focal objects, abstract filler tags, or duplicate tags.",
        }
    else:
        instructions = {
            "none": "Preserve only the user's stated content. Add no new visible details; change wording only when required by the target profile, active style, or active framing controls.",
            "minimal": "Keep the rewrite short. Only convert style or format. Do not add new details.",
            "clean": "Lightly improve clarity and wording. Add little or no new detail.",
            "detailed": "Add useful visible details, composition, materials, and environment where appropriate. Write exactly two short descriptive sentences. Keep all added language consistent with the selected style.",
            "rich": "Use cohesive descriptive prose with stronger visual specificity and tasteful detail. Write a longer prompt with several concrete descriptive clauses. Keep atmosphere, lighting, quality, camera, and medium language consistent with the selected style. Do not add props, landmarks, extra subjects, or interactions with unmentioned entities unless explicitly present in the input.",
            "maximum": "Create a highly expanded prompt with extensive visible detail, composition, materials, environment, and style-appropriate descriptive language while still respecting the user's intent. Aim for a substantial prompt, usually 50 to 90 words unless the original is already long. Elaborate existing content; do not introduce a different style or new focal objects.",
            "ultra maximum": "Create a highly detailed, extensively expanded prompt with strong visible detail, composition, materials, environment, body language, expressions, and style-appropriate descriptive language while still respecting the user's intent. Aim for about 120 to 160 words unless the original is already long. Sentence count is irrelevant. Faithful adherence to the user's intent and all active content, style, and framing constraints is more important than reaching the word target. Expand with attributes, textures, pose, expression, sub-details of existing subjects, and plausible non-focal setting details. Do not introduce a different style, new characters, or new focal objects.",
        }
    return instructions.get(level, instructions["clean"])


def _revision_embellishment_instruction(embellishment_level, profile):
    level = str(embellishment_level or "Clean").strip().lower()
    style = str(profile.get("style") or "").lower()
    target = "tags" if "tag" in style else "wording"
    instructions = {
        "none": f"Change only the essential {target} required by the request. Add no extra detail and do not expand untouched content.",
        "minimal": f"Keep the edit minimal. Change only the essential {target} inside the requested edit scope and add no extra detail.",
        "clean": f"Make a clean coherent replacement inside the requested edit scope. Add little or no new {target}, and do not expand untouched content.",
        "detailed": f"Add useful visible {target} only to the requested object, attribute, or visual category. Do not add detail to protected parts of the prompt.",
        "rich": f"Use richer visual {target} inside the requested edit scope only. Unrelated subjects, objects, setting, composition, and technical details must not become more elaborate.",
        "maximum": f"Elaborate the requested edit scope extensively with concrete visual {target}, but preserve the amount and specificity of every unrelated part of the prompt.",
        "ultra maximum": f"Make the requested edit scope extremely detailed with concrete visual {target}. This does not permit expanding, restyling, or adding content anywhere outside that scope.",
    }
    return instructions.get(level, instructions["clean"])


def _revision_thinking_instruction(thinking_mode):
    effort = _reasoning_effort(thinking_mode)
    focus = {
        "minimal": "Briefly identify the edit scope and protected content.",
        "low": "Identify the target, conflicting old details, and protected content.",
        "medium": "Determine the smallest sufficient edit scope, every conflicting target reference, and all unrelated clauses or tags that must remain unchanged.",
        "high": "Carefully map the smallest sufficient edit scope, locate every obsolete or conflicting reference, preserve unrelated wording and tag order, and check for collateral changes.",
    }.get(effort, "")
    if not focus:
        return "Analyze the edit scope silently and do not expose reasoning or change notes in the final answer."
    return (
        f"Use the model's private reasoning channel before answering. {focus} "
        "Do not repeat or summarize that reasoning in the final answer."
    )


def _expansion_requirement(embellishment_level, profile, fragment=False):
    level = str(embellishment_level or "Clean").strip().lower()
    if level not in {"maximum", "ultra maximum"}:
        return []

    style = str(profile.get("style") or "").lower()
    tag_mode = "tag" in style
    target = "fragment" if fragment else "prompt"
    source = "fragment" if fragment else "user prompt"

    if tag_mode:
        if level == "ultra maximum":
            amount = "roughly 24 to 40 useful tags"
        else:
            amount = "roughly 18 to 30 useful tags"
        text = (
            f"The final {target} must be visibly denser than the {source}. If the {source} is short, "
            f"do not stop after the core subject tags; add {amount} covering existing subject attributes, "
            "pose/action, materials, colors, composition, and plausible supporting environment tags. Use concrete visual tags only."
        )
    else:
        if level == "ultra maximum":
            amount = "about 120 to 160 words"
            shape = "a cohesive, extensively detailed prompt using whatever sentence structure best preserves the user's intent"
        else:
            amount = "about 50 to 90 words"
            shape = "three to four short descriptive sentences, or one paragraph with at least four concrete descriptive clauses"
        text = (
            f"The final {target} must be visibly longer and more detailed than the {source}. If the {source} is short, "
            f"write {shape}, usually {amount}. Each sentence or clause should add concrete visible detail; do not merely clean up or restate the input. "
            "Preserving the user's intent and obeying all content, style, and framing constraints takes priority over reaching the target length."
        )

    return [
        "",
        "Expansion requirement:",
        text,
        "Allowed supporting details include natural attributes, textures, materials, colors, posture, expression, simple composition, and ordinary background details that fit the named setting.",
        "Do not add new main subjects, new characters, new focal objects, named landmarks, readable text, logos, brands, or new story events.",
    ]


def _expansion_rule_lines(embellishment_level, profile, fragment=False):
    level = str(embellishment_level or "Clean").strip().lower()
    if level not in {"detailed", "maximum", "ultra maximum"}:
        return []

    style = str(profile.get("style") or "").lower()
    tag_mode = "tag" in style
    target = "fragment" if fragment else "prompt"
    if tag_mode:
        if level == "detailed":
            return []
        if level == "ultra maximum":
            return [
                f"- For Ultra Maximum tag output, do not stop after the core tags; make the final {target} a dense expanded tag set.",
                "- Use concrete visual tags only; do not add abstract, meta, instruction, duplicate, or template-name tags.",
            ]
        return [
            f"- For Maximum tag output, make the final {target} clearly denser than the input.",
            "- Use concrete visual tags only; do not add abstract, meta, instruction, duplicate, or template-name tags.",
        ]

    if fragment:
        if level == "detailed":
            return [f"- For Detailed natural-language output, write exactly two short descriptive sentences in the final {target}."]
        if level == "ultra maximum":
            return [f"- For Ultra Maximum natural-language output, do not return a terse one-clause {target}; use several concrete descriptive clauses."]
        return [f"- For Maximum natural-language output, do not return a terse one-clause {target}; include multiple concrete descriptive clauses."]

    if level == "detailed":
        return [
            "- For Detailed natural-language output, write exactly two short descriptive sentences about the same scene.",
            "- Make each sentence add useful visible detail while preserving the user's intent and active constraints.",
        ]
    if level == "ultra maximum":
        return [
            "- Sentence count is irrelevant; use the structure that best preserves the user's intent and active constraints.",
            "- Aim for about 120 to 160 words, but never pad the prompt with unrelated content merely to reach the target.",
        ]
    return [
        "- For Maximum natural-language output, do not return a one-sentence prompt.",
        "- Write three to four short descriptive sentences about the same scene, and make each sentence add visible detail.",
    ]


def _word_count(text):
    return len(re.findall(r"\b[\w'-]+\b", str(text or "")))


def _sentence_count(text):
    return len([part for part in re.split(r"[.!?]+", str(text or "")) if part.strip()])


def _tag_count(text):
    return len([part for part in re.split(r"[,;\n]+", str(text or "")) if part.strip()])


def _density_count(text, profile):
    style = str(profile.get("style") or "").lower()
    if "tag" in style:
        return _tag_count(text)
    return _word_count(text)


def _needs_expansion_retry(original, rewritten, embellishment_level, profile):
    level = str(embellishment_level or "Clean").strip().lower()
    if level not in {"detailed", "maximum", "ultra maximum"}:
        return False
    if not str(original or "").strip():
        return False
    if not str(rewritten or "").strip():
        return True

    style = str(profile.get("style") or "").lower()
    if "tag" in style:
        if level == "detailed":
            return False
        original_tags = max(_tag_count(original), max(1, _word_count(original) // 2))
        rewritten_tags = _tag_count(rewritten)
        floor = 16 if level == "ultra maximum" else 10
        return rewritten_tags <= original_tags or rewritten_tags < floor

    if level == "detailed":
        return _sentence_count(rewritten) != 2

    original_words = _word_count(original)
    rewritten_words = _word_count(rewritten)
    floor = 120 if level == "ultra maximum" else 50
    if original_words < floor:
        return rewritten_words < floor
    return rewritten_words <= original_words


def _retry_seed(sampler_seed):
    seed = int(sampler_seed)
    if seed < 0:
        return seed
    return (seed + 1) % 1000000


def _build_expansion_retry_prompt(
    profile,
    style_template,
    style_modifier,
    framing_template,
    framing_modifier,
    embellishment_level,
    thinking_mode,
    original_text,
    rewritten_text,
    additional_instructions,
):
    prompt_parts = [
        "You are correcting an image-generation prompt because the previous rewrite did not meet the selected embellishment level's output target.",
        "Use the current rewritten prompt as the base, preserve the original user intent, and adjust its detail and structure only as needed.",
        "",
        f"Target profile: {profile.get('name', '')}",
        f"Target style: {profile.get('style', '')}",
        "",
        "Profile instruction:",
        str(profile.get("instruction", "")),
    ]

    notes = _profile_notes(profile)
    if notes:
        prompt_parts.extend(["", "Model profile notes:", notes])

    style_modifier = (style_modifier or "").strip()
    style_instruction = style_modifier or str(style_template.get("instruction") or "").strip()
    style_name = "Style modifier" if style_modifier else str(style_template.get("name") or "None")
    if style_instruction:
        prompt_parts.extend(
            [
                "",
                f"Active target style: {style_name}",
                style_instruction,
                "Keep all added detail inside this style.",
            ]
        )

    framing_modifier = (framing_modifier or "").strip()
    framing_instruction = framing_modifier or str(framing_template.get("instruction") or "").strip()
    framing_name = "Framing modifier" if framing_modifier else str(framing_template.get("name") or "None")
    if framing_instruction:
        prompt_parts.extend(
            [
                "",
                f"Active target framing: {framing_name}",
                framing_instruction,
                "Keep all added detail inside this framing.",
            ]
        )

    additional_instructions = (additional_instructions or "").strip()
    if additional_instructions:
        prompt_parts.extend(["", "Additional user instructions:", additional_instructions])

    if _reasoning_effort(thinking_mode) == "none":
        prompt_parts.extend(
            [
                "",
                "Reasoning policy:",
                _thinking_instruction(thinking_mode),
            ]
        )
    else:
        prompt_parts.extend(["", "Reasoning policy:", _thinking_instruction(thinking_mode)])

    prompt_parts.extend(
        [
            "",
            f"Embellishment level: {embellishment_level}",
            _embellishment_instruction(embellishment_level, profile),
            *_expansion_requirement(embellishment_level, profile),
            "",
            "Rules:",
            "- Preserve all subject matter, actions, setting, style, framing, and concrete visible details already present.",
            "- Expand by adding visible attributes, textures, materials, colors, pose, expression, composition, and ordinary supporting setting details.",
            "- Do not add new main subjects, extra characters, animals, vehicles, signs, symbols, readable text, logos, landmarks, brands, new focal props, loose decorative props, or new story events.",
            "- Use visible details only. Do not add sounds, smells, emotions, mood labels, or invisible sensory details unless the user asks for them.",
            "- Follow any explicit, NSFW and similar content orders if asked for.",
            *_expansion_rule_lines(embellishment_level, profile),
            "- Do not explain your changes.",
            "- Do not include markdown.",
            f"- Start the final answer with exactly '{FINAL_PROMPT_MARKER}' followed by the expanded prompt.",
            f"- Stop immediately after the expanded prompt. Do not add notes, rule checks, examples, or another user prompt.",
            "",
            "Original user prompt:",
            str(original_text or "").strip(),
            "",
            "Current rewritten prompt:",
            str(rewritten_text or "").strip(),
        ]
    )
    return "\n".join(prompt_parts)


def _append_framing_context(prompt_parts, framing_template, framing_modifier):
    active_framing_name = ""
    active_framing_instruction = ""
    framing_modifier = (framing_modifier or "").strip()
    if framing_modifier:
        active_framing_name = "Framing modifier"
        active_framing_instruction = framing_modifier
        prompt_parts.extend(
            [
                "",
                "Framing modifier:",
                framing_modifier,
                "Apply this as the target framing, composition, viewpoint, shot type, and subject placement for the rewritten prompt.",
            ]
        )
    else:
        framing_instruction = str(framing_template.get("instruction") or "").strip()
        if framing_instruction:
            active_framing_name = str(framing_template.get("name") or "Framing template")
            active_framing_instruction = framing_instruction
            prompt_parts.extend(
                [
                    "",
                    f"Framing template: {framing_template.get('name', '')}",
                    framing_instruction,
                    "Apply this as the target framing, composition, viewpoint, shot type, and subject placement for the rewritten prompt.",
                ]
            )
    return active_framing_name, active_framing_instruction


def _build_instruction_prompt(profile, style_template, style_modifier, framing_template, framing_modifier, embellishment_level, thinking_mode, text, additional_instructions):
    prompt_parts = [
        "You rewrite prompts for image generation.",
        "",
        f"Target profile: {profile.get('name', '')}",
        f"Target style: {profile.get('style', '')}",
        "",
        *_format_profile_examples(profile),
        "Use these examples only for syntax, wording, ordering, separators, and prompt grammar. Do not copy their length or amount of detail.",
        "Borrow the examples' structure, not their subject matter. Never answer by copying or lightly editing an example.",
        "",
        "Instruction:",
        str(profile.get("instruction", "")),
    ]

    notes = _profile_notes(profile)
    if notes:
        prompt_parts.extend(
            [
                "",
                "Model profile notes:",
                notes,
            ]
        )

    active_style_name = ""
    active_style_instruction = ""
    style_modifier = (style_modifier or "").strip()
    if style_modifier:
        active_style_name = "Style modifier"
        active_style_instruction = style_modifier
        prompt_parts.extend(
            [
                "",
                "Style modifier:",
                style_modifier,
                "Apply this as the target style for the entire rewritten prompt. If the user's prompt contains conflicting style, medium, quality, camera, or rendering terms, replace them with this style while preserving the subject and concrete content.",
            ]
        )
    else:
        style_instruction = str(style_template.get("instruction") or "").strip()
        if style_instruction:
            active_style_name = str(style_template.get("name") or "Style template")
            active_style_instruction = style_instruction
            prompt_parts.extend(
                [
                "",
                f"Style template: {style_template.get('name', '')}",
                style_instruction,
                "Apply this as the target style for the entire rewritten prompt. If the user's prompt contains conflicting style, medium, quality, camera, or rendering terms, replace them with this style while preserving the subject and concrete content.",
            ]
        )

    active_framing_name, active_framing_instruction = _append_framing_context(
        prompt_parts,
        framing_template,
        framing_modifier,
    )

    if _reasoning_effort(thinking_mode) == "none":
        prompt_parts.extend(
            [
                "",
                "Reasoning policy:",
                _thinking_instruction(thinking_mode),
            ]
        )
    else:
        prompt_parts.extend(
            [
                "",
                "Reasoning policy:",
                _thinking_instruction(thinking_mode),
            ]
        )

    prompt_parts.extend(
        [
            "",
            f"Embellishment level: {embellishment_level}",
            _embellishment_instruction(embellishment_level, profile),
        ]
    )
    prompt_parts.extend(_expansion_requirement(embellishment_level, profile))
    if active_style_instruction:
        prompt_parts.extend(
            [
                "",
                "Style priority reminder:",
                f"The active target style is {active_style_name}. Embellishment may add detail only inside this style and must not add conflicting mood, quality, medium, camera, lighting, or genre language.",
                f"Active style instruction: {active_style_instruction}",
            ]
        )
    if active_framing_instruction:
        prompt_parts.extend(
            [
                "",
                "Framing priority reminder:",
                f"The active target framing is {active_framing_name}. Style and embellishment may add visual treatment and detail only inside this framing/composition.",
                f"Active framing instruction: {active_framing_instruction}",
            ]
        )

    additional_instructions = (additional_instructions or "").strip()
    if additional_instructions:
        prompt_parts.extend(
            [
                "",
                "Additional user instructions:",
                additional_instructions,
            ]
        )

    prompt_parts.extend(
        [
            "",
            "Rules:",
            "- Preserve the user's intent.",
            "- Preserve subject matter, actions, setting, and concrete visible details.",
            "- Keep one coherent scene. Do not add unrelated objects, extra characters, background landmarks, text, logos, symbols, or conflicting details unless the user prompt implies them.",
            "- You may add ordinary supporting details that naturally belong to the named setting, such as surfaces, materials, broad background features, and small non-focal environment details.",
            "- Allowed additions: adjectives, texture, material, pose, expression, color, broad lighting if style allows it, simple composition, and generic environment qualities.",
            "- Forbidden additions: new main subjects, extra characters, animals, vehicles, buildings, signs, symbols, readable text, logos, landmarks, brands, new focal props, loose decorative props, or new interactions.",
            "- Use visible details only. Do not add sounds, smells, emotions, mood labels, or invisible sensory details unless the user asks for them.",
            "- Do not introduce new focal concrete nouns that are absent from the user prompt, except generic style/framing words needed by the selected settings.",
            "- Example: if the user prompt says 'a happy robot in a park', do not add bouquets, passersby, balloons, city buildings, signs, decorative flowers, or other new focal objects.",
            "- When adding detail, elaborate existing subjects, materials, pose, expression, and setting instead of inventing new scene concepts.",
            "- The selected style preset or style modifier overrides conflicting style words in the user prompt.",
            "- The selected framing preset or framing modifier overrides conflicting framing, composition, viewpoint, shot type, and camera angle words in the user prompt.",
            "- The embellishment level controls amount of detail only; it must not override or change the selected style.",
            "- The embellishment level must not override or change the selected framing.",
            "- Follow the syntax, wording pattern, ordering, separators, and prompt grammar shown in the model profile examples whenever the user's prompt provides enough information.",
            "- Do not copy subjects, objects, settings, or details from the examples unless they are also present in the user's prompt.",
            "- Never use a model profile example as the final prompt; examples are format references only.",
            *_expansion_rule_lines(embellishment_level, profile),
            "- Do not explain your changes.",
            "- Do not include markdown.",
            f"- Start the final answer with exactly '{FINAL_PROMPT_MARKER}' followed by the rewritten prompt.",
            f"- Do not put reasoning, notes, explanations, or parenthetical comments after '{FINAL_PROMPT_MARKER}'.",
            f"- Stop immediately after the rewritten prompt. Do not add notes, rule checks, examples, or another user prompt.",
            "",
            "User prompt:",
            text,
        ]
    )
    return "\n".join(prompt_parts)


def _build_revision_prompt(
    profile,
    style_template,
    style_modifier,
    framing_template,
    framing_modifier,
    embellishment_level,
    thinking_mode,
    current_prompt,
    revision,
):
    """Build a stateless edit request for Prompt Studio."""
    prompt_parts = [
        "You are a precision image-prompt editor.",
        "Return the complete current prompt after applying the user's requested revision, but perform the smallest coherent edit that fully satisfies the request.",
        "First infer the edit scope: the specific object, attribute, relationship, action, or visual category named or implied by the revision.",
        "Everything outside that scope is protected content and must remain semantically unchanged and as close to the original wording and order as the target prompt syntax permits.",
        "The requested revision has priority over conflicting details in the current prompt.",
        "Within the edit scope, a changed attribute replaces every previous conflicting value; it is never appended as an alternative or a second object.",
        "Return one coherent complete replacement prompt, never a patch or list of changes.",
        "",
        f"Target profile: {profile.get('name', '')}",
        f"Target style: {profile.get('style', '')}",
        "",
        *_format_profile_examples(profile),
        "Use the examples for syntax and prompt grammar, not for subject matter.",
        "",
        "Profile instruction:",
        str(profile.get("instruction") or DEFAULT_PROFILE["instruction"]),
    ]

    notes = _profile_notes(profile)
    if notes:
        prompt_parts.extend(["", "Model profile notes:", notes])

    style_modifier = (style_modifier or "").strip()
    style_instruction = style_modifier or str(style_template.get("instruction") or "").strip()
    style_name = "Style modifier" if style_modifier else str(style_template.get("name") or "None")
    if style_instruction:
        prompt_parts.extend(
            [
                "",
                f"Active target style: {style_name}",
                style_instruction,
                "Keep the replacement prompt inside this style unless the requested revision explicitly changes the style.",
                "For a targeted edit, use this style only to shape details inside the edit scope. Do not restyle protected content.",
            ]
        )

    framing_modifier = (framing_modifier or "").strip()
    framing_instruction = framing_modifier or str(framing_template.get("instruction") or "").strip()
    framing_name = "Framing modifier" if framing_modifier else str(framing_template.get("name") or "None")
    if framing_instruction:
        prompt_parts.extend(
            [
                "",
                f"Active target framing: {framing_name}",
                framing_instruction,
                "Keep the replacement prompt inside this framing unless the requested revision explicitly changes the framing.",
                "For a targeted edit, preserve the existing framing and composition unless they are inside the requested edit scope.",
            ]
        )

    prompt_parts.extend(
        [
            "",
            f"Embellishment level: {embellishment_level}",
            _revision_embellishment_instruction(embellishment_level, profile),
            "The embellishment level controls detail only inside the edit scope. It never expands the scope of the user's request.",
        ]
    )

    if _reasoning_effort(thinking_mode) == "none":
        prompt_parts.extend(
            [
                "",
                "Reasoning policy:",
                _revision_thinking_instruction(thinking_mode),
            ]
        )
    else:
        prompt_parts.extend(["", "Reasoning policy:", _revision_thinking_instruction(thinking_mode)])

    prompt_parts.extend(
        [
            "",
            "Precision revision procedure:",
            "1. Identify the smallest sufficient edit scope from the requested revision. A broad request may have a broad scope; a narrow request must remain narrow.",
            "2. Find every phrase, clause, or tag in the current prompt that describes that target, including indirect or repeated references.",
            "3. Remove or replace obsolete and conflicting target details before inserting the requested value. Produce one coherent description of the target.",
            "4. Copy protected clauses and tags unchanged where possible. Make only minimal grammar or connective edits needed to keep the complete prompt readable.",
            "5. Compare the result with the current prompt and undo any change that is not required by the edit scope, target syntax, or an explicitly requested active-control update.",
            "",
            "Revision rules:",
            "- Apply the requested revision even when it contradicts the current prompt.",
            "- Preserve subjects, identity, actions, setting, background, composition, pose, expression, wardrobe, lighting, camera, style, and visible details unless the revision places that category inside the edit scope.",
            "- Treat the profile, active style, active framing, and embellishment level as constraints on the edit, not as permission to revise unrelated content. Reapply them globally only when the revision explicitly requests an active-control update.",
            "- In tag output, retain unaffected tags verbatim and in the same order whenever possible. In natural-language output, retain unaffected clauses verbatim whenever possible.",
            "- Treat remove, replace, reduce, simplify, and change requests as explicit permission to alter those details.",
            "- When an attribute changes, find and replace every conflicting reference to the old value throughout the prompt.",
            "- Never keep both the old and new values for the same attribute, object, garment, person, action, pose, expression, location, lighting, or composition.",
            "- Do not satisfy a replacement by appending a new object. Preserve the existing object type unless the user asks to replace the object itself.",
            "- Clothing example: 'make her clothes blue' means locate all of her existing garment descriptions, remove conflicting clothing colors, make those same garments blue, and leave her body, face, pose, scene, lighting, and camera unchanged. Do not add a separate blue shirt.",
            "- Lighting example: 'use warm sunset lighting' means replace only illumination, color-temperature, exposure, highlight, and shadow details that conflict. Do not change the subjects, wardrobe, actions, setting objects, background layout, framing, or camera unless explicitly requested.",
            "- Background example: 'make the background more varied' may enrich background content according to the embellishment level, but must not change the foreground subject, wardrobe, pose, expression, lighting, framing, or camera.",
            "- The examples demonstrate edit boundaries only; never copy their subject matter or requested values into the response.",
            "- Resolve short contextual requests such as 'make it warmer' using the current prompt.",
            "- Before responding, silently check for contradictions, duplicated alternatives, obsolete target details, and any collateral change outside the edit scope.",
            "- Do not mention the editing process or describe what changed.",
            "- Do not include markdown.",
            f"- Start the final answer with exactly '{FINAL_PROMPT_MARKER}' followed by the complete replacement prompt.",
            f"- Do not put anything after the replacement prompt following '{FINAL_PROMPT_MARKER}'.",
            "",
            "Current prompt:",
            str(current_prompt or "").strip(),
            "",
            "Requested revision:",
            str(revision or "").strip(),
        ]
    )
    return "\n".join(prompt_parts)


def _build_main_revision_prompt(current_main_prompt, current_final_prompt, revision, thinking_mode):
    """Build a model-neutral edit request for Prompt Studio's stored user intent."""
    prompt_parts = [
        "You are editing the model-neutral main prompt behind an image-generation prompt.",
        "Return the complete updated main prompt after applying the user's requested revision.",
        "The main prompt stores only user-requested subject matter, actions, setting, attributes, and other durable intent.",
        "It must not absorb decorative, stylistic, framing, camera, lighting, quality, or incidental details that exist only in the rendered final prompt.",
        "Use the rendered final prompt only to resolve what the user is referring to; do not copy its automatic details into the main prompt.",
        "Perform the smallest coherent edit that satisfies the request and preserve everything else as closely as possible.",
        "Return one complete main prompt, never a patch or a list of changes.",
        "",
        "Main-prompt rules:",
        "- Add or replace positive content when the user explicitly requests that content.",
        "- A requested attribute replacement must remove the old conflicting value from the main prompt.",
        "- If the user removes, deletes, reduces, or omits something that exists only in the rendered final prompt and not in the main prompt, leave the main prompt unchanged.",
        "- Never translate a removal into negative wording such as 'without', 'no', 'not', 'exclude', or 'avoid'.",
        "- Never add a removed auto-generated detail to the main prompt merely to record its removal.",
        "- Do not add prompt weights, model-specific syntax, quality tags, or automatic embellishment.",
        "- Do not mention the editing process or explain what changed.",
        "- Do not include markdown.",
        f"- Start the final answer with exactly '{FINAL_PROMPT_MARKER}' followed by the updated main prompt.",
        f"- Do not put anything after the updated main prompt following '{FINAL_PROMPT_MARKER}'.",
    ]
    if _reasoning_effort(thinking_mode) != "none":
        prompt_parts.extend(
            [
                "",
                "Reasoning policy:",
                _revision_thinking_instruction(thinking_mode),
            ]
        )
    prompt_parts.extend(
        [
            "",
            "Current main prompt:",
            str(current_main_prompt or "").strip(),
            "",
            "Current rendered final prompt (reference only):",
            str(current_final_prompt or "").strip(),
            "",
            "Requested revision:",
            str(revision or "").strip(),
        ]
    )
    return "\n".join(prompt_parts)


def _build_fragment_rewrite_prompt(profile, style_template, style_modifier, framing_template, framing_modifier, embellishment_level, thinking_mode, text, additional_instructions):
    prompt_parts = [
        "You rewrite prompt fragments for an image generation model.",
        "",
        f"Target profile: {profile.get('name', '')}",
        f"Target style: {profile.get('style', '')}",
        "",
        *_format_profile_examples(profile),
        "Use these examples only for syntax, wording, ordering, separators, and prompt grammar. Do not copy their length or amount of detail.",
        "Borrow the examples' structure, not their subject matter. Never answer by copying or lightly editing an example.",
        "",
        "Instruction:",
        str(profile.get("instruction", "")),
    ]

    notes = _profile_notes(profile)
    if notes:
        prompt_parts.extend(
            [
                "",
                "Model profile notes:",
                notes,
            ]
        )

    active_style_name = ""
    active_style_instruction = ""
    style_modifier = (style_modifier or "").strip()
    if style_modifier:
        active_style_name = "Style modifier"
        active_style_instruction = style_modifier
        prompt_parts.extend(
            [
                "",
                "Style modifier:",
                style_modifier,
                "Apply this as the target style for this rewritten fragment. If the fragment contains conflicting style, medium, quality, camera, or rendering terms, replace them with this style while preserving the subject and concrete content.",
            ]
        )
    else:
        style_instruction = str(style_template.get("instruction") or "").strip()
        if style_instruction:
            active_style_name = str(style_template.get("name") or "Style template")
            active_style_instruction = style_instruction
            prompt_parts.extend(
                [
                    "",
                    f"Style template: {style_template.get('name', '')}",
                    style_instruction,
                    "Apply this as the target style for this rewritten fragment. If the fragment contains conflicting style, medium, quality, camera, or rendering terms, replace them with this style while preserving the subject and concrete content.",
                ]
            )

    active_framing_name, active_framing_instruction = _append_framing_context(
        prompt_parts,
        framing_template,
        framing_modifier,
    )

    if _reasoning_effort(thinking_mode) == "none":
        prompt_parts.extend(
            [
                "",
                "Reasoning policy:",
                _thinking_instruction(thinking_mode),
            ]
        )
    else:
        prompt_parts.extend(
            [
                "",
                "Reasoning policy:",
                _thinking_instruction(thinking_mode),
            ]
        )

    prompt_parts.extend(
        [
            "",
            f"Embellishment level: {embellishment_level}",
            _embellishment_instruction(embellishment_level, profile),
        ]
    )
    prompt_parts.extend(_expansion_requirement(embellishment_level, profile, fragment=True))
    if active_style_instruction:
        prompt_parts.extend(
            [
                "",
                "Style priority reminder:",
                f"The active target style is {active_style_name}. Embellishment may add detail only inside this style and must not add conflicting mood, quality, medium, camera, lighting, or genre language.",
                f"Active style instruction: {active_style_instruction}",
            ]
        )
    if active_framing_instruction:
        prompt_parts.extend(
            [
                "",
                "Framing priority reminder:",
                f"The active target framing is {active_framing_name}. Style and embellishment may add visual treatment and detail only inside this framing/composition.",
                f"Active framing instruction: {active_framing_instruction}",
            ]
        )

    additional_instructions = (additional_instructions or "").strip()
    if additional_instructions:
        prompt_parts.extend(
            [
                "",
                "Additional user instructions:",
                additional_instructions,
            ]
        )

    prompt_parts.extend(
        [
            "",
            "Rules:",
            "- Rewrite only the provided prompt fragment.",
            "- Preserve the fragment's subject matter, actions, setting, and concrete visible details.",
            "- Do not add information from any other prompt fragment.",
            "- Keep the fragment coherent. Do not add unrelated objects, extra characters, background landmarks, text, logos, symbols, or conflicting details unless the fragment implies them.",
            "- You may add ordinary supporting details that naturally belong to the named setting, such as surfaces, materials, broad background features, and small non-focal environment details.",
            "- Allowed additions: adjectives, texture, material, pose, expression, color, broad lighting if style allows it, simple composition, and generic environment qualities.",
            "- Forbidden additions: new main subjects, extra characters, animals, vehicles, buildings, signs, symbols, readable text, logos, landmarks, brands, new focal props, loose decorative props, or new interactions.",
            "- Use visible details only. Do not add sounds, smells, emotions, mood labels, or invisible sensory details unless the fragment asks for them.",
            "- Do not introduce new focal concrete nouns that are absent from the fragment, except generic style/framing words needed by the selected settings.",
            "- Example: if the fragment says 'a happy robot in a park', do not add bouquets, passersby, balloons, city buildings, signs, decorative flowers, or other new focal objects.",
            "- When adding detail, elaborate existing subjects, materials, pose, expression, and setting instead of inventing new scene concepts.",
            "- The selected style preset or style modifier overrides conflicting style words in the fragment.",
            "- The selected framing preset or framing modifier overrides conflicting framing, composition, viewpoint, shot type, and camera angle words in the fragment.",
            "- The embellishment level controls amount of detail only; it must not override or change the selected style.",
            "- The embellishment level must not override or change the selected framing.",
            "- Follow the syntax, wording pattern, ordering, separators, and prompt grammar shown in the model profile examples whenever the fragment provides enough information.",
            "- Do not copy subjects, objects, settings, or details from the examples unless they are also present in the fragment.",
            "- Never use a model profile example as the final fragment; examples are format references only.",
            *_expansion_rule_lines(embellishment_level, profile, fragment=True),
            "- Do not explain your changes.",
            "- Do not include markdown.",
            f"- Start the final answer with exactly '{FINAL_PROMPT_MARKER}' followed by the rewritten fragment.",
            f"- Do not put reasoning, notes, explanations, or parenthetical comments after '{FINAL_PROMPT_MARKER}'.",
            f"- Stop immediately after the rewritten fragment. Do not add notes, rule checks, examples, or another user prompt.",
            "",
            "Prompt fragment:",
            text,
        ]
    )
    return "\n".join(prompt_parts)


class KCPP_PromptAmplify:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "multiline": True}),
                "additional_instructions": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "Optional extra guidance for this run without editing model_profiles.json.",
                    },
                ),
                "model_profile": (_profile_names(),),
                "style_preset": (_style_template_names(),),
                "style_modifier": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "Optional aesthetic/style guidance for this run without editing preset files.",
                    },
                ),
                "framing_preset": (_framing_template_names(),),
                "framing_modifier": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "Optional framing/composition guidance. Overrides the selected framing preset when non-empty.",
                    },
                ),
                "thinking_mode": (
                    ["Disabled", "Minimal", "Low", "Medium", "High"],
                    {
                        "default": "Disabled",
                        "tooltip": "Private-reasoning limits: Minimal 200 tokens, Low 500, Medium 1000, and High uses the available context window.",
                    },
                ),
                "embellishment_level": (
                    ["None", "Minimal", "Clean", "Detailed", "Rich", "Maximum", "Ultra Maximum"],
                    {
                        "default": "Clean",
                        "tooltip": "Controls how much the prompt is expanded or polished after style conversion.",
                    },
                ),
                **_common_kcpp_inputs(),
            },
            "optional": {
                "secondary_instructions": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "Optional text returned unchanged from the secondary_instructions output.",
                    },
                ),
                **_resolution_inputs(),
            },
            "hidden": _resolution_override_inputs(),
        }

    RETURN_TYPES = ("STRING", "STRING", "INT", "INT")
    RETURN_NAMES = ("amplified_text", "secondary_instructions", "width", "height")
    FUNCTION = "amplify"
    CATEGORY = "KoboldCpp"

    @classmethod
    def IS_CHANGED(cls, sampler_seed=-1, **kwargs):
        return _llm_node_change_token(sampler_seed)

    def amplify(
        self,
        text,
        additional_instructions,
        model_profile,
        style_preset,
        style_modifier,
        framing_preset,
        framing_modifier,
        thinking_mode,
        embellishment_level,
        kobold_url,
        max_response_tokens,
        temperature,
        top_p,
        top_k,
        min_p,
        rep_pen,
        rep_pen_range,
        sampler_seed,
        secondary_instructions="",
        stop_sequence="",
        request_timeout=120,
        aspect_ratio="1:1 (Square)",
        megapixels=1.0,
        multiple=8,
        resolution_width=0,
        resolution_height=0,
    ):
        profile = _get_profile(model_profile)
        style_template = _get_style_template(style_preset)
        framing_template = _get_framing_template(framing_preset)
        default_max_response_tokens = int(profile.get("default_max_response_tokens") or DEFAULT_PROFILE["default_max_response_tokens"])
        amplified = _generate_kcpp(
            _build_instruction_prompt(
                profile,
                style_template,
                style_modifier,
                framing_template,
                framing_modifier,
                embellishment_level,
                thinking_mode,
                text,
                additional_instructions,
            ),
            kobold_url,
            max_response_tokens,
            default_max_response_tokens,
            temperature,
            top_p,
            top_k,
            min_p,
            rep_pen,
            rep_pen_range,
            sampler_seed,
            thinking_mode,
            stop_sequence,
            request_timeout,
            include_default_continuation_stops=True,
        )

        amplified = _strip_response(amplified)
        if _needs_expansion_retry(text, amplified, embellishment_level, profile):
            retry = _generate_kcpp(
                _build_expansion_retry_prompt(
                    profile,
                    style_template,
                    style_modifier,
                    framing_template,
                    framing_modifier,
                    embellishment_level,
                    thinking_mode,
                    text,
                    amplified,
                    additional_instructions,
                ),
                kobold_url,
                max_response_tokens,
                default_max_response_tokens,
                temperature,
                top_p,
                top_k,
                min_p,
                rep_pen,
                rep_pen_range,
                _retry_seed(sampler_seed),
                thinking_mode,
                stop_sequence,
                request_timeout,
                include_default_continuation_stops=True,
            )
            retry = _strip_response(retry)
            if retry and _density_count(retry, profile) > _density_count(amplified, profile):
                amplified = retry

        if not amplified:
            raise RuntimeError("KoboldCpp returned an empty prompt")
        width, height = _resolve_prompt_resolution(
            aspect_ratio,
            megapixels,
            multiple,
            resolution_width,
            resolution_height,
        )
        return (_apply_profile_wrappers(amplified, profile), secondary_instructions, width, height)


class KCPP_PromptSlot:
    """Stable workflow attachment point for the Prompt Studio frontend."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": ("STRING", {"default": "", "multiline": True}),
                "slot_name": (
                    "STRING",
                    {
                        "default": "Positive Prompt",
                        "multiline": False,
                        "tooltip": "Name shown in Prompt Studio when the workflow has multiple prompt slots.",
                    },
                ),
            },
            "optional": {
                "secondary_instructions": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "Optional text passed unchanged to the secondary_instructions output.",
                    },
                ),
            },
            "hidden": {**_resolution_inputs(), **_resolution_override_inputs()},
        }

    RETURN_TYPES = ("STRING", "STRING", "INT", "INT")
    RETURN_NAMES = ("prompt", "secondary_instructions", "width", "height")
    FUNCTION = "get_prompt"
    CATEGORY = "KoboldCpp"

    def get_prompt(
        self,
        prompt,
        slot_name="Positive Prompt",
        secondary_instructions="",
        aspect_ratio="1:1 (Square)",
        megapixels=1.0,
        multiple=8,
        resolution_width=0,
        resolution_height=0,
    ):
        width, height = _resolve_prompt_resolution(
            aspect_ratio,
            megapixels,
            multiple,
            resolution_width,
            resolution_height,
        )
        return (prompt, secondary_instructions, width, height)


def _parse_chat_image_reference(image_ref):
    try:
        reference = json.loads(str(image_ref or ""))
    except json.JSONDecodeError as exc:
        raise ValueError("Image reference must be valid Prompt Studio JSON") from exc
    if not isinstance(reference, dict):
        raise ValueError("Image reference must be a JSON object")

    storage_type = str(reference.get("type") or "output").strip().lower()
    roots = {
        "input": folder_paths.get_input_directory,
        "output": folder_paths.get_output_directory,
        "temp": folder_paths.get_temp_directory,
        "promptstudio": _prompt_studio_image_directory,
    }
    if storage_type not in roots:
        raise ValueError("Image reference type must be input, output, temp, or promptstudio")

    filename = str(reference.get("filename") or "").strip()
    subfolder = str(reference.get("subfolder") or "").strip()
    if not filename:
        raise ValueError("Image reference filename is required")
    if os.path.basename(filename) != filename or os.path.isabs(filename):
        raise ValueError("Image reference filename must not contain a path")
    if os.path.isabs(subfolder):
        raise ValueError("Image reference subfolder must be relative")

    root = os.path.realpath(roots[storage_type]())
    relative_path = os.path.normpath(os.path.join(subfolder, filename))
    if relative_path == os.pardir or relative_path.startswith(os.pardir + os.sep):
        raise ValueError("Image reference cannot leave its configured storage directory")
    path = os.path.realpath(os.path.join(root, relative_path))
    try:
        inside_root = os.path.commonpath((root, path)) == root
    except ValueError:
        inside_root = False
    if not inside_root:
        raise ValueError("Image reference cannot leave its configured storage directory")
    if not os.path.isfile(path):
        raise ValueError(f"Referenced image does not exist: {relative_path}")
    return reference, path


def _prompt_studio_image_directory():
    get_user_directory = getattr(folder_paths, "get_user_directory", None)
    if not callable(get_user_directory):
        raise RuntimeError("This ComfyUI version does not expose a user-data directory")
    return os.path.realpath(os.path.join(get_user_directory(), PROMPT_STUDIO_IMAGE_SUBDIRECTORY))


def _sanitize_prompt_studio_image(image_bytes):
    if not isinstance(image_bytes, (bytes, bytearray, memoryview)) or not image_bytes:
        raise ValueError("The dropped image is empty")

    try:
        with Image.open(io.BytesIO(bytes(image_bytes))) as source:
            source.seek(0)
            if source.width <= 0 or source.height <= 0:
                raise ValueError("The dropped image has invalid dimensions")
            if source.width * source.height > VISION_IMAGE_MAX_PIXELS:
                raise ValueError("The dropped image exceeds the 64-megapixel safety limit")
            has_alpha = (
                source.mode in {"RGBA", "LA"}
                or (source.mode == "P" and "transparency" in source.info)
            )
            image = ImageOps.exif_transpose(source)
            image.load()
            image = image.convert("RGBA" if has_alpha else "RGB")
            image.info.clear()
    except (Image.DecompressionBombError, UnidentifiedImageError) as exc:
        raise ValueError("The dropped file is not a safe, supported raster image") from exc

    image.thumbnail((VISION_IMAGE_MAX_EDGE, VISION_IMAGE_MAX_EDGE), Image.Resampling.LANCZOS)
    output_directory = _prompt_studio_image_directory()
    os.makedirs(output_directory, exist_ok=True)
    filename = f"{secrets.token_hex(16)}.webp"
    destination = os.path.join(output_directory, filename)
    temporary = destination + ".tmp"
    try:
        image.save(
            temporary,
            format="WEBP",
            lossless=False,
            quality=80,
            method=4,
            exact=False,
        )
        os.replace(temporary, destination)
    except Exception:
        try:
            os.remove(temporary)
        except FileNotFoundError:
            pass
        raise
    return {
        "filename": filename,
        "subfolder": "",
        "type": "promptstudio",
        "width": image.width,
        "height": image.height,
    }


def _chat_image_vision_payload(image_ref):
    _reference, path = _parse_chat_image_reference(image_ref)
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source)
        if image.width <= 0 or image.height <= 0:
            raise ValueError("The dropped image has invalid dimensions")
        if image.width * image.height > VISION_IMAGE_MAX_PIXELS:
            raise ValueError("The dropped image exceeds the 64-megapixel vision limit")
        image = image.copy()

    image.thumbnail((VISION_IMAGE_MAX_EDGE, VISION_IMAGE_MAX_EDGE), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    if "A" in image.getbands():
        image.save(buffer, format="PNG", optimize=True)
        media_type = "image/png"
    else:
        if image.mode != "RGB":
            image = image.convert("RGB")
        image.save(buffer, format="JPEG", quality=92, optimize=True)
        media_type = "image/jpeg"
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return encoded, f"data:{media_type};base64,{encoded}"


def _chat_image_dimensions(image_ref):
    _, path = _parse_chat_image_reference(image_ref)
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source)
        return image.width, image.height


class Save_as_webp_cond:
    def __init__(self):
        self.output_dir = folder_paths.get_output_directory()
        self.type = "output"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "filename_prefix": ("STRING", {"default": "ComfyUI"}),
                "mode": (["lossy", "lossless"],),
                "compression": ("INT", {"default": 80, "min": 1, "max": 100, "step": 1}),
                "save": (["yes", "no"],),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "Save_as_webp_cond"
    OUTPUT_NODE = True
    CATEGORY = "image"

    def Save_as_webp_cond(
        self,
        mode,
        compression,
        images,
        save,
        filename_prefix="ComfyUI",
        prompt=None,
        extra_pnginfo=None,
    ):
        def map_filename(filename):
            prefix_len = len(os.path.basename(filename_prefix))
            prefix = filename[:prefix_len + 1]
            try:
                digits = int(filename[prefix_len + 1:].split("_")[0])
            except (TypeError, ValueError):
                digits = 0
            return digits, prefix

        filename_prefix = filename_prefix.replace("%width%", str(images[0].shape[1]))
        filename_prefix = filename_prefix.replace("%height%", str(images[0].shape[0]))
        should_save = save == "yes"

        subfolder = os.path.dirname(os.path.normpath(filename_prefix))
        filename = os.path.basename(os.path.normpath(filename_prefix))
        preview_subfolder = os.path.join(subfolder, str(date.today())) if should_save else ""
        output_dir = self.output_dir if should_save else folder_paths.get_temp_directory()
        output_type = self.type if should_save else "temp"
        full_output_folder = os.path.join(output_dir, preview_subfolder)
        os.makedirs(full_output_folder, exist_ok=True)

        try:
            counter = max(
                filter(
                    lambda item: item[1][:-1] == filename and item[1][-1] == "_",
                    map(map_filename, os.listdir(full_output_folder)),
                )
            )[0] + 1
        except ValueError:
            counter = 1

        results = []
        lossless = mode == "lossless"
        for image in images:
            image_array = 255.0 * image.cpu().numpy()
            pil_image = Image.fromarray(np.clip(image_array, 0, 255).astype(np.uint8))
            image_exif = pil_image.getexif()

            if prompt is not None:
                image_exif[0x010F] = "Prompt:" + json.dumps(prompt)

            workflow_metadata = ""
            if extra_pnginfo is not None:
                for key in extra_pnginfo:
                    workflow_metadata += json.dumps(extra_pnginfo[key])
            image_exif[0x010E] = "Workflow:" + workflow_metadata

            output_filename = f"{filename}_{counter:05}_.webp"
            pil_image.save(
                os.path.join(full_output_folder, output_filename),
                method=6,
                exif=image_exif,
                lossless=lossless,
                quality=compression,
            )
            results.append(
                {
                    "filename": output_filename,
                    "subfolder": preview_subfolder,
                    "type": output_type,
                }
            )
            counter += 1

        return {"ui": {"images": results}, "result": (images,)}


class KCPP_ChatImageInput:
    """Load a generated or imported Prompt Studio chat image."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_ref": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "Injected by Prompt Studio. References an existing generated image or sanitized Prompt Studio import without copying it.",
                    },
                ),
                "source_name": (
                    "STRING",
                    {
                        "default": "Edit Source",
                        "multiline": False,
                        "tooltip": "Name shown when an editing workflow has multiple image inputs.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "load_image"
    CATEGORY = "KoboldCpp"

    def load_image(self, image_ref, source_name="Edit Source"):
        _, path = _parse_chat_image_reference(image_ref)
        output_images = []
        output_masks = []
        with Image.open(path) as source:
            expected_size = None
            for frame in ImageSequence.Iterator(source):
                frame = ImageOps.exif_transpose(frame)
                has_alpha = "A" in frame.getbands() or "transparency" in frame.info or "transparency" in source.info
                rgba = frame.convert("RGBA") if has_alpha else None
                rgb = rgba.convert("RGB") if rgba is not None else frame.convert("RGB")
                if expected_size is None:
                    expected_size = rgb.size
                if rgb.size != expected_size:
                    continue
                image = np.asarray(rgb).astype(np.float32) / 255.0
                output_images.append(torch.from_numpy(image)[None,])
                if rgba is not None:
                    alpha = np.asarray(rgba.getchannel("A")).astype(np.float32) / 255.0
                    output_masks.append((1.0 - torch.from_numpy(alpha))[None,])
                else:
                    output_masks.append(torch.zeros((1, rgb.height, rgb.width), dtype=torch.float32))

        if not output_images:
            raise ValueError("Referenced image did not contain a readable frame")
        return (torch.cat(output_images, dim=0), torch.cat(output_masks, dim=0))

    @classmethod
    def IS_CHANGED(cls, image_ref, source_name="Edit Source"):
        _, path = _parse_chat_image_reference(image_ref)
        digest = hashlib.sha256()
        with open(path, "rb") as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    @classmethod
    def VALIDATE_INPUTS(cls, image_ref, source_name="Edit Source"):
        try:
            _parse_chat_image_reference(image_ref)
        except ValueError as exc:
            return str(exc)
        return True


class KCPP_PromptStudioUpscale:
    """Prompt Studio attachment point for image upscaling workflows."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_ref": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "Injected by Prompt Studio. References the image selected for upscaling.",
                    },
                ),
                "upscale_factor": (
                    "FLOAT",
                    {
                        "default": 2.0,
                        "min": 1.0,
                        "max": 16.0,
                        "step": 0.1,
                        "tooltip": "Injected by Prompt Studio and used to calculate the target width and height.",
                    },
                ),
            },
            "optional": {
                "prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "The source image prompt when Use prompt when upscaling is enabled.",
                    },
                ),
                "secondary_instructions": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "Optional text passed unchanged to the secondary instructions output.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT", "FLOAT", "STRING", "STRING")
    RETURN_NAMES = ("image", "width", "height", "upscale_factor", "prompt", "secondary_instructions")
    FUNCTION = "prepare_upscale"
    CATEGORY = "KoboldCpp"

    def prepare_upscale(self, image_ref, upscale_factor=2.0, prompt="", secondary_instructions=""):
        factor = float(upscale_factor)
        if not math.isfinite(factor) or factor < 1.0 or factor > 16.0:
            raise ValueError("Upscale factor must be between 1 and 16")
        image, _ = KCPP_ChatImageInput().load_image(image_ref)
        source_width, source_height = _chat_image_dimensions(image_ref)
        width = max(1, round(source_width * factor))
        height = max(1, round(source_height * factor))
        return (image, width, height, factor, prompt, secondary_instructions)

    @classmethod
    def IS_CHANGED(cls, image_ref, upscale_factor=2.0, prompt="", secondary_instructions=""):
        return KCPP_ChatImageInput.IS_CHANGED(image_ref)

    @classmethod
    def VALIDATE_INPUTS(cls, image_ref, upscale_factor=2.0, prompt="", secondary_instructions=""):
        image_validation = KCPP_ChatImageInput.VALIDATE_INPUTS(image_ref)
        if image_validation is not True:
            return image_validation
        try:
            factor = float(upscale_factor)
        except (TypeError, ValueError):
            return "Upscale factor must be a number"
        if not math.isfinite(factor) or factor < 1.0 or factor > 16.0:
            return "Upscale factor must be between 1 and 16"
        return True


class KCPP_Apply:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "multiline": True}),
                **_common_kcpp_inputs(default_max_response_tokens=300, raw_completion=True),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "apply"
    CATEGORY = "KoboldCpp"

    @classmethod
    def IS_CHANGED(cls, sampler_seed=-1, **kwargs):
        return _llm_node_change_token(sampler_seed)

    def apply(
        self,
        text,
        thinking_mode,
        kobold_url,
        max_response_tokens,
        temperature,
        top_p,
        top_k,
        min_p,
        rep_pen,
        rep_pen_range,
        sampler_seed,
        stop_sequence="",
        request_timeout=120,
    ):
        result = _generate_kcpp_raw(
            text,
            kobold_url,
            max_response_tokens,
            300,
            temperature,
            top_p,
            top_k,
            min_p,
            rep_pen,
            rep_pen_range,
            sampler_seed,
            thinking_mode,
            stop_sequence,
            request_timeout,
        )
        return (_strip_apply_response(result),)


def _normalized_lora_type(value):
    value = str(value or "").strip()
    if not value or value in {".", ".."} or "/" in value or "\\" in value:
        return ""
    return value


def _lora_names_for_type(lora_type):
    normalized_type = _normalized_lora_type(lora_type)
    if not normalized_type:
        return []
    type_key = normalized_type.casefold()
    matches = []
    for name in folder_paths.get_filename_list("loras"):
        normalized_name = str(name or "").replace("\\", "/").strip("/")
        parts = normalized_name.split("/")
        if (
            len(parts) > 1
            and parts[0].casefold() == type_key
            and not parts[-1].startswith("_")
        ):
            matches.append(normalized_name)
    return sorted(set(matches), key=lambda name: (name.casefold(), name))


def _normalized_model_type(value):
    value = str(value or "").strip()
    if not value or value in {".", ".."} or "/" in value or "\\" in value:
        return ""
    return value


def _model_name_key(value):
    return str(value or "").replace("\\", "/").strip("/").casefold()


def _diffusion_model_names_for_type(model_type):
    normalized_type = _normalized_model_type(model_type)
    if not normalized_type:
        return []
    type_key = normalized_type.casefold()
    matches = {}
    for name in folder_paths.get_filename_list("diffusion_models"):
        canonical_name = str(name or "").strip().strip("/\\")
        normalized_name = canonical_name.replace("\\", "/")
        parts = normalized_name.split("/")
        if len(parts) > 1 and parts[0].casefold() == type_key:
            matches.setdefault(_model_name_key(canonical_name), canonical_name)
    return sorted(matches.values(), key=lambda name: (_model_name_key(name), name))


class KCPP_PromptStudioLoraLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "lora_type": (
                    "STRING",
                    {
                        "default": "",
                        "tooltip": "Only LoRAs inside a top-level folder with this name are offered in Prompt Studio.",
                    },
                ),
            },
            # Prompt Studio removes this implementation detail from the graph UI and
            # injects it only into the executable API snapshot.
            "optional": {
                "lora_stack_json": ("STRING", {"default": "[]", "multiline": True}),
            },
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "load_loras"
    CATEGORY = "Prompt Studio"

    def __init__(self):
        self._cached_loras = []
        self._cache_signature = None

    def _parse_stack(self, lora_type, lora_stack_json):
        normalized_type = _normalized_lora_type(lora_type)
        if not normalized_type:
            if str(lora_stack_json or "").strip() not in {"", "[]"}:
                raise ValueError("LoRA Type must name one top-level LoRA folder")
            return []
        if len(str(lora_stack_json or "")) > 64 * 1024:
            raise ValueError("Prompt Studio LoRA selection is too large")
        try:
            entries = json.loads(str(lora_stack_json or "[]"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"Prompt Studio LoRA selection is not valid JSON: {exc}") from exc
        if not isinstance(entries, list):
            raise ValueError("Prompt Studio LoRA selection must be a list")
        if len(entries) > MAX_PROMPT_STUDIO_LORAS:
            raise ValueError(f"Prompt Studio supports at most {MAX_PROMPT_STUDIO_LORAS} LoRAs per loader")

        available = {name.casefold(): name for name in _lora_names_for_type(normalized_type)}
        parsed = []
        seen = set()
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError("Each Prompt Studio LoRA selection must be an object")
            requested_name = str(entry.get("name") or "").replace("\\", "/").strip("/")
            canonical_name = available.get(requested_name.casefold())
            if not canonical_name:
                raise ValueError(
                    f"LoRA '{requested_name}' is not inside the '{normalized_type}' LoRA folder"
                )
            if canonical_name.casefold() in seen:
                continue
            try:
                strength = float(entry.get("strength", 1.0))
            except (TypeError, ValueError) as exc:
                raise ValueError(f"LoRA '{canonical_name}' has an invalid strength") from exc
            if not math.isfinite(strength) or strength < -100 or strength > 100:
                raise ValueError(f"LoRA '{canonical_name}' strength must be between -100 and 100")
            seen.add(canonical_name.casefold())
            parsed.append((canonical_name, strength))
        return parsed

    def load_loras(self, model, lora_type, lora_stack_json="[]"):
        stack = self._parse_stack(lora_type, lora_stack_json)
        if not stack:
            self._cached_loras = []
            self._cache_signature = None
            return (model,)

        import comfy.sd
        import comfy.utils

        resolved = []
        for name, strength in stack:
            if hasattr(folder_paths, "get_full_path_or_raise"):
                path = folder_paths.get_full_path_or_raise("loras", name)
            else:
                path = folder_paths.get_full_path("loras", name)
                if not path:
                    raise ValueError(f"LoRA '{name}' could not be found")
            resolved.append((name, strength, path, os.path.getmtime(path)))

        signature = tuple((path, modified) for _, _, path, modified in resolved)
        if signature != self._cache_signature:
            self._cached_loras = [
                comfy.utils.load_torch_file(path, safe_load=True)
                for _, _, path, _ in resolved
            ]
            self._cache_signature = signature

        loaded_model = model
        for (_, strength, _, _), lora in zip(resolved, self._cached_loras):
            loaded_model, _ = comfy.sd.load_lora_for_models(
                loaded_model,
                None,
                lora,
                strength,
                0,
            )
        return (loaded_model,)


class KCPP_Ideogram4:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "json_input": ("STRING", {"default": "", "multiline": True}),
                "additional_instructions": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "Optional extra guidance for each extracted prompt fragment.",
                    },
                ),
                "model_profile": (_profile_names(),),
                "style_preset": (_style_template_names(),),
                "style_modifier": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "Optional aesthetic/style guidance. Overrides the selected style preset when non-empty.",
                    },
                ),
                "framing_preset": (_framing_template_names(),),
                "framing_modifier": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "Optional framing/composition guidance. Overrides the selected framing preset when non-empty.",
                    },
                ),
                "thinking_mode": (
                    ["Disabled", "Minimal", "Low", "Medium", "High"],
                    {
                        "default": "Disabled",
                        "tooltip": "Private-reasoning limits: Minimal 200 tokens, Low 500, Medium 1000, and High uses the available context window.",
                    },
                ),
                "embellishment_level": (
                    ["None", "Minimal", "Clean", "Detailed", "Rich", "Maximum", "Ultra Maximum"],
                    {
                        "default": "Clean",
                        "tooltip": "Controls how much each extracted prompt fragment is expanded or polished.",
                    },
                ),
                "process_high_level_description": ("BOOLEAN", {"default": True}),
                "process_background": ("BOOLEAN", {"default": True}),
                "process_elements": ("BOOLEAN", {"default": True}),
                "seed_mode": (["Offset per field", "Same seed"],),
                "on_error": (["Stop", "Keep Original"],),
                "pretty_json": ("BOOLEAN", {"default": True}),
                **_common_kcpp_inputs(),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("json_output",)
    FUNCTION = "process"
    CATEGORY = "KoboldCpp"

    @classmethod
    def IS_CHANGED(cls, sampler_seed=-1, **kwargs):
        return _llm_node_change_token(sampler_seed)

    def _field_seed(self, sampler_seed, seed_mode, offset):
        seed = int(sampler_seed)
        if seed < 0 or seed_mode == "Same seed":
            return seed
        return (seed + offset) % 1000000

    def _rewrite_fragment(
        self,
        value,
        field_label,
        offset,
        profile,
        style_template,
        style_modifier,
        framing_template,
        framing_modifier,
        embellishment_level,
        thinking_mode,
        additional_instructions,
        seed_mode,
        kobold_url,
        max_response_tokens,
        temperature,
        top_p,
        top_k,
        min_p,
        rep_pen,
        rep_pen_range,
        sampler_seed,
        stop_sequence,
        request_timeout,
        on_error,
    ):
        if not isinstance(value, str) or not value.strip():
            return value

        try:
            result = _generate_kcpp(
                _build_fragment_rewrite_prompt(
                    profile,
                    style_template,
                    style_modifier,
                    framing_template,
                    framing_modifier,
                    embellishment_level,
                    thinking_mode,
                    value,
                    additional_instructions,
                ),
                kobold_url,
                max_response_tokens,
                int(profile.get("default_max_response_tokens") or DEFAULT_PROFILE["default_max_response_tokens"]),
                temperature,
                top_p,
                top_k,
                min_p,
                rep_pen,
                rep_pen_range,
                self._field_seed(sampler_seed, seed_mode, offset),
                thinking_mode,
                stop_sequence,
                request_timeout,
                include_default_continuation_stops=True,
            )
            rewritten = _strip_response(result)
            return rewritten if rewritten else value
        except Exception as exc:
            if on_error == "Keep Original":
                print(f"[ComfyUI_PromptStudio] Keeping original {field_label} after KoboldCpp error: {exc}")
                return value
            raise RuntimeError(f"Failed to rewrite {field_label}: {exc}") from exc

    def process(
        self,
        json_input,
        additional_instructions,
        model_profile,
        style_preset,
        style_modifier,
        framing_preset,
        framing_modifier,
        thinking_mode,
        embellishment_level,
        process_high_level_description,
        process_background,
        process_elements,
        seed_mode,
        on_error,
        pretty_json,
        kobold_url,
        max_response_tokens,
        temperature,
        top_p,
        top_k,
        min_p,
        rep_pen,
        rep_pen_range,
        sampler_seed,
        stop_sequence="",
        request_timeout=120,
    ):
        try:
            data = json.loads(json_input)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Ideogram4-KoboldCPP input is not valid JSON: {exc}") from exc

        if not isinstance(data, dict):
            raise ValueError("Ideogram4-KoboldCPP expects a JSON object at the root.")

        profile = _get_profile(model_profile)
        style_template = _get_style_template(style_preset)
        framing_template = _get_framing_template(framing_preset)
        offset = 0

        def next_offset():
            nonlocal offset
            current = offset
            offset += 1
            return current

        if process_high_level_description and isinstance(data.get("high_level_description"), str):
            data["high_level_description"] = self._rewrite_fragment(
                data["high_level_description"],
                "high_level_description",
                next_offset(),
                profile,
                style_template,
                style_modifier,
                framing_template,
                framing_modifier,
                embellishment_level,
                thinking_mode,
                additional_instructions,
                seed_mode,
                kobold_url,
                max_response_tokens,
                temperature,
                top_p,
                top_k,
                min_p,
                rep_pen,
                rep_pen_range,
                sampler_seed,
                stop_sequence,
                request_timeout,
                on_error,
            )

        compositional = data.get("compositional_deconstruction")
        if isinstance(compositional, dict):
            if process_background and isinstance(compositional.get("background"), str):
                compositional["background"] = self._rewrite_fragment(
                    compositional["background"],
                    "compositional_deconstruction.background",
                    next_offset(),
                    profile,
                    style_template,
                    style_modifier,
                    framing_template,
                    framing_modifier,
                    embellishment_level,
                    thinking_mode,
                    additional_instructions,
                    seed_mode,
                    kobold_url,
                    max_response_tokens,
                    temperature,
                    top_p,
                    top_k,
                    min_p,
                    rep_pen,
                    rep_pen_range,
                    sampler_seed,
                    stop_sequence,
                    request_timeout,
                    on_error,
                )

            elements = compositional.get("elements")
            if process_elements and isinstance(elements, list):
                for index, element in enumerate(elements):
                    if not isinstance(element, dict) or not isinstance(element.get("desc"), str):
                        continue
                    if str(element.get("type") or "").lower() == "text":
                        continue
                    element["desc"] = self._rewrite_fragment(
                        element["desc"],
                        f"compositional_deconstruction.elements[{index}].desc",
                        next_offset(),
                        profile,
                        style_template,
                        style_modifier,
                        framing_template,
                        framing_modifier,
                        embellishment_level,
                        thinking_mode,
                        additional_instructions,
                        seed_mode,
                        kobold_url,
                        max_response_tokens,
                        temperature,
                        top_p,
                        top_k,
                        min_p,
                        rep_pen,
                        rep_pen_range,
                        sampler_seed,
                        stop_sequence,
                        request_timeout,
                        on_error,
                    )

        if pretty_json:
            return (json.dumps(data, ensure_ascii=False, indent=2),)
        return (json.dumps(data, ensure_ascii=False, separators=(",", ":")),)


def _safetensors_uses_int8(unet_path):
    """Inspect a safetensors header without reading the model tensor data."""
    if not str(unet_path).lower().endswith((".safetensors", ".sft")):
        return False

    try:
        file_size = os.path.getsize(unet_path)
        with open(unet_path, "rb") as file:
            size_bytes = file.read(8)
            if len(size_bytes) != 8:
                return False
            header_size = struct.unpack("<Q", size_bytes)[0]
            if header_size <= 0 or header_size > min(file_size - 8, 64 * 1024 * 1024):
                return False
            header = json.loads(file.read(header_size))
    except (OSError, ValueError, json.JSONDecodeError, struct.error):
        return False

    return any(
        name.endswith(".weight")
        and isinstance(tensor_info, dict)
        and tensor_info.get("dtype") == "I8"
        for name, tensor_info in header.items()
        if name != "__metadata__"
    )


def _uses_int8_diffusion_loader(unet_name):
    """Select the INT8 loader from the safetensors weight dtype."""
    try:
        unet_path = folder_paths.get_full_path_or_raise("diffusion_models", unet_name)
    except (AttributeError, FileNotFoundError):
        return False
    return _safetensors_uses_int8(unet_path)


class KCPP_PromptStudioModelLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model_type": (
                    "STRING",
                    {
                        "default": "",
                        "tooltip": (
                            "Only diffusion models inside a top-level folder with this name "
                            "are offered in Prompt Studio."
                        ),
                    },
                ),
                "unet_name": (
                    folder_paths.get_filename_list("diffusion_models"),
                    {
                        "tooltip": (
                            "The default diffusion model outside Prompt Studio. Prompt Studio "
                            "can replace it with a model from the configured Model Type folder."
                        ),
                    },
                ),
            },
        }

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "load_model"
    CATEGORY = "Prompt Studio"
    DESCRIPTION = (
        "Automatically selects the standard ComfyUI diffusion-model loader or "
        "Load Diffusion Model INT8 (W8A8)."
    )

    def load_model(self, model_type, unet_name):
        import nodes as comfy_nodes

        normalized_type = _normalized_model_type(model_type)
        if normalized_type:
            available = {
                _model_name_key(name): name
                for name in _diffusion_model_names_for_type(normalized_type)
            }
            requested_name = str(unet_name or "").strip().strip("/\\")
            canonical_name = available.get(_model_name_key(requested_name))
            if not canonical_name:
                raise ValueError(
                    f"Diffusion model '{requested_name}' is not inside the "
                    f"'{normalized_type}' model folder"
                )
            unet_name = canonical_name

        if _uses_int8_diffusion_loader(unet_name):
            loader_class = comfy_nodes.NODE_CLASS_MAPPINGS.get("OTUNetLoaderW8A8")
            if loader_class is None:
                raise RuntimeError(
                    "This model requires Load Diffusion Model INT8 (W8A8), but "
                    "ComfyUI-INT8-Fast is not installed or did not load successfully."
                )
            return loader_class().load_unet(
                unet_name,
                "default",
                "krea2",
                False,
                enable_convrot=False,
                lora_mode="None",
            )

        loader_class = comfy_nodes.NODE_CLASS_MAPPINGS.get("UNETLoader")
        if loader_class is None:
            raise RuntimeError("ComfyUI's standard diffusion model loader is unavailable.")
        return loader_class().load_unet(unet_name, "default")


NODE_CLASS_MAPPINGS = {
    "Save_as_webp_cond": Save_as_webp_cond,
    "KCPP_PromptAmplify": KCPP_PromptAmplify,
    "KCPP_PromptSlot": KCPP_PromptSlot,
    "KCPP_ChatImageInput": KCPP_ChatImageInput,
    "KCPP_PromptStudioUpscale": KCPP_PromptStudioUpscale,
    "KCPP_PromptStudioLoraLoader": KCPP_PromptStudioLoraLoader,
    "KCPP_Apply": KCPP_Apply,
    "KCPP_Ideogram4": KCPP_Ideogram4,
    "KCPP_PromptStudioModelLoader": KCPP_PromptStudioModelLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Save_as_webp_cond": "Save as WebP Conditional",
    "KCPP_PromptAmplify": "KoboldCpp Prompt Amplify",
    "KCPP_PromptSlot": "KoboldCpp Prompt Slot",
    "KCPP_ChatImageInput": "Prompt Studio Image Source",
    "KCPP_PromptStudioUpscale": "Prompt Studio Upscale",
    "KCPP_PromptStudioLoraLoader": "Prompt Studio LoRA Loader",
    "KCPP_Apply": "KoboldCpp Apply",
    "KCPP_Ideogram4": "Ideogram4-KoboldCPP",
    "KCPP_PromptStudioModelLoader": "Prompt Studio Model Loader",
}
