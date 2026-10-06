// Optional local acceleration. Failure always falls back to the existing pipeline.
export async function referenceDetection(fetchApi, kind, payload, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, {once: true});
  const timer = setTimeout(abort, 10000);
  try {
    const response = await fetchApi(`/promptstudio/references/${kind}`, {method: "POST",
      headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload), signal: controller.signal});
    if (!response.ok) throw new Error("Local detection unavailable");
    const result = await response.json();
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid detection result");
    return result;
  } catch (error) {
    if (signal?.aborted) throw error;
    return {decision: "deep", available: false, reason: "Local detection unavailable; using deeper analysis."};
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", abort);
  }
}

export async function requestReferenceRegion(fetchApi, kind, payload, signal) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 190000);
  const abort=()=>controller.abort();if(signal?.aborted)abort();signal?.addEventListener("abort",abort,{once:true});
  try {
    const response = await fetchApi(`/promptstudio/references/${kind}`, {method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload), signal: controller.signal, timeoutMs: null});
    const result = await response.json();
    if (!response.ok || result.available === false) throw new Error(result.error || result.reason || "Region analysis failed");
    return result;
  } finally {clearTimeout(timer);signal?.removeEventListener("abort",abort);}
}
