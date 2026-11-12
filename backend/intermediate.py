"""Ephemeral, CPU-only handoff between separately queued Studio graph stages."""
import secrets
import threading
import time

MAX_OPTIONS = 32


def image_saver():
    # Loaded lazily because nodes registers this class after defining the saver.
    from .nodes import Save_as_webp_cond
    return Save_as_webp_cond


def choice_labels(value):
    labels = [line.strip() for line in str(value).splitlines() if line.strip()]
    if not 1 <= len(labels) <= MAX_OPTIONS or any(len(label) > 120 for label in labels):
        raise ValueError("Enter 1–32 choice labels, one per line (at most 120 characters each).")
    return labels


def cpu_copy(value):
    if hasattr(value, "detach"):
        return value.detach().to(device="cpu", copy=True)
    if isinstance(value, dict):
        return {key: cpu_copy(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(cpu_copy(item) for item in value)
    return value


def tensor_bytes(value):
    if hasattr(value, "numel"):
        return value.numel() * value.element_size()
    if isinstance(value, dict):
        return sum(tensor_bytes(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return sum(tensor_bytes(item) for item in value)
    return 0


class ChoiceStore:
    def __init__(self, max_bytes=2 * 1024**3, ttl=3600, clock=time.monotonic):
        self.entries = {}
        self.lock = threading.RLock()
        self.max_bytes, self.ttl, self.clock = max_bytes, ttl, clock

    def _prune(self):
        now = self.clock()
        for token, entry in list(self.entries.items()):
            if now - entry["touched"] > self.ttl:
                del self.entries[token]

    def reserve(self):
        with self.lock:
            self._prune()
            if len(self.entries) >= 64:
                raise ValueError("Too many pending choices. Discard an older choice first.")
            token = secrets.token_urlsafe(32)
            self.entries[token] = {"touched": self.clock(), "state": "reserved", "bytes": 0}
            return token

    def capture(self, token, images, latent, labels):
        size = tensor_bytes(images) + tensor_bytes(latent)
        with self.lock:
            self._prune()
            entry = self.entries.get(token)
            if not entry or entry["state"] != "reserved":
                raise ValueError("This choice has expired. Start a new generation in Studio.")
            if size + sum(item["bytes"] for item in self.entries.values()) > self.max_bytes:
                raise ValueError("Pending choices exceed the memory budget. Discard an older choice or reduce the image batch.")
            entry.update(images=cpu_copy(images), latent=cpu_copy(latent), labels=labels,
                         bytes=size, state="ready", touched=self.clock())

    def claim(self, token, index):
        with self.lock:
            self._prune()
            entry = self.entries.get(token)
            if not entry or entry["state"] != "ready":
                raise ValueError("This choice was already used or has expired.")
            if type(index) is not int or not 0 <= index < len(entry["labels"]):
                raise ValueError("Unknown choice.")
            ticket = secrets.token_urlsafe(32)
            entry.update(state="claimed", ticket=ticket, touched=self.clock())
            return ticket

    def read(self, token, ticket):
        with self.lock:
            self._prune()
            entry = self.entries.get(token)
            if not entry or entry["state"] != "claimed" or not secrets.compare_digest(entry["ticket"], ticket):
                raise ValueError("This continuation has expired. Generate a new image.")
            entry["touched"] = self.clock()
            # Consumers may mutate latents; never expose the stored source itself.
            return cpu_copy(entry["images"]), cpu_copy(entry["latent"])

    def status(self, token):
        with self.lock:
            self._prune()
            entry = self.entries.get(token)
            if entry:
                entry["touched"] = self.clock()
            return entry["state"] if entry else "expired"

    def release(self, token):
        with self.lock:
            self.entries.pop(token, None)


CHOICES = ChoiceStore()


class IntermediateChoice:
    @classmethod
    def INPUT_TYPES(cls):
        saving = image_saver().INPUT_TYPES()
        return {"required": {"images": ("IMAGE",),
                             "message": ("STRING", {"default": "Continue with this image?", "multiline": True}),
                             "options": ("STRING", {"default": "Refine", "multiline": True})},
                "optional": {"latent": ("LATENT",), "_choice_token": ("STRING", {"forceInput": True}),
                             "save_intermediate": ("BOOLEAN", {"default": True, "tooltip": "Save permanently so this image remains available in conversation history after cache cleanup."}),
                             "filename_prefix": ("STRING", {"default": "PromptStudio/Intermediate"}),
                             **{key: saving["required"][key] for key in ("mode", "compression")},
                             **saving["optional"]},
                "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"}}

    RETURN_TYPES = ("IMAGE",) * MAX_OPTIONS
    RETURN_NAMES = tuple(f"Option {i + 1}" for i in range(MAX_OPTIONS))
    FUNCTION = "pause"
    CATEGORY = "Prompt Studio"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def pause(self, images, message, options, latent=None, _choice_token="", prompt=None, extra_pnginfo=None,
              save_intermediate=True, filename_prefix="PromptStudio/Intermediate", mode="lossy", compression=80,
              format="webp", png_compression=4, png_optimize=False, webp_method=6, force=False):
        if not _choice_token:
            raise ValueError("Intermediate / Choice workflows must be started from Image or Video Studio.")
        labels = choice_labels(options)
        CHOICES.capture(_choice_token, images, latent, labels)
        try:
            preview = image_saver()().Save_as_webp_cond(
                mode, compression, images, "yes" if save_intermediate else "no", filename_prefix,
                prompt=prompt, extra_pnginfo=extra_pnginfo, format=format, png_compression=png_compression,
                png_optimize=png_optimize, webp_method=webp_method, force=force,
                _preview_thumbnail=not save_intermediate)
        except Exception:
            CHOICES.release(_choice_token)
            raise
        for reference in preview["ui"]["images"]:
            reference["intermediate"] = True
        return {"ui": preview["ui"], "result": (images,) * MAX_OPTIONS}


class IntermediateSource:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"token": ("STRING",), "ticket": ("STRING",)}}

    RETURN_TYPES = ("IMAGE", "LATENT")
    FUNCTION = "restore"
    CATEGORY = "_PromptStudio/Internal"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def restore(self, token, ticket):
        return CHOICES.read(token, ticket)


def register_choice_routes(server):
    # Import at registration time: isolated suites may have scoped aiohttp stubs.
    from aiohttp import web

    async def dispatch(request):
        try:
            data = await request.json()
            action = request.match_info["action"]
            token = str(data.get("token", ""))
            if action == "reserve":
                return web.json_response({"token": CHOICES.reserve()})
            if action == "claim":
                return web.json_response({"ticket": CHOICES.claim(token, data.get("index"))})
            if action == "release":
                CHOICES.release(token)
                return web.json_response({"released": True})
            if action == "status":
                return web.json_response({"state": CHOICES.status(token)})
            raise ValueError("Unknown choice action")
        except (ValueError, TypeError, KeyError) as exc:
            return web.json_response({"error": str(exc)}, status=400)

    server.routes.post("/promptstudio/choices/{action}")(dispatch)
