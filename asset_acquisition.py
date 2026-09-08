"""Verified, resumable asset acquisition using only the Python standard library.

This module deliberately imports no package initializer or ComfyUI runtime. Asset
identity is the source URL, expected byte count, and published SHA-256 digest.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import ssl
import threading
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from pathlib import Path


_VERIFIED_FILES = {}
_CACHE_LOCK = threading.Lock()
_BLOCK_SIZE = 8 * 1024 * 1024


def _identity(asset):
    digest = str(asset.get("sha256") or "").lower()
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("Asset requires a published SHA-256 digest")
    size = int(asset.get("size") or 0)
    if size <= 0:
        raise ValueError("Asset requires a positive expected byte count")
    url = str(asset.get("url") or "")
    if urllib.parse.urlsplit(url).scheme.lower() != "https":
        raise ValueError("Asset downloads require verified HTTPS")
    return {"url": url, "size": size, "sha256": digest}


def _file_stamp(path):
    stat = path.stat()
    return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)


def sha256_file(path, progress=None):
    path = Path(path)
    total = path.stat().st_size
    done = 0
    digest = hashlib.sha256()
    if progress:
        progress(0, total, "Verifying")
    with path.open("rb") as source:
        while block := source.read(_BLOCK_SIZE):
            digest.update(block)
            done += len(block)
            if progress:
                progress(done, total, "Verifying")
    return digest.hexdigest()


def verified_file(path, expected_size, expected_sha256, progress=None):
    """Reuse hashes only while the file's identity and modification stamps match."""
    path = Path(path)
    digest = str(expected_sha256 or "").lower()
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        return False
    try:
        if not path.is_file():
            return False
        stamp = _file_stamp(path)
        if stamp[2] != int(expected_size):
            return False
        key = (str(path.resolve()), digest)
        with _CACHE_LOCK:
            cached = _VERIFIED_FILES.get(key) == stamp
        if cached:
            if progress:
                progress(stamp[2], stamp[2], "Verified")
            return True
        if sha256_file(path, progress) != digest or _file_stamp(path) != stamp:
            return False
        with _CACHE_LOCK:
            _VERIFIED_FILES[key] = stamp
        return True
    except OSError:
        return False


@contextmanager
def _target_lock(target):
    """An OS-owned lock also excludes a concurrently running standalone installer."""
    lock_path = target.with_name(target.name + ".acquire.lock")
    with lock_path.open("a+b") as handle:
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeError("Another download is already using {}".format(target)) from exc
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    # Keep the small lock file: unlinking could split waiters across two inodes.


def _read_metadata(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_metadata(path, value):
    temporary = path.with_name(path.name + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(value, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _publish_verified(asset, partial, target, metadata, progress):
    expected_size = asset["size"]
    actual_size = partial.stat().st_size
    if actual_size != expected_size:
        raise RuntimeError("Download ended at {} bytes; expected {}. Retry to resume.".format(actual_size, expected_size))
    stamp = _file_stamp(partial)
    digest = sha256_file(partial, progress)
    if _file_stamp(partial) != stamp:
        raise RuntimeError("The partial changed during verification; retry before publication")
    if digest != asset["sha256"]:
        partial.unlink(missing_ok=True)
        metadata.unlink(missing_ok=True)
        raise RuntimeError("Downloaded SHA-256 checksum did not match; the corrupt partial was discarded")
    # Windows FlushFileBuffers requires a writable descriptor.
    with partial.open("r+b") as handle:
        os.fsync(handle.fileno())
    if target.exists():
        raise RuntimeError("The model destination appeared during acquisition; partial retained")
    os.replace(partial, target)
    metadata.unlink(missing_ok=True)
    if progress:
        progress(expected_size, expected_size, "Verified")
    return target


def acquire_asset(asset, target, progress=None, *, opener=None, fallback=None):
    """Verify/reuse or download and atomically publish one pinned asset.

    progress receives (bytes, total, stage). A trusted caller may supply a verified
    TLS fallback(error, partial, progress); it must start a new complete download.
    Interrupted transfers retain only partials with matching identity metadata.
    """
    identity = _identity(asset)
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    with _target_lock(target):
        if target.is_file():
            if verified_file(target, identity["size"], identity["sha256"], progress):
                return target
            raise RuntimeError("Existing model checksum or size does not match: {}".format(target))
        partial = target.with_name(target.name + ".part")
        metadata_path = partial.with_name(partial.name + ".json")
        metadata = _read_metadata(metadata_path)
        offset = partial.stat().st_size if partial.is_file() else 0
        # A complete legacy partial can prove its identity directly by its hash.
        if offset == identity["size"]:
            return _publish_verified(identity, partial, target, metadata_path, progress)
        if offset > identity["size"] or any(metadata.get(key) != value for key, value in identity.items()):
            partial.unlink(missing_ok=True)
            metadata_path.unlink(missing_ok=True)
            offset, metadata = 0, {}
        headers = {"User-Agent": "PromptStudioAssetAcquisition/1.0", "Accept-Encoding": "identity"}
        if offset:
            headers["Range"] = "bytes={}-".format(offset)
            if metadata.get("etag"):
                headers["If-Range"] = metadata["etag"]
        request = urllib.request.Request(identity["url"], headers=headers)
        opener = opener or urllib.request.urlopen
        if progress:
            progress(offset, identity["size"], "Downloading")
        try:
            with opener(request, timeout=60) as response:
                status = getattr(response, "status", None) or response.getcode()
                final_url = response.geturl() if hasattr(response, "geturl") else identity["url"]
                if urllib.parse.urlsplit(final_url).scheme.lower() != "https":
                    raise RuntimeError("Refusing an insecure asset redirect")
                if response.headers.get("Content-Encoding", "identity").lower() != "identity":
                    raise RuntimeError("Asset response must use identity content encoding")
                etag = str(response.headers.get("ETag") or "")
                etag = etag if etag and not etag.startswith("W/") else ""
                if offset and metadata.get("etag") and etag != metadata["etag"]:
                    raise RuntimeError("Resumed asset object identity changed; partial retained without appending")
                if status == 206:
                    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
                    if (not match or int(match[1]) != offset or int(match[3]) != identity["size"]
                            or int(match[2]) < offset or int(match[2]) >= identity["size"]):
                        raise RuntimeError("Resumed asset has an invalid Content-Range; partial retained")
                    response_size = int(match[2]) - offset + 1
                elif status == 200:
                    # A server that ignores Range sent the entire object. Replace
                    # the partial from byte zero instead of appending its body.
                    offset = 0
                    response_size = identity["size"]
                else:
                    raise RuntimeError("Unexpected asset HTTP status {}".format(status))
                content_length = response.headers.get("Content-Length")
                if content_length is not None and int(content_length) != response_size:
                    raise RuntimeError("Asset Content-Length does not match its expected range")
                _write_metadata(metadata_path, {**identity, "etag": etag})
                done, received = offset, 0
                with partial.open("ab" if offset else "wb") as output:
                    while block := response.read(_BLOCK_SIZE):
                        if received + len(block) > response_size:
                            raise RuntimeError("Asset response exceeds its declared byte range")
                        output.write(block)
                        received += len(block)
                        done += len(block)
                        if progress:
                            progress(done, identity["size"], "Downloading")
                    output.flush()
                    os.fsync(output.fileno())
                if received != response_size:
                    raise RuntimeError("Asset transfer was interrupted; retry to resume")
        except (urllib.error.URLError, ssl.SSLError) as exc:
            if fallback is None or not fallback(exc, partial, progress):
                raise
        return _publish_verified(identity, partial, target, metadata_path, progress)
