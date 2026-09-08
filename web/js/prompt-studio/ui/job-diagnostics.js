const TERMINAL = new Set(["complete", "failed", "cancelled", "interrupted"]);
const PHASE_LABELS = Object.freeze({ queued: "Queued", routing: "Routing", grounding: "Inspecting references",
  prompt_processing: "Processing prompt", generation: "Generating", validation: "Validating",
  persistence: "Saving", assembly: "Assembling" });
const RETRY_LABELS = Object.freeze({
  rerun_inference: "Retry reruns inference with a new job ID; it does not resume the interrupted response.",
  replan: "Retry creates a new plan from the saved request.",
  requeue: "Retry queues a new generation.",
  rerun_assembly: "Retry rebuilds the output from its source media.",
});

export function isActiveJob(job) {
  return Boolean(job && ["queued", "running"].includes(job.state));
}

export function jobRetryText(job) {
  return RETRY_LABELS[job?.retry_action] || RETRY_LABELS.rerun_inference;
}

export function jobOriginLabel(job, { chats = [], projects = [] } = {}) {
  const origin = job?.origin || {};
  const item = job?.studio === "video"
    ? projects.find(project => project.id === origin.project_id)
    : chats.find(chat => chat.id === origin.chat_id);
  const id = job?.studio === "video" ? origin.project_id : origin.chat_id;
  const title = item?.title || item?.name || (id ? String(id).slice(0, 12) : "");
  return `${job?.studio === "video" ? "Video project" : "Image chat"}${title ? `: ${title}` : ""}`;
}

export function jobActivityText(job, context = {}) {
  const state = job?.state;
  const label = TERMINAL.has(state)
    ? { complete: "Completed", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted by server restart" }[state]
    : PHASE_LABELS[job?.phase] || "Working";
  const queue = state === "queued" && Number.isInteger(job?.queue_position) ? ` · position ${job.queue_position}` : "";
  return `${jobOriginLabel(job, context)} · ${label}${queue}`;
}

export function recoveredJobError(payload) {
  if (!payload || !["server_restarted", "result_unavailable"].includes(payload.code)) return null;
  const reason = payload.code === "result_unavailable"
    ? "This job completed before the restart. Check its saved output before retrying."
    : "The server restarted before this job finished.";
  const error = new Error(`${reason} ${jobRetryText(payload.job || payload)}`);
  error.code = payload.code;
  error.retryAction = payload.job?.retry_action || payload.retry_action || "rerun_inference";
  return error;
}

export async function fetchJobActivity(fetchApi = fetch, signal) {
  const response = await fetchApi("/promptstudio/jobs", { cache: "no-store", signal });
  if (!response.ok) throw new Error("Job activity is temporarily unavailable.");
  const data = await response.json();
  if (data?.version !== 1 || !Array.isArray(data.jobs) || data.jobs.length > 128) {
    throw new Error("The job activity response is incompatible.");
  }
  return data;
}

export async function downloadJobDiagnostics({ fetchApi = fetch, document: doc = document, urlApi = URL } = {}) {
  const response = await fetchApi("/promptstudio/jobs/diagnostics", { cache: "no-store" });
  if (!response.ok) throw new Error("Diagnostics are temporarily unavailable.");
  const blob = await response.blob();
  if (blob.size > 64 * 1024) throw new Error("Diagnostics exceeded the export size limit.");
  const url = urlApi.createObjectURL(blob);
  const link = doc.createElement("a");
  link.href = url;
  link.download = "promptstudio-diagnostics.json";
  try {
    doc.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => urlApi.revokeObjectURL(url), 1000);
  }
}
