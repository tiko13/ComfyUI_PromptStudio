import asyncio
import json
import os

from aiohttp import web
from server import PromptServer

from .nodes import (
    BASE_DIR,
    DEFAULT_PROFILE,
    _build_instruction_prompt,
    _build_revision_prompt,
    _generate_kcpp,
    _get_framing_template,
    _get_profile,
    _get_style_template,
    _load_framing_templates,
    _load_profiles,
    _load_style_templates,
    _strip_response,
)


CHAT_STORE_PATH = os.path.join(BASE_DIR, "prompt_studio_chats.json")
CHAT_STORE_LOCK = asyncio.Lock()
MAX_CHAT_STORE_BYTES = 20 * 1024 * 1024


def _text(value, default=""):
    if value is None:
        return default
    return str(value)


def _empty_chat_store():
    return {"version": 1, "activeChatId": None, "chats": []}


def _read_chat_store():
    try:
        with open(CHAT_STORE_PATH, "r", encoding="utf-8") as file:
            data = json.load(file)
    except FileNotFoundError:
        return _empty_chat_store()
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid Prompt Studio chat store: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("chats"), list):
        raise RuntimeError("Prompt Studio chat store must contain a chats list")
    return data


def _write_chat_store(data):
    if not isinstance(data, dict) or not isinstance(data.get("chats"), list):
        raise ValueError("Chat store must contain a chats list")
    normalized = {
        "version": 1,
        "activeChatId": data.get("activeChatId"),
        "chats": data["chats"],
    }
    encoded = json.dumps(normalized, ensure_ascii=False, indent=2).encode("utf-8")
    if len(encoded) > MAX_CHAT_STORE_BYTES:
        raise ValueError("Prompt Studio chat store exceeds the 20 MB limit")
    temporary_path = CHAT_STORE_PATH + ".tmp"
    with open(temporary_path, "wb") as file:
        file.write(encoded)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary_path, CHAT_STORE_PATH)


def _revise(data):
    current_prompt = _text(data.get("current_prompt")).strip()
    revision = _text(data.get("revision")).strip()
    if not revision:
        raise ValueError("revision is required")

    mode = _text(data.get("mode"), "revise")
    if mode not in ("create", "revise"):
        raise ValueError("mode must be create or revise")
    if mode == "revise" and not current_prompt:
        raise ValueError("current_prompt is required")

    profile = _get_profile(_text(data.get("model_profile"), "General Natural Language"))
    style_template = _get_style_template(_text(data.get("style_preset"), "None"))
    framing_template = _get_framing_template(_text(data.get("framing_preset"), "None"))
    thinking_mode = _text(data.get("thinking_mode"), "Disabled")
    embellishment_level = _text(data.get("embellishment_level"), "Clean")

    if mode == "create":
        prompt = _build_instruction_prompt(
            profile,
            style_template,
            _text(data.get("style_modifier")),
            framing_template,
            _text(data.get("framing_modifier")),
            embellishment_level,
            thinking_mode,
            revision,
            "",
        )
    else:
        prompt = _build_revision_prompt(
            profile,
            style_template,
            _text(data.get("style_modifier")),
            framing_template,
            _text(data.get("framing_modifier")),
            embellishment_level,
            thinking_mode,
            current_prompt,
            revision,
        )

    raw = _generate_kcpp(
        prompt,
        _text(data.get("kobold_url"), "http://localhost:5001"),
        int(data.get("max_response_tokens", 0) or 0),
        int(profile.get("default_max_response_tokens") or DEFAULT_PROFILE["default_max_response_tokens"]),
        float(data.get("temperature", 0.7)),
        float(data.get("top_p", 0.9)),
        int(data.get("top_k", 100)),
        float(data.get("min_p", 0.0)),
        float(data.get("rep_pen", 1.05)),
        int(data.get("rep_pen_range", 360)),
        int(data.get("sampler_seed", -1)),
        thinking_mode,
        _text(data.get("stop_sequence")),
        int(data.get("request_timeout", 120)),
        include_default_continuation_stops=True,
    )
    revised = _strip_response(raw)
    if not revised:
        raise RuntimeError("KoboldCpp returned an empty prompt")

    return (
        str(profile.get("final_prompt_prefix") or "")
        + revised
        + str(profile.get("final_prompt_suffix") or "")
    )


@PromptServer.instance.routes.get("/lllm/prompt-studio/config")
async def prompt_studio_config(request):
    return web.json_response(
        {
            "profiles": [profile["name"] for profile in _load_profiles()],
            "styles": [template["name"] for template in _load_style_templates()],
            "framings": [template["name"] for template in _load_framing_templates()],
            "thinking_modes": ["Disabled", "Minimal", "Low", "Medium", "High"],
            "embellishment_levels": [
                "Minimal",
                "Clean",
                "Detailed",
                "Rich",
                "Maximum",
                "Ultra Maximum",
            ],
        }
    )


@PromptServer.instance.routes.get("/lllm/prompt-studio/chats")
async def prompt_studio_get_chats(request):
    try:
        async with CHAT_STORE_LOCK:
            data = await asyncio.to_thread(_read_chat_store)
        return web.json_response(data)
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


@PromptServer.instance.routes.put("/lllm/prompt-studio/chats")
async def prompt_studio_save_chats(request):
    try:
        if request.content_length is not None and request.content_length > MAX_CHAT_STORE_BYTES:
            raise ValueError("Prompt Studio chat store exceeds the 20 MB limit")
        data = await request.json()
        async with CHAT_STORE_LOCK:
            await asyncio.to_thread(_write_chat_store, data)
        return web.json_response({"ok": True})
    except (ValueError, json.JSONDecodeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


@PromptServer.instance.routes.post("/lllm/prompt-studio/revise")
async def prompt_studio_revise(request):
    try:
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError("JSON body must be an object")
        revised = await asyncio.to_thread(_revise, data)
        return web.json_response({"prompt": revised})
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=502)
