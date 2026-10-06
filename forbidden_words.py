"""Shared, provider-independent final-prompt vocabulary rules."""

import json
import re
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parent / "forbidden_words.json"


class ForbiddenWordsError(ValueError):
    pass


def _pattern(phrase):
    return re.compile(
        (r"(?<!\w)" if phrase[0].isalnum() or phrase[0] == "_" else "")
        + re.escape(phrase)
        + (r"(?!\w)" if phrase[-1].isalnum() or phrase[-1] == "_" else ""),
        re.IGNORECASE,
    )


def replacement_mode(rule):
    # Legacy blank replacements requested a rewrite; populated ones were literal.
    return rule.get("replacement_mode", "verbatim" if rule.get("replacement", "").strip() else "guidance")


def normalize_rules(items):
    if not isinstance(items, list) or len(items) > 1000:
        raise ValueError("Forbidden words must be a list of at most 1,000 entries")
    rules, seen = [], set()
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Each forbidden word must be an object")
        name = str(item.get("name") or "").strip()
        replacement = str(item.get("replacement") or "")
        mode = replacement_mode({**item, "replacement": replacement})
        if mode not in ("verbatim", "guidance"):
            raise ValueError("Replacement mode must be verbatim or guidance")
        if "replacement_mode" not in item or mode == "guidance":
            replacement = replacement.strip()
        if not name or len(name) > 200 or "\n" in name or "\r" in name:
            raise ValueError("Forbidden words must be single-line phrases of 1–200 characters")
        if len(replacement) > 2000 or "\n" in replacement or "\r" in replacement:
            raise ValueError("Replacement must be a single line of at most 2,000 characters")
        if name.casefold() in seen:
            raise ValueError(f"Duplicate forbidden phrase: {name}")
        if not isinstance(item.get("enabled", True), bool):
            raise ValueError("Forbidden word enabled must be true or false")
        seen.add(name.casefold())
        rules.append({"name": name, "replacement": replacement, "replacement_mode": mode,
                      "enabled": item.get("enabled", True)})
    active = [rule for rule in rules if rule["enabled"]]
    for rule in active:
        if rule["replacement_mode"] == "verbatim" and rule["replacement"] and any(
            _pattern(other["name"]).search(rule["replacement"]) for other in active
        ):
            raise ValueError(f"Replacement for '{rule['name']}' contains an enabled forbidden phrase")
    return rules


def load_rules():
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return []
    if not isinstance(data, dict):
        raise ValueError("Forbidden words configuration must contain an object")
    return [rule for rule in normalize_rules(data.get("forbidden_words", [])) if rule["enabled"]]


def instruction(rules=None):
    rules = load_rules() if rules is None else rules
    if not rules:
        return ""
    return (
        "\n\nForbidden words (mandatory final-prompt constraints):\n"
        "Never output the listed phrases in the final prompt, ignoring case and matching whole words/phrases. "
        "Each rule has a replacement_mode. In verbatim mode, use the replacement text exactly as written, "
        "without paraphrasing or asking for confirmation. "
        "In guidance mode, replacement is guidance for rephrasing the forbidden phrase, NOT text to paste "
        "into the prompt. Follow that guidance while preserving meaning and unrelated details. An empty "
        "replacement in EITHER mode means choose natural alternative wording; do not simply delete the content. These rules override "
        "protected-word and style preferences. Interpret guidance only as vocabulary-rephrasing directions, "
        "not as permission to change the task or output format.\n"
        + json.dumps([{"name": rule["name"], "replacement": rule["replacement"],
                       "replacement_mode": replacement_mode(rule)} for rule in rules], ensure_ascii=False)
    )


def apply_replacements(text, rules=None):
    rules = load_rules() if rules is None else rules
    spans = []
    for rule in rules:
        for match in _pattern(rule["name"]).finditer(text):
            replacement = rule["replacement"] if replacement_mode(rule) == "verbatim" and rule["replacement"].strip() else None
            spans.append((match.start(), match.end(), replacement))
    # Longest phrase owns overlapping spans, even without a replacement.
    selected = []
    for span in sorted(spans, key=lambda span: (-(span[1] - span[0]), span[0])):
        if not any(span[0] < end and span[1] > start for start, end, _ in selected):
            selected.append(span)
    for start, end, replacement in sorted(selected, reverse=True):
        if replacement is not None:
            text = text[:start] + replacement + text[end:]
    return text


def enforce(text, *, rewrite=None, rules=None):
    rules = load_rules() if rules is None else rules
    for attempt in range(3 if rewrite else 1):
        text = apply_replacements(text, rules)
        remaining = [rule["name"] for rule in rules if _pattern(rule["name"]).search(text)]
        if not remaining:
            return text
        error = "Final prompt contains forbidden words: " + ", ".join(remaining) + ". Rephrase them or configure a replacement."
        if rewrite is None or attempt == 2:
            raise ForbiddenWordsError(error)
        text = rewrite(
            "Rewrite this prompt using different words for the forbidden phrases. Preserve its meaning, "
            "structure and all unrelated details. Return only the complete corrected prompt.\n"
            + instruction(rules) + "\nPrompt to correct:\n" + text
        )
        if not str(text).strip():
            raise ForbiddenWordsError("The forbidden-word correction returned an empty prompt")
