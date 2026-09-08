import base64
import hashlib
import functools
import inspect
import io
import ipaddress
import json
import math
import os
import re
import secrets
import struct
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

import numpy as np
import torch
from PIL import Image, ImageOps, ImageSequence, UnidentifiedImageError

import folder_paths

from . import provider_transport as _provider_transport
from . import llm_coordinator as _llm_scheduling
from .prompt_intent import build_intent_prompt_context as _intent_prompt_context


def _apply_image_intent_context(prompt, intent_provenance, *, stage, rebuild=False):
    """Attach validated sidecar constraints without changing native node IO."""
    context = _intent_prompt_context(intent_provenance, stage=stage, include_edit_scope=not rebuild)
    return f"{prompt}\n\n{context}" if context else prompt


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
ADDITIONAL_INSTRUCTION_TEMPLATES_PATH = os.path.join(
    BASE_DIR,
    "additional_instruction_templates.json",
)
ADDITIONAL_INSTRUCTION_TEMPLATES_EXAMPLE_PATH = os.path.join(
    PRESET_EXAMPLES_DIR,
    "additional_instruction_templates.example.json",
)
KNOWN_REFERENCES_PATH = os.path.join(BASE_DIR, "known_references.json")
KNOWN_REFERENCES_EXAMPLE_PATH = os.path.join(
    PRESET_EXAMPLES_DIR,
    "known_references.example.json",
)
PROTECTED_WORDS_PATH = os.path.join(BASE_DIR, "protected_words.txt")
_PROTECTED_WORDS_CACHE = {"signature": None, "words": ()}
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

OUTPUT_LENGTH_SPECS = {
    "words": {
        "min": 20,
        "max": 200,
        "step": 5,
        "defaults": {
            "none": 20,
            "minimal": 25,
            "clean": 35,
            "detailed": 50,
            "rich": 65,
            "maximum": 70,
            "ultra maximum": 140,
        },
    },
    "tags": {
        "min": 5,
        "max": 40,
        "step": 1,
        "defaults": {
            "none": 5,
            "minimal": 7,
            "clean": 10,
            "detailed": 12,
            "rich": 20,
            "maximum": 24,
            "ultra maximum": 32,
        },
    },
}
DEFAULT_STYLE_TEMPLATE = {
    "name": "None",
    "instruction": "",
}
DEFAULT_FRAMING_TEMPLATE = {
    "name": "None",
    "instruction": "",
}
DEFAULT_ADDITIONAL_INSTRUCTION_TEMPLATE = {
    "name": "",
    "instruction": "",
}
LEGACY_FRAMING_ALIASES = {
    "Point of view": "First-Person Downward View",
}
FINAL_PROMPT_MARKER = "Final prompt:"
CHAT_SYSTEM_MESSAGE = (
    "You are an expert image-generation prompt editor. Follow the requested transformation and "
    "output-format constraints precisely. Preserve the user's requested subject matter without "
    "sanitizing it or introducing more extreme content. Keep analysis in the model's private reasoning channel. "
    "The final answer must contain only the requested prompt output, without commentary or markdown."
)
# Natural-language labels are valid prompt content (including visible text), so
# Prompt Studio never installs heuristic textual stops. Model-native end-of-turn
# tokens remain authoritative, and explicit user stops are preserved.
DEFAULT_CONTINUATION_STOPS = ()

# KoboldCpp exposes GBNF grammar sampling but does not consistently expose the
# same JSON-Schema request contract across releases. For non-thinking JSON
# requests, constrain the response to one syntactically complete JSON object;
# task-specific schemas and deterministic validation remain authoritative.
JSON_OBJECT_GBNF = r'''root ::= ws object ws
value ::= object | array | string | number | "true" | "false" | "null"
object ::= "{" ws (string ws ":" ws value (ws "," ws string ws ":" ws value)*)? ws "}"
array ::= "[" ws (value (ws "," ws value)*)? ws "]"
string ::= "\"" chars "\""
chars ::= ([^"\\\x00-\x1F] | "\\" (["\\/bfnrt] | "u" hex hex hex hex))*
number ::= "-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [+-]? [0-9]+)?
hex ::= [0-9a-fA-F]
ws ::= [ \t\n\r]*
'''
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


def _allowed_llamacpp_hosts():
    configured = os.environ.get("PROMPT_STUDIO_LLAMACPP_ALLOWED_HOSTS", "").strip()
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
    # One syntax reference is enough for local models; multiple content-rich
    # examples consume context and increase subject-matter copying.
    return ["Syntax example (format only; never copy its subject matter):", examples[0]]


def _profile_notes(profile):
    notes = profile.get("notes", "")
    if isinstance(notes, list):
        return "\n".join(str(note).strip() for note in notes if str(note).strip())
    return str(notes or "").strip()


def _load_protected_words():
    """Load user-owned protected literals, refreshing when the local file changes."""
    try:
        stat = os.stat(PROTECTED_WORDS_PATH)
        signature = (PROTECTED_WORDS_PATH, stat.st_mtime_ns, stat.st_size)
    except FileNotFoundError:
        signature = (PROTECTED_WORDS_PATH, None, None)

    if _PROTECTED_WORDS_CACHE["signature"] == signature:
        return _PROTECTED_WORDS_CACHE["words"]

    try:
        with open(PROTECTED_WORDS_PATH, "r", encoding="utf-8-sig") as file:
            lines = file.readlines()
    except FileNotFoundError:
        lines = []

    words = []
    seen = set()
    for line in lines:
        word = line.strip()
        if not word or word == "#" or word.startswith("# "):
            continue
        key = word.casefold()
        if key in seen:
            continue
        seen.add(key)
        words.append(word)

    result = tuple(words)
    _PROTECTED_WORDS_CACHE["signature"] = signature
    _PROTECTED_WORDS_CACHE["words"] = result
    return result


def _literal_match_spans(text, literal):
    text = str(text or "")
    literal = str(literal or "")
    if not text or not literal:
        return []

    matches = []
    literal_starts_with_token = literal[0].isalnum() or literal[0] == "_"
    literal_ends_with_token = literal[-1].isalnum() or literal[-1] == "_"
    for match in re.finditer(re.escape(literal), text, flags=re.IGNORECASE):
        start, end = match.span()
        if literal_starts_with_token and start > 0:
            previous = text[start - 1]
            if previous.isalnum() or previous == "_":
                continue
        if literal_ends_with_token and end < len(text):
            following = text[end]
            if following.isalnum() or following == "_":
                continue
        matches.append((start, end, match.group(0)))
    return matches


def _protected_word_matches(text, word):
    return [match for _start, _end, match in _literal_match_spans(text, word)]


def _matched_protected_words(*source_texts, excluded_literals=()):
    matches = []
    seen = set()
    excluded = {str(item or "").strip().casefold() for item in excluded_literals}
    for word in _load_protected_words():
        if word.casefold() in excluded:
            continue
        for source_text in source_texts:
            for match in _protected_word_matches(source_text, word):
                if match in seen:
                    continue
                seen.add(match)
                matches.append(match)
    return matches


def _protected_word_instruction_lines(*source_texts, excluded_literals=()):
    matches = _matched_protected_words(
        *source_texts,
        excluded_literals=excluded_literals,
    )
    if not matches:
        return []
    return [
        "Protected literals found in the source text:",
        json.dumps(matches, ensure_ascii=False),
        "Copy each listed literal exactly as shown whenever its referenced content remains in the output. Do not translate, rephrase, correct, re-capitalize, pluralize, split, or join it. An explicit request to remove the referenced content may remove its literal; otherwise do not omit it.",
    ]


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


def _load_additional_instruction_templates():
    _ensure_additional_template_file(
        ADDITIONAL_INSTRUCTION_TEMPLATES_PATH,
        ADDITIONAL_INSTRUCTION_TEMPLATES_EXAMPLE_PATH,
    )
    normalized = _load_template_file(
        ADDITIONAL_INSTRUCTION_TEMPLATES_PATH,
        "additional_instruction_templates",
        "Additional instruction template",
        DEFAULT_ADDITIONAL_INSTRUCTION_TEMPLATE,
    )
    normalized = [
        template
        for template in normalized
        if str(template.get("name") or "").strip()
        and str(template.get("instruction") or "").strip()
    ]
    _validate_unique_names(normalized, "additional instruction template")
    return normalized


def _load_known_references():
    _ensure_additional_template_file(
        KNOWN_REFERENCES_PATH,
        KNOWN_REFERENCES_EXAMPLE_PATH,
    )
    try:
        with open(KNOWN_REFERENCES_PATH, "r", encoding="utf-8") as file:
            data = json.load(file)
    except FileNotFoundError:
        return []
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid known reference JSON: {KNOWN_REFERENCES_PATH}: {exc}") from exc

    _require_json_object(data, "Known reference")
    references = data.get("known_references", [])
    if not isinstance(references, list):
        raise ValueError("Known reference JSON must contain a 'known_references' list.")

    normalized = []
    for reference in references:
        if not isinstance(reference, dict) or reference.get("enabled", True) is False:
            continue
        name = str(reference.get("name") or "").strip()
        definition = str(reference.get("definition") or "").strip()
        if not name or not definition:
            continue
        normalized.append({"name": name, "definition": definition})
    _validate_unique_names(normalized, "known reference")
    return normalized


def _matched_known_references(*source_texts):
    """Return matched definitions in source order, preferring the longest name at one position."""
    references = _load_known_references()
    found = {}
    for source_index, source_text in enumerate(source_texts):
        candidates = []
        for reference_index, reference in enumerate(references):
            for start, end, matched_text in _literal_match_spans(
                source_text,
                reference["name"],
            ):
                candidates.append(
                    (start, -(end - start), reference_index, end, matched_text)
                )

        accepted = []
        for start, _negative_length, reference_index, end, matched_text in sorted(candidates):
            if any(
                start < accepted_end and end > accepted_start
                for accepted_start, accepted_end, *_ in accepted
            ):
                continue
            accepted.append((start, end, reference_index, matched_text))

        for start, end, reference_index, matched_text in sorted(accepted):
            record = found.get(reference_index)
            if record is None:
                reference = references[reference_index]
                record = {
                    "name": reference["name"],
                    "definition": reference["definition"],
                    "matched_texts": [],
                    "first_match": (source_index, start, end),
                }
                found[reference_index] = record
            if matched_text not in record["matched_texts"]:
                record["matched_texts"].append(matched_text)

    return sorted(found.values(), key=lambda item: item["first_match"])


def _known_reference_main_prompt_lines(*source_texts):
    references = _matched_known_references(*source_texts)
    matches = []
    for reference in references:
        for matched_text in reference["matched_texts"]:
            if matched_text not in matches:
                matches.append(matched_text)
    if not matches:
        return []
    return [
        "Known-reference literals found in the Main Prompt or requested revision:",
        json.dumps(matches, ensure_ascii=False),
        "While editing the Main Prompt, copy each listed reference literal exactly as shown whenever its referenced content remains. Do not replace it with its definition, translate it, rephrase it, correct it, re-capitalize it, pluralize it, split it, or join it. An explicit request to remove or replace that referenced content may remove its literal; otherwise do not omit it.",
    ]


def _known_reference_final_prompt_lines(references):
    if not references:
        return []
    mappings = [
        {
            "reference_name": reference["name"],
            "matched_texts": reference["matched_texts"],
            "definition": reference["definition"],
        }
        for reference in references
    ]
    return [
        "",
        "Known references used by the source text:",
        json.dumps(mappings, ensure_ascii=False, indent=2),
        "Known-reference conversion rules:",
        "- A reference may describe any reusable concept, including a person, character, item, clothing, pose, gesture, facial expression, location, background, lighting, composition, or visual treatment. Never assume all references are people or subjects.",
        "- Interpret each reference from its definition and from the grammatical role of each occurrence in the source text.",
        "- Replace every matched reference occurrence with final-prompt content guided by its definition. The definition is an instruction, not text that must be copied verbatim.",
        "- Do not output a reference name or matched spelling merely because it appears in the source. The final prompt must describe the referenced content instead.",
        "- Apply every mapping independently and simultaneously. Never merge mappings, swap definitions, transfer attributes between references, or assign a pose, expression, item, background, or other concept to the wrong subject or location.",
        "- If a reference appears only in a requested revision, use its definition to identify the corresponding content in the current prompt, apply the requested edit, and still omit the reference name from the result.",
        "- An explicit local modification attached to a reference may refine or override the conflicting part of its definition. Otherwise the definition is the baseline and overrides conflicting generic style, framing, or embellishment guidance. The latest explicit user prompt or revision remains authoritative, and compatible persistent guidance may refine only unspecified details.",
        "- Preserve all compatible surrounding prompt details and combine compatible reference definitions coherently.",
    ]


def _expand_additional_instructions(value):
    """Resolve an exact, case-insensitive shortcut without exposing it as a selector."""
    instruction = str(value or "").strip()
    if not instruction:
        return ""
    key = instruction.casefold()
    for template in _load_additional_instruction_templates():
        if str(template.get("name") or "").strip().casefold() == key:
            return str(template.get("instruction") or "").strip()
    return instruction


def _additional_instruction_prompt_lines(value):
    instruction = _expand_additional_instructions(value)
    if not instruction:
        return []
    lines = [
        "",
        "Persistent additional guidance:",
        instruction,
        "Apply this guidance only where it is compatible with the latest explicit user prompt or revision. The latest request is authoritative and must never be reversed, weakened, or silently replaced by this persistent setting.",
        "This guidance may refine selected style, framing, embellishment, format, or otherwise unspecified details, but it must not expand the requested edit scope, introduce unrelated subjects or scene concepts, or alter protected content.",
        "Do not copy meta-instruction language into the output unless it explicitly describes content the user wants generated.",
    ]
    return lines


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


def _coordinated_native_llm(provider):
    """Wrap whole native operations and provider helpers without route imports."""
    def decorate(operation):
        signature = inspect.signature(operation)
        @functools.wraps(operation)
        def scheduled(*args, **kwargs):
            bound = signature.bind(*args, **kwargs)
            bound.apply_defaults()
            settings = {"llm_provider": provider,
                        provider.replace("koboldcpp", "kobold") + "_url": bound.arguments.get(
                            provider.replace("koboldcpp", "kobold") + "_url")}
            coordinator = _llm_scheduling.SHARED_COORDINATOR
            nested = coordinator.current_token() is not None
            resources = [_llm_scheduling.endpoint_identity(settings)]
            if not nested:
                resources.append(("shared-gpu",))
            token = coordinator.current_token() or _llm_scheduling.CancellationToken(
                bound.arguments.get("cancellation_check"),
            )
            def run():
                if not nested and coordinator.native_prepare is not None:
                    coordinator.native_prepare(settings)
                token.check()
                return operation(*args, **kwargs)
            return coordinator.run(resources, run, token=token)
        return scheduled
    return decorate


def _provider_url_validator(url, service_name=""):
    name = service_name.casefold()
    if "ollama" in name:
        allowed, env = _allowed_ollama_hosts(), "PROMPT_STUDIO_OLLAMA_ALLOWED_HOSTS"
    elif "llama" in name:
        allowed, env = _allowed_llamacpp_hosts(), "PROMPT_STUDIO_LLAMACPP_ALLOWED_HOSTS"
    else:
        allowed, env = _allowed_kobold_hosts(), "PROMPT_STUDIO_KOBOLD_ALLOWED_HOSTS"
    parsed = urllib.parse.urlsplit(url)
    # Query strings are valid on provider endpoints; origin/credentials are
    # validated with the same policy used for the original configured URL.
    origin = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
    return _clean_service_base_url(origin, origin, service_name or "Provider", allowed, env)


def _open_provider_response(request, timeout, service_name=""):
    return _provider_transport.open_response(
        request, timeout, lambda url: _provider_url_validator(url, service_name),
    )


def _post_json(
    url,
    payload,
    timeout,
    service_name="KoboldCpp",
    response_hook=None,
    headers=None,
):
    data = json.dumps(payload).encode("utf-8")
    request_headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if headers:
        request_headers.update(headers)
    request = urllib.request.Request(
        url,
        data=data,
        headers=request_headers,
        method="POST",
    )
    try:
        with _open_provider_response(request, timeout, service_name) as response:
            if response_hook is not None:
                response_hook(response)
            try:
                body = response.read().decode("utf-8")
            finally:
                if response_hook is not None:
                    response_hook(None)
    except urllib.error.HTTPError as exc:
        detail = str(exc)
        raise RuntimeError(f"{service_name} request failed with HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach {service_name} at {url}: {exc.reason}") from exc

    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{service_name} returned invalid JSON: {body[:500]}") from exc


def _clean_llamacpp_base_url(url):
    return _clean_service_base_url(
        url,
        "http://localhost:8080",
        "Llama.cpp",
        _allowed_llamacpp_hosts(),
        "PROMPT_STUDIO_LLAMACPP_ALLOWED_HOSTS",
    )


def _list_ollama_models(ollama_url, request_timeout=10):
    base_url = _clean_ollama_base_url(ollama_url)
    url = _ollama_api_url(base_url, "tags")
    request = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    try:
        with _open_provider_response(request, request_timeout, "Ollama") as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = str(exc)
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


def _list_llamacpp_models(llamacpp_url, request_timeout=10):
    base_url = _clean_llamacpp_base_url(llamacpp_url)
    # /models lists both the active single model and router-mode available models.
    url = urllib.parse.urljoin(base_url + "/", "models")
    request = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    try:
        with _open_provider_response(request, request_timeout, "Llama.cpp") as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = str(exc)
        raise RuntimeError(f"Llama.cpp request failed with HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach Llama.cpp at {url}: {exc.reason}") from exc

    try:
        data = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Llama.cpp returned invalid JSON: {body[:500]}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("data"), list):
        raise RuntimeError(f"Unexpected Llama.cpp model-list response: {data}")
    models = []
    for item in data["data"]:
        if not isinstance(item, dict):
            continue
        name = str(item.get("id") or "").strip()
        if name and name not in models:
            models.append(name)
    return models


_LLAMACPP_ACTIVE_RESPONSES = {}
_LLAMACPP_ACTIVE_STREAMS = {}
_LLAMACPP_ABORTED_RESPONSES = set()
_LLAMACPP_RESPONSE_LOCK = threading.Lock()


def _llamacpp_active_stream_status(llamacpp_url):
    """Return the exact output phase observed in Prompt Studio-owned SSE streams."""
    base_url = _clean_llamacpp_base_url(llamacpp_url)
    with _LLAMACPP_RESPONSE_LOCK:
        streams = list(_LLAMACPP_ACTIVE_STREAMS.get(base_url, {}).values())
    if not streams:
        return None
    phases = {
        stream.get("generation_phase")
        for stream in streams
        if stream.get("generation_phase") in {"thinking", "generating"}
    }
    generation_phase = phases.pop() if len(phases) == 1 else "thinking_or_generating"
    return {
        "active_streams": len(streams),
        "generation_phase": generation_phase,
    }


def _abort_llamacpp_generation(llamacpp_url):
    """Close all live Prompt Studio streams for one llama-server endpoint."""
    base_url = _clean_llamacpp_base_url(llamacpp_url)
    with _LLAMACPP_RESPONSE_LOCK:
        responses = list(_LLAMACPP_ACTIVE_RESPONSES.get(base_url, ()))
        _LLAMACPP_ABORTED_RESPONSES.update(id(response) for response in responses)
    closed = 0
    for response in responses:
        try:
            response.close()
            closed += 1
        except Exception:
            pass
    return {"provider": "llamacpp", "success": closed > 0, "closed_streams": closed}


def _post_llamacpp_chat(base_url, payload, timeout, response_hook=None, cancellation_check=None):
    """Read llama-server's SSE chat stream while keeping it externally cancellable."""
    data = json.dumps({**payload, "stream": True}).encode("utf-8")
    request = urllib.request.Request(
        urllib.parse.urljoin(base_url + "/", "v1/chat/completions"),
        data=data,
        headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
        method="POST",
    )
    response = None
    response_id = None
    content_parts = []
    reasoning_parts = []
    finish_reason = None
    stream_complete = False
    chunks = []
    chat_template_kwargs = payload.get("chat_template_kwargs")
    thinking_enabled = bool(
        chat_template_kwargs.get("enable_thinking")
        if isinstance(chat_template_kwargs, dict) else False
    )
    try:
        response = _open_provider_response(request, timeout, "Llama.cpp")
        response_id = id(response)
        with _LLAMACPP_RESPONSE_LOCK:
            _LLAMACPP_ACTIVE_RESPONSES.setdefault(base_url, set()).add(response)
            _LLAMACPP_ACTIVE_STREAMS.setdefault(base_url, {})[response_id] = {
                "generation_phase": "thinking" if thinking_enabled else "generating",
            }
        if response_hook is not None:
            response_hook(response)
        for raw_line in response:
            if cancellation_check is not None and cancellation_check():
                with _LLAMACPP_RESPONSE_LOCK:
                    _LLAMACPP_ABORTED_RESPONSES.add(response_id)
                response.close()
                raise RuntimeError("Llama.cpp request was cancelled")
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line or line.startswith(":"):
                continue
            if not line.startswith("data:"):
                continue
            event = line[5:].strip()
            if event == "[DONE]":
                stream_complete = True
                break
            try:
                chunk = json.loads(event)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"Llama.cpp returned invalid stream JSON: {event[:500]}") from exc
            if isinstance(chunk, dict) and chunk.get("error"):
                raise RuntimeError(f"Llama.cpp reported an error: {chunk['error']}")
            # Retain bounded diagnostic metadata, not every streamed token.
            if len(chunks) < 32:
                chunks.append(chunk)
            choices = chunk.get("choices") if isinstance(chunk, dict) else None
            choice = choices[0] if isinstance(choices, list) and choices else None
            if not isinstance(choice, dict):
                continue
            delta = choice.get("delta")
            if isinstance(delta, dict):
                content_received = False
                if delta.get("content") is not None:
                    content = str(delta["content"])
                    content_parts.append(content)
                    content_received = bool(content)
                reasoning = delta.get("reasoning_content")
                if reasoning is None:
                    reasoning = delta.get("reasoning")
                reasoning_received = False
                if reasoning is not None:
                    reasoning = str(reasoning)
                    reasoning_parts.append(reasoning)
                    reasoning_received = bool(reasoning)
                if content_received or reasoning_received:
                    with _LLAMACPP_RESPONSE_LOCK:
                        stream = _LLAMACPP_ACTIVE_STREAMS.get(base_url, {}).get(response_id)
                        if stream is not None:
                            if content_received:
                                stream["generation_phase"] = "generating"
                            elif stream["generation_phase"] != "generating":
                                stream["generation_phase"] = "thinking"
            if choice.get("finish_reason") is not None:
                finish_reason = choice.get("finish_reason")
        with _LLAMACPP_RESPONSE_LOCK:
            aborted = response_id in _LLAMACPP_ABORTED_RESPONSES
        if aborted:
            raise RuntimeError("Llama.cpp request was cancelled")
        if not stream_complete and finish_reason is None:
            raise RuntimeError("Llama.cpp stream ended before completion")
    except urllib.error.HTTPError as exc:
        detail = str(exc)
        raise RuntimeError(f"Llama.cpp request failed with HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach Llama.cpp at {request.full_url}: {exc.reason}") from exc
    except (OSError, ValueError) as exc:
        with _LLAMACPP_RESPONSE_LOCK:
            aborted = response_id in _LLAMACPP_ABORTED_RESPONSES
        if aborted:
            raise RuntimeError("Llama.cpp request was cancelled") from exc
        raise RuntimeError(f"Llama.cpp stream failed: {exc}") from exc
    finally:
        if response_hook is not None and response is not None:
            response_hook(None)
        if response is not None:
            try:
                response.close()
            except Exception:
                pass
        if response_id is not None:
            with _LLAMACPP_RESPONSE_LOCK:
                active = _LLAMACPP_ACTIVE_RESPONSES.get(base_url)
                if active is not None:
                    active.discard(response)
                    if not active:
                        _LLAMACPP_ACTIVE_RESPONSES.pop(base_url, None)
                streams = _LLAMACPP_ACTIVE_STREAMS.get(base_url)
                if streams is not None:
                    streams.pop(response_id, None)
                    if not streams:
                        _LLAMACPP_ACTIVE_STREAMS.pop(base_url, None)
                _LLAMACPP_ABORTED_RESPONSES.discard(response_id)
    return {
        "choices": [{
            "message": {
                "content": "".join(content_parts),
                "reasoning_content": "".join(reasoning_parts),
            },
            "finish_reason": finish_reason,
        }],
        "stream_chunks": chunks,
    }


def _get_json(url, timeout, service_name="KoboldCpp"):
    request = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    try:
        with _open_provider_response(request, timeout, service_name) as response:
            body = response.read().decode("utf-8")
    except (urllib.error.URLError, RuntimeError, OSError):
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


def _llamacpp_props(base_url, timeout, model=""):
    query = urllib.parse.urlencode({"model": str(model).strip()}) if str(model).strip() else ""
    url = urllib.parse.urljoin(base_url + "/", "props")
    if query:
        url = f"{url}?{query}"
    data = _get_json(url, timeout, "Llama.cpp")
    return data if isinstance(data, dict) else {}


def _llamacpp_context_length(base_url, timeout, model=""):
    settings = _llamacpp_props(base_url, timeout, model).get("default_generation_settings")
    if not isinstance(settings, dict):
        return None
    try:
        return int(settings.get("n_ctx"))
    except (TypeError, ValueError):
        return None


def _llamacpp_token_count(base_url, timeout, messages, model, reasoning_effort, enable_thinking):
    chat_template_kwargs = {"enable_thinking": bool(enable_thinking)}
    if enable_thinking and reasoning_effort != "none":
        # Qwen 3.8 reads its native xhigh/medium/low level directly from the
        # Jinja context. Keep this explicit for llama.cpp builds predating the
        # top-level reasoning_effort forwarding path as well as current builds.
        chat_template_kwargs["reasoning_effort"] = reasoning_effort
    try:
        result = _post_json(
            urllib.parse.urljoin(base_url + "/", "v1/chat/completions/input_tokens"),
            {
                "model": model,
                "messages": messages,
                "reasoning_effort": reasoning_effort,
                "chat_template_kwargs": chat_template_kwargs,
            },
            timeout,
            service_name="Llama.cpp",
        )
    except RuntimeError:
        return None
    if not isinstance(result, dict):
        return None
    for key in ("input_tokens", "tokens"):
        try:
            return int(result[key])
        except (KeyError, TypeError, ValueError):
            pass
    return None


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


def _ollama_model_info(base_url, model, timeout):
    result = _post_json(
        _ollama_api_url(base_url, "show"),
        {"model": model},
        timeout,
        service_name="Ollama",
    )
    if not isinstance(result, dict):
        raise RuntimeError(f"Unexpected Ollama model-info response: {result}")
    return result


def _ollama_model_capabilities(base_url, model, timeout):
    result = _ollama_model_info(base_url, model, timeout)
    capabilities = result.get("capabilities")
    return [str(value).strip().casefold() for value in capabilities] if isinstance(capabilities, list) else []


def _ollama_model_context_length(model_info):
    metadata = model_info.get("model_info") if isinstance(model_info, dict) else None
    if not isinstance(metadata, dict):
        return None
    architecture = str(metadata.get("general.architecture") or "").strip()
    if architecture:
        try:
            primary = int(metadata.get(f"{architecture}.context_length"))
        except (TypeError, ValueError):
            primary = 0
        if primary > 0:
            return primary
    values = []
    for key, value in metadata.items():
        if not str(key).casefold().endswith(".context_length"):
            continue
        try:
            length = int(value)
        except (TypeError, ValueError):
            continue
        if length > 0:
            values.append(length)
    # If an older model omits general.architecture, choose the most conservative
    # advertised context rather than accidentally selecting an auxiliary encoder.
    return min(values) if values else None


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


def _llamacpp_vision_unavailable_reason(props, model):
    modalities = props.get("modalities") if isinstance(props, dict) else None
    if isinstance(modalities, dict) and modalities.get("vision") is True:
        return ""
    label = f" for '{model}'" if model else ""
    if isinstance(modalities, dict) and "vision" in modalities:
        return (
            f"Llama.cpp vision is not active{label}. Start llama-server with a supported "
            "multimodal model and its matching mmproj file."
        )
    return (
        f"Llama.cpp did not advertise vision capability{label}. Update llama.cpp or select a "
        "server/model whose /props response includes modalities.vision."
    )


def _llm_vision_capability(
    llm_provider,
    *,
    kobold_url="http://localhost:5001",
    ollama_url="http://localhost:11434",
    ollama_model="",
    llamacpp_url="http://localhost:8080",
    llamacpp_model="",
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
    if provider == "llamacpp":
        base_url = _clean_llamacpp_base_url(llamacpp_url)
        model = str(llamacpp_model or "").strip()
        if not model:
            models = _list_llamacpp_models(base_url, timeout)
            model = models[0] if len(models) == 1 else ""
        if not model:
            return {
                "available": False,
                "provider": "Llama.cpp",
                "reason": "Select a Llama.cpp model before dropping an image.",
            }
        props = _llamacpp_props(base_url, timeout, model)
        reason = _llamacpp_vision_unavailable_reason(props, model)
        return {"available": not reason, "provider": "Llama.cpp", "model": model, "reason": reason}
    raise ValueError("llm_provider must be koboldcpp, ollama, or llamacpp")


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
    allowance. High and XHigh have no reasoning cap and may use the remaining context window.
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
    elif fixed_reasoning_budgets and effort in {"high", "xhigh"}:
        # Normal requests supply safe_limit from KoboldCpp's actual context window.
        # Keep a generous fallback for direct calls if that capability is unavailable.
        total = int(safe_limit) if safe_limit is not None and safe_limit > 0 else response_tokens + 65536
    elif effort == "minimal":
        total = (response_tokens * 10 + 8) // 9
    elif effort == "low":
        total = (response_tokens * 10 + 6) // 7
    elif effort == "medium":
        total = (response_tokens * 5 + 1) // 2
    elif effort in {"high", "xhigh"}:
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


def _llamacpp_generation_budget(
    response_tokens,
    thinking_mode,
    safe_limit=None,
    reasoning_budget_tokens=0,
):
    """Return llama.cpp's combined output limit and optional hard reasoning cap.

    Qwen-style reasoning effort is a qualitative chat-template control, not a
    token budget. With no explicit cap, allow the model to use the available
    context window. A positive cap opts into llama.cpp's forced end-of-thinking
    mechanism and reserves the requested final-answer allowance when possible.
    """
    response_tokens = max(1, int(response_tokens))
    effort = _reasoning_effort(thinking_mode)
    safe_limit = int(safe_limit) if safe_limit is not None and safe_limit > 0 else None
    if effort == "none":
        total = response_tokens
        if safe_limit is not None:
            total = min(total, safe_limit)
        return max(1, total), None

    requested_cap = max(0, int(reasoning_budget_tokens or 0))
    if requested_cap > 0:
        total = response_tokens + requested_cap
        if safe_limit is not None:
            total = min(total, safe_limit)
        total = max(1, total)
        final_allowance = min(response_tokens, total)
        applied_cap = min(requested_cap, max(0, total - final_allowance))
        return total, applied_cap

    total = safe_limit if safe_limit is not None else response_tokens + 65536
    return max(1, total), None


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


@_coordinated_native_llm("koboldcpp")
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
    response_hook=None,
    cancellation_check=None,
    presence_penalty=0.0,
    response_schema=None,
):
    def ensure_active():
        if cancellation_check is not None and cancellation_check():
            raise RuntimeError("KoboldCpp request was cancelled")

    ensure_active()
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
        ensure_active()
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
            "presence_penalty": float(presence_penalty),
            "rep_pen": float(rep_pen),
            "rep_pen_range": int(rep_pen_range),
            "seed": int(sampler_seed),
            "chat_template_kwargs": chat_template_kwargs,
            "stop": stop_sequences,
            "encapsulate_thinking": True,
            "continue_assistant_turn": False,
            "stream": False,
        }
        if isinstance(response_schema, dict) and effort == "none":
            payload["grammar"] = JSON_OBJECT_GBNF
        if thinking_budget is not None:
            # KoboldCpp's top-level Minimal/Low/Medium efforts enforce percentage caps
            # before consulting thinking_budget_tokens. Keep the effort as a template
            # hint and omit it at the top level so the explicit fixed cap takes effect.
            chat_template_kwargs["reasoning_effort"] = effort
        else:
            payload["reasoning_effort"] = effort
        if thinking_budget is not None:
            payload["thinking_budget_tokens"] = thinking_budget

        ensure_active()
        result = _post_json(
            urllib.parse.urljoin(base_url + "/", "v1/chat/completions"),
            payload,
            timeout,
            response_hook=response_hook,
        )
        ensure_active()
        try:
            choice = result["choices"][0]
            message = choice["message"]
            content = message.get("content") or ""
            finish_reason = choice.get("finish_reason")
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError(f"Unexpected KoboldCpp response: {result}") from exc
        if finish_reason == "error":
            raise RuntimeError("KoboldCpp reported an error while processing the chat completion.")
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


@_coordinated_native_llm("llamacpp")
def _generate_llamacpp(
    prompt,
    llamacpp_url,
    llamacpp_model,
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
    response_hook=None,
    cancellation_check=None,
    presence_penalty=0.0,
    reasoning_budget_tokens=0,
    response_schema=None,
):
    def ensure_active():
        if cancellation_check is not None and cancellation_check():
            raise RuntimeError("Llama.cpp request was cancelled")

    ensure_active()
    base_url = _clean_llamacpp_base_url(llamacpp_url)
    timeout = int(request_timeout)
    model = str(llamacpp_model or "").strip()
    if not model:
        models = _list_llamacpp_models(base_url, timeout)
        if len(models) == 1:
            model = models[0]
        elif not models:
            raise ValueError("Llama.cpp did not report a loaded or available model")
        else:
            raise ValueError("Select a Llama.cpp model in Prompt Studio settings")

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
    else:
        has_images = bool(image_data_uri)
        user_content = str(prompt or "")
        if image_data_uri:
            user_content = [
                {"type": "text", "text": str(prompt or "")},
                {"type": "image_url", "image_url": {"url": str(image_data_uri)}},
            ]
        messages = [
            {"role": "system", "content": CHAT_SYSTEM_MESSAGE},
            {"role": "user", "content": user_content},
        ]
    if has_images:
        reason = _llamacpp_vision_unavailable_reason(
            _llamacpp_props(base_url, timeout, model),
            model,
        )
        if reason:
            raise RuntimeError(reason)

    effort = _reasoning_effort(thinking_mode)
    enable_thinking = effort != "none"
    prompt_tokens = _llamacpp_token_count(
        base_url,
        timeout,
        messages,
        model,
        effort,
        enable_thinking,
    )
    context_length = _llamacpp_context_length(base_url, timeout, model)
    if context_length is not None and prompt_tokens is not None and prompt_tokens >= context_length - 32:
        raise RuntimeError(
            f"The formatted request uses {prompt_tokens} tokens, leaving no usable space in "
            f"Llama.cpp's {context_length}-token context window. Shorten the instructions or "
            "increase llama-server's context size."
        )
    response_tokens = _requested_response_tokens(max_response_tokens, default_max_response_tokens)
    max_length, thinking_budget = _llamacpp_generation_budget(
        response_tokens,
        thinking_mode,
        _context_safe_generation_limit(context_length, prompt_tokens),
        reasoning_budget_tokens,
    )
    stop_sequences = _split_stop_sequences(stop_sequence)
    if include_default_continuation_stops and effort == "none":
        stop_sequences = _with_default_continuation_stops(stop_sequences)
    chat_template_kwargs = {"enable_thinking": enable_thinking}
    if enable_thinking:
        # Qwen 3.8 has three model-native effort values (xhigh, medium, low).
        # Sending the selected effort in both locations works with current
        # llama.cpp and with builds that expose only direct template kwargs.
        chat_template_kwargs["reasoning_effort"] = effort
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_length,
        "temperature": float(temperature),
        "top_p": float(top_p),
        "top_k": int(top_k),
        "min_p": float(min_p),
        "presence_penalty": float(presence_penalty),
        "repeat_penalty": float(rep_pen),
        "repeat_last_n": int(rep_pen_range),
        "seed": int(sampler_seed),
        "reasoning_effort": effort,
        "reasoning_format": "auto",
        "chat_template_kwargs": chat_template_kwargs,
        "stop": stop_sequences,
    }
    if isinstance(response_schema, dict):
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {
                "name": "prompt_studio_response",
                "schema": response_schema,
                "strict": True,
            },
        }
    if thinking_budget is not None:
        payload["thinking_budget_tokens"] = thinking_budget
    ensure_active()
    result = _post_llamacpp_chat(
        base_url,
        payload,
        timeout,
        response_hook=response_hook,
        cancellation_check=cancellation_check,
    )
    ensure_active()
    try:
        choice = result["choices"][0]
        message = choice["message"]
        content = str(message.get("content") or "")
        finish_reason = choice.get("finish_reason")
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"Unexpected Llama.cpp response: {result}") from exc
    if finish_reason == "length":
        raise RuntimeError(
            f"Llama.cpp exhausted the {max_length}-token completion budget before finishing. "
            "Increase max_response_tokens or llama-server's context size."
        )
    if not content.strip():
        if message.get("reasoning_content"):
            raise RuntimeError(
                "Llama.cpp returned reasoning but no final answer. Increase max_response_tokens "
                "or llama-server's context size."
            )
        raise RuntimeError(f"Llama.cpp returned an empty chat completion: {result}")
    return content


def _ollama_thinking_value(thinking_mode):
    effort = _reasoning_effort(thinking_mode)
    if effort == "none":
        return False
    if effort in {"minimal", "low"}:
        return "low"
    return effort


OLLAMA_MAX_REQUEST_CONTEXT = 65536


def _ollama_context_estimate(messages):
    """Conservatively estimate formatted text and vision tokens for Ollama.

    Ollama does not expose the model's exact formatted input-token count through
    its native chat API.  A conservative estimate is still preferable to
    silently relying on a small server default that may discard system or user
    context.  Image payload bytes are excluded; each image receives a separate
    vision-token allowance.
    """
    text_chars = 0
    image_count = 0
    for message in messages if isinstance(messages, list) else []:
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if isinstance(content, str):
            text_chars += len(content)
        elif isinstance(content, list):
            for part in content:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "text":
                    text_chars += len(str(part.get("text") or ""))
                elif part.get("type") == "image_url":
                    image_count += 1
        images = message.get("images")
        if isinstance(images, list):
            image_count += len(images)
    # English prompt text is commonly near four characters per token.  Two
    # characters per token leaves headroom for JSON/chat-template overhead and
    # less compact languages.  Vision encoders vary, so reserve a generous
    # fixed allowance per sanitized image.
    return math.ceil(text_chars / 2) + image_count * 4096 + 256


def _ollama_request_context(messages, completion_tokens, model_context_length=None):
    required = _ollama_context_estimate(messages) + max(1, int(completion_tokens))
    if model_context_length is not None and required > int(model_context_length):
        raise RuntimeError(
            f"The Ollama request needs approximately {required} context tokens, but the selected "
            f"model advertises a {int(model_context_length)}-token context window. Shorten the "
            "conversation or reduce the response budget."
        )
    if required > OLLAMA_MAX_REQUEST_CONTEXT:
        raise RuntimeError(
            f"The Ollama request needs approximately {required} context tokens, exceeding "
            f"Prompt Studio's {OLLAMA_MAX_REQUEST_CONTEXT}-token safety limit. Shorten the "
            "conversation or Director context."
        )
    # Stable power-of-two buckets avoid needless Ollama runner reloads between
    # closely related routing, rewrite, and discussion stages.
    context = 2048
    while context < required:
        context *= 2
    return min(context, int(model_context_length)) if model_context_length is not None else context


class _GenerationText(str):
    """A generated string with a non-fatal warning for interactive callers."""

    def __new__(cls, value, warning=""):
        instance = super().__new__(cls, str(value or ""))
        instance.warning = str(warning or "").strip()
        return instance


def _ollama_completion_warning(max_length, retried_without_thinking=False, partial=False):
    if retried_without_thinking:
        return (
            f"Ollama did not finish its first attempt within the {max_length}-token response "
            "budget, so Prompt Studio retried once with Thinking disabled. Review the result; "
            "increase Max response tokens if it looks incomplete."
        )
    if partial:
        return (
            f"Ollama reached the {max_length}-token response limit. Prompt Studio kept the partial "
            "result instead of failing, so it may be incomplete. Increase Max response tokens or "
            "lower/disable Thinking for this model."
        )
    return ""


def _unload_ollama_model(ollama_url, ollama_model, request_timeout=15):
    """Release a loaded Ollama model before ComfyUI starts diffusion work."""
    base_url = _clean_ollama_base_url(ollama_url)
    model = str(ollama_model or "").strip()
    if not model:
        raise ValueError("Select an Ollama model in Prompt Studio settings")
    result = _post_json(
        _ollama_api_url(base_url, "chat"),
        {
            "model": model,
            "messages": [],
            "stream": False,
            "keep_alive": 0,
        },
        int(request_timeout),
        service_name="Ollama",
    )
    if not isinstance(result, dict):
        raise RuntimeError(f"Unexpected Ollama unload response: {result}")
    if result.get("error"):
        raise RuntimeError(f"Ollama reported an unload error: {result['error']}")
    return result


@_coordinated_native_llm("ollama")
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
    response_hook=None,
    cancellation_check=None,
    allow_partial=True,
    keep_alive=30,
    presence_penalty=0.0,
    response_schema=None,
):
    def ensure_active():
        if cancellation_check is not None and cancellation_check():
            raise RuntimeError("Ollama request was cancelled")

    ensure_active()
    base_url = _clean_ollama_base_url(ollama_url)
    model = str(ollama_model or "").strip()
    if not model:
        raise ValueError("Select an Ollama model in Prompt Studio settings")
    ensure_active()
    model_info = _ollama_model_info(base_url, model, int(request_timeout))
    model_context_length = _ollama_model_context_length(model_info)
    has_images = bool(image_base64) or (
        messages_override is not None
        and any(
            isinstance(message, dict) and bool(message.get("images"))
            for message in messages_override
        )
    )
    if has_images:
        capabilities = model_info.get("capabilities")
        capabilities = (
            [str(value).strip().casefold() for value in capabilities]
            if isinstance(capabilities, list)
            else []
        )
        vision_reason = _ollama_vision_unavailable_reason(capabilities, model)
        if vision_reason:
            raise RuntimeError(vision_reason)
    ensure_active()

    stop_sequences = _split_stop_sequences(stop_sequence)
    if include_default_continuation_stops and _reasoning_effort(thinking_mode) == "none":
        stop_sequences = _with_default_continuation_stops(stop_sequences)
    response_tokens = _requested_response_tokens(max_response_tokens, default_max_response_tokens)
    max_length, _thinking_budget = _chat_generation_budget(response_tokens, thinking_mode)
    user_message = {"role": "user", "content": str(prompt or "")}
    if image_base64:
        user_message["images"] = [str(image_base64)]
    messages = messages_override if messages_override is not None else [
        {"role": "system", "content": CHAT_SYSTEM_MESSAGE},
        user_message,
    ]
    request_context = _ollama_request_context(messages, max_length, model_context_length)
    def generate_once(request_thinking_mode, prediction_limit):
        options = {
            "num_predict": int(prediction_limit),
            "num_ctx": request_context,
            "temperature": float(temperature),
            "top_p": float(top_p),
            "top_k": int(top_k),
            "min_p": float(min_p),
            "presence_penalty": float(presence_penalty),
            "repeat_penalty": float(rep_pen),
            "repeat_last_n": int(rep_pen_range),
            "stop": stop_sequences,
        }
        if int(sampler_seed) >= 0:
            options["seed"] = int(sampler_seed)
        payload = {
            "model": model,
            "messages": messages,
            "options": options,
            "think": _ollama_thinking_value(request_thinking_mode),
            "stream": False,
            # Reuse the runner across Prompt Studio's routing and rewrite stages. The
            # frontend explicitly unloads it immediately before queueing ComfyUI.
            "keep_alive": keep_alive,
        }
        if isinstance(response_schema, dict):
            payload["format"] = response_schema
        ensure_active()
        result = _post_json(
            _ollama_api_url(base_url, "chat"),
            payload,
            int(request_timeout),
            service_name="Ollama",
            response_hook=response_hook,
        )
        if not isinstance(result, dict):
            raise RuntimeError(f"Unexpected Ollama response: {result}")
        if result.get("error"):
            raise RuntimeError(f"Ollama reported an error: {result['error']}")
        try:
            message = result["message"]
            content = str(message.get("content") or "")
        except (KeyError, TypeError) as exc:
            raise RuntimeError(f"Unexpected Ollama response: {result}") from exc
        return content, message, result.get("done_reason"), result

    content, message, done_reason, result = generate_once(thinking_mode, max_length)
    if done_reason == "length" and content.strip() and allow_partial:
        return _GenerationText(
            content,
            _ollama_completion_warning(max_length, partial=True),
        )

    effort = _reasoning_effort(thinking_mode)
    retry_without_thinking = effort != "none" and (
        done_reason == "length" or not content.strip()
    )
    if retry_without_thinking:
        content, message, done_reason, result = generate_once("Disabled", max_length)
        warning = _ollama_completion_warning(
            max_length,
            retried_without_thinking=True,
        )
        if done_reason == "length":
            if content.strip() and allow_partial:
                return _GenerationText(
                    content,
                    f"{warning} {_ollama_completion_warning(max_length, partial=True)}",
                )
            raise RuntimeError(
                f"Ollama exhausted the {max_length}-token completion budget twice, including "
                "a retry with Thinking disabled. Increase max_response_tokens."
            )
        if content.strip():
            return _GenerationText(content, warning)

    if done_reason == "length":
        raise RuntimeError(
            f"Ollama exhausted the {max_length}-token completion budget before finishing. "
            "Increase max_response_tokens."
        )
    if not content.strip():
        if message.get("thinking"):
            raise RuntimeError(
                "Ollama returned reasoning but no final answer, including after a retry with "
                "Thinking disabled. Increase max_response_tokens."
            )
        raise RuntimeError(f"Ollama returned an empty chat completion: {result}")
    return str(content)


@_coordinated_native_llm("koboldcpp")
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
        raise RuntimeError("KoboldCpp reported an error while processing the raw completion.")
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

    text = re.sub(r"^\s*<\|channel\>thought\b.*?<channel\|>\s*", "", text, count=1, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"^\s*<\|channel\>analysis\b.*?<channel\|>\s*", "", text, count=1, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"^\s*<thinking>.*?</thinking>\s*", "", text, count=1, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"^\s*<think>.*?</think>\s*", "", text, count=1, flags=re.IGNORECASE | re.DOTALL)
    if not has_final_marker:
        text = re.sub(r"^.*?</thinking>", "", text, flags=re.IGNORECASE | re.DOTALL)
        text = re.sub(r"^.*?</think>", "", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"</(?:thinking|think)>", "", text, flags=re.IGNORECASE)
    output_match = re.fullmatch(r"\s*<output>(.*?)</output>\s*", text, flags=re.IGNORECASE | re.DOTALL)
    if output_match:
        text = output_match.group(1)
    fence_match = re.fullmatch(r"\s*```(?:text|prompt)?\s*\n?(.*?)\n?```\s*", text, flags=re.IGNORECASE | re.DOTALL)
    if fence_match:
        text = fence_match.group(1)
    text = re.sub(r"</?(?:output|final_prompt)>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^(?:rewritten prompt|amplified prompt|prompt)\s*:\s*", "", text, flags=re.IGNORECASE)
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
    if mode in {"minimal", "low", "medium", "high", "xhigh"}:
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
        "medium": "Make one concise pass: check the central subject, active style or framing, and requested output format, then answer without starting a second review pass.",
        "high": "Carefully verify every preserved detail, active style and framing constraint, forbidden addition, and output-format requirement.",
        "xhigh": "Thoroughly analyze and verify every preserved detail, active style and framing constraint, forbidden addition, interaction, and output-format requirement before answering.",
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
        "medium": "Make one concise pass: identify the edit target, replace its conflicting value, preserve everything else, then answer without starting a second review pass.",
        "high": "Carefully map the smallest sufficient edit scope, locate every obsolete or conflicting reference, preserve unrelated wording and tag order, and check for collateral changes.",
        "xhigh": "Thoroughly map the smallest sufficient edit scope, locate every obsolete or conflicting reference, preserve all unrelated wording and tag order, and verify the result for subtle collateral changes.",
    }.get(effort, "")
    if not focus:
        return "Analyze the edit scope silently and do not expose reasoning or change notes in the final answer."
    return (
        f"Use the model's private reasoning channel before answering. {focus} "
        "Do not repeat or summarize that reasoning in the final answer."
    )


def _positive_output_rule_lines(target="final prompt"):
    return [
        f"- Write the {target} only as affirmative descriptions of visible content to generate.",
        "- Express the desired state directly; omit absent, rejected, removed, or superseded alternatives, comparison, correction, and meta-instructions.",
    ]


def _output_length_spec(profile, embellishment_level="Clean"):
    style = str(profile.get("style") or "").lower()
    unit = "tags" if "tag" in style else "words"
    source = OUTPUT_LENGTH_SPECS[unit]
    level = str(embellishment_level or "Clean").strip().lower()
    defaults = dict(source["defaults"])
    return {
        "unit": unit,
        "min": int(source["min"]),
        "max": int(source["max"]),
        "step": int(source["step"]),
        "default": int(defaults.get(level, defaults["clean"])),
        "defaults": defaults,
    }


def _target_output_length(value, profile, embellishment_level="Clean"):
    spec = _output_length_spec(profile, embellishment_level)
    try:
        requested = int(value)
    except (TypeError, ValueError):
        requested = spec["default"]
    return max(spec["min"], min(spec["max"], requested))


def _target_length_response_tokens(target_output_length, profile, embellishment_level="Clean"):
    return _output_policy(target_output_length, profile, embellishment_level)["response_tokens"]


def _output_policy(target_output_length, profile, embellishment_level="Clean"):
    """One soft length contract; fidelity always outranks an approximate count."""
    target = _target_output_length(target_output_length, profile, embellishment_level)
    unit = _output_length_spec(profile, embellishment_level)["unit"]
    return {
        "target": target,
        "explicit": bool(target_output_length),
        "unit": unit,
        "minimum": max(1, int(target * 0.7)),
        "maximum": max(target, int(target * 1.3)),
        "response_tokens": target * (6 if unit == "tags" else 2) + (32 if unit == "tags" else 64),
        "fidelity_priority": True,
    }


def _select_expansion_candidate(current, candidate, profile, target_output_length=0, embellishment_level="Clean"):
    if not str(candidate or "").strip():
        return current
    if not str(current or "").strip():
        return candidate
    if not target_output_length:
        return candidate if _density_count(candidate, profile) > _density_count(current, profile) else current
    policy = _output_policy(target_output_length, profile, embellishment_level)
    def distance(value):
        count = _density_count(value, profile)
        return max(policy["minimum"] - count, 0, count - policy["maximum"])
    return candidate if distance(candidate) < distance(current) else current


def _output_policy_warning(text, profile, target_output_length, embellishment_level="Clean"):
    policy = _output_policy(target_output_length, profile, embellishment_level)
    count = _density_count(text, profile)
    if policy["minimum"] <= count <= policy["maximum"]:
        return ""
    return (f"Output has {count} {policy['unit']} for an approximate target of {policy['target']}. "
            "Review required details; content was not cut or padded to force the target.")


def _target_length_rule_lines(target_output_length, profile, embellishment_level="Clean", target="rewritten prompt"):
    if not target_output_length:
        return []
    policy = _output_policy(target_output_length, profile, embellishment_level)
    amount, unit = policy["target"], policy["unit"]
    return [
        f"- For this fresh rewrite, aim for about {amount} {unit} in the {target}.",
        "- This target replaces any earlier numeric length or density guidance.",
        "- Treat the target as approximate: preserve every required detail, and never pad, repeat, or omit important content merely to hit the number.",
    ]


def _combined_control_context(template, modifier, control_label):
    preset_name = str(template.get("name") or f"{control_label} preset")
    preset_instruction = str(template.get("instruction") or "").strip()
    modifier = str(modifier or "").strip()
    names = []
    instruction_parts = []
    if preset_instruction:
        names.append(preset_name)
        instruction_parts.extend(
            [
                f"Selected {control_label.casefold()} preset instruction:",
                preset_instruction,
            ]
        )
    if modifier:
        names.append(f"{control_label} modifier")
        instruction_parts.extend(
            [
                f"Additional {control_label.casefold()} modifier:",
                modifier,
            ]
        )
    return " + ".join(names), "\n".join(instruction_parts)


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


def _needs_expansion_retry(original, rewritten, embellishment_level, profile, target_output_length=0):
    level = str(embellishment_level or "Clean").strip().lower()
    if level not in {"detailed", "maximum", "ultra maximum"}:
        return False
    if not str(original or "").strip():
        return False
    if not str(rewritten or "").strip():
        return True

    if target_output_length:
        policy = _output_policy(target_output_length, profile, embellishment_level)
        # A rich setting is no reason to pad already long input or enforce a
        # sentence count on decimals, abbreviations or quoted punctuation.
        return (_density_count(original, profile) < policy["minimum"]
                and _density_count(rewritten, profile) < policy["minimum"])

    style = str(profile.get("style") or "").lower()
    if "tag" in style:
        if level == "detailed":
            return False
        original_tags = max(_tag_count(original), max(1, _word_count(original) // 2))
        rewritten_tags = _tag_count(rewritten)
        floor = 16 if level == "ultra maximum" else 10
        return original_tags < floor and rewritten_tags < floor

    if level == "detailed":
        return _sentence_count(rewritten) != 2

    original_words = _word_count(original)
    rewritten_words = _word_count(rewritten)
    floor = 120 if level == "ultra maximum" else 50
    if original_words < floor:
        return rewritten_words < floor
    return False


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
    target_output_length=0,
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

    style_name, style_instruction = _combined_control_context(
        style_template,
        style_modifier,
        "Style",
    )
    if style_instruction:
        prompt_parts.extend(
            [
                "",
                f"Active target style: {style_name}",
                style_instruction,
                "Apply the selected style preset and its modifier together. The modifier is an additional refinement and must not replace or discard the preset.",
                "Keep all added detail inside this style.",
            ]
        )

    framing_name, framing_instruction = _combined_control_context(
        framing_template,
        framing_modifier,
        "Framing",
    )
    if framing_instruction:
        prompt_parts.extend(
            [
                "",
                f"Active target framing: {framing_name}",
                framing_instruction,
                "Apply the selected framing preset and its modifier together. The modifier is an additional refinement and must not replace or discard the preset.",
                "Keep all added detail inside this framing.",
            ]
        )

    prompt_parts.extend(_additional_instruction_prompt_lines(additional_instructions))

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

    known_references = _matched_known_references(original_text, rewritten_text)
    protected_word_lines = _protected_word_instruction_lines(
        original_text,
        rewritten_text,
        excluded_literals=[reference["name"] for reference in known_references],
    )
    if protected_word_lines:
        prompt_parts.extend(["", *protected_word_lines])
    prompt_parts.extend(_known_reference_final_prompt_lines(known_references))

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
            "- Follow the user's explicit content request without sanitizing, substituting, or escalating it.",
            *_expansion_rule_lines(embellishment_level, profile),
            *_target_length_rule_lines(target_output_length, profile, embellishment_level, "expanded prompt"),
            *_positive_output_rule_lines("expanded prompt"),
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
    active_framing_name, active_framing_instruction = _combined_control_context(
        framing_template,
        framing_modifier,
        "Framing",
    )
    if active_framing_instruction:
        prompt_parts.extend(
            [
                "",
                f"Active target framing: {active_framing_name}",
                active_framing_instruction,
                "Apply the selected framing preset and its modifier together to the composition, viewpoint, shot type, and subject placement. The modifier is an additional refinement and must not replace or discard the preset.",
            ]
        )
    return active_framing_name, active_framing_instruction


def _build_instruction_prompt(profile, style_template, style_modifier, framing_template, framing_modifier, embellishment_level, thinking_mode, text, additional_instructions, target_output_length=0):
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

    active_style_name, active_style_instruction = _combined_control_context(
        style_template,
        style_modifier,
        "Style",
    )
    if active_style_instruction:
        prompt_parts.extend(
            [
                "",
                f"Active target style: {active_style_name}",
                active_style_instruction,
                "Apply the selected style preset and its modifier together to the entire rewritten prompt. The modifier is an additional refinement and must not replace or discard the preset. If the user's prompt contains conflicting style, medium, quality, camera, or rendering terms, replace them with this combined style while preserving the subject and concrete content.",
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

    prompt_parts.extend(_additional_instruction_prompt_lines(additional_instructions))

    known_references = _matched_known_references(text)
    protected_word_lines = _protected_word_instruction_lines(
        text,
        excluded_literals=[reference["name"] for reference in known_references],
    )
    if protected_word_lines:
        prompt_parts.extend(["", *protected_word_lines])
    prompt_parts.extend(_known_reference_final_prompt_lines(known_references))

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
            *_target_length_rule_lines(target_output_length, profile, embellishment_level),
            *_positive_output_rule_lines("rewritten prompt"),
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
    additional_instructions="",
):
    """Build a stateless edit request for Prompt Studio."""
    prompt_parts = [
        "You are a precision image-prompt editor.",
        "Return the complete current prompt after applying the user's requested revision, but perform the smallest coherent edit that fully satisfies the request.",
        "First infer the edit scope: the specific object, attribute, relationship, action, or visual category named or implied by the revision.",
        "Everything outside that scope is protected content and must remain semantically unchanged and as close to the original wording and order as the target prompt syntax permits.",
        "The requested revision has priority over conflicting details in the current prompt.",
        "Within the edit scope, replace the complete old attribute value, including qualifiers that belong to it; do not splice the new value into the old phrase or retain an omitted old qualifier.",
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

    style_name, style_instruction = _combined_control_context(
        style_template,
        style_modifier,
        "Style",
    )
    if style_instruction:
        prompt_parts.extend(
            [
                "",
                f"Active target style: {style_name}",
                style_instruction,
                "Apply the selected style preset and its modifier together. The modifier is an additional refinement and must not replace or discard the preset.",
                "Keep the replacement prompt inside this style unless the requested revision explicitly changes the style.",
                "For a targeted edit, use this style only to shape details inside the edit scope. Do not restyle protected content.",
            ]
        )

    framing_name, framing_instruction = _combined_control_context(
        framing_template,
        framing_modifier,
        "Framing",
    )
    if framing_instruction:
        prompt_parts.extend(
            [
                "",
                f"Active target framing: {framing_name}",
                framing_instruction,
                "Apply the selected framing preset and its modifier together. The modifier is an additional refinement and must not replace or discard the preset.",
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

    known_references = _matched_known_references(current_prompt, revision)
    protected_word_lines = _protected_word_instruction_lines(
        current_prompt,
        revision,
        excluded_literals=[reference["name"] for reference in known_references],
    )
    if protected_word_lines:
        prompt_parts.extend(["", *protected_word_lines])

    prompt_parts.extend(_additional_instruction_prompt_lines(additional_instructions))
    prompt_parts.extend(_known_reference_final_prompt_lines(known_references))

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
            "- When an attribute changes, replace its complete old value phrase throughout the prompt, including old qualifiers such as color tone, intensity, size, or age. Preserve neighboring attributes that describe a different property.",
            "- Example: 'dark wavy hair' revised with 'make her hair blonde' becomes 'blonde wavy hair', not 'dark blonde wavy hair'. 'Wavy' stays because it describes texture; 'dark' goes because it qualifies the replaced color.",
            "- Never keep both the old and new values for the same attribute, object, garment, person, action, pose, expression, location, lighting, or composition.",
            "- Do not satisfy a replacement by appending a new object. Preserve the existing object type unless the user asks to replace the object itself.",
            "- Clothing example: 'make her clothes blue' means locate all of her existing garment descriptions, remove conflicting clothing colors, make those same garments blue, and leave her body, face, pose, scene, lighting, and camera unchanged. Do not add a separate blue shirt.",
            "- Lighting example: 'use warm sunset lighting' means replace only illumination, color-temperature, exposure, highlight, and shadow details that conflict. Do not change the subjects, wardrobe, actions, setting objects, background layout, framing, or camera unless explicitly requested.",
            "- Background example: 'make the background more varied' may enrich background content according to the embellishment level, but must not change the foreground subject, wardrobe, pose, expression, lighting, framing, or camera.",
            "- The examples demonstrate edit boundaries only; never copy their subject matter or requested values into the response.",
            "- Resolve short contextual requests such as 'make it warmer' using the current prompt.",
            "- Before responding, silently check for contradictions, duplicated alternatives, obsolete target details, and any collateral change outside the edit scope.",
            *_positive_output_rule_lines("replacement prompt"),
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


def _build_main_revision_prompt(
    current_main_prompt,
    revision,
    thinking_mode,
):
    """Build a model-neutral edit request for Prompt Studio's stored user intent."""
    prompt_parts = [
        "You are editing the model-neutral main prompt behind an image-generation prompt.",
        "Return the complete updated main prompt after applying the user's requested revision.",
        "The main prompt stores only user-requested subject matter, actions, setting, attributes, and other durable intent.",
        "Use only the current main prompt and the user's requested revision as source content.",
        "It must not absorb decorative, stylistic, framing, camera, lighting, quality, or incidental details supplied by rendering controls, persistent additional instructions, or the rendered final prompt.",
        "Perform the smallest coherent edit that satisfies the request and preserve everything else as closely as possible.",
        "Return one complete main prompt, never a patch or a list of changes.",
        "",
        "Main-prompt rules:",
        "- Keep the main prompt as a direct description of the desired visual content, not an instruction to create, generate, draw, show, render, or produce something.",
        "- Interpret conversational or request framing in the revision as editing instructions; store only the resulting visual intent, while preserving request wording that is explicitly meant to appear as visible content.",
        "- Add or replace positive content when the user explicitly requests that content.",
        "- A requested attribute replacement must replace the complete old value phrase, including omitted old qualifiers, while preserving neighboring attributes that describe a different property.",
        "- Example: 'dark wavy hair' revised with 'make her hair blonde' becomes 'blonde wavy hair', not 'dark blonde wavy hair'.",
        "- If the user removes, deletes, reduces, or omits something that exists only in the rendered final prompt and not in the main prompt, leave the main prompt unchanged.",
        "- Never translate a removal into negative wording such as 'without', 'no', 'not', 'exclude', or 'avoid'.",
        "- Never add a removed auto-generated detail to the main prompt merely to record its removal.",
        "- Do not add prompt weights, model-specific syntax, quality tags, or automatic embellishment.",
        *_positive_output_rule_lines("updated main prompt"),
        "- Do not mention the editing process or explain what changed.",
        "- Do not include markdown.",
        f"- Start the final answer with exactly '{FINAL_PROMPT_MARKER}' followed by the updated main prompt.",
        f"- Do not put anything after the updated main prompt following '{FINAL_PROMPT_MARKER}'.",
    ]
    protected_word_lines = _protected_word_instruction_lines(current_main_prompt, revision)
    if protected_word_lines:
        prompt_parts.extend(["", *protected_word_lines])
    known_reference_lines = _known_reference_main_prompt_lines(
        current_main_prompt,
        revision,
    )
    if known_reference_lines:
        prompt_parts.extend(["", *known_reference_lines])
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
            "Requested revision:",
            str(revision or "").strip(),
        ]
    )
    return "\n".join(prompt_parts)


def _build_main_creation_prompt(
    user_request,
    thinking_mode,
):
    """Build the first model-neutral main prompt from a creation request."""
    prompt_parts = [
        "You convert a user's first image-creation request into Prompt Studio's model-neutral main prompt.",
        "The main prompt is a direct description of the visual content the user wants, not an instruction to create, generate, draw, show, or render something.",
        "Interpret the request semantically. Separate language used only to ask for an image from language that describes the desired content.",
        "Use only the user's image-creation request as source content. Rendering controls and persistent additional instructions belong only to the rendered final prompt.",
        "Preserve every explicitly requested subject, action, setting, relationship, attribute, medium, style, composition, camera choice, lighting choice, and other durable intent.",
        "Do not add decorative detail, automatic embellishment, inferred content, quality language, model-specific syntax, or prompt weights.",
        "Return one complete main prompt, never a response to the user, a patch, or a list of changes.",
        "",
        "Main-prompt semantics:",
        "- Begin directly with the content to depict and describe it affirmatively.",
        "- Never begin with or retain a request wrapper such as an instruction to create, generate, make, draw, show, render, or produce the result.",
        "- Omit generic container wording such as 'an image of', 'a picture of', or 'a photo of' when it merely introduces the actual subject.",
        "- Preserve image, picture, photograph, painting, drawing, and similar nouns when they are themselves requested visible objects or explicitly specify the desired medium. Decide this from meaning, not from a fixed phrase-removal rule.",
        "- Preserve an explicitly requested style or medium even when it appears inside the request framing.",
        "- Do not address the user, mention their request, or describe the act of making the image.",
        *_positive_output_rule_lines("main prompt"),
        "- Do not explain the transformation.",
        "- Do not include markdown.",
        f"- Start the final answer with exactly '{FINAL_PROMPT_MARKER}' followed by the main prompt.",
        f"- Do not put anything after the main prompt following '{FINAL_PROMPT_MARKER}'.",
    ]
    known_references = _matched_known_references(user_request)
    protected_word_lines = _protected_word_instruction_lines(
        user_request,
        excluded_literals=[reference["name"] for reference in known_references],
    )
    if protected_word_lines:
        prompt_parts.extend(["", *protected_word_lines])
    known_reference_lines = _known_reference_main_prompt_lines(user_request)
    if known_reference_lines:
        prompt_parts.extend(["", *known_reference_lines])
    if _reasoning_effort(thinking_mode) != "none":
        prompt_parts.extend(
            [
                "",
                "Reasoning policy:",
                "Silently distinguish request framing from desired visual content, verify that every explicit detail is preserved, then answer without exposing the analysis.",
            ]
        )
    prompt_parts.extend(
        [
            "",
            "User's image-creation request:",
            str(user_request or "").strip(),
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

    active_style_name, active_style_instruction = _combined_control_context(
        style_template,
        style_modifier,
        "Style",
    )
    if active_style_instruction:
        prompt_parts.extend(
            [
                "",
                f"Active target style: {active_style_name}",
                active_style_instruction,
                "Apply the selected style preset and its modifier together to this rewritten fragment. The modifier is an additional refinement and must not replace or discard the preset. If the fragment contains conflicting style, medium, quality, camera, or rendering terms, replace them with this combined style while preserving the subject and concrete content.",
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

    prompt_parts.extend(_additional_instruction_prompt_lines(additional_instructions))

    known_references = _matched_known_references(text)
    protected_word_lines = _protected_word_instruction_lines(
        text,
        excluded_literals=[reference["name"] for reference in known_references],
    )
    if protected_word_lines:
        prompt_parts.extend(["", *protected_word_lines])
    prompt_parts.extend(_known_reference_final_prompt_lines(known_references))

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
            *_positive_output_rule_lines("rewritten fragment"),
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
                        "tooltip": "Optional aesthetic/style guidance added to the selected style preset. Select None for modifier-only behavior.",
                    },
                ),
                "framing_preset": (_framing_template_names(),),
                "framing_modifier": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "Optional framing/composition guidance added to the selected framing preset. Select None for modifier-only behavior.",
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
                        "tooltip": "Optional phrases returned unchanged through the secondary_instructions output, such as LoRA trigger words.",
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

    @_coordinated_native_llm("koboldcpp")
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
                        "tooltip": "Optional phrases returned unchanged through the secondary_instructions output, such as LoRA trigger words.",
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
                        "tooltip": "Optional phrases returned unchanged through the secondary_instructions output, such as LoRA trigger words.",
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

    @_coordinated_native_llm("koboldcpp")
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
                        "tooltip": "Optional aesthetic/style guidance added to the selected style preset. Select None for modifier-only behavior.",
                    },
                ),
                "framing_preset": (_framing_template_names(),),
                "framing_modifier": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "Optional framing/composition guidance added to the selected framing preset. Select None for modifier-only behavior.",
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

    @_coordinated_native_llm("koboldcpp")
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


class KCPP_PromptStudioSampler:
    """A standard KSampler with an explicit Prompt Studio injection contract."""

    @classmethod
    def INPUT_TYPES(cls):
        import comfy.samplers

        return {
            "required": {
                "model": ("MODEL",),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xffffffffffffffff,
                        "control_after_generate": True,
                    },
                ),
                "steps": ("INT", {"default": 20, "min": 1, "max": 10000}),
                "cfg": ("FLOAT", {"default": 8.0, "min": 0.0, "max": 100.0, "step": 0.1, "round": 0.01}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS,),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS,),
                "positive": ("CONDITIONING",),
                "negative": ("CONDITIONING",),
                "latent_image": ("LATENT",),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("samples",)
    FUNCTION = "sample"
    CATEGORY = "Prompt Studio"
    DESCRIPTION = (
        "Behaves like ComfyUI's standard KSampler and exposes seed, sampler, scheduler, "
        "steps, CFG, and denoise as explicit Prompt Studio plot controls."
    )

    def sample(
        self,
        model,
        seed,
        steps,
        cfg,
        sampler_name,
        scheduler,
        positive,
        negative,
        latent_image,
        denoise=1.0,
    ):
        import nodes as comfy_nodes

        return comfy_nodes.common_ksampler(
            model,
            seed,
            steps,
            cfg,
            sampler_name,
            scheduler,
            positive,
            negative,
            latent_image,
            denoise=denoise,
        )


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
    "KCPP_PromptStudioSampler": KCPP_PromptStudioSampler,
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
    "KCPP_PromptStudioSampler": "Prompt Studio Sampler",
}
