"""Pure, conservative acceptance and calibration helpers for visual judging."""
import copy
import math


def enforce_visual_evidence(evaluation, rubric):
    result = copy.deepcopy(evaluation)
    criteria = {item["id"]: item for item in result.get("criteria", [])}
    missing = []
    for requirement in rubric.get("criteria", []):
        observed = criteria.get(requirement["id"])
        if observed is None or not str(observed.get("evidence", "")).strip():
            missing.append(requirement["id"])
            if observed is not None:
                observed.update(status="fail", score=0, evidence="No visual evidence was supplied.")
    if missing:
        result["pass"] = False
        result["summary"] = "Visual evidence is missing for: " + ", ".join(missing)
        total = sum(item["weight"] for item in rubric.get("criteria", []))
        result["score"] = sum(item["weight"] * criteria.get(item["id"], {}).get("score", 0) for item in rubric.get("criteria", [])) / total if total else 0
    result["evidence_missing"] = missing
    return result


def combine_reference_assessment(candidate, comparison, rubric):
    """A reference comparison cannot erase a failed candidate requirement."""
    result = enforce_visual_evidence(candidate, rubric)
    reference = enforce_visual_evidence(comparison, rubric)
    checks = {item["id"]: item for item in reference.get("criteria", [])}
    order = {"fail": 0, "partial": 1, "pass": 2}
    for item in result.get("criteria", []):
        other = checks.get(item["id"], {"status": "fail", "score": 0, "evidence": "Reference assessment missing."})
        item["reference_evidence"] = str(other.get("evidence", ""))
        item["status"] = min((item["status"], other["status"]), key=lambda value: order.get(value, 0))
        item["score"] = min(item["score"], other["score"])
    by_id = {item["id"]: item for item in result.get("criteria", [])}
    total = sum(item["weight"] for item in rubric["criteria"])
    result["score"] = sum(item["weight"] * by_id.get(item["id"], {}).get("score", 0) for item in rubric["criteria"]) / total if total else 0
    result["confidence"] = min(result["confidence"], reference["confidence"])
    result["pass"] = bool(result.get("pass") and reference.get("pass"))
    result["defects"] = list(dict.fromkeys(result.get("defects", []) + reference.get("defects", [])))
    reference_forbidden = {item["index"]: item for item in reference.get("forbidden", [])}
    forbidden_order = {"visible": 0, "uncertain": 1, "clear": 2}
    for item in result.get("forbidden", []):
        other = reference_forbidden.get(item["index"])
        if other is not None:
            item["reference_evidence"] = other.get("evidence", "")
            item["status"] = min((item["status"], other["status"]), key=lambda value: forbidden_order.get(value, 0))
    result["reference_comparison"] = {"attached_pixels": True, "pass": reference.get("pass", False), "summary": reference.get("summary", "")}
    if not reference.get("pass"):
        result["summary"] = "Reference comparison: " + reference.get("summary", "Reference fidelity is unconfirmed.")
        result["next_revision"] = reference.get("next_revision") or result.get("next_revision", "")
    return result


def calibration_metrics(rows, *, tolerance=5):
    """Rows are user-supplied blind scores; this function never calls a model."""
    if not 0 <= tolerance <= 100:
        raise ValueError("Tolerance must be between 0 and 100")
    valid = []
    for row in rows:
        values = [float(row[key]) for key in ("human_score", "score", "permuted_score")]
        if any(not math.isfinite(value) or not 0 <= value <= 100 for value in values):
            raise ValueError("Calibration scores must be finite values from 0 to 100")
        valid.append(values)
    if not valid:
        return {"count": 0, "measured": False}
    pairs = [(left, right) for index, left in enumerate(valid) for right in valid[index+1:]
             if left[1] != right[1] and left[2] != right[2]]
    reversed_pairs = sum((left[1]-right[1])*(left[2]-right[2]) < 0 for left,right in pairs)
    return {"count": len(valid), "measured": True,
            "human_mean_absolute_error": sum(abs(human-score) for human,score,_ in valid)/len(valid),
            "order_max_delta": max(abs(score-permuted) for _,score,permuted in valid),
            "order_within_tolerance": all(abs(score-permuted)<=tolerance for _,score,permuted in valid),
            "ranking_pairs": len(pairs), "ranking_reversed_pairs": reversed_pairs,
            "ranking_reversal_fraction": reversed_pairs/len(pairs) if pairs else None,
            "tolerance": tolerance}
