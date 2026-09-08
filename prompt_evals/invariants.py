"""Deterministic contract checks, not a model judge or a semantic quality score."""

import copy
import math
import re


_MISSING = object()
_OPS = {"equal", "contains", "excludes", "same_as_prior", "word_range", "timeline", "unchanged_except"}


def at(value, path):
    if path == "":
        return value
    if not isinstance(path, str) or not path.startswith("/"):
        raise ValueError("Invariant paths must be JSON pointers")
    for token in path[1:].split("/"):
        token = token.replace("~1", "/").replace("~0", "~")
        try:
            value = value[int(token)] if isinstance(value, list) else value[token]
        except (KeyError, IndexError, TypeError, ValueError):
            return _MISSING
    return value


def mutated(output, mutation):
    result = copy.deepcopy(output)
    prefix, _, leaf = mutation["path"].rpartition("/")
    parent = at(result, prefix)
    key = int(leaf) if isinstance(parent, list) else leaf.replace("~1", "/").replace("~0", "~")
    parent[key] = copy.deepcopy(mutation["value"])
    return result


def _diff_paths(before, after, path=""):
    if isinstance(before, dict) and isinstance(after, dict):
        for key in before.keys() | after.keys():
            token = str(key).replace("~", "~0").replace("/", "~1")
            yield from _diff_paths(before.get(key, _MISSING), after.get(key, _MISSING), path + "/" + token)
    elif isinstance(before, list) and isinstance(after, list) and len(before) == len(after):
        for index, (old, new) in enumerate(zip(before, after)):
            yield from _diff_paths(old, new, path + "/" + str(index))
    elif before != after:
        yield path


def _timeline_valid(value):
    if not isinstance(value, dict):
        return False
    try:
        duration = float(value["duration_seconds"])
        shots = value["shots"]
        starts = [float(shot["start"]) for shot in shots]
        identifiers = [shot["id"] for shot in shots]
        return (math.isfinite(duration) and duration > 0 and bool(starts) and starts[0] == 0
                and len(set(identifiers)) == len(identifiers)
                and all(math.isfinite(start) and 0 <= start < duration for start in starts)
                and all(left < right for left, right in zip(starts, starts[1:])))
    except (KeyError, TypeError, ValueError):
        return False


def check_output(case, output):
    failures = []
    if not isinstance(output, dict):
        return [{"kind": "format", "path": "", "reason": "Output must be one JSON object"}]
    for rule in case["invariants"]:
        path, operation = rule["path"], rule["op"]
        value = at(output, path)
        valid, kind = value is not _MISSING, "invariant"
        if valid:
            if operation == "equal":
                valid = value == rule["value"]
            elif operation in {"contains", "excludes"}:
                if not isinstance(value, str):
                    valid = False
                else:
                    text, needle = value, rule["value"]
                    if not rule.get("case_sensitive", False):
                        text, needle = text.casefold(), needle.casefold()
                    valid = (needle in text) == (operation == "contains")
            elif operation == "same_as_prior":
                original = at(case["prior_state"], rule.get("prior_path", path))
                valid = original is not _MISSING and value == original
                kind = "unintended_change"
            elif operation == "word_range":
                valid = isinstance(value, str) and rule["minimum"] <= len(re.findall(r"\S+", value)) <= rule["maximum"]
            elif operation == "timeline":
                valid = _timeline_valid(value)
            elif operation == "unchanged_except":
                before = at(case["prior_state"], rule.get("prior_path", path))
                allowed = rule["allowed"]
                unexpected = [changed for changed in _diff_paths(before, value)
                              if not any(changed == item or changed.startswith(item + "/") for item in allowed)]
                valid = before is not _MISSING and not unexpected
                kind = "unintended_change"
            else:
                raise ValueError("Unknown invariant operation: " + operation)
        if not valid:
            failures.append({"kind": kind, "path": path, "reason": operation + " failed"})
    for path in case["prohibited_collateral_changes"]:
        previous, current = at(case["prior_state"], path), at(output, path)
        if previous is _MISSING or current is _MISSING or previous != current:
            failures.append({"kind": "unintended_change", "path": path, "reason": "Protected prior state changed"})
    return failures


def validate_cases(matrix):
    """Check fixture schema and ensure every adversarial mutation is detected."""
    identifiers = set()
    for case in matrix:
        required = {"schema_version", "suite_version", "id", "product", "synthetic", "input", "prior_state",
                    "controls", "invariants", "prohibited_collateral_changes", "accepted_output", "rejected_mutations"}
        if not isinstance(case, dict) or required - case.keys():
            raise ValueError("Incomplete evaluation case")
        if (case["schema_version"] != 1 or case["synthetic"] is not True
                or case["product"] not in {"image", "video"} or case["id"] in identifiers):
            raise ValueError("Invalid, private, or duplicate evaluation case")
        identifiers.add(case["id"])
        if not case["invariants"] or not case["rejected_mutations"]:
            raise ValueError("Each case needs invariants and an adversarial rejection")
        for rule in case["invariants"]:
            if rule["op"] not in _OPS:
                raise ValueError("Unknown invariant operation")
            at(case["accepted_output"], rule["path"])
        if check_output(case, case["accepted_output"]):
            raise ValueError("Accepted fixture failed: " + case["id"])
        for mutation in case["rejected_mutations"]:
            if not check_output(case, mutated(case["accepted_output"], mutation)):
                raise ValueError("Adversarial fixture escaped its oracle: " + case["id"])
    if not identifiers:
        raise ValueError("No evaluation cases selected")
    return len(identifiers)
