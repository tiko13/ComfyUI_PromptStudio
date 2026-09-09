import { normalizeImageReference } from "../chat/image-reference.js";

export function referenceContextMatches(saved, current) {
  const key = value => {
    const image = normalizeImageReference(value);
    return image ? JSON.stringify([image.type, image.subfolder, image.filename]) : "";
  };
  return Boolean(saved && current)
    && key(saved.sourceImage) === key(current.sourceImage)
    && key(saved.referenceImage) === key(current.referenceImage);
}

export function normalizeReferenceClarification(value) {
  if (!value || typeof value !== "object" || !String(value.userText || "").trim() || !String(value.question || "").trim()) return null;
  if (!normalizeImageReference(value.sourceImage) || !normalizeImageReference(value.referenceImage)) return null;
  return {userText: String(value.userText).slice(0,16000), question: String(value.question).slice(0,4000),
    sourceImage: normalizeImageReference(value.sourceImage), referenceImage: normalizeImageReference(value.referenceImage),
    mainPrompt: String(value.mainPrompt || ""), finalPrompt: String(value.finalPrompt || "")};
}

export function normalizeReferenceGrounding(value) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const key of ["observations", "resolved_instruction", "edit_instruction", "uncertainty"]) {
    if (typeof value[key] !== "string" || value[key].length > 4000) return null;
    result[key] = value[key];
  }
  if (value.needs_clarification !== false) return null;
  if (!result.observations.trim() || !result.resolved_instruction.trim() || !result.edit_instruction.trim()) return null;
  return {...result, needs_clarification: false, already_satisfied: value.already_satisfied === true, userText: String(value.userText || ""),
    sourceImage: normalizeImageReference(value.sourceImage),
    referenceImage: normalizeImageReference(value.referenceImage)};
}

export async function requestReferenceGrounding(fetchApi, payload, signal) {
  const response = await fetchApi("/promptstudio/prompt-studio/ground-edit-reference", {
    method: "POST", headers: {"Content-Type": "application/json"}, signal,
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "The reference image could not be analyzed. Existing prompts were kept.");
  if (data.grounding?.needs_clarification) {
    const error = new Error(data.grounding.uncertainty || "Clarify which detail to use from the reference image.");
    error.name = "ReferenceClarificationNeeded";
    throw error;
  }
  const grounding = normalizeReferenceGrounding({...data.grounding, userText: payload.user_text,
    sourceImage: payload.source_image, referenceImage: payload.reference_image});
  if (!grounding) throw new Error("Reference analysis returned an incomplete description. Existing prompts were kept.");
  return grounding;
}
