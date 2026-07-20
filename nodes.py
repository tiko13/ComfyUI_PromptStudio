import hashlib
import ipaddress
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

import numpy as np
import torch
from PIL import Image, ImageOps, ImageSequence

import folder_paths


BASE_DIR = os.path.dirname(os.path.realpath(__file__))
PROFILES_PATH = os.path.join(BASE_DIR, "model_profiles.json")
STYLE_TEMPLATES_PATH = os.path.join(BASE_DIR, "style_templates.json")
FRAMING_TEMPLATES_PATH = os.path.join(BASE_DIR, "framing_templates.json")
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
    "<channel|>",
    "\n<channel|>",
    "\r\n<channel|>",
    "<|channel>",
    "\n<|channel>",
    "\r\n<|channel>",
    "<|channel>thought",
    "<|channel>analysis",
]


def _allowed_kobold_hosts():
    configured = os.environ.get("LLLM_KOBOLD_ALLOWED_HOSTS", "").strip()
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


def _load_style_templates():
    try:
        with open(STYLE_TEMPLATES_PATH, "r", encoding="utf-8") as file:
            data = json.load(file)
    except FileNotFoundError:
        return [DEFAULT_STYLE_TEMPLATE]
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid KoboldCpp style template JSON: {STYLE_TEMPLATES_PATH}: {exc}") from exc

    _require_json_object(data, "KoboldCpp style template")
    templates = data.get("style_templates", [])
    if not isinstance(templates, list):
        raise ValueError("KoboldCpp style template JSON must contain a 'style_templates' list.")

    normalized = []
    for index, template in enumerate(templates):
        if not isinstance(template, dict):
            continue
        merged = dict(DEFAULT_STYLE_TEMPLATE)
        merged.update(template)
        merged["name"] = str(merged.get("name") or "").strip() or f"Style {index + 1}"
        normalized.append(merged)

    normalized = normalized or [DEFAULT_STYLE_TEMPLATE]
    _validate_unique_names(normalized, "style template")
    return normalized


def _load_framing_templates():
    try:
        with open(FRAMING_TEMPLATES_PATH, "r", encoding="utf-8") as file:
            data = json.load(file)
    except FileNotFoundError:
        return [DEFAULT_FRAMING_TEMPLATE]
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid framing template JSON: {FRAMING_TEMPLATES_PATH}: {exc}") from exc

    _require_json_object(data, "Framing template")
    templates = data.get("framing_templates", [])
    if not isinstance(templates, list):
        raise ValueError("Framing template JSON must contain a 'framing_templates' list.")

    normalized = []
    for index, template in enumerate(templates):
        if not isinstance(template, dict):
            continue
        merged = dict(DEFAULT_FRAMING_TEMPLATE)
        merged.update(template)
        merged["name"] = str(merged.get("name") or "").strip() or f"Framing {index + 1}"
        normalized.append(merged)

    normalized = normalized or [DEFAULT_FRAMING_TEMPLATE]
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


def _clean_base_url(url):
    cleaned = (url or "http://localhost:5001").strip()
    if not cleaned:
        cleaned = "http://localhost:5001"
    if "://" not in cleaned:
        cleaned = "http://" + cleaned
    cleaned = cleaned.rstrip("/")
    parsed = urllib.parse.urlsplit(cleaned)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("KoboldCpp URL must use http or https")
    if not parsed.hostname:
        raise ValueError("KoboldCpp URL must include a hostname")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("KoboldCpp URL must not contain credentials")
    try:
        parsed.port
    except ValueError as exc:
        raise ValueError("KoboldCpp URL contains an invalid port") from exc
    if parsed.query or parsed.fragment:
        raise ValueError("KoboldCpp URL must not contain a query string or fragment")

    hostname = parsed.hostname.casefold()
    allowed_hosts = _allowed_kobold_hosts()
    if "*" not in allowed_hosts and hostname not in allowed_hosts:
        try:
            is_loopback = ipaddress.ip_address(hostname).is_loopback
        except ValueError:
            is_loopback = False
        if not is_loopback:
            raise ValueError(
                f"KoboldCpp host '{parsed.hostname}' is not allowed. "
                "Add it to LLLM_KOBOLD_ALLOWED_HOSTS or use '*' to allow remote hosts."
            )
    return cleaned


def _post_json(url, payload, timeout):
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
        raise RuntimeError(f"KoboldCpp request failed with HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach KoboldCpp at {url}: {exc.reason}") from exc

    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"KoboldCpp returned invalid JSON: {body[:500]}") from exc


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


def _server_max_length(base_url, timeout):
    data = _get_json(
        urllib.parse.urljoin(base_url + "/", "api/v1/config/max_length"),
        timeout,
    )
    if not isinstance(data, dict):
        return None
    try:
        return int(data["value"])
    except (KeyError, TypeError, ValueError):
        return None


def _split_stop_sequences(value):
    if not value:
        return []
    return [item.strip() for item in value.splitlines() if item.strip()]


def _common_kcpp_inputs(default_max_response_tokens=180):
    return {
        "thinking_mode": (
            ["Disabled", "Minimal", "Low", "Medium", "High"],
            {
                "default": "Disabled",
                "tooltip": "Controls KoboldCpp reasoning_effort.",
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
                "tooltip": "Maximum generated tokens. Use 0 to use the node default. The node clamps to the server max when KoboldCpp reports one.",
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
):
    base_url = _clean_base_url(kobold_url)
    timeout = int(request_timeout)
    max_length = int(max_response_tokens)
    if max_length <= 0:
        max_length = int(default_max_response_tokens)
    server_max_length = _server_max_length(base_url, timeout)
    if server_max_length is not None and server_max_length > 0:
        max_length = min(max_length, server_max_length)

    stop_sequences = _split_stop_sequences(stop_sequence)
    if include_default_continuation_stops:
        stop_sequences = _with_default_continuation_stops(stop_sequences)

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
        "stop_sequence": stop_sequences,
    }

    result = _post_json(
        urllib.parse.urljoin(base_url + "/", "api/v1/generate"),
        payload,
        timeout,
    )
    try:
        return result["results"][0]["text"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"Unexpected KoboldCpp response: {result}") from exc


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
    if effort == "minimal":
        return "Write a section starting exactly 'Reasoning:' with one short sentence about what to preserve. Then write a line exactly 'Final prompt:' followed by the final rewritten prompt."
    if effort == "low":
        return "Write a section starting exactly 'Reasoning:' with a brief note about the subject, setting, and composition to preserve. Then write a line exactly 'Final prompt:' followed by the final rewritten prompt."
    if effort == "medium":
        return "Write a section starting exactly 'Reasoning:' about the subject, setting, composition, and concrete visible details to preserve. Then write a line exactly 'Final prompt:' followed by the final rewritten prompt."
    if effort == "high":
        return "Write a section starting exactly 'Reasoning:' and reason carefully about the subject, setting, composition, concrete visible details, style constraints, and anything that should not be added. Then write a line exactly 'Final prompt:' followed by the final rewritten prompt."
    return ""


def _embellishment_instruction(embellishment_level, profile):
    level = str(embellishment_level or "Clean").strip().lower()
    style = str(profile.get("style") or "").lower()
    tag_mode = "tag" in style

    if tag_mode:
        instructions = {
            "minimal": "Keep the tag output very short. Only convert the user's prompt into essential tags. Do not add new details.",
            "clean": "Use a concise tag set with clear subject, action, setting, and important visible details. Add little or no new content.",
            "detailed": "Use a fuller tag set with useful visible details such as subject attributes, pose/action, setting, materials, and composition. Aim for roughly 8 to 14 relevant tags.",
            "rich": "Use a dense tag set with strong visual specificity, composition, materials, and style-relevant tags where appropriate. Aim for roughly 14 to 24 relevant tags. Do not add mood, lighting, quality, camera, medium, props, landmarks, extra subjects, abstract filler tags, or duplicate tags unless they match the selected style and are implied by the input.",
            "maximum": "Use a very dense tag set with extensive visible detail, environment, composition, materials, and style-appropriate tags while preserving the user's intent. Aim for roughly 18 to 30 relevant tags. Use concrete visual tags only; do not introduce a different style, new focal objects, abstract filler tags, or duplicate tags.",
            "ultra maximum": "Use a very dense tag set with extensive visible detail, environment, composition, materials, and style-appropriate tags while preserving the user's intent. Aim for roughly 24 to 40 relevant tags. Expand with attributes, textures, pose, expression, sub-details of existing subjects, and plausible non-focal setting details. Use concrete visual tags only; do not introduce a different style, new characters, new focal objects, abstract filler tags, or duplicate tags.",
        }
    else:
        instructions = {
            "minimal": "Keep the rewrite short. Only convert style or format. Do not add new details.",
            "clean": "Lightly improve clarity and wording. Add little or no new detail.",
            "detailed": "Add useful visible details, composition, materials, and environment where appropriate. Write a clearly expanded sentence or two. Keep all added language consistent with the selected style.",
            "rich": "Use cohesive descriptive prose with stronger visual specificity and tasteful detail. Write a longer prompt with several concrete descriptive clauses. Keep atmosphere, lighting, quality, camera, and medium language consistent with the selected style. Do not add props, landmarks, extra subjects, or interactions with unmentioned entities unless explicitly present in the input.",
            "maximum": "Create a highly expanded prompt with extensive visible detail, composition, materials, environment, and style-appropriate descriptive language while still respecting the user's intent. Aim for a substantial prompt, usually 35 to 70 words unless the original is already long. Elaborate existing content; do not introduce a different style or new focal objects.",
            "ultra maximum": "Create a highly detailed, extremely expanded prompt with extensive visible detail, composition, materials, environment, body language, expressions, and style-appropriate descriptive language while still respecting the user's intent. Aim for a substantial prompt, usually 60 to 110 words unless the original is already long. Expand with attributes, textures, pose, expression, sub-details of existing subjects, and plausible non-focal setting details. Do not introduce a different style, new characters, or new focal objects.",
        }
    return instructions.get(level, instructions["clean"])


def _revision_embellishment_instruction(embellishment_level, profile):
    level = str(embellishment_level or "Clean").strip().lower()
    style = str(profile.get("style") or "").lower()
    target = "tags" if "tag" in style else "wording"
    instructions = {
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
    if effort == "minimal":
        return "Write a section starting exactly 'Reasoning:' with one short sentence naming the edit scope and what must remain unchanged. Then write a line exactly 'Final prompt:' followed by the final replacement prompt."
    if effort == "low":
        return "Write a section starting exactly 'Reasoning:' with a brief edit plan: identify the target, conflicting old details to remove, and protected content to preserve. Then write a line exactly 'Final prompt:' followed by the final replacement prompt."
    if effort == "medium":
        return "Write a section starting exactly 'Reasoning:' that identifies the smallest sufficient edit scope, all conflicting references to that target, and the unrelated clauses or tags that must remain unchanged. Then write a line exactly 'Final prompt:' followed by the final replacement prompt."
    if effort == "high":
        return "Write a section starting exactly 'Reasoning:' and carefully map the requested change to the smallest sufficient edit scope, locate every obsolete or conflicting target reference, preserve unrelated wording and tag order, and check the final prompt for collateral changes. Then write a line exactly 'Final prompt:' followed by the final replacement prompt."
    return ""


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
            amount = "about 60 to 110 words"
            clauses = "at least six concrete descriptive clauses"
            shape = "five short descriptive sentences, or one paragraph with at least six concrete descriptive clauses"
        else:
            amount = "about 35 to 70 words"
            clauses = "at least four concrete descriptive clauses"
            shape = "three to four short descriptive sentences, or one paragraph with at least four concrete descriptive clauses"
        text = (
            f"The final {target} must be visibly longer and more detailed than the {source}. If the {source} is short, "
            f"write {shape}, usually {amount}. Each sentence or clause should add concrete visible detail; do not merely clean up or restate the input."
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
    if level not in {"maximum", "ultra maximum"}:
        return []

    style = str(profile.get("style") or "").lower()
    tag_mode = "tag" in style
    target = "fragment" if fragment else "prompt"
    if tag_mode:
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
        if level == "ultra maximum":
            return [f"- For Ultra Maximum natural-language output, do not return a terse one-clause {target}; use several concrete descriptive clauses."]
        return [f"- For Maximum natural-language output, do not return a terse one-clause {target}; include multiple concrete descriptive clauses."]

    if level == "ultra maximum":
        return [
            "- For Ultra Maximum natural-language output, do not return a one-sentence prompt.",
            "- Write exactly five short descriptive sentences about the same scene, and make each sentence add visible detail.",
        ]
    return [
        "- For Maximum natural-language output, do not return a one-sentence prompt.",
        "- Write three to four short descriptive sentences about the same scene, and make each sentence add visible detail.",
    ]


def _word_count(text):
    return len(re.findall(r"\b[\w'-]+\b", str(text or "")))


def _tag_count(text):
    return len([part for part in re.split(r"[,;\n]+", str(text or "")) if part.strip()])


def _density_count(text, profile):
    style = str(profile.get("style") or "").lower()
    if "tag" in style:
        return _tag_count(text)
    return _word_count(text)


def _needs_expansion_retry(original, rewritten, embellishment_level, profile):
    level = str(embellishment_level or "Clean").strip().lower()
    if level not in {"maximum", "ultra maximum"}:
        return False
    if not str(original or "").strip():
        return False
    if not str(rewritten or "").strip():
        return True

    style = str(profile.get("style") or "").lower()
    if "tag" in style:
        original_tags = max(_tag_count(original), max(1, _word_count(original) // 2))
        rewritten_tags = _tag_count(rewritten)
        floor = 16 if level == "ultra maximum" else 10
        return rewritten_tags <= original_tags or rewritten_tags < floor

    original_words = _word_count(original)
    rewritten_words = _word_count(rewritten)
    floor = 60 if level == "ultra maximum" else 35
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
        "You are expanding an image-generation prompt because the previous rewrite was too short for the selected embellishment level.",
        "Use the current rewritten prompt as the base, preserve the original user intent, and add concrete visible detail.",
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
                "Thinking:",
                "Do not include thinking, analysis, reasoning, scratchpad notes, <think> tags, or <thinking> tags in the response.",
            ]
        )
    else:
        prompt_parts.extend(["", "Thinking:", _thinking_instruction(thinking_mode)])

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
            *_expansion_rule_lines(embellishment_level, profile),
            "- Do not explain your changes.",
            "- Do not include markdown.",
            f"- End with a line exactly '{FINAL_PROMPT_MARKER}' followed by the expanded prompt.",
            f"- Stop immediately after the expanded prompt. Do not add notes, rule checks, examples, or another user prompt.",
            "",
            "Original user prompt:",
            str(original_text or "").strip(),
            "",
            "Current rewritten prompt:",
            str(rewritten_text or "").strip(),
            "",
            "Response:",
        ]
    )
    if _reasoning_effort(thinking_mode) != "none":
        prompt_parts.append("Reasoning:")
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
                "Thinking:",
                "Do not include thinking, analysis, reasoning, scratchpad notes, <think> tags, or <thinking> tags in the response.",
            ]
        )
    else:
        prompt_parts.extend(
            [
                "",
                "Thinking:",
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
            f"- End with a line exactly '{FINAL_PROMPT_MARKER}' followed by the rewritten prompt.",
            f"- Do not put reasoning, notes, explanations, or parenthetical comments after '{FINAL_PROMPT_MARKER}'.",
            f"- Stop immediately after the rewritten prompt. Do not add notes, rule checks, examples, or another user prompt.",
            "",
            "User prompt:",
            text,
            "",
            "Response:",
        ]
    )
    if _reasoning_effort(thinking_mode) != "none":
        prompt_parts.append("Reasoning:")
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
                "Analyze the edit scope silently. Start the response with the required final-prompt marker, output only the complete replacement prompt, and stop immediately. Do not include thinking, analysis, explanations, markdown, or change notes before or after it.",
            ]
        )
    else:
        prompt_parts.extend(["", "Thinking:", _revision_thinking_instruction(thinking_mode)])

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
            f"- End with a line exactly '{FINAL_PROMPT_MARKER}' followed by the complete replacement prompt.",
            f"- Do not put anything after the replacement prompt following '{FINAL_PROMPT_MARKER}'.",
            "",
            "Current prompt:",
            str(current_prompt or "").strip(),
            "",
            "Requested revision:",
            str(revision or "").strip(),
            "",
            "Response:",
        ]
    )
    if _reasoning_effort(thinking_mode) != "none":
        prompt_parts.append("Reasoning:")
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
                "Thinking:",
                "Do not include thinking, analysis, reasoning, scratchpad notes, <think> tags, or <thinking> tags in the response.",
            ]
        )
    else:
        prompt_parts.extend(
            [
                "",
                "Thinking:",
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
            f"- End with a line exactly '{FINAL_PROMPT_MARKER}' followed by the rewritten fragment.",
            f"- Do not put reasoning, notes, explanations, or parenthetical comments after '{FINAL_PROMPT_MARKER}'.",
            f"- Stop immediately after the rewritten fragment. Do not add notes, rule checks, examples, or another user prompt.",
            "",
            "Prompt fragment:",
            text,
            "",
            "Response:",
        ]
    )
    if _reasoning_effort(thinking_mode) != "none":
        prompt_parts.append("Reasoning:")
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
                        "tooltip": "Optional aesthetic/style guidance for this run without editing style_templates.json.",
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
                        "tooltip": "Controls KoboldCpp reasoning_effort. Disabled sends 'none'; the other modes enable model thinking at that effort level.",
                    },
                ),
                "embellishment_level": (
                    ["Minimal", "Clean", "Detailed", "Rich", "Maximum", "Ultra Maximum"],
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
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("amplified_text", "secondary_instructions")
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
        return (_apply_profile_wrappers(amplified, profile), secondary_instructions)


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
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("prompt", "secondary_instructions")
    FUNCTION = "get_prompt"
    CATEGORY = "KoboldCpp"

    def get_prompt(self, prompt, slot_name="Positive Prompt", secondary_instructions=""):
        return (prompt, secondary_instructions)


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
    }
    if storage_type not in roots:
        raise ValueError("Image reference type must be input, output, or temp")

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
        raise ValueError("Image reference cannot leave its ComfyUI storage directory")
    path = os.path.realpath(os.path.join(root, relative_path))
    try:
        inside_root = os.path.commonpath((root, path)) == root
    except ValueError:
        inside_root = False
    if not inside_root:
        raise ValueError("Image reference cannot leave its ComfyUI storage directory")
    if not os.path.isfile(path):
        raise ValueError(f"Referenced image does not exist: {relative_path}")
    return reference, path


class KCPP_ChatImageInput:
    """Load a Prompt Studio chat image directly from ComfyUI storage."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_ref": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "Injected by Prompt Studio. References an existing input, output, or temp image without copying it.",
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


class KCPP_Apply:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "multiline": True}),
                **_common_kcpp_inputs(default_max_response_tokens=300),
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
        result = _generate_kcpp(
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
            include_default_continuation_stops=False,
        )
        return (_strip_apply_response(result),)


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
                        "tooltip": "Controls KoboldCpp reasoning_effort. Disabled sends 'none'; the other modes enable model thinking at that effort level.",
                    },
                ),
                "embellishment_level": (
                    ["Minimal", "Clean", "Detailed", "Rich", "Maximum", "Ultra Maximum"],
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
                **_common_kcpp_inputs(default_max_response_tokens=180),
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
                print(f"[ComfyUI_LLLM] Keeping original {field_label} after KoboldCpp error: {exc}")
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


NODE_CLASS_MAPPINGS = {
    "KCPP_PromptAmplify": KCPP_PromptAmplify,
    "KCPP_PromptSlot": KCPP_PromptSlot,
    "KCPP_ChatImageInput": KCPP_ChatImageInput,
    "KCPP_Apply": KCPP_Apply,
    "KCPP_Ideogram4": KCPP_Ideogram4,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "KCPP_PromptAmplify": "KoboldCpp Prompt Amplify",
    "KCPP_PromptSlot": "KoboldCpp Prompt Slot",
    "KCPP_ChatImageInput": "Prompt Studio Image Source",
    "KCPP_Apply": "KoboldCpp Apply",
    "KCPP_Ideogram4": "Ideogram4-KoboldCPP",
}
