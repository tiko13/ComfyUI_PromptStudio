"""Opt-in HTTP adapter for prompt-only experiments; no connection on import."""

import base64
import json
import struct
import urllib.parse
import urllib.request
import zlib


def synthetic_image(grid):
    """Render a small synthetic color grid as PNG without loading user files."""
    colors = {"red": (255, 0, 0), "blue": (0, 0, 255), "green": (0, 255, 0), "white": (255, 255, 255)}
    if not grid or any(len(row) != len(grid[0]) for row in grid):
        raise ValueError("Invalid synthetic image grid")
    scale = 32
    raw = b"".join(b"\0" + b"".join(bytes(colors[color]) * scale for color in row)
                   for row in grid for _ in range(scale))

    def chunk(kind, value):
        return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", zlib.crc32(kind + value) & 0xffffffff)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", len(grid[0]) * scale, len(grid) * scale, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def openai_compatible(case, variant, settings, seed):
    """Measure a supplied prompt with synthetic context using a chat JSON response.

    This does not invoke production rewrite/compile/Director correction code.
    A product-pipeline experiment must provide its own instrumented adapter.
    """
    endpoint = settings["endpoint"]
    parsed_url = urllib.parse.urlsplit(endpoint)
    if parsed_url.username or parsed_url.password:
        raise ValueError("Use an API-key environment variable, not credentials in the endpoint URL")
    if parsed_url.scheme != "https" and not (parsed_url.scheme == "http" and parsed_url.hostname in {"localhost", "127.0.0.1", "::1"}):
        raise ValueError("Use HTTPS for remote providers")
    context = {key: case[key] for key in ("input", "prior_state", "controls", "product")}
    context["output_contract"] = {
        "format": "Return one JSON object with the requested result fields; no Markdown.",
        "fields": list(case["output_fields"]),
        "note": "main_prompt comes entirely from chat; controls affect only final_prompt. document is the resulting structured video document. observations describe attached pixels. intent_route is mutate, discuss, or clarify.",
    }
    user_content = [{"type": "text", "text": json.dumps(context, ensure_ascii=False)}]
    for attachment in case.get("attachments", []):
        user_content.append({"type": "image_url", "image_url": {"url": synthetic_image(attachment["synthetic_grid"])}})
    payload = {
        "model": settings["model"], "seed": seed, "temperature": settings.get("temperature", 0.2),
        "top_p": settings.get("top_p", 1.0), "max_tokens": settings.get("max_tokens", 2048),
        "response_format": {"type": "json_object"},
        "messages": [{"role": "system", "content": variant["prompt"]},
                     {"role": "user", "content": user_content if len(user_content) > 1 else user_content[0]["text"]}],
    }
    headers = {"Content-Type": "application/json"}
    if settings.get("api_key"):
        headers["Authorization"] = "Bearer " + settings["api_key"]
    request = urllib.request.Request(endpoint, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=settings.get("timeout", 120)) as response:
        raw_response = json.load(response)
    content = raw_response["choices"][0]["message"]["content"]
    try:
        output = json.loads(content)
    except (ValueError, TypeError):
        output = content
    return {
        "output": output, "first_output": output, "correction_calls": 0,
        "token_usage": raw_response.get("usage"),
        "provider_metadata": {"provider": settings["provider"], "requested_model": settings["model"],
                              "returned_model": raw_response.get("model"),
                              "system_fingerprint": raw_response.get("system_fingerprint"),
                              "requested_seed": seed, "seed_honored": None},
    }
