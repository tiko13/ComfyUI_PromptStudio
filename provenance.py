"""Runtime asset provenance without exposing private filesystem paths.

Large content hashes are lazy; a stat identity is returned immediately and the
single worker enriches the cache for subsequent capture/replay requests.
"""
from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor
import hashlib
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import threading

PROVENANCE_VERSION = 1
ASSET_INPUTS = {
    "ckpt_name": "checkpoints", "unet_name": "diffusion_models",
    "vae_name": "vae", "clip_name": "text_encoders", "clip_name1": "text_encoders",
    "clip_name2": "text_encoders", "clip_name3": "text_encoders",
    "lora_name": "loras", "fl2va_mixed_8step_lora": "loras",
    "fl2va_mixed_4step_lora": "loras", "fl2va_768p_4step_lora": "loras",
    "ref2va_4step_lora": "loras",
}


def _relative_name(value):
    if not isinstance(value, str) or not value.strip():
        return None
    value = value.strip().replace("\\", "/")
    if PureWindowsPath(value).drive or PurePosixPath(value).is_absolute() or ".." in PurePosixPath(value).parts:
        return None
    return value


def snapshot_asset_references(snapshot):
    """Recognize native loaders plus shared Prompt Studio LoRA stacks."""
    references = []
    output = snapshot.get("output", {}) if isinstance(snapshot, dict) else {}
    if not isinstance(output, dict):
        return references
    for node_id, node in output.items():
        inputs = node.get("inputs", {}) if isinstance(node, dict) else {}
        if not isinstance(inputs, dict):
            continue
        for input_name, category in ASSET_INPUTS.items():
            raw = inputs.get(input_name)
            if not isinstance(raw, str) or not raw.strip():
                continue
            name = _relative_name(raw)
            references.append({"node_id": str(node_id), "input": input_name, "category": category,
                               "name": name or "[private path]", "invalid": name is None})
        try:
            stack = json.loads(inputs.get("lora_stack_json", "[]"))
        except (ValueError, TypeError):
            stack = []
        for index, item in enumerate(stack if isinstance(stack, list) else []):
            if not isinstance(item, dict) or not item.get("name"):
                continue
            name = _relative_name(item["name"])
            references.append({"node_id": str(node_id), "input": f"lora_stack_json[{index}]", "category": "loras",
                               "name": name or "[private path]", "invalid": name is None})
    return references


def _signature(path):
    stat = path.stat()
    if not path.is_file():
        raise OSError("Asset is not a file")
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


class AssetIdentityCache:
    def __init__(self, *, eager_bytes=2 * 1024 * 1024, max_entries=512):
        self.eager_bytes = eager_bytes
        self.max_entries = max_entries
        self._lock = threading.Lock()
        self._stopping = threading.Event()
        self._entries = {}
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ps-asset-hash")

    def _hash(self, path, signature):
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                if self._stopping.is_set(): return None
                digest.update(chunk)
        if _signature(path) != signature:
            return None
        return digest.hexdigest()

    def identify(self, path):
        path = Path(path)
        try:
            signature = _signature(path)
        except OSError:
            return {"status": "missing", "hash_state": "unavailable"}
        token = hashlib.sha256(json.dumps(signature, separators=(",", ":")).encode()).hexdigest()
        key = (str(path.resolve()), signature)
        with self._lock:
            future = self._entries.get(key)
            if future is None:
                if len(self._entries) >= self.max_entries:
                    completed = next((key for key, task in self._entries.items() if task.done()), None)
                    if completed is not None:
                        self._entries.pop(completed)
                    else:
                        return {"status": "available", "size": signature[2], "metadata_token": token, "hash_state": "pending"}
                if signature[2] <= self.eager_bytes:
                    # Small metadata files must never wait behind a queued model hash.
                    future = Future()
                    try:
                        future.set_result(self._hash(path, signature))
                    except (OSError, ValueError) as exc:
                        future.set_exception(exc)
                else:
                    future = self._executor.submit(self._hash, path, signature)
                self._entries[key] = future
        if signature[2] <= self.eager_bytes or future.done():
            try:
                digest = future.result()
            except (OSError, ValueError):
                digest = None
            return {"status": "available", "size": signature[2], "metadata_token": token,
                    "hash_state": "complete" if digest else "unavailable", **({"sha256": digest} if digest else {})}
        return {"status": "available", "size": signature[2], "metadata_token": token, "hash_state": "pending"}

    def close(self):
        self._stopping.set()
        self._executor.shutdown(wait=True, cancel_futures=True)


DEFAULT_ASSET_CACHE = AssetIdentityCache()


def capture_runtime_metadata(snapshot, resolver, *, versions=None, cache=DEFAULT_ASSET_CACHE):
    """resolver(category, relative_name) is supplied by the trusted runtime.

    Never accept a client-provided path resolver or absolute filesystem path.
    The resulting metadata can safely be sent to either studio.
    """
    assets = []
    for reference in snapshot_asset_references(snapshot):
        invalid = reference.pop("invalid")
        try:
            path = None if invalid else resolver(reference["category"], reference["name"])
            identity = cache.identify(path) if path else {"status": "unavailable" if invalid else "missing", "hash_state": "unavailable"}
        except (OSError, ValueError, KeyError):
            identity = {"status": "unavailable", "hash_state": "unavailable"}
        assets.append({**reference, **identity})
    safe_versions = {str(key): str(value) for key, value in (versions or {}).items()
                     if isinstance(value, (str, int, float)) and _relative_name(str(value)) is not None}
    return {"version": PROVENANCE_VERSION, "versions": safe_versions, "assets": assets}
