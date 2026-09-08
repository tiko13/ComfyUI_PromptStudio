"""Immutable JSON records published by one atomic manifest replacement.

Readers see an entire old or new revision. Existing split records and legacy
files remain untouched; saves write content-addressed records and retain prior
manifests. No automatic record garbage collection can invalidate readers or
recovery points. Callers hold store_lock across read/check/merge/save.

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
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import uuid


class RecoveryRequiredError(RuntimeError):
    pass


class RevisionConflictError(RuntimeError):
    pass


_LOCKS = {}
_LOCKS_GUARD = threading.Lock()
_LOCAL = threading.local()
_MANIFEST_CACHE = {}
_MANIFEST_CACHE_LOCK = threading.Lock()


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
    value = json.loads(path.read_text(encoding="utf-8"))
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
    return Path(path).read_bytes()


def _backup_candidates(directory):
    backups = Path(directory) / "_backups"
    return list(backups.glob("index_r*.json")) + ([backups / "index.bak"] if (backups / "index.bak").is_file() else [])


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
        if not record_id or record_id in seen or filename != expected:
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


def read_snapshot(directory, entries_key, prefix, manifest=None):
    """Return a complete snapshot; recovery fallback is visible and read-only."""
    index = Path(directory) / "index.json"
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


def read_selected_snapshot(directory, manifest, entries_key, prefix, record_ids):
    """Stay proportional when healthy; preserve complete-snapshot recovery."""
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
        manifest["storage_format"] = "immutable-json-v1"
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
            filename = f"{prefix}_{digest}_{checksum}.json"
            checkpoint("before_record", record_id)
            path = Path(directory) / filename
            if path.exists():
                if path.read_bytes() != raw:
                    raise RecoveryRequiredError(f"Immutable record is damaged: {path}; original retained")
            else:
                _atomic_bytes(path, raw)
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
            _atomic_bytes(Path(directory) / "_backups" / f"index_r{actual}_{checksum}.json", old)
            _atomic_bytes(Path(directory) / "_backups" / "index.bak", old)
        checkpoint("after_backup")
        checkpoint("before_commit")
        # Reserve the revision durably before publication. If the current index
        # later becomes unreadable, recovery still avoids reusing a revision a
        # browser may have observed (including after a post-commit failure).
        _atomic_bytes(Path(directory) / "_backups" / f"revision_r{manifest.get('revision', 0)}.json",
                      _encoded({"revision": manifest.get("revision", 0)}))
        _atomic_bytes(index_path, raw_manifest)
        checkpoint("after_commit")
        checkpoint("before_cleanup")
        # Retain old records and manifests: readers may still hold their index,
        # and recovery must never depend on overwritten/deleted record files.
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
        revisions = [manifest.get("revision", 0)]
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
        _atomic_bytes(Path(directory) / "_backups" / f"revision_r{restored['revision']}.json",
                      _encoded({"revision": restored["revision"]}))
        _atomic_bytes(index, _encoded(restored))
        return restored


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("inspect", "export", "migrate", "recover"))
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
    else:
        value, records = read_snapshot(args.directory, entries_key, args.kind)
        value = {"revision": value.get("revision"), "records": len(records), "recovery": value.get("_recovery")}
    print(json.dumps(value, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
