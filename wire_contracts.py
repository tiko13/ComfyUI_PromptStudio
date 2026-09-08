"""Versioned common wire contracts; standard library only, independent of ComfyUI.

Unversioned records are the explicit legacy format. New versioned writes must
preserve discriminants and both workflow snapshot envelopes. Video documents
remain owned and normalized by PromptStudio_Video.video.contracts.
"""
from __future__ import annotations

import copy
import json
import math
from pathlib import Path
from typing import Literal, TypedDict

ENUMS = json.loads((Path(__file__).parent / "web/js/prompt-studio/core/wire-contract-enums.json").read_text(encoding="utf-8"))
WIRE_VERSION = ENUMS["wire_version"]
PROVIDERS = tuple(ENUMS["providers"])
JOB_STATUSES = tuple(ENUMS["job_statuses"])
JOB_TRANSITIONS = ENUMS["job_transitions"]
LlmProvider = Literal["koboldcpp", "ollama", "llamacpp"]
JobStatus = Literal["queued", "running", "complete", "failed", "cancelled"]


class WorkflowSnapshot(TypedDict):
    workflow: dict
    output: dict


class SnapshotWire(TypedDict):
    wire_version: Literal[1]
    kind: Literal["workflow_snapshot"]
    snapshot: WorkflowSnapshot


class PendingJob(TypedDict):
    wire_version: Literal[1]
    kind: Literal["llm_job"]
    job_id: str
    status: Literal["queued", "running", "cancelled"]


class CompleteJob(TypedDict):
    wire_version: Literal[1]
    kind: Literal["llm_job"]
    job_id: str
    status: Literal["complete"]
    result: object


class FailedJob(TypedDict):
    wire_version: Literal[1]
    kind: Literal["llm_job"]
    job_id: str
    status: Literal["failed"]
    error: str


JobWire = PendingJob | CompleteJob | FailedJob


def require_wire_version(value):
    if not isinstance(value, dict):
        raise ValueError("Wire value must be an object")
    if "wire_version" in value and (type(value["wire_version"]) is not int or value["wire_version"] != WIRE_VERSION):
        raise ValueError("Unsupported wire version")


def normalize_provider_settings(value, *, strict=False):
    """Validate shared fields; callers retain video/action-specific fields separately.

    strict=True additionally rejects unknown fields for a provider-only envelope.
    """
    require_wire_version(value)
    provider = str(value.get("llm_provider") or "").strip().lower()
    if provider not in PROVIDERS:
        provider = "koboldcpp"
    if value.get("wire_version") == 1 and value.get("llm_provider") != provider:
        raise ValueError("Invalid llm_provider")
    strings = {
        "kobold_url": "http://localhost:5001", "ollama_url": "http://localhost:11434",
        "ollama_model": "", "llamacpp_url": "http://localhost:8080", "llamacpp_model": "",
        "llamacpp_executable": "", "llamacpp_config_profile": "", "stop_sequence": "",
    }
    bounds = {
        "max_response_tokens": (800, 0, 131072), "llamacpp_reasoning_budget_tokens": (0, 0, 262144),
        "temperature": (0.7, 0, 5), "top_p": (0.9, 0, 1), "top_k": (100, 0, 200),
        "min_p": (0, 0, 1), "presence_penalty": (0, -2, 2), "rep_pen": (1.05, 0.5, 3),
        "rep_pen_range": (360, 0, 4096), "sampler_seed": (-1, -1, 999999), "request_timeout": (120, 5, 3600),
    }
    allowed = {*strings, *bounds, "wire_version", "llm_provider", "llamacpp_autostart", "thinking_mode"}
    if strict and set(value) - allowed:
        raise ValueError("Unknown provider fields: " + ", ".join(sorted(set(value) - allowed)))
    thinking = value.get("thinking_mode", "Disabled")
    if thinking not in ENUMS["thinking_modes"]:
        if value.get("wire_version") == 1:
            raise ValueError("Invalid thinking_mode")
        thinking = "Disabled"
    result = {"wire_version": 1, "llm_provider": provider, "thinking_mode": thinking,
              "llamacpp_autostart": value.get("llamacpp_autostart") is True}
    result.update({key: str(value[key]) if value.get(key) is not None else default for key, default in strings.items()})
    for key, (default, minimum, maximum) in bounds.items():
        try:
            number = float(value.get(key, default))
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError(f"Invalid provider field {key}") from exc
        if not math.isfinite(number) or not minimum <= number <= maximum:
            raise ValueError(f"Invalid provider field {key}")
        result[key] = number
    return result


def normalize_snapshot_wire(value) -> SnapshotWire:
    require_wire_version(value)
    snapshot = value.get("snapshot") if value.get("wire_version") == 1 else value
    if value.get("wire_version") == 1 and value.get("kind") != "workflow_snapshot":
        raise ValueError("Invalid snapshot kind")
    if not isinstance(snapshot, dict) or not all(isinstance(snapshot.get(key), dict) for key in ("workflow", "output")):
        raise ValueError("Snapshot requires workflow and output objects")
    return {"wire_version": 1, "kind": "workflow_snapshot", "snapshot": copy.deepcopy(snapshot)}


def normalize_job_wire(value) -> JobWire:
    require_wire_version(value)
    if value.get("wire_version") == 1 and value.get("kind") != "llm_job":
        raise ValueError("Invalid job kind")
    status = value.get("status")
    if "wire_version" not in value and status == "error":
        status = "failed"
    job_id = str(value.get("job_id") or "")
    if not job_id:
        raise ValueError("Job ID is required")
    result = {"wire_version": 1, "kind": "llm_job", "job_id": job_id, "status": status}
    if status in {"queued", "running", "cancelled"}:
        return result
    if status == "complete" and "result" in value:
        return {**result, "result": copy.deepcopy(value["result"])}
    if status == "failed" and isinstance(value.get("error"), str):
        return {**result, "error": value["error"]}
    raise ValueError("Invalid job status or missing terminal result/error")


def assert_job_transition(previous: JobStatus, following: JobStatus):
    if following not in JOB_TRANSITIONS.get(previous, ()):
        raise ValueError(f"Invalid job transition {previous} -> {following}")
