"""Immutable JSON records published by one atomic manifest replacement.

Readers see an entire old or new revision. Existing split records and legacy
files remain readable; saves write compressed content-addressed records.
Maintenance retains bounded recovery checkpoints and serializes with readers.
Callers hold store_lock across read/check/merge/save.

Recovery tooling (use the ComfyUI VENV interpreter):
  transactional_store.py inspect DIRECTORY --kind chat
  transactional_store.py export DIRECTORY OUTPUT.json --kind project
  transactional_store.py migrate DIRECTORY --kind chat --legacy LEGACY.json
  transactional_store.py recover DIRECTORY --kind project

Inspect/export are read-only. Migration retains source files. Recovery retains
the damaged manifest and records and publishes a new revision of the newest
complete retained snapshot. Back up/export before an intentional rollback.
"""

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from functools import wraps
import gzip
import hashlib
import json
import logging
import os
import re
from pathlib import Path
import tempfile
import threading
import time
import uuid
import zlib


class RecoveryRequiredError(RuntimeError):
    pass


class RevisionConflictError(RuntimeError):
    pass


_LOCKS = {}
_LOCKS_GUARD = threading.Lock()
_LOCAL = threading.local()
_MANIFEST_CACHE = {}
_MANIFEST_CACHE_LOCK = threading.Lock()
RETENTION = {"recent": 3, "daily_days": 7, "weekly_weeks": 4, "budget_bytes": 256 * 1024 * 1024}
MAINTENANCE_INTERVAL = 30 * 60
_MAINTENANCE_RUNNING = set()
_MAINTENANCE_GUARD = threading.Lock()


@contextmanager
def store_lock(directory):
    """Serialize full read-modify-write transactions across threads/processes."""
    directory = os.path.normcase(os.path.realpath(directory))
    with _LOCKS_GUARD:
        lock = _LOCKS.setdefault(directory, threading.RLock())
    with lock:
        held = getattr(_LOCAL, "held", set())
        if directory in held:
            yield
            return
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, ".writer.lock"), "a+b") as file:
            if os.name == "nt":
                import msvcrt
                file.seek(0, os.SEEK_END)
                if not file.tell():
                    file.write(b"0")
                    file.flush()
                deadline = time.monotonic() + 60
                while True:
                    try:
                        file.seek(0)
                        msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
                        break
                    except OSError:
                        if time.monotonic() >= deadline:
                            raise RuntimeError("Store writer lock timed out; another save is still active")
                        time.sleep(0.05)
            else:
                import fcntl
                fcntl.flock(file.fileno(), fcntl.LOCK_EX)
            _LOCAL.held = held | {directory}
            try:
                yield
            finally:
                _LOCAL.held = held
                if os.name == "nt":
                    file.seek(0)
                    msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(file.fileno(), fcntl.LOCK_UN)


def _encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _serialized_read(function):
    @wraps(function)
    def wrapped(directory, *args, **kwargs):
        with store_lock(directory):
            return function(directory, *args, **kwargs)
    return wrapped


def _json_bytes(path):
    raw = Path(path).read_bytes()
    try:
        return gzip.decompress(raw) if raw.startswith(b"\x1f\x8b") else raw
    except (EOFError, OSError, zlib.error) as exc:
        raise ValueError(f"Invalid compressed history file: {Path(path).name}") from exc


def _compressed(raw):
    return gzip.compress(raw, compresslevel=6, mtime=0)


def _atomic_bytes(path, encoded):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as file:
            file.write(encoded)
            file.flush()
            os.fsync(file.fileno())
        deadline = time.monotonic() + 2
        while True:
            try:
                os.replace(temporary, path)
                break
            except PermissionError as exc:
                # Windows readers can briefly hold an index without delete
                # sharing. Keep the old manifest intact and retry publication.
                if os.name != "nt" or getattr(exc, "winerror", None) not in {5, 32, 33} or time.monotonic() >= deadline:
                    raise
                time.sleep(0.01)
        if os.name != "nt":
            descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _parse_manifest(path, entries_key):
    path = Path(path)
    stat = path.stat()
    signature = (stat.st_ino, stat.st_size, stat.st_mtime_ns)
    cache_key = (str(path.resolve()), entries_key)
    with _MANIFEST_CACHE_LOCK:
        cached = _MANIFEST_CACHE.get(cache_key)
    if cached is not None and cached[0] == signature:
        return cached[1]
    value = json.loads(_json_bytes(path))
    if not isinstance(value, dict) or not isinstance(value.get(entries_key), list):
        raise ValueError(f"manifest must contain a {entries_key} list")
    if not isinstance(value.get("revision", 0), int):
        raise ValueError("manifest revision must be an integer")
    with _MANIFEST_CACHE_LOCK:
        if len(_MANIFEST_CACHE) >= 32:
            _MANIFEST_CACHE.pop(next(iter(_MANIFEST_CACHE)))
        _MANIFEST_CACHE[cache_key] = (signature, value)
    return value


def _read_record_bytes(path):
    return _json_bytes(path)


def _backup_candidates(directory):
    backups = Path(directory) / "_backups"
    return list(backups.glob("index_r*.json")) + list(backups.glob("index_r*.json.gz")) + ([backups / "index.bak"] if (backups / "index.bak").is_file() else [])


@_serialized_read
def read_records(directory, manifest, entries_key, prefix, record_ids=None):
    """Read selected records from an immutable manifest; None reads all records."""
    records = []
    seen = set()
    selected = None if record_ids is None else set(record_ids)
    for entry in manifest[entries_key]:
        if not isinstance(entry, dict):
            raise ValueError("manifest record entry must be an object")
        record_id = str(entry.get("id") or "").strip()
        digest = hashlib.sha256(record_id.encode("utf-8")).hexdigest()
        filename = entry.get("file")
        sha256 = entry.get("sha256")
        expected = f"{prefix}_{digest}_{sha256}.json" if sha256 else f"{prefix}_{digest}.json"
        if not record_id or record_id in seen or filename not in {expected, expected + ".gz"}:
            raise ValueError("manifest contains an invalid or duplicate record reference")
        if sha256 and (len(sha256) != 64 or any(character not in "0123456789abcdef" for character in sha256)):
            raise ValueError("manifest contains an invalid record checksum")
        seen.add(record_id)
        if selected is not None and record_id not in selected:
            continue
        raw = _read_record_bytes(Path(directory) / filename)
        if sha256 and hashlib.sha256(raw).hexdigest() != sha256:
            raise ValueError(f"checksum mismatch for {filename}")
        record = json.loads(raw)
        if not isinstance(record, dict) or str(record.get("id") or "").strip() != record_id:
            raise ValueError(f"record identity mismatch for {filename}")
        records.append(record)
    return records


@_serialized_read
def read_snapshot(directory, entries_key, prefix, manifest=None):
    """Return a complete snapshot; recovery fallback is visible and read-only."""
    index = Path(directory) / "index.json"
    # A caller can hold a manifest while maintenance retires that revision.
    # Retry the current snapshot, rather than misreporting corruption.
    if manifest is not None and not manifest.get("_recovery"):
        try:
            current = _parse_manifest(index, entries_key)
            if current != manifest:
                manifest = current
        except (OSError, ValueError, TypeError):
            manifest = None
    try:
        manifest = manifest if manifest is not None else _parse_manifest(index, entries_key)
        return manifest, read_records(directory, manifest, entries_key, prefix)
    except (OSError, ValueError, TypeError, KeyError) as exc:
        failure = str(exc)
    candidates = []
    for path in _backup_candidates(directory):
        try:
            value = _parse_manifest(path, entries_key)
            candidates.append((value.get("revision", 0), path, value))
        except (OSError, ValueError, TypeError):
            continue
    for _, path, value in sorted(candidates, key=lambda item: item[0], reverse=True):
        try:
            records = read_records(directory, value, entries_key, prefix)
        except (OSError, ValueError, TypeError, KeyError):
            continue
        recovered = dict(value)
        recovered["_recovery"] = {
            "source": str(path), "error": failure,
            "message": (
                "Showing a complete retained revision. Saving is blocked until explicit recovery; damaged files are retained. "
                f"Inspect/export this revision, then run transactional_store.py recover \"{directory}\" --kind {prefix}."
            ),
        }
        return recovered, records
    raise RecoveryRequiredError(
        f"Store at {directory} is damaged ({failure}). Originals were retained. "
        f"Run transactional_store.py inspect \"{directory}\" --kind {prefix}; restore a verified export if no complete backup remains."
    )


def read_manifest(directory, entries_key, prefix):
    """Read only the index on the healthy path, allowing proportional paging."""
    try:
        return _parse_manifest(Path(directory) / "index.json", entries_key)
    except FileNotFoundError:
        if not _backup_candidates(directory):
            return None
    except (OSError, ValueError, TypeError):
        pass
    return read_snapshot(directory, entries_key, prefix)[0]


@_serialized_read
def read_selected_snapshot(directory, manifest, entries_key, prefix, record_ids):
    """Stay proportional when healthy; preserve complete-snapshot recovery."""
    if not manifest.get("_recovery"):
        try:
            current = _parse_manifest(Path(directory) / "index.json", entries_key)
            if current != manifest:
                manifest = current
        except (OSError, ValueError, TypeError):
            pass
    try:
        return manifest, read_records(directory, manifest, entries_key, prefix, record_ids)
    except (OSError, ValueError, TypeError, KeyError):
        recovered, records = read_snapshot(directory, entries_key, prefix, manifest)
        selected = set(record_ids)
        return recovered, [record for record in records if record["id"] in selected]


def commit_records(directory, metadata, records, entries_key, prefix, *,
                   expected_revision=None, maximum_bytes=100 * 1024 * 1024, fault=None,
                   summary_builder=None, partial=False, deleted_ids=()):
    """Publish records atomically. Any failure exposes one whole revision."""
    checkpoint = fault or (lambda _stage, _record_id=None: None)
    with store_lock(directory):
        previous = read_manifest(directory, entries_key, prefix)
        if previous is not None:
            if partial:
                # Immutable records were checked when originally committed;
                # validate their references without reopening unrelated history.
                read_records(directory, previous, entries_key, prefix, ())
            else:
                previous, _ = read_snapshot(directory, entries_key, prefix, previous)
            if previous.get("_recovery"):
                raise RecoveryRequiredError(previous["_recovery"]["message"])
        actual = previous.get("revision", 0) if previous else 0
        if expected_revision is not None and expected_revision != actual:
            raise RevisionConflictError("Store revision changed before the transaction committed")
        manifest = {**(previous if partial and previous else {}), **metadata}
        manifest.pop("_recovery", None)
        manifest["storage_format"] = "immutable-json-gzip-v1"
        entries = []
        seen = set()
        for record in records:
            record_id = str(record.get("id") or "").strip()
            if not record_id or record_id in seen:
                raise ValueError("record identifiers must be nonempty and unique")
            seen.add(record_id)
            raw = _encoded(record)
            if len(raw) > maximum_bytes:
                raise ValueError("Record exceeds the store size limit")
            digest = hashlib.sha256(record_id.encode("utf-8")).hexdigest()
            checksum = hashlib.sha256(raw).hexdigest()
            filename = f"{prefix}_{digest}_{checksum}.json.gz"
            checkpoint("before_record", record_id)
            path = Path(directory) / filename
            if path.exists():
                if _json_bytes(path) != raw:
                    raise RecoveryRequiredError(f"Immutable record is damaged: {path}; original retained")
            else:
                _atomic_bytes(path, _compressed(raw))
            entry = {"id": record_id, "file": filename, "sha256": checksum}
            if summary_builder is not None:
                entry["summary"] = summary_builder(record)
            entries.append(entry)
            checkpoint("after_record", record_id)
        if partial and previous:
            replacements = {entry["id"]: entry for entry in entries}
            entries = [replacements.pop(entry["id"], entry) for entry in previous[entries_key]]
            entries.extend(replacements.values())
        deleted = set(deleted_ids)
        manifest[entries_key] = [entry for entry in entries if entry["id"] not in deleted]
        raw_manifest = _encoded(manifest)
        if len(raw_manifest) > maximum_bytes:
            raise ValueError("Manifest exceeds the store size limit")
        checkpoint("before_backup")
        index_path = Path(directory) / "index.json"
        if previous is not None:
            old = index_path.read_bytes()
            checksum = hashlib.sha256(old).hexdigest()
            backup = Path(directory) / "_backups" / f"index_r{actual}_{checksum}.json.gz"
            saved_at = index_path.stat().st_mtime
            _atomic_bytes(backup, _compressed(old))
            os.utime(backup, (saved_at, saved_at))
            _atomic_bytes(Path(directory) / "_backups" / "index.bak", _compressed(old))
        checkpoint("after_backup")
        checkpoint("before_commit")
        # Reserve the revision durably before publication. If the current index
        # later becomes unreadable, recovery still avoids reusing a revision a
        # browser may have observed (including after a post-commit failure).
        _reserve_revision(directory, manifest.get("revision", 0))
        _atomic_bytes(index_path, raw_manifest)
        checkpoint("after_commit")
        checkpoint("before_cleanup")
        # Cleanup runs separately from the save transaction, under the same lock.
        checkpoint("after_cleanup")
        return manifest


def commit_record_updates(directory, metadata, records, entries_key, prefix, **kwargs):
    """Commit only changed records while retaining immutable unrelated entries."""
    return commit_records(directory, metadata, records, entries_key, prefix, partial=True, **kwargs)


def export_snapshot(directory, entries_key, prefix, records_key, output):
    manifest, records = read_snapshot(directory, entries_key, prefix)
    value = {key: item for key, item in manifest.items()
             if key not in {entries_key, "storage_format", "_recovery"}}
    value[records_key] = records
    output = Path(output)
    if output.exists():
        raise FileExistsError(f"Export destination already exists: {output}")
    _atomic_bytes(output, _encoded(value))
    return value


def migrate_store(directory, entries_key, prefix, records_key, legacy_path=None):
    """Explicit migration; verify the published snapshot and retain originals."""
    with store_lock(directory):
        current = read_manifest(directory, entries_key, prefix)
        if current is not None:
            current, records = read_snapshot(directory, entries_key, prefix, current)
            if current.get("_recovery"):
                raise RecoveryRequiredError("Recover the store before migrating it")
            metadata = {key: value for key, value in current.items() if key != entries_key}
        elif legacy_path:
            raw = Path(legacy_path).read_bytes()
            value = json.loads(raw)
            records = value[records_key]
            metadata = {key: item for key, item in value.items() if key != records_key}
            backup = Path(directory) / "_backups" / ("legacy_" + hashlib.sha256(raw).hexdigest() + ".json")
            _atomic_bytes(backup, raw)
        else:
            raise ValueError("No existing split store; provide --legacy for migration")
        manifest = commit_records(directory, metadata, records, entries_key, prefix)
        if read_records(directory, manifest, entries_key, prefix) != records:
            raise RecoveryRequiredError("Migration verification failed; originals were retained")
        return manifest


def recover_store(directory, entries_key, prefix):
    with store_lock(directory):
        manifest, records = read_snapshot(directory, entries_key, prefix)
        if not manifest.get("_recovery"):
            return manifest
        index = Path(directory) / "index.json"
        if index.exists():
            _atomic_bytes(Path(directory) / "_backups" / f"damaged-index-{uuid.uuid4().hex}.json", index.read_bytes())
        revisions = [manifest.get("revision", 0), _high_water_revision(directory)]
        for path in (Path(directory) / "_backups").glob("revision_r*.json"):
            try:
                revisions.append(int(path.stem.removeprefix("revision_r")))
            except ValueError:
                continue
        for path in [index, *_backup_candidates(directory)]:
            try:
                revisions.append(_parse_manifest(path, entries_key).get("revision", 0))
            except (OSError, ValueError, TypeError):
                pass
        restored = {key: value for key, value in manifest.items() if key != "_recovery"}
        restored["recovered_from_revision"] = manifest.get("revision", 0)
        restored["revision"] = max(revisions) + 1
        _reserve_revision(directory, restored["revision"])
        _atomic_bytes(index, _encoded(restored))
        return restored


def _high_water_revision(directory):
    path = Path(directory) / "_backups" / "revision.json"
    try:
        return int(json.loads(path.read_bytes())["revision"])
    except FileNotFoundError:
        return 0


def _reserve_revision(directory, revision):
    _atomic_bytes(Path(directory) / "_backups" / "revision.json",
                  _encoded({"revision": max(revision, _high_water_revision(directory))}))


def _checkpoint_catalog(directory):
    """Discover checkpoints without opening thousands of obsolete indexes."""
    by_revision = {}
    for path in _backup_candidates(directory):
        match = re.fullmatch(r"index_r(\d+)_[0-9a-f]{64}\.json(?:\.gz)?", path.name)
        if not match:
            continue
        revision = int(match[1])
        candidate = {"revision": revision, "path": path, "saved_at": path.stat().st_mtime}
        previous = by_revision.get(revision)
        if previous is None or (path.suffix == ".gz", path.name) > (previous["path"].suffix == ".gz", previous["path"].name):
            by_revision[revision] = candidate
    # Old split stores can have only index.bak, with no revision checkpoint.
    backup = Path(directory) / "_backups" / "index.bak"
    if backup.is_file():
        try:
            value = json.loads(_json_bytes(backup))
            revision = int(value["revision"])
            by_revision.setdefault(revision, {"revision": revision, "path": backup, "saved_at": backup.stat().st_mtime})
        except (ValueError, KeyError, TypeError):
            pass
    return sorted(by_revision.values(), key=lambda item: item["revision"], reverse=True)


def _retained_checkpoints(catalog, now):
    today = datetime.fromtimestamp(now, timezone.utc).date()
    monday = today - timedelta(days=today.weekday())
    selected = {}
    days, weeks = set(), set()
    for position, item in enumerate(catalog):
        day = datetime.fromtimestamp(item["saved_at"], timezone.utc).date()
        week = day - timedelta(days=day.weekday())
        tier = None
        if monday - timedelta(weeks=RETENTION["weekly_weeks"]) <= week < monday and week not in weeks:
            tier = "weekly"
            weeks.add(week)
        if today - timedelta(days=RETENTION["daily_days"]) <= day < today and day not in days:
            tier = "daily"
            days.add(day)
        if position < RETENTION["recent"]:
            tier = "recent"
        if tier:
            selected[item["revision"]] = {**item, "tier": tier}
    return list(selected.values())


def _safe_remove(root, path):
    """Only remove regular files inside this store, never follow links."""
    root, path = Path(root).resolve(), Path(path)
    if path.is_symlink() or not path.resolve().is_relative_to(root):
        raise ValueError("History cleanup encountered a path outside its store")
    path.unlink(missing_ok=True)


def _compress_manifest(directory, manifest, entries_key, prefix, converted):
    read_records(directory, manifest, entries_key, prefix, ())  # Validate references first.
    entries = []
    for entry in manifest[entries_key]:
        old_name = entry["file"]
        if old_name not in converted:
            raw = _read_record_bytes(Path(directory) / old_name)
            checksum = hashlib.sha256(raw).hexdigest()
            if entry.get("sha256") and checksum != entry["sha256"]:
                raise RecoveryRequiredError(f"Checksum mismatch in retained record {old_name}; cleanup cancelled")
            value = json.loads(raw)
            if not isinstance(value, dict) or value.get("id") != entry["id"]:
                raise RecoveryRequiredError("Retained record identity mismatch; cleanup cancelled")
            digest = hashlib.sha256(entry["id"].encode("utf-8")).hexdigest()
            name = f"{prefix}_{digest}_{checksum}.json.gz"
            path = Path(directory) / name
            if not path.exists():
                _atomic_bytes(path, _compressed(raw))
            if _read_record_bytes(path) != raw:
                raise RecoveryRequiredError("Compressed record verification failed; originals retained")
            converted[old_name] = (name, checksum)
        name, checksum = converted[old_name]
        entries.append({**entry, "file": name, "sha256": checksum})
    return {**manifest, entries_key: entries, "storage_format": "immutable-json-gzip-v1"}


def _maintenance_state(directory):
    try:
        return json.loads((Path(directory) / "_maintenance.json").read_bytes())
    except (OSError, ValueError):
        return {}


def maintain_storage(directory, entries_key, prefix, *, now=None, budget_bytes=None, fault=None):
    """Verified, resumable migration and retention. Never prunes a damaged store.

    Compressed records and checkpoints are published before their originals are
    retired. Current data and the newest verified fallback are never budget victims.
    A crash during cleanup leaves extra files, not a partially published snapshot.
    """
    now = time.time() if now is None else now
    budget = RETENTION["budget_bytes"] if budget_bytes is None else budget_bytes
    checkpoint = fault or (lambda _stage: None)
    root = Path(directory)
    with store_lock(directory):
        manifest, _ = read_snapshot(directory, entries_key, prefix)
        if manifest.get("_recovery"):
            raise RecoveryRequiredError("Recover the damaged store before optimizing history storage")
        catalog = _checkpoint_catalog(directory)
        selected = _retained_checkpoints([item for item in catalog if item["revision"] < manifest.get("revision", 0)], now)
        converted = {}
        current = _compress_manifest(directory, manifest, entries_key, prefix, converted)
        retained = []
        for item in selected:
            value = _parse_manifest(item["path"], entries_key)
            value = _compress_manifest(directory, value, entries_key, prefix, converted)
            raw = _encoded(value)
            name = f"index_r{value['revision']}_{hashlib.sha256(raw).hexdigest()}.json.gz"
            target = root / "_backups" / name
            _atomic_bytes(target, _compressed(raw))
            os.utime(target, (item["saved_at"], item["saved_at"]))
            if _parse_manifest(target, entries_key) != value:
                raise RecoveryRequiredError("Checkpoint verification failed; originals retained")
            retained.append({**item, "path": target, "manifest": value})
        current_files = {entry["file"] for entry in current[entries_key]}

        def recovery_bytes(items):
            names = {entry["file"] for item in items for entry in item["manifest"][entries_key]} - current_files
            fallback_bytes = max(items, key=lambda item: item["revision"])["path"].stat().st_size if items else 0
            return sum((root / name).stat().st_size for name in names) + sum(item["path"].stat().st_size for item in items) + fallback_bytes

        # Oldest weekly, then daily, then recent; protect the newest fallback.
        newest = max((item["revision"] for item in retained), default=None)
        for item in sorted(retained, key=lambda item: ({"weekly": 0, "daily": 1, "recent": 2}[item["tier"]], item["revision"])):
            if recovery_bytes(retained) <= budget:
                break
            if item["revision"] != newest:
                retained.remove(item)
        # Consolidate revision markers BEFORE deleting any of them.
        high = max([manifest.get("revision", 0), _high_water_revision(directory)] + [item["revision"] for item in catalog])
        for path in (root / "_backups").glob("revision_r*.json"):
            match = re.fullmatch(r"revision_r(\d+)\.json", path.name)
            if match:
                high = max(high, int(match[1]))
        _reserve_revision(directory, high)
        checkpoint("before_publish")
        index = root / "index.json"
        saved_at = index.stat().st_mtime
        _atomic_bytes(index, _encoded(current))
        os.utime(index, (saved_at, saved_at))
        backup = root / "_backups" / "index.bak"
        if retained:
            latest = max(retained, key=lambda item: item["revision"])
            _atomic_bytes(backup, _compressed(_encoded(latest["manifest"])))
            os.utime(backup, (latest["saved_at"], latest["saved_at"]))
        checkpoint("after_publish")
        read_records(directory, current, entries_key, prefix)
        for item in retained:
            read_records(directory, item["manifest"], entries_key, prefix)
        checkpoint("before_cleanup")
        keep_records = current_files | {entry["file"] for item in retained for entry in item["manifest"][entries_key]}
        keep_indexes = {item["path"].name for item in retained}
        removed_bytes = removed_files = 0
        # Delete retired manifests first, so recovery never advertises a snapshot
        # whose records have already been removed after an interrupted cleanup.
        for path in list((root / "_backups").iterdir()):
            managed = re.fullmatch(r"index_r\d+_[0-9a-f]{64}\.json(?:\.gz)?|revision_r\d+\.json", path.name)
            if managed and path.name not in keep_indexes or path == backup and not retained:
                removed_bytes += path.stat().st_size
                _safe_remove(root, path)
                removed_files += 1
        for path in root.iterdir():
            if re.fullmatch(rf"{prefix}_[0-9a-f]{{64}}(?:_[0-9a-f]{{64}})?\.json(?:\.gz)?", path.name) and path.name not in keep_records:
                removed_bytes += path.stat().st_size
                _safe_remove(root, path)
                removed_files += 1
        # Legacy migration artifacts get a bounded grace period, measured from
        # the first successful migration. Unknown/damaged files are never swept.
        previous_state = _maintenance_state(directory)
        migrated_at = previous_state.get("migrated_at", now)
        legacy_expires = migrated_at + 7 * 86400
        for path in list((root / "_backups").iterdir()):
            legacy = re.fullmatch(rf"(?:legacy[^/\\]*|{prefix}_[0-9a-f]{{64}})\.(?:bak|json)(?:\.gz)?", path.name)
            if not legacy:
                continue
            if now >= legacy_expires:
                removed_bytes += path.stat().st_size
                _safe_remove(root, path)
                removed_files += 1
            elif path.suffix != ".gz":
                raw = path.read_bytes()
                target = path.with_name(path.name + ".gz")
                _atomic_bytes(target, _compressed(raw))
                if _json_bytes(target) != raw:
                    raise RecoveryRequiredError("Legacy backup compression verification failed")
                _safe_remove(root, path)
        result = {"version": 1, "migrated_at": migrated_at, "last_completed": now,
                  "legacy_expires_at": legacy_expires, "removed_files": removed_files,
                  "removed_bytes": removed_bytes, "checkpoints": len(retained),
                  "recovery_bytes": recovery_bytes(retained), "budget_exceeded": recovery_bytes(retained) > budget}
        _atomic_bytes(root / "_maintenance.json", _encoded(result))
        checkpoint("after_cleanup")
        return result


def schedule_maintenance(directory, entries_key, prefix, legacy_path=None):
    """Startup migrates the entire store; subsequent access schedules upkeep."""
    root = Path(directory)
    if not (root / "index.json").is_file() and not (legacy_path and Path(legacy_path).is_file()):
        return
    state = _maintenance_state(root)
    last = max(state.get("last_completed", 0), state.get("last_attempt", 0))
    if time.time() - last < MAINTENANCE_INTERVAL:
        return
    key = str(root.resolve())
    with _MAINTENANCE_GUARD:
        if key in _MAINTENANCE_RUNNING:
            return
        _MAINTENANCE_RUNNING.add(key)

    def run():
        try:
            with store_lock(root):
                if time.time() - _maintenance_state(root).get("last_completed", 0) < MAINTENANCE_INTERVAL:
                    return
                if not (root / "index.json").exists():
                    migrate_store(root, entries_key, prefix, "chats" if prefix == "chat" else "projects", legacy_path)
                logging.info("Prompt Studio: optimizing entire %s history library at %s", prefix, root)
                result = maintain_storage(root, entries_key, prefix)
                # Retire the old monolith too, including installs migrated by an
                # older release that deliberately kept this redundant source.
                if legacy_path:
                    legacy = Path(legacy_path)
                    if legacy.resolve().parent != root.resolve().parent or legacy.name != root.name + ".json":
                        raise ValueError("Legacy history path must be the sibling store JSON")
                    for source in (legacy, legacy.with_name(legacy.name + ".bak")):
                        if not source.is_file():
                            continue
                        raw = source.read_bytes()
                        target = root / "_backups" / ("legacy_source_" + hashlib.sha256(raw).hexdigest() + ".json.gz")
                        _atomic_bytes(target, _compressed(raw))
                        if _json_bytes(target) != raw:
                            raise RecoveryRequiredError("Legacy source verification failed; source retained")
                        _safe_remove(root.parent, source)
                logging.info("Prompt Studio: %s history optimized; %s recovery checkpoints, %.2f MiB retired",
                             prefix, result["checkpoints"], result["removed_bytes"] / 1048576)
        except Exception as exc:
            logging.exception("Prompt Studio: %s history optimization failed; remaining originals retained", prefix)
            with store_lock(root):
                _atomic_bytes(root / "_maintenance.json", _encoded({**_maintenance_state(root), "last_attempt": time.time(), "error": str(exc)}))
        finally:
            with _MAINTENANCE_GUARD:
                _MAINTENANCE_RUNNING.discard(key)
    threading.Thread(target=run, name=f"promptstudio-{prefix}-storage", daemon=True).start()


@_serialized_read
def storage_status(directory, entries_key, prefix, revision=None):
    manifest = read_manifest(directory, entries_key, prefix)
    if manifest is None:
        return {"revision": 0, "current_bytes": 0, "recovery_bytes": 0, "other_bytes": 0, "checkpoints": [], "policy": RETENTION}
    catalog = _checkpoint_catalog(directory)
    if revision is not None:
        item = next((item for item in catalog if item["revision"] == int(revision)), None)
        if item is None:
            raise ValueError("This recovery checkpoint has expired. Refresh the list.")
        value = _parse_manifest(item["path"], entries_key)
        return {"revision": item["revision"], "records": [{"id": entry["id"], "summary": entry.get("summary", {})} for entry in value[entries_key]]}
    root = Path(directory)
    names = {entry["file"] for entry in manifest[entries_key]} | {"index.json"}
    current_bytes = recovery_bytes = other_bytes = 0
    for path in root.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        size = path.stat().st_size
        if path.parent == root and path.name in names:
            current_bytes += size
        elif path.name.startswith((prefix + "_", "index_r")) or path.name == "index.bak":
            recovery_bytes += size
        else:
            other_bytes += size
    return {"revision": manifest.get("revision", 0), "current_bytes": current_bytes, "recovery_bytes": recovery_bytes,
            "other_bytes": other_bytes, "policy": RETENTION, "maintenance": _maintenance_state(root),
            "checkpoints": [{"revision": item["revision"], "saved_at": item["saved_at"]} for item in catalog]}


@_serialized_read
def restore_record(directory, entries_key, prefix, revision, record_id, expected_revision, *, summary_builder):
    current, _ = read_snapshot(directory, entries_key, prefix)
    if current.get("_recovery"):
        raise RecoveryRequiredError("Recover the damaged store before restoring an individual session")
    if current["revision"] != expected_revision:
        raise RevisionConflictError("History changed. Refresh recovery before restoring.")
    item = next((item for item in _checkpoint_catalog(directory) if item["revision"] == revision), None)
    if item is None:
        raise ValueError("Recovery checkpoint has expired")
    old = _parse_manifest(item["path"], entries_key)
    records = read_records(directory, old, entries_key, prefix, [record_id])
    if not records:
        raise ValueError("Session is not present in this checkpoint")
    existing = read_records(directory, current, entries_key, prefix, [record_id])
    for record in records + existing:
        summary = summary_builder(record)
        if summary.get("pending_count") or summary.get("pendingCount") or (record.get("consultAgent") or {}).get("active") or record.get("director_pending"):
            raise ValueError("This session has unfinished work. Choose a completed checkpoint and finish or stop current work first.")
    deleted_key = "deletedChatIds" if prefix == "chat" else "deletedProjectIds"
    active_key = "activeChatId" if prefix == "chat" else "active_project_id"
    metadata = {"revision": current["revision"] + 1, active_key: record_id,
                deleted_key: [value for value in current.get(deleted_key, []) if value != record_id]}
    return commit_record_updates(directory, metadata, records, entries_key, prefix,
                                 expected_revision=expected_revision, summary_builder=summary_builder)


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("inspect", "export", "migrate", "recover", "optimize", "storage"))
    parser.add_argument("directory")
    parser.add_argument("output", nargs="?")
    parser.add_argument("--kind", choices=("chat", "project"), required=True)
    parser.add_argument("--legacy")
    args = parser.parse_args()
    entries_key, records_key = ("chatFiles", "chats") if args.kind == "chat" else ("projectFiles", "projects")
    if args.command == "export":
        if not args.output:
            parser.error("export requires an output JSON path")
        value = export_snapshot(args.directory, entries_key, args.kind, records_key, args.output)
    elif args.command == "migrate":
        value = migrate_store(args.directory, entries_key, args.kind, records_key, args.legacy)
    elif args.command == "recover":
        value = recover_store(args.directory, entries_key, args.kind)
    elif args.command == "optimize":
        value = maintain_storage(args.directory, entries_key, args.kind)
    elif args.command == "storage":
        value = storage_status(args.directory, entries_key, args.kind)
    else:
        value, records = read_snapshot(args.directory, entries_key, args.kind)
        value = {"revision": value.get("revision"), "records": len(records), "recovery": value.get("_recovery")}
    print(json.dumps(value, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
