"""Local, bounded job metadata. Prompts, results and exception text never enter it."""
import copy
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import threading
import time
import uuid
import weakref

MAX_JOBS = 128
MAX_EXPORT_BYTES = 64 * 1024
PHASES = frozenset({"queued", "routing", "grounding", "prompt_processing", "generation", "validation", "persistence", "assembly"})
TERMINAL = frozenset({"complete", "failed", "cancelled", "interrupted"})
PHASE_ALIASES = {"intent_classification": "routing", "vision_grounding": "grounding",
                 "director_generation": "generation", "proposal_correction": "validation",
                 "compile": "prompt_processing", "prepare": "prompt_processing"}
KINDS = frozenset({"consult", "prompt_agent", "director", "extension_plan", "generation", "assembly"})
ERRORS = {
    "server_restarted": ("The server restarted before this job finished.", True),
    "result_unavailable": ("This job completed before the restart. Check its saved output before retrying.", True),
    "llm_overloaded": ("The LLM queue is full. Retry after an active job finishes.", True),
    "provider_transport_busy": ("Provider connection capacity is full. Retry shortly.", True),
    "provider_deadline": ("The provider exceeded the job deadline.", True),
    "provider_response_too_large": ("The provider response exceeded its size limit.", False),
    "invalid_request": ("The request did not pass validation.", False),
    "provider_failed": ("The provider could not finish this job.", True),
    "cancelled": ("This job was cancelled.", True),
}
RETRY_TEXT = {
    "rerun_inference": "Retry reruns inference with a new job ID; it does not resume the interrupted model response.",
    "replan": "Retry creates a new plan from the saved request; it does not resume the old plan.",
    "requeue": "Retry queues a new generation; it does not resume the old generation.",
    "rerun_assembly": "Retry rebuilds the assembled output from its source media.",
}


def _identifier(value):
    value = str(value or "")
    return value if re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value) else ""


def _job_identifier(value):
    return _identifier(value) or (hashlib.sha256(str(value).encode()).hexdigest() if value else uuid.uuid4().hex)


def error_envelope(error=None, *, code=None):
    code = code or getattr(error, "code", None) or ("invalid_request" if isinstance(error, ValueError) else "provider_failed")
    if code not in ERRORS:
        code = "provider_failed"
    message, retryable = ERRORS[code]
    return {"code": code, "message": message, "retryable": retryable}


class JobAlreadyRecorded(RuntimeError):
    status = 409
    retryable = True

    def __init__(self, envelope):
        self.code = "result_unavailable" if envelope["state"] == "complete" else "server_restarted"
        super().__init__(ERRORS[self.code][0] + " " + RETRY_TEXT[envelope["retry_action"]])


class JobMetadataFull(RuntimeError):
    status = 503
    code = "llm_overloaded"
    retryable = True


class JobLedger:
    def __init__(self, path, *, clock=time.time):
        self.path = Path(path)
        self.clock = clock
        self.boot_id = uuid.uuid4().hex
        self._lock = threading.RLock()
        self._jobs = {}
        self.durable = True
        self._connection = None
        self._finalizer = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._connection = sqlite3.connect(self.path, timeout=.25, check_same_thread=False)
            self._finalizer = weakref.finalize(self, self._connection.close)
            self._connection.execute("PRAGMA max_page_count=512")
            self._connection.execute("CREATE TABLE IF NOT EXISTS jobs (key TEXT PRIMARY KEY, payload TEXT NOT NULL)")
            rows = self._connection.execute("SELECT key,payload FROM jobs LIMIT ?", (MAX_JOBS,)).fetchall()
            for key, payload in rows:
                value = json.loads(payload)
                if isinstance(value, dict) and value.get("version") == 1 and value.get("state") in TERMINAL | {"queued", "running"}:
                    self._jobs[key] = value
            for key, job in self._jobs.items():
                if job["state"] not in TERMINAL:
                    self._finish_phase(job, at=job.get("updated_at", job.get("phase_started_at", self.clock())))
                    job.update(state="interrupted", updated_at=self.clock(), finished_at=self.clock(),
                               error=error_envelope(code="server_restarted"), queue_position=None, timing_incomplete=True)
                    self._write(key, job)
        except (OSError, sqlite3.Error, ValueError, TypeError, KeyError):
            self.durable = False

    def _write(self, key, job):
        if self._connection is None or not self.durable:
            return
        try:
            with self._connection:
                self._connection.execute("INSERT OR REPLACE INTO jobs VALUES (?,?)", (key, json.dumps(job, separators=(",", ":"))))
                self._connection.execute("DELETE FROM jobs WHERE key NOT IN (%s)" % ",".join("?" for _ in self._jobs), tuple(self._jobs))
        except sqlite3.Error:
            self.durable = False

    def _finish_phase(self, job, *, at=None):
        phase = job["phase"]
        elapsed = max(0, (self.clock() if at is None else at) - job.get("phase_started_at", self.clock())) * 1000
        job["stage_ms"][phase] = round(job["stage_ms"].get(phase, 0) + elapsed, 2)

    def start(self, job_id, *, studio="image", kind="generation", data=None, queue_position=None):
        job_id = _job_identifier(job_id)
        studio = "video" if studio == "video" else "image"
        key = studio + ":" + job_id
        data = data if isinstance(data, dict) else {}
        origin = data.get("origin") if isinstance(data.get("origin"), dict) else data
        kind = kind if kind in KINDS else "generation"
        with self._lock:
            if key in self._jobs:
                raise JobAlreadyRecorded(self._jobs[key])
            if len(self._jobs) >= MAX_JOBS:
                if all(job["state"] not in TERMINAL for job in self._jobs.values()):
                    raise JobMetadataFull("Job capacity is full; retry after an active job finishes")
                oldest = min(self._jobs, key=lambda value: (self._jobs[value]["state"] not in TERMINAL,
                                                           self._jobs[value]["updated_at"]))
                self._jobs.pop(oldest)
            now = self.clock()
            job = {"version": 1, "job_id": job_id, "request_id": _identifier(data.get("request_id")) or job_id,
                   "studio": studio, "kind": kind, "origin": {name: _identifier(origin.get(name)) for name in
                    ("chat_id", "project_id", "message_id") if _identifier(origin.get(name))},
                   "provider": data.get("llm_provider") if data.get("llm_provider") in {"koboldcpp", "ollama", "llamacpp"} else "koboldcpp",
                   "state": "queued", "phase": "queued", "queue_position": self._position(queue_position),
                   "created_at": now, "updated_at": now, "started_at": None, "finished_at": None,
                   "phase_started_at": now, "stage_ms": {}, "cancellation_requested": False, "error": None,
                   "timing_incomplete": False,
                   "retry_action": {"extension_plan": "replan", "generation": "requeue", "assembly": "rerun_assembly"}.get(kind, "rerun_inference")}
            self._jobs[key] = job
            self._write(key, job)
            return copy.deepcopy(job)

    @staticmethod
    def _position(value):
        return min(MAX_JOBS, max(1, value)) if isinstance(value, int) and not isinstance(value, bool) else None

    def update(self, job_id, *, studio="image", phase=None, state=None, error=None, code=None,
               cancellation_requested=False, queue_position=None):
        with self._lock:
            key = studio + ":" + _job_identifier(job_id)
            job = self._jobs.get(key)
            if job is None or job["state"] in TERMINAL:
                return copy.deepcopy(job)
            phase = PHASE_ALIASES.get(phase, phase)
            if phase in PHASES and phase != job["phase"]:
                self._finish_phase(job)
                job.update(phase=phase, phase_started_at=self.clock())
            if phase and phase != "queued" and job["started_at"] is None:
                job["started_at"] = self.clock()
            job["state"] = state if state in TERMINAL | {"queued", "running"} else "running"
            job["updated_at"] = self.clock()
            job["cancellation_requested"] |= bool(cancellation_requested)
            job["queue_position"] = self._position(queue_position) if job["state"] == "queued" else None
            if job["state"] in TERMINAL:
                self._finish_phase(job)
                job["finished_at"] = self.clock()
                if job["state"] != "complete":
                    job["error"] = error_envelope(error, code=code or ("cancelled" if job["state"] == "cancelled" else None))
            self._write(key, job)
            return copy.deepcopy(job)

    def get(self, job_id, *, studio="image"):
        with self._lock:
            return copy.deepcopy(self._jobs.get(studio + ":" + _job_identifier(job_id)))

    def snapshot(self):
        with self._lock:
            return {"version": 1, "durable": self.durable, "jobs": copy.deepcopy(sorted(
                self._jobs.values(), key=lambda job: job["updated_at"], reverse=True))}

    def diagnostic_export(self):
        snapshot = self.snapshot()
        result = {"version": 1, "exported_at": self.clock(), "durable": self.durable,
                  "content_included": False, "truncated": False, "jobs": []}
        for job in snapshot["jobs"]:
            # Rebuild an allowlist even for disk records written by old versions.
            safe = {}
            for name, allowed in {"studio": {"image", "video"}, "kind": KINDS,
                                  "provider": {"koboldcpp", "ollama", "llamacpp"},
                                  "state": TERMINAL | {"queued", "running"}, "phase": PHASES,
                                  "retry_action": set(RETRY_TEXT)}.items():
                value = job.get(name)
                safe[name] = value if isinstance(value, str) and value in allowed else None
            for name in ("queue_position", "created_at", "updated_at", "started_at", "finished_at"):
                value = job.get(name)
                safe[name] = value if type(value) in {int, float} and 0 <= value < 10 ** 13 else None
            safe["cancellation_requested"] = job.get("cancellation_requested") is True
            safe["timing_incomplete"] = job.get("timing_incomplete") is True
            safe["stage_ms"] = {name: value for name, value in job.get("stage_ms", {}).items()
                                if name in PHASES and type(value) in {int, float} and 0 <= value < 10 ** 13}
            for name in ("job_id", "request_id"):
                safe[name] = hashlib.sha256(str(job.get(name, "")).encode()).hexdigest()[:16]
            safe["origin"] = {name: hashlib.sha256(str(value).encode()).hexdigest()[:16]
                              for name, value in job.get("origin", {}).items() if name in {"chat_id", "project_id", "message_id"}}
            safe["error"] = error_envelope(code=(job.get("error") or {}).get("code")) if job.get("error") else None
            result["jobs"].append(safe)
            if len(json.dumps(result, separators=(",", ":")).encode()) > MAX_EXPORT_BYTES:
                result["jobs"].pop()
                result["truncated"] = True
                break
        return result

    def close(self):
        if self._finalizer is not None:
            self._finalizer()
        self._connection = None


_ledger = None
_ledger_lock = threading.Lock()


def shared_job_ledger():
    global _ledger
    with _ledger_lock:
        if _ledger is None:
            import folder_paths
            _ledger = JobLedger(Path(folder_paths.get_user_directory()) / "promptstudio" / "job_metadata.sqlite3")
        return _ledger


def shared_job_status(job_id, *, studio="image", ledger=None):
    """Legacy status shape plus richer metadata; interrupted jobs never replay."""
    job = (ledger or shared_job_ledger()).get(job_id, studio=studio)
    if job is None:
        return None
    error = job.get("error") or error_envelope(code="result_unavailable")
    return {"status": "failed", "job": job, "error": error["message"] + " " + RETRY_TEXT[job["retry_action"]],
            "code": error["code"], "retryable": error["retryable"], "retry_action": job["retry_action"]}
