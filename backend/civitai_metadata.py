"""Hash-based, read-only Civitai metadata shared by both studios.

Only registered model files can be inspected. Network requests contain a hash or
public model ID, never local names, paths, prompts, or model bytes.
"""
from datetime import datetime
from contextlib import contextmanager
import asyncio
import hashlib
from html.parser import HTMLParser
import json
import os
import sqlite3
from pathlib import Path
import threading
import time
import urllib.error
import urllib.request

CATEGORIES = {"loras", "diffusion_models", "checkpoints", "refmods", "audio_refmods"}
CACHE_TTL = 24 * 60 * 60
RETRY_TTL = 5 * 60
MISSING_GRACE = 3 * 24 * 60 * 60
MAX_RESPONSE = 8 * 1024 * 1024
SITES = {"auto", "civitai.com", "civitai.green", "civitai.red"}


class MetadataError(RuntimeError):
    pass


class MissingModelError(ValueError):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_json(path, site="auto"):
    if not isinstance(site, str) or site not in SITES:
        raise ValueError("Unsupported Civitai site.")
    hosts = ["civitai.com", "civitai.red"] if site == "auto" else ["civitai.com" if site == "civitai.green" else site]
    errors = []
    for host in hosts:
        try:
            result = _fetch_host(path, host)
            if result is not None:
                return {**result, "_source_host": host}
        except MetadataError as exc:
            errors.append(str(exc))
    if errors:
        raise MetadataError(errors[0])
    return None


def _fetch_host(path, host):
    headers = {"Accept": "application/json", "User-Agent": "PromptStudio/1.0"}
    token = os.environ.get("CIVITAI_API_KEY", "").strip()
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(f"https://{host}/api/v1/" + path, headers=headers)
    try:
        with urllib.request.build_opener(_NoRedirect()).open(request, timeout=25) as response:
            raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise MetadataError("Civitai returned too much metadata.")
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError("Expected an object")
        return result
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        if exc.code in {401, 403}:
            raise MetadataError("Civitai denied access. This resource may require an API key or be restricted.") from None
        if exc.code == 429:
            raise MetadataError("Civitai rate limit reached. Try again later.") from None
        raise MetadataError(f"Civitai request failed (HTTP {exc.code}).") from None
    except (OSError, ValueError) as exc:
        raise MetadataError("Civitai could not be reached or returned invalid metadata.") from exc


class _PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.hidden += 1
        if tag in {"p", "br", "div", "li", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style"}:
            self.hidden = max(0, self.hidden - 1)
        if tag in {"p", "div", "li"}:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def plain_text(value):
    parser = _PlainText()
    parser.feed(str(value or "")[:100000])
    return "\n".join(line.strip() for line in "".join(parser.parts).splitlines() if line.strip())[:30000]


def _date(version):
    # updatedAt is an edit timestamp, not a new release.
    value = version.get("publishedAt") or version.get("createdAt")
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.timestamp() if parsed.tzinfo else None
    except (ValueError, TypeError, OverflowError):
        return None


def version_summary(version, model_id, host="civitai.com"):
    version_id = int(version["id"])
    return {"id": version_id, "name": str(version.get("name") or version_id),
            "base_model": str(version.get("baseModel") or ""),
            "published_at": version.get("publishedAt") or version.get("createdAt"),
            "url": f"https://{host}/models/{model_id}?modelVersionId={version_id}"}


def normalize_metadata(version, model):
    model_id = int(version["modelId"])
    host = version.get("_source_host", "civitai.com")
    current = version_summary(version, model_id, host)
    current_date = _date(version)
    candidates = []
    versions = (model or {}).get("modelVersions")
    comparison_known = isinstance(versions, list) and bool(versions) and current_date is not None and bool(current["base_model"])
    for candidate in versions if isinstance(versions, list) else []:
        if not isinstance(candidate, dict) or candidate.get("id") == current["id"]:
            continue
        if candidate.get("status", "Published") != "Published":
            continue
        if not current["base_model"] or candidate.get("baseModel") != current["base_model"]:
            continue
        date = _date(candidate)
        if date is None:
            comparison_known = False
        if current_date is not None and date is not None and date > current_date:
            candidates.append((date, candidate))
    latest = version_summary(max(candidates, key=lambda item: item[0])[1], model_id, host) if candidates else None
    words = version.get("trainedWords") or []
    words = list(dict.fromkeys(word for word in words if isinstance(word, str) and word.strip())) if isinstance(words, list) else []
    parent = model or version.get("model") or {}
    return {"status": "found", "model_id": model_id, "source_host": host,
            "name": str(parent.get("name") or current["name"]),
            "type": str(parent.get("type") or ""),
            "creator": str((parent.get("creator") or {}).get("username") or ""),
            "version": current, "trigger_words": words,
            "description": plain_text(parent.get("description")),
            "version_description": plain_text(version.get("description")),
            "latest_version": latest,
            "update_status": "available" if latest else "current" if comparison_known else "unknown"}


def validate_file(category, name):
    if not isinstance(category, str) or category not in CATEGORIES or not isinstance(name, str) or not name or len(name) > 2048:
        raise ValueError("Choose a registered LoRA or model file.")
    # Compare portable names, but resolve the exact name registered by ComfyUI.
    parts = name.replace("\\", "/").split("/")
    if any(part in {"", ".", ".."} or ":" in part for part in parts):
        raise ValueError("Invalid model file name.")
    return "/".join(parts)


def resolve_registered_file(category, name):
    import folder_paths
    normalized = validate_file(category, name)
    canonical = next((item for item in folder_paths.get_filename_list(category)
                      if item.replace("\\", "/") == normalized), None)
    path = folder_paths.get_full_path(category, canonical) if canonical else None
    if not path or not Path(path).is_file():
        raise MissingModelError("This file is no longer in the installed model catalog. Refresh the list.")
    return Path(path).resolve()


def _signature(path):
    stat = path.stat()
    return [stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_ino, stat.st_dev]


class MetadataService:
    def __init__(self, cache_dir, *, resolve=resolve_registered_file, fetch=fetch_json, clock=time.time):
        self.cache_dir = Path(cache_dir)
        self.resolve = resolve
        self.fetch = fetch
        self.clock = clock
        # Bound disk/network work and coalesce concurrent requests for one file.
        self.lookup_lock = threading.Lock()
        self.cleanup_lock = threading.Lock()
        self.last_cleanup = None
        self.database_path = self.cache_dir / "library.sqlite3"
        self.database_lock = threading.RLock()
        self.database_ready = False

    @contextmanager
    def _database(self):
        with self.database_lock:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            connection = sqlite3.connect(self.database_path, timeout=30)
            try:
                if not self.database_ready:
                    connection.execute("CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, category TEXT, name TEXT, sha256 TEXT, status TEXT, data TEXT NOT NULL)")
                    connection.execute("CREATE INDEX IF NOT EXISTS files_category_name ON files(category, name)")
                    connection.execute("CREATE INDEX IF NOT EXISTS files_hash ON files(sha256)")
                    connection.commit()
                    # Import the previous on-disk cache before removing each
                    # legacy file. A crash/retry cannot overwrite a newer row.
                    for legacy in self.cache_dir.glob("*.json"):
                        if len(legacy.stem) != 64 or any(c not in "0123456789abcdef" for c in legacy.stem):
                            continue
                        try:
                            data = json.loads(legacy.read_text(encoding="utf-8"))
                            if not isinstance(data, dict) or not data.get("local_path"):
                                continue
                        except (OSError, ValueError):
                            continue
                        self._put_record(connection, legacy.stem, data, replace=False)
                        connection.commit()
                        legacy.unlink()
                    self.database_ready = True
                yield connection
                connection.commit()
            except sqlite3.Error as exc:
                raise OSError("The local model metadata database could not be read or written.") from exc
            finally:
                connection.close()

    @staticmethod
    def _put_record(connection, key, data, *, replace=True):
        verb = "REPLACE" if replace else "IGNORE"
        connection.execute(f"INSERT OR {verb} INTO files VALUES (?, ?, ?, ?, ?, ?)",
                           (key, data.get("category", ""), data.get("file_name", ""), data.get("sha256", ""),
                            (data.get("result") or {}).get("status", "unchecked"), json.dumps(data, ensure_ascii=False)))

    def _read(self, path):
        with self._database() as connection:
            row = connection.execute("SELECT data FROM files WHERE id = ?", (path.stem,)).fetchone()
        return json.loads(row[0]) if row else {}

    def _write(self, path, data, *, preserve_trigger_edits=True):
        with self._database() as connection:
            if preserve_trigger_edits:
                row = connection.execute("SELECT data FROM files WHERE id = ?", (path.stem,)).fetchone()
                latest = json.loads(row[0]) if row else {}
                # A slow lookup may have started before a local edit. Merge the
                # current override only for the same file identity, under the
                # short database lock, including intentionally empty lists.
                if ("trigger_words_override" in latest
                        and latest.get("signature") == data.get("signature")
                        and latest.get("local_path") == data.get("local_path")):
                    data["trigger_words_override"] = latest["trigger_words_override"]
            self._put_record(connection, path.stem, data)

    def records(self):
        with self._database() as connection:
            rows = connection.execute("SELECT id, data FROM files").fetchall()
        return [(self.cache_dir / (key + ".json"), json.loads(data)) for key, data in rows]

    def _delete(self, path):
        with self._database() as connection:
            connection.execute("DELETE FROM files WHERE id = ?", (path.stem,))

    def summary(self):
        with self._database() as connection:
            return dict(connection.execute("SELECT status, COUNT(*) FROM files GROUP BY status").fetchall())

    def maintain(self):
        with self.lookup_lock:
            self.cleanup()

    def register(self, category, name):
        """Inventory every installed file before slow hashing/network work."""
        normalized = validate_file(category, name)
        key = hashlib.sha256((category + ":" + normalized).encode("utf-8")).hexdigest()
        record_path = self.cache_dir / (key + ".json")
        path = self.resolve(category, name)
        with self.database_lock:
            data = self._read(record_path)
            data.update(category=category, file_name=name)
            data.setdefault("local_path", str(path))
            self._write(record_path, data)

    def cleanup(self):
        """Delete metadata only after a file has been observed missing for days.

        Runs at most daily while Studio is used. Errors inspecting a path never
        count as proof of deletion; restored files cancel their grace period.
        """
        if not self.cleanup_lock.acquire(blocking=False):
            return
        try:
            now = self.clock()
            if self.last_cleanup is not None and now - self.last_cleanup < CACHE_TTL:
                return
            self.last_cleanup = now
            for record_path, data in self.records():
                local_path = data.get("local_path")
                if not isinstance(local_path, str):
                    continue
                try:
                    Path(local_path).stat()
                except FileNotFoundError:
                    missing = True
                except OSError:
                    continue
                else:
                    missing = False
                with self.database_lock:
                    current = self._read(record_path)
                    # A local save can run during maintenance. Never restore
                    # the stale snapshot or delete a newly restored file.
                    if (current.get("signature") != data.get("signature")
                            or current.get("local_path") != local_path
                            or current.get("missing_since") != data.get("missing_since")):
                        continue
                    since = current.get("missing_since")
                    if missing:
                        if isinstance(since, (int, float)) and now - since >= MISSING_GRACE:
                            self._delete(record_path)
                        elif since is None:
                            current["missing_since"] = now
                            self._write(record_path, current)
                    elif "missing_since" in current:
                        current.pop("missing_since")
                        self._write(record_path, current)
        finally:
            self.cleanup_lock.release()

    def details(self, category, name, *, lookup=False, refresh=False, site="auto"):
        validate_file(category, name)
        if not isinstance(site, str) or site not in SITES:
            raise ValueError("Unsupported Civitai site.")
        if lookup:
            with self.lookup_lock:
                self.cleanup()
                return self._details(category, name, lookup=True, refresh=refresh, site=site)
        # Maintenance and remote lookups share this lock; cache-only reads and
        # local trigger edits do not wait for a large file to finish hashing.
        if self.lookup_lock.acquire(blocking=False):
            try:
                self.cleanup()
            finally:
                self.lookup_lock.release()
        return self._details(category, name, site=site)

    @staticmethod
    def _trigger_words(cached, result):
        edited = "trigger_words_override" in cached
        return {**result, **({"trigger_words": list(cached["trigger_words_override"])} if edited else {}),
                "trigger_words_edited": edited}

    def saved_details(self, category, name):
        """Read the saved snapshot without catalog scans, file stats or cleanup."""
        normalized = validate_file(category, name)
        key = hashlib.sha256((category + ":" + normalized).encode("utf-8")).hexdigest()
        cached = self._read(self.cache_dir / (key + ".json"))
        data = self._cached_details(cached, category, name, cached.get("signature") or [0])
        if cached.get("missing_since") is not None:
            data.update(missing_file=True, missing_since=cached["missing_since"], refresh_due=False,
                        warning="The local file was last observed missing. Showing saved details.")
        return data

    def save_trigger_words(self, category, name, words):
        normalized = validate_file(category, name)
        if category != "loras":
            raise ValueError("Trigger words can only be edited for LoRAs.")
        if not isinstance(words, list) or len(words) > 128 or any(
                not isinstance(word, str) or not word.strip() or len(word) > 1024 for word in words):
            raise ValueError("Use up to 128 non-empty trigger words, each at most 1024 characters.")
        words = list(dict.fromkeys(word.strip() for word in words))
        key = hashlib.sha256((category + ":" + normalized).encode("utf-8")).hexdigest()
        cache_path = self.cache_dir / (key + ".json")
        path = self.resolve(category, name)
        signature = _signature(path)
        # Only the short read/modify/write transaction is serialized. Saving
        # must never wait for hashing, network requests or library maintenance.
        with self.database_lock:
            cached = self._read(cache_path)
            if cached.get("signature") != signature or cached.get("local_path") != str(path):
                cached = {}
            cached.update(signature=signature, local_path=str(path), category=category, file_name=name,
                          trigger_words_override=words)
            cached.pop("missing_since", None)
            cached.setdefault("result", {"status": "unchecked"})
            self._write(cache_path, cached, preserve_trigger_edits=False)
        return self._cached_details(cached, category, name, signature)

    def _cached_details(self, cached, category, name, signature, site="auto"):
        return {**self._trigger_words(cached, cached.get("result") or {"status": "unchecked"}),
                "file_name": name, "category": category, "size_bytes": signature[0],
                "sha256": cached.get("sha256", ""), "error": cached.get("error", ""),
                "refresh_due": self.clock() >= cached.get("next_check", 0),
                "site": cached.get("site", site), "stale": bool(cached.get("error"))}

    def _details(self, category, name, *, lookup=False, refresh=False, site="auto"):
        normalized = validate_file(category, name)
        key = hashlib.sha256((category + ":" + normalized).encode("utf-8")).hexdigest()
        cache_path = self.cache_dir / (key + ".json")
        cached = self._read(cache_path)
        previous = cached
        try:
            path = self.resolve(category, name)
            signature = _signature(path)
        except (MissingModelError, FileNotFoundError):
            if not cached.get("result"):
                raise MissingModelError("The local file is missing and has no saved Civitai details.") from None
            return {**self._trigger_words(cached, cached["result"]), "file_name": name, "category": category,
                    "size_bytes": cached.get("signature", [0])[0], "sha256": cached.get("sha256", ""),
                    "missing_file": True, "missing_since": cached.get("missing_since"),
                    "warning": "The local file is missing or no longer registered. Saved details are retained for three days after the file is first observed missing.",
                    "refresh_due": False, "site": cached.get("site", "auto")}
        if cached.get("signature") != signature or cached.get("local_path") != str(path):
            cached = {}
        if lookup and cached.get("site", "auto") != site:
            cached = {**cached, "next_check": 0}
        now = self.clock()
        result = cached.get("result") or {"status": "unchecked"}
        due = now >= cached.get("next_check", 0)
        if lookup and (refresh or due):
            digest = cached.get("sha256")
            if not digest:
                hasher = hashlib.sha256()
                with path.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
                        hasher.update(chunk)
                if _signature(path) != signature:
                    raise ValueError("The file changed while hashing. Try again when it has finished downloading.")
                digest = hasher.hexdigest()
                if digest == previous.get("sha256"):
                    result = previous.get("result") or result
                    if "trigger_words_override" in previous:
                        cached["trigger_words_override"] = previous["trigger_words_override"]
            cached.update(signature=signature, sha256=digest, local_path=str(path), category=category, file_name=name)
            try:
                version = self.fetch("model-versions/by-hash/" + digest, site)
                if version is None:
                    # A deleted/hidden remote listing must not destroy the only
                    # surviving copy of the author's triggers and instructions.
                    if result.get("status") == "found":
                        result = {**result, "source_unavailable": True,
                                  "warning": "Civitai no longer returns this file. Showing saved details.",
                                  "update_status": "unknown"}
                        result.pop("latest_version", None)
                    else:
                        result = {"status": "not_found", "checked_at": now}
                else:
                    model_error = ""
                    try:
                        model = self.fetch("models/" + str(int(version["modelId"])), version.get("_source_host", site))
                        if model is None:
                            model_error = "The model listing is unavailable; newer versions could not be checked."
                    except MetadataError as exc:
                        model, model_error = None, str(exc)
                    result = normalize_metadata(version, model)
                    result["checked_at"] = now
                    if model_error:
                        result["warning"] = model_error
                cached["next_check"] = now + (RETRY_TTL if result.get("warning") and not result.get("source_unavailable") else CACHE_TTL)
                cached.pop("error", None)
            except (MetadataError, ValueError, KeyError, TypeError) as exc:
                cached["error"] = str(exc) if isinstance(exc, MetadataError) else "Civitai returned incomplete or invalid metadata."
                cached["next_check"] = now + RETRY_TTL
            if _signature(path) != signature:
                raise ValueError("The file changed during lookup. Please try again.")
            cached["result"] = result
            cached["site"] = site
            self._write(cache_path, cached)
        return self._cached_details(cached, category, name, signature, site)


def installed_library():
    import folder_paths
    files = []
    # Both studios share the same ComfyUI roots, including extra model paths.
    for category in ("loras", "diffusion_models", "checkpoints", "refmods", "audio_refmods"):
        if category not in folder_paths.folder_names_and_paths:
            continue
        for name in folder_paths.get_filename_list(category):
            files.append((category, name))
    return files


class LibraryPopulation:
    """One resumable background pass for the full installed library."""
    def __init__(self, service, *, catalog=installed_library, delay=1):
        self.service = service
        self.catalog = catalog
        self.delay = delay
        self.task = None
        self.last_started = None
        self.retry_after = 0
        self.state = {"state": "idle", "total": 0, "processed": 0, "errors": 0}

    def start(self, *, force=False):
        if self.task and not self.task.done():
            return self.task
        now = self.service.clock()
        if now < self.retry_after:
            return self.task
        if not force and self.last_started is not None and now - self.last_started < 60:
            return self.task
        self.last_started = now
        self.task = asyncio.create_task(self.run())
        return self.task

    async def run(self):
        try:
            while True:
                await self._run_pass()
                if self.state["state"] != "deferred":
                    return
                await asyncio.sleep(RETRY_TTL)
        except asyncio.CancelledError:
            self.state["state"] = "stopped"
            raise

    async def _run_pass(self):
        self.state = {"state": "indexing", "total": 0, "processed": 0, "errors": 0}
        try:
            await asyncio.to_thread(self.service.maintain)
            files = list(dict.fromkeys(await asyncio.to_thread(self.catalog)))
            self.state["total"] = len(files)
            available = []
            # Populate the complete inventory first; a restart resumes lookup
            # from each file's committed hash/result and expiry.
            for category, name in files:
                try:
                    await asyncio.to_thread(self.service.register, category, name)
                    available.append((category, name))
                except (OSError, ValueError):
                    self.state["errors"] += 1
                    self.state["processed"] += 1
            self.state["state"] = "populating"
            consecutive_errors = 0
            for category, name in available:
                try:
                    data = await asyncio.to_thread(self.service.details, category, name)
                    if data.get("refresh_due") and not data.get("missing_file"):
                        data = await asyncio.to_thread(self.service.details, category, name,
                                                       lookup=True, site=data.get("site", "auto"))
                        # Pace remote requests and let foreground lookups run.
                        await asyncio.sleep(self.delay)
                    if data.get("error"):
                        self.state["errors"] += 1
                        consecutive_errors += 1
                    else:
                        consecutive_errors = 0
                    if consecutive_errors >= 3 or "rate limit" in data.get("error", "").lower():
                        self.state["processed"] += 1
                        self.retry_after = self.service.clock() + RETRY_TTL
                        self.state.update(state="deferred", error="Civitai is unavailable or rate limited. Saved records are kept; population will resume after a cooldown.")
                        # Resume without needing an open browser. Nothing is
                        # rehashed and fresh records remain API-free.
                        return
                except (OSError, ValueError):
                    self.state["errors"] += 1
                self.state["processed"] += 1
            self.state["state"] = "complete"
        except asyncio.CancelledError:
            self.state["state"] = "stopped"
            raise
        except Exception:
            self.state["state"] = "failed"
            self.state["error"] = "The installed model library could not be indexed. Refresh the model list to retry."

    async def stop(self):
        if self.task and not self.task.done():
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
