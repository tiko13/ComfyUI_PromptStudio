"""Shared user-owned prompt configuration, with lossless legacy-file migration."""

import hashlib
import json
import logging
import os
from pathlib import Path
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
USER_DIR = ROOT / "config" / "user"
DEFAULTS_DIR = ROOT / "config" / "defaults"
BACKUP_DIR = ROOT / "config" / "migration-backups"
LOCK = threading.RLock()
# New filename -> legacy root filename, legacy collection, starter data.
FILES = {
    "model_profiles.json": ("model_profiles.additional.json", "profiles", None),
    "styles.json": ("style_templates.additional.json", "style_templates", "styles.user.psc"),
    "framing.json": ("framing_templates.additional.json", "framing_templates", "framing.user.psc"),
    "instructions.json": ("additional_instruction_templates.json", "additional_instruction_templates", "instructions.user.psc"),
    "references.json": ("known_references.json", "known_references", "references.user.psc"),
    "protected_words.json": ("protected_words.txt", "protected_words", None),
    "forbidden_words.json": ("forbidden_words.json", "forbidden_words", None),
}


def document(items):
    return {"version": 1, "items": items}


def items_from_document(data, legacy_key):
    if not isinstance(data, dict):
        raise ValueError("Configuration must contain an object")
    if "version" in data or "items" in data:
        if type(data.get("version")) is not int or data["version"] != 1:
            raise ValueError("Unsupported configuration version; expected version 1")
        items = data.get("items")
    else:
        # Read compatibility for legacy files and third-party integrations.
        items = data.get(legacy_key, [])
    if not isinstance(items, list):
        raise ValueError("Configuration must contain an items list")
    return items


def _decode(raw, path, legacy_key):
    text = raw.decode("utf-8-sig")
    if Path(path).suffix == ".txt" and not text.lstrip().startswith("{"):
        return list(dict.fromkeys(line.strip() for line in text.splitlines()
                                 if line.strip() and line.strip() != "#" and not line.strip().startswith("# ")))
    try:
        return items_from_document(json.loads(text), legacy_key)
    except ValueError as exc:
        raise ValueError(f"Invalid configuration in {Path(path).name}: {exc}") from exc


def _atomic_bytes(path, raw):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + ".", suffix=".tmp", delete=False) as file:
            temporary = Path(file.name)
            file.write(raw)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def write_items(path, items):
    raw = (json.dumps(document(items), ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    _atomic_bytes(path, raw)


def _archive_legacy(source):
    """Keep the exact old bytes, including comments, before removing the root file."""
    if not source.exists():
        return
    raw = source.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()[:16]
    target = BACKUP_DIR / f"{source.name}.{digest}.bak"
    if not target.exists():
        _atomic_bytes(target, raw)
    if target.read_bytes() != raw:
        raise ValueError(f"Migration backup differs for {source.name}; original retained")
    if source.read_bytes() != raw:
        raise ValueError(f"{source.name} changed during migration; original retained")
    source.unlink()


def ensure_user_file(path):
    path = Path(path)
    if path.parent != USER_DIR or path.name not in FILES:
        return
    with LOCK:
        legacy_name, key, starter = FILES[path.name]
        legacy = ROOT / legacy_name
        if not path.exists():
            if legacy.exists():
                items = _decode(legacy.read_bytes(), legacy, key)
            elif starter:
                items = _decode((DEFAULTS_DIR / starter).read_bytes(), DEFAULTS_DIR / starter, key)
            else:
                items = []
            write_items(path, items)
        elif legacy.exists():
            # The new file wins on retries/upgrades; retain the older copy for recovery.
            _decode(path.read_bytes(), path, key)
            logging.info("Prompt Studio: keeping %s; archiving legacy %s", path.name, legacy.name)
        _archive_legacy(legacy)
        _archive_legacy(ROOT / (legacy_name + ".bak"))


def read_items(path, legacy_key):
    ensure_user_file(path)
    try:
        raw = Path(path).read_bytes()
    except FileNotFoundError:
        return []
    return _decode(raw, path, legacy_key)


def protected_words(path):
    items = read_items(path, "protected_words")
    words, seen = [], set()
    for item in items:
        if not isinstance(item, str):
            raise ValueError("Protected words must be strings")
        word = item.strip()
        if word and word.casefold() not in seen:
            words.append(word)
            seen.add(word.casefold())
    return words
