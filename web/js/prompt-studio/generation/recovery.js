// Stored in ComfyUI's queue/history workflow metadata, never in prompt text.
export function tagSubmission(snapshot, id) {
  snapshot.workflow ||= {};
  snapshot.workflow.extra ||= {};
  snapshot.workflow.extra.promptstudio_submission = String(id);
  return snapshot;
}

function submissionId(entry) {
  return entry?.[3]?.extra_pnginfo?.workflow?.extra?.promptstudio_submission;
}

export async function findSubmittedPrompt(api, id) {
  const read = async (path) => {
    const response = await api.fetchApi(path, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Generation recovery failed (${response.status}).`);
    return response.json();
  };
  // Read queue before history so a job finishing between reads is still found.
  const queue = await read("/queue");
  if (!Array.isArray(queue?.queue_running) || !Array.isArray(queue?.queue_pending)) {
    throw new Error("ComfyUI queue is unavailable.");
  }
  const queued = [...queue.queue_running, ...queue.queue_pending]
    .find(entry => submissionId(entry) === id);
  if (queued) return String(queued[1]);
  const history = await read("/history?max_items=200");
  if (!history || typeof history !== "object" || Array.isArray(history)) {
    throw new Error("ComfyUI history is unavailable.");
  }
  const completed = Object.entries(history).find(([, item]) => submissionId(item?.prompt) === id);
  return completed?.[0] || "";
}

export const interruptedSubmissionMessage = "Reload interrupted generation tracking before a prompt ID was saved. No matching job was found in the ComfyUI queue or recent history. Check ComfyUI before generating again; nothing was resubmitted.";

// Network failures are not execution failures. Keep following accepted work.
export async function readPromptHistory(api, id) {
  try {
    const response = await api.fetchApi(`/history/${encodeURIComponent(id)}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    return (await response.json())?.[id] || null;
  } catch (_) { return null; }
}
