import { normalizeImageReference } from "../chat/image-reference.js";
import { normalizeQwenReferences, qwenReferenceAdapter, validateQwenReferences, REFERENCE_ROLES } from "./qwen-references.js";

export const persistentReferences = references => normalizeQwenReferences(references).filter(entry => !entry.semanticTurn);

export function semanticReferenceAdapter(profile) {
  const adapter = qwenReferenceAdapter(profile);
  if (!adapter || adapter.guideOnly || adapter.limit < 1) {
    throw new Error("This workflow cannot use a pasted image as a semantic reference. Select a workflow with managed image references, or configure its inputs in References.");
  }
  return adapter;
}

export async function requestSemanticReference(fetchApi, payload, signal) {
  const response = await fetchApi("/promptstudio/prompt-studio/semantic-reference", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload), timeoutMs: null, signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Reference assignment failed.");
  if (data.status !== "assigned") {
    const error = new Error(data.message || "Describe which detail to use and where to apply it.");
    error.name = data.status === "clarify" ? "QwenClarificationNeeded" : "SemanticReferenceNotAssigned";
    error.semanticStatus = data.status;
    throw error;
  }
  if (!Object.hasOwn(payload.supported_roles, data.role) || typeof data.instruction !== "string"
      || !data.instruction.trim() || data.instruction.length > 4000) throw new Error("The LLM returned an invalid reference assignment.");
  return {role: data.role, instruction: data.instruction.trim()};
}

export async function assignSemanticReference(fetchApi, settings, profile, userText, connection, signal) {
  if (!settings.semanticAttachment) return userText;
  const adapter = semanticReferenceAdapter(profile);
  const references = persistentReferences(settings.qwenReferences);
  if (references.length >= adapter.limit) throw new Error("This workflow's reference slots are full. Remove an item in References before sending this image.");
  const image = normalizeImageReference(settings.semanticAttachment);
  if (!image || !settings.sourceImage) throw new Error("Select a source image and attach one reference image for this edit.");
  const assignment = await requestSemanticReference(fetchApi, {...connection,
    user_text: userText, source_image: settings.sourceImage, attachments: [image],
    supported_roles: adapter.roles || REFERENCE_ROLES,
    context: references.map(entry => `${entry.role}: ${entry.instruction}`).join("\n").slice(0, 16000),
  }, signal);
  settings.qwenReferences = validateQwenReferences([...references, {
    id: settings.semanticReferenceId || (settings.semanticReferenceId = crypto.randomUUID()),
    image, ...assignment, semanticTurn: true,
  }], "edit", adapter);
  return `${userText}\nReference transfer: ${assignment.instruction}`;
}
