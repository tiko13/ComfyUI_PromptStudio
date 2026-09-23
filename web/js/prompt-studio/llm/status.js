export function thinkingModeEnablesReasoning(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  return !["disabled", "none"].includes(normalized) && !normalized.startsWith("instruct ");
}

export function llmActivityLabel(status = {}, thinkingEnabled = false) {
  if (status.generation_phase === "thinking") return "Thinking";
  if (status.generation_phase === "generating") return "Processing";
  if (status.generation_phase === "thinking_or_generating" || thinkingEnabled) {
    return "Thinking / processing";
  }
  return "Processing";
}

export function llmGeneratedTokenCount(status = {}) {
  if (status.generated_tokens == null || status.generated_tokens === "") return null;
  const tokens = Number(status.generated_tokens);
  return Number.isFinite(tokens) && tokens >= 0 ? Math.trunc(tokens) : null;
}
