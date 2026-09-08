"""Paired sampling and honest metrics; provider calls occur only via an adapter."""

import copy
import hashlib
import json
import math
import random
import time
import uuid

from .invariants import at, check_output, validate_cases


def _percentile(values, percentile):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * percentile) - 1)] if ordered else None


def summarize(records):
    count = len(records)
    first = [row["first_pass_valid"] for row in records if row["first_pass_valid"] is not None]
    corrections = [row["correction_calls"] for row in records if row["correction_calls"] is not None]
    times = [row["latency_seconds"] for row in records]
    return {
        "samples": count,
        "success_rate": sum(not row["failures"] for row in records) / count if count else None,
        "unintended_change_rate": sum(any(failure["kind"] == "unintended_change" for failure in row["failures"])
                                      for row in records) / count if count else None,
        "first_pass_validity": sum(first) / len(first) if first else None,
        "first_pass_observed_samples": len(first),
        "mean_correction_calls": sum(corrections) / len(corrections) if corrections else None,
        "total_correction_calls": sum(corrections) if corrections else None,
        "correction_observed_samples": len(corrections),
        "p50_latency_seconds": _percentile(times, 0.50),
        "p95_latency_seconds": _percentile(times, 0.95),
    }


def compare(matrix, baseline, candidate, settings, *, seeds, repeats, adapter):
    """The same cases/settings/seeds reach both variants, with alternating order.

    adapter(case, variant, settings, seed) returns output and optional first_output,
    correction_calls, token_usage, and provider_metadata. Unknown telemetry stays
    null rather than being silently counted as zero or as first-pass success.
    """
    validate_cases(matrix)
    if repeats < 1 or not seeds or any(not isinstance(seed, int) for seed in seeds):
        raise ValueError("Choose at least one integer seed and a positive repeat count")
    if baseline["version"] == candidate["version"]:
        raise ValueError("Baseline and candidate need distinct version identifiers")
    for variant in (baseline, candidate):
        if not variant.get("prompt", "").strip() or not variant.get("policy_version", "").strip():
            raise ValueError("Each variant needs prompt text and a policy version")
    records = []
    for case in matrix:
        for seed in seeds:
            for repeat in range(repeats):
                order = [("baseline", baseline), ("candidate", candidate)]
                if repeat % 2:
                    order.reverse()
                for label, variant in order:
                    started = time.perf_counter()
                    row = {"case_id": case["id"], "product": case["product"], "variant": label,
                           "prompt_version": variant["version"], "policy_version": variant["policy_version"],
                           "prompt_sha256": hashlib.sha256(variant["prompt"].encode()).hexdigest(),
                           "seed": seed, "repeat": repeat, "first_pass_valid": None, "correction_calls": None,
                           "token_usage": None, "provider_metadata": None, "output": None, "first_output": None,
                           "categories": copy.deepcopy(case.get("categories", [])),
                           "blind_id": uuid.uuid4().hex, "pair_group": case.get("pair_group")}
                    try:
                        # Never give the live adapter accepted answers or oracle
                        # rules that could contaminate its provider payload.
                        adapter_case = {key: copy.deepcopy(case[key]) for key in (
                            "id", "product", "input", "prior_state", "controls", "attachments",
                        ) if key in case}
                        adapter_case["output_fields"] = list(case["accepted_output"])
                        answer = adapter(adapter_case, copy.deepcopy(variant), copy.deepcopy(settings), seed)
                        row["output"] = copy.deepcopy(answer["output"])
                        row["failures"] = check_output(case, row["output"])
                        if "first_output" in answer:
                            row["first_output"] = copy.deepcopy(answer["first_output"])
                            row["first_pass_valid"] = not check_output(case, answer["first_output"])
                        corrections = answer.get("correction_calls")
                        if corrections is not None:
                            if not isinstance(corrections, int) or corrections < 0:
                                raise ValueError("Invalid correction-call telemetry")
                            row["correction_calls"] = corrections
                        row["token_usage"] = copy.deepcopy(answer.get("token_usage"))
                        row["provider_metadata"] = copy.deepcopy(answer.get("provider_metadata"))
                    except Exception as exc:
                        row["failures"] = [{"kind": "execution", "path": "", "reason": type(exc).__name__ + ": " + str(exc)}]
                    row["latency_seconds"] = time.perf_counter() - started
                    records.append(row)
    # Paired control changes must not leak into Main, even if both strings pass
    # the individual lexical checks. This is a deterministic contract check.
    groups = {}
    for row in records:
        if row["pair_group"]:
            groups.setdefault((row["variant"], row["seed"], row["repeat"], row["pair_group"]), []).append(row)
    for grouped in groups.values():
        if len(grouped) > 1 and len({json.dumps(at(row["output"] or {}, "/main_prompt"), default=str) for row in grouped}) != 1:
            for row in grouped:
                row["failures"].append({"kind": "unintended_change", "path": "/main_prompt", "reason": "Controls changed Main across paired cases"})
        observed = [row for row in grouped if row["first_pass_valid"] is not None]
        if len(observed) > 1 and len({json.dumps(at(row["first_output"] or {}, "/main_prompt"), default=str) for row in observed}) != 1:
            for row in observed:
                row["first_pass_valid"] = False
    return {
        "report_schema_version": 1, "suite_version": matrix[0]["suite_version"],
        "synthetic_inputs_only": True, "evaluation_scope": settings.get("evaluation_scope", "prompt-only"),
        "settings": {key: settings[key] for key in (
            "provider", "model", "temperature", "top_p", "max_tokens", "timeout", "evaluation_scope",
        ) if key in settings},
        "requested_seeds": list(seeds), "repeats": repeats,
        "records": records,
        "summary": {label: summarize([row for row in records if row["variant"] == label])
                    for label in ("baseline", "candidate")},
        "semantic_quality_assessment": "unmeasured; use blinded human assessment",
        "interpretation": "Invariant success is not subjective semantic quality. Requested seeds may not be honored by every provider.",
    }


def blinded_export(report, matrix, *, allow_sharing=False):
    """Produce an explicitly requested human-review artifact without model labels."""
    if not allow_sharing:
        raise ValueError("Sharing evaluation outputs requires explicit opt-in")
    by_id = {case["id"]: case for case in matrix}
    rows = [{"blind_id": row["blind_id"], "case_id": row["case_id"],
             "input": by_id[row["case_id"]]["input"], "prior_state": by_id[row["case_id"]]["prior_state"],
             "controls": by_id[row["case_id"]]["controls"], "output": row["output"],
             "human_assessment": {"intent_fidelity": None, "visual_specificity": None,
                                  "unintended_change": None, "notes": ""}}
            for row in report["records"]]
    random.SystemRandom().shuffle(rows)
    return {"schema_version": 1, "suite_version": report["suite_version"], "rows": rows,
            "instructions": "Assess intent fidelity and useful visual detail without seeing provider or variant labels. Do not rank outputs by length alone."}
