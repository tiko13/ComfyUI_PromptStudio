import asyncio
import json
import math
import os
import shutil

from aiohttp import web
from server import PromptServer

from .nodes import (
    BASE_DIR,
    DEFAULT_PROFILE,
    _apply_profile_wrappers,
    _build_expansion_retry_prompt,
    _build_instruction_prompt,
    _build_revision_prompt,
    _chat_image_dimensions,
    _density_count,
    _generate_kcpp,
    _get_framing_template,
    _get_profile,
    _get_style_template,
    _load_framing_templates,
    _load_profiles,
    _load_style_templates,
    _needs_expansion_retry,
    _remove_known_profile_wrappers,
    _retry_seed,
    _strip_response,
)


CHAT_STORE_PATH = os.path.join(BASE_DIR, "prompt_studio_chats.json")
CHAT_STORE_LOCK = asyncio.Lock()
MAX_CHAT_STORE_BYTES = 20 * 1024 * 1024
WORKFLOW_STORE_PATH = os.path.join(BASE_DIR, "prompt_studio_workflows.json")
WORKFLOW_STORE_LOCK = asyncio.Lock()
MAX_WORKFLOW_STORE_BYTES = 100 * 1024 * 1024
MAX_REVISE_REQUEST_BYTES = 1024 * 1024
MAX_IMAGE_REFERENCE_BYTES = 16 * 1024


class StoreConflictError(RuntimeError):
    pass


def _text(value, default=""):
    if value is None:
        return default
    return str(value)


def _bounded_number(value, default, minimum, maximum, integer=False):
    if value is None or value == "":
        value = default
    try:
        number = int(value) if integer else float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Expected a {'whole' if integer else 'finite'} number, received {value!r}") from exc
    if not math.isfinite(float(number)) or number < minimum or number > maximum:
        raise ValueError(f"Number must be between {minimum} and {maximum}")
    return number


def _empty_chat_store():
    return {"version": 1, "revision": 0, "activeChatId": None, "chats": []}


def _empty_workflow_store():
    return {"version": 2, "revision": 0, "templates": []}


def _revision(value):
    try:
        revision = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, revision)


def _atomic_write_store(path, normalized, max_bytes, limit_message):
    encoded = json.dumps(normalized, ensure_ascii=False, indent=2).encode("utf-8")
    if len(encoded) > max_bytes:
        raise ValueError(limit_message)
    temporary_path = path + ".tmp"
    backup_path = path + ".bak"
    try:
        with open(temporary_path, "wb") as file:
            file.write(encoded)
            file.flush()
            os.fsync(file.fileno())
        if os.path.isfile(path):
            shutil.copy2(path, backup_path)
        os.replace(temporary_path, path)
    finally:
        try:
            os.remove(temporary_path)
        except FileNotFoundError:
            pass
    return normalized


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
    data["revision"] = _revision(data.get("revision"))
    return data


def _write_chat_store(data, current_revision=None):
    if not isinstance(data, dict) or not isinstance(data.get("chats"), list):
        raise ValueError("Chat store must contain a chats list")
    if current_revision is None:
        current_revision = _revision(data.get("revision"))
    normalized = {
        "version": 1,
        "revision": current_revision + 1,
        "activeChatId": data.get("activeChatId"),
        "chats": data["chats"],
    }
    return _atomic_write_store(
        CHAT_STORE_PATH,
        normalized,
        MAX_CHAT_STORE_BYTES,
        "Prompt Studio chat store exceeds the 20 MB limit",
    )


def _update_chat_store(data):
    current = _read_chat_store()
    expected = _revision(data.get("revision")) if isinstance(data, dict) else 0
    actual = _revision(current.get("revision"))
    if expected != actual:
        raise StoreConflictError("Chat history changed in another browser. Reload Prompt Studio before saving again.")
    return _write_chat_store(data, actual)


def _read_workflow_store():
    try:
        with open(WORKFLOW_STORE_PATH, "r", encoding="utf-8") as file:
            data = json.load(file)
    except FileNotFoundError:
        return _empty_workflow_store()
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid Prompt Studio workflow cache: {exc}") from exc
    if not isinstance(data, dict):
        raise RuntimeError("Prompt Studio workflow cache must be an object")
    if isinstance(data.get("profiles"), list) and "templates" not in data:
        # Version 1 stored manually captured profiles. They are intentionally not
        # migrated because ComfyUI's live [PS] workflows are now the source of truth.
        return {"version": 2, "revision": _revision(data.get("revision")), "templates": []}
    if not isinstance(data.get("templates"), list):
        raise RuntimeError("Prompt Studio workflow cache must contain a templates list")
    try:
        _validate_workflow_templates(data["templates"])
    except ValueError as exc:
        raise RuntimeError(f"Invalid Prompt Studio workflow cache: {exc}") from exc
    data["revision"] = _revision(data.get("revision"))
    return data


def _validate_workflow_templates(templates):
    paths = set()
    for index, template in enumerate(templates):
        if not isinstance(template, dict):
            raise ValueError(f"Workflow cache entry {index + 1} must be an object")
        path = _text(template.get("path") or template.get("id")).strip().replace("\\", "/")
        filename = path.rsplit("/", 1)[-1]
        if not path or path in paths:
            raise ValueError("Workflow cache entries must have unique non-empty paths")
        if not filename.startswith("[PS]") or not filename.lower().endswith(".json"):
            raise ValueError(f"Workflow cache entry {index + 1} is not a [PS] JSON workflow")
        paths.add(path)
        if not _text(template.get("name")).strip():
            raise ValueError(f"Workflow cache entry {index + 1} must have a name")
        kind = template.get("kind")
        if kind not in {"create", "edit"}:
            raise ValueError(f"Workflow cache entry {index + 1} kind must be create or edit")
        snapshot = template.get("snapshot")
        output = snapshot.get("output") if isinstance(snapshot, dict) else None
        prompt_node_id = _text(template.get("promptNodeId")).strip()
        if not isinstance(output, dict) or not prompt_node_id or prompt_node_id not in output:
            raise ValueError(f"Workflow cache entry {index + 1} has no executable prompt node")
        prompt_node = output[prompt_node_id]
        if not isinstance(prompt_node, dict) or prompt_node.get("class_type") not in {"KCPP_PromptSlot", "KCPP_PromptAmplify"}:
            raise ValueError(f"Workflow cache entry {index + 1} prompt node has an incompatible class")
        if kind == "edit":
            image_node_id = _text(template.get("imageNodeId")).strip()
            if not image_node_id or image_node_id not in output:
                raise ValueError(f"Workflow cache entry {index + 1} has no executable image source node")
            image_node = output[image_node_id]
            if not isinstance(image_node, dict) or image_node.get("class_type") != "KCPP_ChatImageInput":
                raise ValueError(f"Workflow cache entry {index + 1} image source has an incompatible class")
        result_node_ids = template.get("resultNodeIds", [])
        if (
            not isinstance(result_node_ids, list)
            or len(result_node_ids) != 1
            or _text(result_node_ids[0]) not in output
        ):
            raise ValueError(f"Workflow cache entry {index + 1} must identify exactly one image output")
        result_fields = template.get("resultFields", ["images", "gifs"])
        if not isinstance(result_fields, list) or not result_fields or any(not _text(field).strip() for field in result_fields):
            raise ValueError(f"Workflow cache entry {index + 1} has invalid history fields")


def _write_workflow_store(data, current_revision=None):
    if not isinstance(data, dict) or not isinstance(data.get("templates"), list):
        raise ValueError("Workflow cache must contain a templates list")
    _validate_workflow_templates(data["templates"])
    if current_revision is None:
        current_revision = _revision(data.get("revision"))
    normalized = {"version": 2, "revision": current_revision + 1, "templates": data["templates"]}
    return _atomic_write_store(
        WORKFLOW_STORE_PATH,
        normalized,
        MAX_WORKFLOW_STORE_BYTES,
        "Prompt Studio workflow cache exceeds the 100 MB limit",
    )


def _update_workflow_store(data):
    current = _read_workflow_store()
    expected = _revision(data.get("revision")) if isinstance(data, dict) else 0
    actual = _revision(current.get("revision"))
    if expected != actual:
        raise StoreConflictError("The Prompt Studio workflow cache changed in another browser. Reload Prompt Studio before saving again.")
    return _write_workflow_store(data, actual)


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
    if thinking_mode not in {"Disabled", "Minimal", "Low", "Medium", "High"}:
        raise ValueError("Invalid thinking_mode")
    if embellishment_level not in {"Minimal", "Clean", "Detailed", "Rich", "Maximum", "Ultra Maximum"}:
        raise ValueError("Invalid embellishment_level")

    max_response_tokens = _bounded_number(data.get("max_response_tokens"), 0, 0, 8192, integer=True)
    temperature = _bounded_number(data.get("temperature"), 0.7, 0.0, 5.0)
    top_p = _bounded_number(data.get("top_p"), 0.9, 0.0, 1.0)
    top_k = _bounded_number(data.get("top_k"), 100, 0, 200, integer=True)
    min_p = _bounded_number(data.get("min_p"), 0.0, 0.0, 1.0)
    rep_pen = _bounded_number(data.get("rep_pen"), 1.05, 0.5, 3.0)
    rep_pen_range = _bounded_number(data.get("rep_pen_range"), 360, 0, 4096, integer=True)
    sampler_seed = _bounded_number(data.get("sampler_seed"), -1, -1, 999999, integer=True)
    request_timeout = _bounded_number(data.get("request_timeout"), 120, 5, 600, integer=True)
    kobold_url = _text(data.get("kobold_url"), "http://localhost:5001")
    stop_sequence = _text(data.get("stop_sequence"))
    style_modifier = _text(data.get("style_modifier"))
    framing_modifier = _text(data.get("framing_modifier"))
    default_max_response_tokens = int(
        profile.get("default_max_response_tokens") or DEFAULT_PROFILE["default_max_response_tokens"]
    )

    if mode == "create":
        prompt = _build_instruction_prompt(
            profile,
            style_template,
            style_modifier,
            framing_template,
            framing_modifier,
            embellishment_level,
            thinking_mode,
            revision,
            "",
        )
    else:
        current_prompt = _remove_known_profile_wrappers(current_prompt)
        prompt = _build_revision_prompt(
            profile,
            style_template,
            style_modifier,
            framing_template,
            framing_modifier,
            embellishment_level,
            thinking_mode,
            current_prompt,
            revision,
        )

    def generate(request_prompt, seed):
        return _generate_kcpp(
            request_prompt,
            kobold_url,
            max_response_tokens,
            default_max_response_tokens,
            temperature,
            top_p,
            top_k,
            min_p,
            rep_pen,
            rep_pen_range,
            seed,
            thinking_mode,
            stop_sequence,
            request_timeout,
            include_default_continuation_stops=True,
        )

    raw = generate(prompt, sampler_seed)
    revised = _strip_response(raw)
    if mode == "create" and _needs_expansion_retry(revision, revised, embellishment_level, profile):
        retry_prompt = _build_expansion_retry_prompt(
            profile,
            style_template,
            style_modifier,
            framing_template,
            framing_modifier,
            embellishment_level,
            thinking_mode,
            revision,
            revised,
            "",
        )
        retry = _strip_response(generate(retry_prompt, _retry_seed(sampler_seed)))
        if retry and _density_count(retry, profile) > _density_count(revised, profile):
            revised = retry
    if not revised:
        raise RuntimeError("KoboldCpp returned an empty prompt")
    return _apply_profile_wrappers(revised, profile)


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


@PromptServer.instance.routes.post("/lllm/prompt-studio/image-size")
async def prompt_studio_image_size(request):
    try:
        if request.content_length is not None and request.content_length > MAX_IMAGE_REFERENCE_BYTES:
            raise ValueError("Prompt Studio image reference exceeds the 16 KB limit")
        data = await request.json()
        if not isinstance(data, dict) or not isinstance(data.get("image"), dict):
            raise ValueError("JSON body must contain an image reference")
        width, height = await asyncio.to_thread(_chat_image_dimensions, json.dumps(data["image"]))
        return web.json_response({"width": width, "height": height})
    except (ValueError, json.JSONDecodeError, OSError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


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
            saved = await asyncio.to_thread(_update_chat_store, data)
        return web.json_response({"ok": True, "revision": saved["revision"]})
    except StoreConflictError as exc:
        return web.json_response({"error": str(exc)}, status=409)
    except (ValueError, json.JSONDecodeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


@PromptServer.instance.routes.get("/lllm/prompt-studio/workflows")
async def prompt_studio_get_workflows(request):
    try:
        async with WORKFLOW_STORE_LOCK:
            data = await asyncio.to_thread(_read_workflow_store)
        return web.json_response(data)
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


@PromptServer.instance.routes.put("/lllm/prompt-studio/workflows")
async def prompt_studio_save_workflows(request):
    try:
        if request.content_length is not None and request.content_length > MAX_WORKFLOW_STORE_BYTES:
            raise ValueError("Prompt Studio workflow cache exceeds the 100 MB limit")
        data = await request.json()
        async with WORKFLOW_STORE_LOCK:
            saved = await asyncio.to_thread(_update_workflow_store, data)
        return web.json_response({"ok": True, "revision": saved["revision"]})
    except StoreConflictError as exc:
        return web.json_response({"error": str(exc)}, status=409)
    except (ValueError, json.JSONDecodeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


@PromptServer.instance.routes.post("/lllm/prompt-studio/revise")
async def prompt_studio_revise(request):
    try:
        if request.content_length is not None and request.content_length > MAX_REVISE_REQUEST_BYTES:
            raise ValueError("Prompt Studio revision request exceeds the 1 MB limit")
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError("JSON body must be an object")
        revised = await asyncio.to_thread(_revise, data)
        return web.json_response({"prompt": revised})
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=502)
