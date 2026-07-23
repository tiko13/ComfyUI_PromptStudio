import asyncio
import base64
import hashlib
import hmac
import html
import ipaddress
import json
import logging
import math
import os
import secrets
import shutil
import time
import urllib.parse

from aiohttp import web
from server import PromptServer

from .nodes import (
    BASE_DIR,
    DEFAULT_PROFILE,
    _apply_profile_wrappers,
    _build_expansion_retry_prompt,
    _build_instruction_prompt,
    _build_main_revision_prompt,
    _build_revision_prompt,
    _chat_image_vision_payload,
    _chat_image_dimensions,
    _density_count,
    _generate_kcpp,
    _generate_ollama,
    _get_framing_template,
    _get_profile,
    _get_style_template,
    _load_framing_templates,
    _load_profiles,
    _load_style_templates,
    _list_ollama_models,
    _lora_names_for_type,
    _llm_vision_capability,
    _needs_expansion_retry,
    _parse_chat_image_reference,
    _remove_known_profile_wrappers,
    _retry_seed,
    _sanitize_prompt_studio_image,
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
MAX_LLM_CONFIG_REQUEST_BYTES = 16 * 1024
MAX_VISION_REQUEST_BYTES = 32 * 1024
MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_IMAGE_UPLOAD_REQUEST_BYTES = MAX_IMAGE_UPLOAD_BYTES + 1024 * 1024
STANDALONE_PAGE_PATH = os.path.join(BASE_DIR, "web", "prompt_studio.html")
STANDALONE_ALIAS_PATH = "/PromptStudio"

LAN_PASSWORD_ENV = "PROMPT_STUDIO_LAN_PASSWORD"
LAN_PASSWORD_BASE64_ENV = "PROMPT_STUDIO_LAN_PASSWORD_B64"
LAN_PASSWORD_MIN_LENGTH = 12
LAN_SESSION_COOKIE = "promptstudio_lan_session"
LAN_SESSION_SECONDS = 12 * 60 * 60
LAN_LOGIN_PATH = "/promptstudio/lan/login"
LAN_LOGOUT_PATH = "/promptstudio/lan/logout"
LAN_LOGIN_MAX_BYTES = 4096
LAN_LOGIN_FAILURE_LIMIT = 5
LAN_LOGIN_FAILURE_WINDOW = 5 * 60
LAN_SESSION_SECRET = secrets.token_bytes(32)
LAN_LOGIN_FAILURES = {}
VISION_CAPTION_PROMPT = """Inspect the attached image and write an accurate, model-neutral source prompt for an image-generation workflow.

Describe only what is visibly present. Capture the subjects and their count, appearance, pose or action, setting, composition, viewpoint, lighting, colors, medium, and any legible text when relevant. Do not invent hidden details or identify real people. Do not mention that you saw an image, a reference, or an attachment. Return only one concise but sufficiently detailed natural-language description, without a label, commentary, or Markdown."""

_LAN_IPV4_NETWORKS = tuple(
    ipaddress.ip_network(value)
    for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16")
)
_LAN_IPV6_NETWORKS = tuple(ipaddress.ip_network(value) for value in ("fc00::/7", "fe80::/10"))


def _password_from_environment():
    password = os.environ.get(LAN_PASSWORD_ENV)
    if password is not None:
        return password
    encoded = os.environ.get(LAN_PASSWORD_BASE64_ENV, "")
    if not encoded:
        return ""
    try:
        return base64.b64decode(encoded, validate=True).decode("utf-8")
    except (UnicodeDecodeError, ValueError) as exc:
        raise RuntimeError(f"{LAN_PASSWORD_BASE64_ENV} is not valid Base64-encoded UTF-8") from exc


LAN_PASSWORD = _password_from_environment()


class StoreConflictError(RuntimeError):
    pass


def _client_ip(value):
    if not value:
        return None
    try:
        address = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        return address.ipv4_mapped
    return address


def _is_loopback_client(value):
    address = _client_ip(value)
    return bool(address and address.is_loopback)


def _is_lan_client(value):
    address = _client_ip(value)
    if not address:
        return False
    networks = _LAN_IPV4_NETWORKS if isinstance(address, ipaddress.IPv4Address) else _LAN_IPV6_NETWORKS
    return any(address in network for network in networks)


def _session_token(now=None):
    expires = int(time.time() if now is None else now) + LAN_SESSION_SECONDS
    payload = f"{expires}.{secrets.token_urlsafe(18)}"
    signature = hmac.new(LAN_SESSION_SECRET, payload.encode("ascii"), hashlib.sha256).digest()
    encoded_signature = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
    return f"{payload}.{encoded_signature}"


def _valid_session_token(token, now=None):
    try:
        expires_text, nonce, supplied_signature = token.split(".", 2)
        expires = int(expires_text)
        if not nonce or expires < int(time.time() if now is None else now):
            return False
        payload = f"{expires_text}.{nonce}"
        signature = hmac.new(LAN_SESSION_SECRET, payload.encode("ascii"), hashlib.sha256).digest()
        expected_signature = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
        return hmac.compare_digest(supplied_signature, expected_signature)
    except (AttributeError, TypeError, ValueError):
        return False


def _safe_next_path(value):
    value = str(value or "")
    parsed = urllib.parse.urlsplit(value)
    decoded_path = urllib.parse.unquote(parsed.path)
    if (
        parsed.scheme
        or parsed.netloc
        or not parsed.path.startswith("/")
        or decoded_path.startswith("//")
        or "\\" in decoded_path
        or "\r" in decoded_path
        or "\n" in decoded_path
    ):
        return "/extensions/ComfyUI_PromptStudio/prompt_studio.html"
    return urllib.parse.urlunsplit(("", "", parsed.path, parsed.query, ""))


def _same_origin_request(request):
    if request.headers.get("Sec-Fetch-Site", "").lower() == "cross-site":
        return bool(
            request.method in {"GET", "HEAD"}
            and request.headers.get("Sec-Fetch-Mode", "").lower() == "navigate"
        )
    origin = request.headers.get("Origin")
    if not origin:
        return True
    try:
        origin_parts = urllib.parse.urlsplit(origin)
        return bool(
            origin_parts.scheme in {"http", "https"}
            and origin_parts.scheme == request.scheme
            and origin_parts.netloc
            and origin_parts.netloc.lower() == request.host.lower()
        )
    except (AttributeError, ValueError):
        return False


def _login_attempt_allowed(remote, now=None):
    current = time.monotonic() if now is None else now
    failures = [
        failure
        for failure in LAN_LOGIN_FAILURES.get(remote, [])
        if current - failure < LAN_LOGIN_FAILURE_WINDOW
    ]
    LAN_LOGIN_FAILURES[remote] = failures
    return len(failures) < LAN_LOGIN_FAILURE_LIMIT


def _record_login_failure(remote, now=None):
    current = time.monotonic() if now is None else now
    LAN_LOGIN_FAILURES.setdefault(remote, []).append(current)


def _login_page(next_path, message="", status=200):
    safe_next = _safe_next_path(next_path)
    message_markup = f'<p class="error" role="alert">{html.escape(message)}</p>' if message else ""
    content = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Prompt Studio LAN sign in</title>
  <style>
    :root {{ color-scheme: dark; font-family: Inter, system-ui, sans-serif; }}
    body {{ min-height: 100vh; margin: 0; display: grid; place-items: center; background: #11151c; color: #edf2f7; }}
    main {{ width: min(88vw, 360px); padding: 28px; border: 1px solid #344154; border-radius: 14px; background: #1a202b; box-shadow: 0 18px 55px #0008; }}
    h1 {{ margin: 0 0 8px; font-size: 1.35rem; }}
    p {{ margin: 0 0 20px; color: #aeb9c9; line-height: 1.45; }}
    .error {{ padding: 10px; border-radius: 8px; color: #ffd7d7; background: #672b35; }}
    label {{ display: grid; gap: 7px; font-size: .82rem; color: #bdc8d8; }}
    input, button {{ box-sizing: border-box; width: 100%; min-height: 42px; border-radius: 8px; font: inherit; }}
    input {{ padding: 9px 11px; border: 1px solid #47566d; background: #10151d; color: inherit; }}
    button {{ margin-top: 14px; border: 0; background: #6d5dfc; color: white; font-weight: 700; cursor: pointer; }}
    small {{ display: block; margin-top: 16px; color: #7f8b9c; }}
  </style>
</head>
<body>
  <main>
    <h1>Prompt Studio</h1>
    <p>This ComfyUI server accepts authenticated devices on the local network only.</p>
    {message_markup}
    <form method="post" action="{LAN_LOGIN_PATH}">
      <input type="hidden" name="next" value="{html.escape(safe_next, quote=True)}">
      <label>Password <input name="password" type="password" autocomplete="current-password" autofocus required></label>
      <button type="submit">Sign in</button>
    </form>
    <small>Sessions expire after 12 hours or when ComfyUI restarts.</small>
  </main>
</body>
</html>"""
    response = web.Response(text=content, content_type="text/html", status=status)
    response.headers.update(
        {
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        }
    )
    return response


def _auth_error(request):
    accepts_html = "text/html" in request.headers.get("Accept", "")
    if request.method in {"GET", "HEAD"} and accepts_html:
        target = urllib.parse.quote(_safe_next_path(str(request.rel_url)), safe="")
        return web.Response(status=303, headers={"Location": f"{LAN_LOGIN_PATH}?next={target}"})
    return web.json_response({"error": "Prompt Studio LAN authentication required"}, status=401)


async def _lan_access_middleware(request, handler):
    remote = request.remote
    if _is_loopback_client(remote):
        return await handler(request)
    if not _is_lan_client(remote):
        return web.Response(text="Prompt Studio LAN access is limited to private network addresses.", status=403)
    if request.path != LAN_LOGIN_PATH and not _same_origin_request(request):
        return web.Response(text="Cross-origin LAN requests are not allowed.", status=403)

    next_path = _safe_next_path(request.query.get("next"))
    if request.path == LAN_LOGIN_PATH:
        if request.method == "GET":
            if len(LAN_PASSWORD) < LAN_PASSWORD_MIN_LENGTH:
                return _login_page(next_path, f"{LAN_PASSWORD_ENV} must contain at least {LAN_PASSWORD_MIN_LENGTH} characters.", 503)
            return _login_page(next_path)
        if request.method == "POST":
            if request.content_length is not None and request.content_length > LAN_LOGIN_MAX_BYTES:
                return _login_page(next_path, "The sign-in request is too large.", 413)
            if not _login_attempt_allowed(remote):
                response = _login_page(next_path, "Too many failed attempts. Try again in a few minutes.", 429)
                response.headers["Retry-After"] = str(LAN_LOGIN_FAILURE_WINDOW)
                return response
            try:
                data = await request.post()
            except Exception:
                return _login_page(next_path, "The sign-in request is invalid.", 400)
            next_path = _safe_next_path(data.get("next"))
            supplied_password = str(data.get("password", ""))
            password_matches = hmac.compare_digest(
                supplied_password.encode("utf-8"),
                LAN_PASSWORD.encode("utf-8"),
            )
            if len(LAN_PASSWORD) >= LAN_PASSWORD_MIN_LENGTH and password_matches:
                LAN_LOGIN_FAILURES.pop(remote, None)
                response = web.Response(status=303, headers={"Location": next_path, "Cache-Control": "no-store"})
                response.set_cookie(
                    LAN_SESSION_COOKIE,
                    _session_token(),
                    max_age=LAN_SESSION_SECONDS,
                    httponly=True,
                    samesite="Strict",
                    secure=bool(getattr(request, "secure", False)),
                    path="/",
                )
                return response
            _record_login_failure(remote)
            return _login_page(next_path, "Incorrect password.", 401)
        return web.Response(status=405, headers={"Allow": "GET, POST"})

    if request.path == LAN_LOGOUT_PATH and request.method == "POST":
        response = web.Response(status=303, headers={"Location": LAN_LOGIN_PATH, "Cache-Control": "no-store"})
        response.del_cookie(LAN_SESSION_COOKIE, path="/")
        return response

    if not _valid_session_token(request.cookies.get(LAN_SESSION_COOKIE)):
        return _auth_error(request)
    return await handler(request)


def _install_lan_access_middleware():
    if not LAN_PASSWORD:
        return False
    application = getattr(PromptServer.instance, "app", None)
    if application is None:
        raise RuntimeError("Prompt Studio cannot enable LAN access because the ComfyUI application is unavailable")
    if getattr(application, "_promptstudio_lan_middleware_installed", False):
        return True
    application.middlewares.insert(0, web.middleware(_lan_access_middleware))
    application._promptstudio_lan_middleware_installed = True
    if len(LAN_PASSWORD) < LAN_PASSWORD_MIN_LENGTH:
        logging.error(
            "Prompt Studio LAN access is locked: %s must contain at least %d characters",
            LAN_PASSWORD_ENV,
            LAN_PASSWORD_MIN_LENGTH,
        )
    else:
        logging.info("Prompt Studio LAN password gate enabled for private network clients")
    return True


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
    return {"version": 3, "revision": 0, "templates": []}


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
        return {"version": 3, "revision": _revision(data.get("revision")), "templates": []}
    if data.get("version") != 3:
        return {"version": 3, "revision": _revision(data.get("revision")), "templates": []}
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
        if kind not in {"create", "edit", "upscale"}:
            raise ValueError(f"Workflow cache entry {index + 1} kind must be create, edit, or upscale")
        snapshot = template.get("snapshot")
        output = snapshot.get("output") if isinstance(snapshot, dict) else None
        prompt_node_id = _text(template.get("promptNodeId")).strip()
        if not isinstance(output, dict):
            raise ValueError(f"Workflow cache entry {index + 1} has no executable snapshot")
        if prompt_node_id:
            if prompt_node_id not in output:
                raise ValueError(f"Workflow cache entry {index + 1} has no executable prompt node")
            prompt_node = output[prompt_node_id]
            if not isinstance(prompt_node, dict) or prompt_node.get("class_type") not in {"KCPP_PromptSlot", "KCPP_PromptAmplify"}:
                raise ValueError(f"Workflow cache entry {index + 1} prompt node has an incompatible class")
        elif kind in {"create", "edit"}:
            raise ValueError(f"Workflow cache entry {index + 1} has no executable prompt node")
        if kind == "edit":
            image_node_id = _text(template.get("imageNodeId")).strip()
            if not image_node_id or image_node_id not in output:
                raise ValueError(f"Workflow cache entry {index + 1} has no executable image source node")
            image_node = output[image_node_id]
            if not isinstance(image_node, dict) or image_node.get("class_type") != "KCPP_ChatImageInput":
                raise ValueError(f"Workflow cache entry {index + 1} image source has an incompatible class")
        if kind == "upscale":
            upscale_node_id = _text(template.get("upscaleNodeId")).strip()
            if not upscale_node_id or upscale_node_id not in output:
                raise ValueError(f"Workflow cache entry {index + 1} has no executable upscale node")
            upscale_node = output[upscale_node_id]
            if not isinstance(upscale_node, dict) or upscale_node.get("class_type") != "KCPP_PromptStudioUpscale":
                raise ValueError(f"Workflow cache entry {index + 1} upscale node has an incompatible class")
        lora_nodes = template.get("loraNodes", [])
        if not isinstance(lora_nodes, list):
            raise ValueError(f"Workflow cache entry {index + 1} LoRA nodes must be a list")
        lora_node_ids = set()
        for lora_node in lora_nodes:
            if not isinstance(lora_node, dict):
                raise ValueError(f"Workflow cache entry {index + 1} has an invalid LoRA node")
            lora_node_id = _text(lora_node.get("id")).strip()
            if not lora_node_id or lora_node_id in lora_node_ids or lora_node_id not in output:
                raise ValueError(f"Workflow cache entry {index + 1} has an invalid executable LoRA node")
            api_lora_node = output[lora_node_id]
            if not isinstance(api_lora_node, dict) or api_lora_node.get("class_type") != "KCPP_PromptStudioLoraLoader":
                raise ValueError(f"Workflow cache entry {index + 1} LoRA node has an incompatible class")
            lora_node_ids.add(lora_node_id)
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
    normalized = {"version": 3, "revision": current_revision + 1, "templates": data["templates"]}
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
    current_final_prompt = _text(data.get("current_final_prompt")).strip()
    revision = _text(data.get("revision")).strip()
    if not revision:
        raise ValueError("revision is required")

    mode = _text(data.get("mode"), "revise")
    if mode not in ("create", "render", "revise", "revise_main"):
        raise ValueError("mode must be create, render, revise, or revise_main")
    if mode in ("revise", "revise_main") and not current_prompt:
        raise ValueError("current_prompt is required")

    profile = _get_profile(_text(data.get("model_profile"), "General Natural Language"))
    style_template = _get_style_template(_text(data.get("style_preset"), "None"))
    framing_template = _get_framing_template(_text(data.get("framing_preset"), "None"))
    thinking_mode = _text(data.get("thinking_mode"), "Disabled")
    embellishment_level = _text(data.get("embellishment_level"), "Clean")
    if thinking_mode not in {"Disabled", "Minimal", "Low", "Medium", "High"}:
        raise ValueError("Invalid thinking_mode")
    if embellishment_level not in {"None", "Minimal", "Clean", "Detailed", "Rich", "Maximum", "Ultra Maximum"}:
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
    llm_provider = _text(data.get("llm_provider"), "koboldcpp").strip().casefold()
    if llm_provider not in {"koboldcpp", "ollama"}:
        raise ValueError("llm_provider must be koboldcpp or ollama")
    kobold_url = _text(data.get("kobold_url"), "http://localhost:5001")
    ollama_url = _text(data.get("ollama_url"), "http://localhost:11434")
    ollama_model = _text(data.get("ollama_model")).strip()
    stop_sequence = _text(data.get("stop_sequence"))
    style_modifier = _text(data.get("style_modifier"))
    framing_modifier = _text(data.get("framing_modifier"))
    default_max_response_tokens = int(
        profile.get("default_max_response_tokens") or DEFAULT_PROFILE["default_max_response_tokens"]
    )

    if mode in ("create", "render"):
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
    elif mode == "revise":
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
    else:
        prompt = _build_main_revision_prompt(
            current_prompt,
            _remove_known_profile_wrappers(current_final_prompt),
            revision,
            thinking_mode,
        )

    def generate(request_prompt, seed):
        if llm_provider == "ollama":
            return _generate_ollama(
                request_prompt,
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
                seed,
                thinking_mode,
                stop_sequence,
                request_timeout,
                include_default_continuation_stops=True,
            )
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
    if mode in ("create", "render") and _needs_expansion_retry(revision, revised, embellishment_level, profile):
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
        provider_name = "Ollama" if llm_provider == "ollama" else "KoboldCpp"
        raise RuntimeError(f"{provider_name} returned an empty prompt")
    if mode == "revise_main":
        return revised
    return _apply_profile_wrappers(revised, profile)


def _vision_capability(data):
    llm_provider = _text(data.get("llm_provider"), "koboldcpp").strip().casefold()
    request_timeout = _bounded_number(data.get("request_timeout"), 10, 5, 60, integer=True)
    return _llm_vision_capability(
        llm_provider,
        kobold_url=_text(data.get("kobold_url"), "http://localhost:5001"),
        ollama_url=_text(data.get("ollama_url"), "http://localhost:11434"),
        ollama_model=_text(data.get("ollama_model")).strip(),
        request_timeout=request_timeout,
    )


def _caption_image(data):
    image_reference = data.get("image")
    if not isinstance(image_reference, dict):
        raise ValueError("image must be a Prompt Studio image reference")

    profile = _get_profile(_text(data.get("model_profile"), "General Natural Language"))
    thinking_mode = _text(data.get("thinking_mode"), "Disabled")
    if thinking_mode not in {"Disabled", "Minimal", "Low", "Medium", "High"}:
        raise ValueError("Invalid thinking_mode")

    max_response_tokens = _bounded_number(data.get("max_response_tokens"), 0, 0, 8192, integer=True)
    temperature = _bounded_number(data.get("temperature"), 0.7, 0.0, 5.0)
    top_p = _bounded_number(data.get("top_p"), 0.9, 0.0, 1.0)
    top_k = _bounded_number(data.get("top_k"), 100, 0, 200, integer=True)
    min_p = _bounded_number(data.get("min_p"), 0.0, 0.0, 1.0)
    rep_pen = _bounded_number(data.get("rep_pen"), 1.05, 0.5, 3.0)
    rep_pen_range = _bounded_number(data.get("rep_pen_range"), 360, 0, 4096, integer=True)
    sampler_seed = _bounded_number(data.get("sampler_seed"), -1, -1, 999999, integer=True)
    request_timeout = _bounded_number(data.get("request_timeout"), 120, 5, 600, integer=True)
    llm_provider = _text(data.get("llm_provider"), "koboldcpp").strip().casefold()
    if llm_provider not in {"koboldcpp", "ollama"}:
        raise ValueError("llm_provider must be koboldcpp or ollama")

    image_base64, image_data_uri = _chat_image_vision_payload(json.dumps(image_reference))
    default_max_response_tokens = int(
        profile.get("default_max_response_tokens") or DEFAULT_PROFILE["default_max_response_tokens"]
    )
    common_args = (
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
        _text(data.get("stop_sequence")),
        request_timeout,
    )
    if llm_provider == "ollama":
        raw = _generate_ollama(
            VISION_CAPTION_PROMPT,
            _text(data.get("ollama_url"), "http://localhost:11434"),
            _text(data.get("ollama_model")).strip(),
            *common_args,
            include_default_continuation_stops=True,
            image_base64=image_base64,
        )
    else:
        raw = _generate_kcpp(
            VISION_CAPTION_PROMPT,
            _text(data.get("kobold_url"), "http://localhost:5001"),
            *common_args,
            include_default_continuation_stops=True,
            image_data_uri=image_data_uri,
        )

    caption = _strip_response(raw)
    if not caption:
        provider_name = "Ollama" if llm_provider == "ollama" else "KoboldCpp"
        raise RuntimeError(f"{provider_name} returned an empty image caption")
    return caption


async def _read_uploaded_image(request):
    if request.content_length is not None and request.content_length > MAX_IMAGE_UPLOAD_REQUEST_BYTES:
        raise ValueError("The dropped image exceeds the 20 MB upload limit")
    reader = await request.multipart()
    image_data = None
    while True:
        field = await reader.next()
        if field is None:
            break
        if field.name != "image":
            continue
        if image_data is not None:
            raise ValueError("Upload exactly one image")
        buffer = bytearray()
        while True:
            chunk = await field.read_chunk(size=64 * 1024)
            if not chunk:
                break
            buffer.extend(chunk)
            if len(buffer) > MAX_IMAGE_UPLOAD_BYTES:
                raise ValueError("The dropped image exceeds the 20 MB upload limit")
        image_data = bytes(buffer)
    if image_data is None:
        raise ValueError("The upload did not contain an image")
    return image_data


@PromptServer.instance.routes.get(f"{STANDALONE_ALIAS_PATH}/")
async def prompt_studio_alias_redirect(request):
    query = f"?{request.query_string}" if request.query_string else ""
    return web.Response(status=308, headers={"Location": f"{STANDALONE_ALIAS_PATH}{query}"})


@PromptServer.instance.routes.get(STANDALONE_ALIAS_PATH)
async def prompt_studio_alias(request):
    return web.FileResponse(STANDALONE_PAGE_PATH)


@PromptServer.instance.routes.get("/promptstudio/prompt-studio/config")
async def prompt_studio_config(request):
    return web.json_response(
        {
            "profiles": [profile["name"] for profile in _load_profiles()],
            "styles": [template["name"] for template in _load_style_templates()],
            "framings": [template["name"] for template in _load_framing_templates()],
            "thinking_modes": ["Disabled", "Minimal", "Low", "Medium", "High"],
            "embellishment_levels": [
                "None",
                "Minimal",
                "Clean",
                "Detailed",
                "Rich",
                "Maximum",
                "Ultra Maximum",
            ],
        }
    )


@PromptServer.instance.routes.get("/promptstudio/prompt-studio/loras")
async def prompt_studio_loras(request):
    try:
        lora_type = request.query.get("type", "")
        if len(lora_type) > 256:
            raise ValueError("LoRA Type is too long")
        names = await asyncio.to_thread(_lora_names_for_type, lora_type)
        return web.json_response(
            {
                "type": str(lora_type).strip(),
                "loras": [
                    {"name": name, "label": name.split("/", 1)[1]}
                    for name in names
                ],
            }
        )
    except (OSError, ValueError) as exc:
        return web.json_response({"error": str(exc)}, status=400)


@PromptServer.instance.routes.post("/promptstudio/prompt-studio/ollama-models")
async def prompt_studio_ollama_models(request):
    try:
        if request.content_length is not None and request.content_length > MAX_LLM_CONFIG_REQUEST_BYTES:
            raise ValueError("Prompt Studio LLM configuration request exceeds the 16 KB limit")
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError("JSON body must be an object")
        ollama_url = _text(data.get("ollama_url"), "http://localhost:11434")
        models = await asyncio.to_thread(_list_ollama_models, ollama_url, 10)
        return web.json_response({"models": models})
    except (ValueError, json.JSONDecodeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=502)


@PromptServer.instance.routes.post("/promptstudio/prompt-studio/import-image")
async def prompt_studio_import_image(request):
    try:
        image_data = await _read_uploaded_image(request)
        reference = await asyncio.to_thread(_sanitize_prompt_studio_image, image_data)
        return web.json_response({"image": reference})
    except (ValueError, OSError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"error": f"The image could not be sanitized: {exc}"}, status=500)


@PromptServer.instance.routes.get("/promptstudio/prompt-studio/image")
async def prompt_studio_image(request):
    try:
        reference = {
            "filename": _text(request.query.get("filename")).strip(),
            "subfolder": "",
            "type": "promptstudio",
        }
        _, path = await asyncio.to_thread(_parse_chat_image_reference, json.dumps(reference))
        response = web.FileResponse(path)
        response.headers["Cache-Control"] = "private, max-age=31536000, immutable"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response
    except (ValueError, OSError) as exc:
        return web.json_response({"error": str(exc)}, status=404)


@PromptServer.instance.routes.post("/promptstudio/prompt-studio/vision-capability")
async def prompt_studio_vision_capability(request):
    try:
        if request.content_length is not None and request.content_length > MAX_LLM_CONFIG_REQUEST_BYTES:
            raise ValueError("Prompt Studio LLM configuration request exceeds the 16 KB limit")
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError("JSON body must be an object")
        capability = await asyncio.to_thread(_vision_capability, data)
        return web.json_response(capability)
    except (ValueError, json.JSONDecodeError) as exc:
        return web.json_response({"available": False, "reason": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"available": False, "reason": str(exc)})


@PromptServer.instance.routes.post("/promptstudio/prompt-studio/caption-image")
async def prompt_studio_caption_image(request):
    try:
        if request.content_length is not None and request.content_length > MAX_VISION_REQUEST_BYTES:
            raise ValueError("Prompt Studio image-caption request exceeds the 32 KB limit")
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError("JSON body must be an object")
        caption = await asyncio.to_thread(_caption_image, data)
        return web.json_response({"prompt": caption})
    except (ValueError, json.JSONDecodeError, OSError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=502)


@PromptServer.instance.routes.post("/promptstudio/prompt-studio/image-size")
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


@PromptServer.instance.routes.get("/promptstudio/prompt-studio/chats")
async def prompt_studio_get_chats(request):
    try:
        async with CHAT_STORE_LOCK:
            data = await asyncio.to_thread(_read_chat_store)
        requested_revision = request.query.get("revision")
        if requested_revision is not None and _revision(requested_revision) == data["revision"]:
            return web.Response(status=204, headers={"X-PromptStudio-Revision": str(data["revision"])})
        return web.json_response(data)
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


@PromptServer.instance.routes.put("/promptstudio/prompt-studio/chats")
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


@PromptServer.instance.routes.get("/promptstudio/prompt-studio/workflows")
async def prompt_studio_get_workflows(request):
    try:
        async with WORKFLOW_STORE_LOCK:
            data = await asyncio.to_thread(_read_workflow_store)
        return web.json_response(data)
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


@PromptServer.instance.routes.put("/promptstudio/prompt-studio/workflows")
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


@PromptServer.instance.routes.post("/promptstudio/prompt-studio/revise")
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


_install_lan_access_middleware()
