import { normalizeImageReference } from "../chat/image-reference.js";

export const QWEN_REFERENCE_LIMIT = 9;
export const REFERENCE_ROLES = Object.freeze({custom: "Custom instruction", subject: "Subject / identity", clothing: "Clothing", pose: "Pose", background: "Background", style: "Style", object: "Object"});

export function normalizeQwenReferences(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => ({id: String(entry?.id || `reference-${index}`),
    image: normalizeImageReference(entry?.image), role: Object.hasOwn(REFERENCE_ROLES, entry?.role) ? entry.role : "custom",
    instruction: String(entry?.instruction || "").slice(0, 4000)})).filter(entry => entry.image);
}

function dependsOn(output, link, id, visited = new Set()) {
  if (!Array.isArray(link) || link.length !== 2 || !Number.isInteger(link[1])) return false;
  const key = String(link[0]);
  if (key === String(id)) return true;
  if (visited.has(key)) return false;
  visited.add(key);
  return Object.values(output[key]?.inputs || {}).some(value => dependsOn(output, value, id, visited));
}

// Explicit encoder contract; never infer prompt support from a workflow title.
// The existing image_1 path may include resizing or other source preprocessing.
export function qwenReferenceAdapter(profile) {
  if (profile?.kind !== "edit" || !profile.imageNodeId || !profile.promptNodeId) return null;
  const output = profile.snapshot?.output || {};
  const encoders = Object.entries(output).filter(([, node]) => node.class_type === "TextEncodeQwenImage21"
    && dependsOn(output, node.inputs?.["images.image_1"], profile.imageNodeId)
    && dependsOn(output, node.inputs?.prompt, profile.promptNodeId));
  if (encoders.length !== 1) return null;
  const [id, encoder] = encoders[0];
  // Prewired reference inputs belong to the workflow, not the managed list.
  if (Object.entries(encoder.inputs).some(([key, value]) => /^images\.image_\d+$/.test(key) && key !== "images.image_1" && value != null)) return null;
  return {id, model: "qwen_image_2_1", limit: QWEN_REFERENCE_LIMIT};
}

export function validateQwenReferences(value) {
  if (!Array.isArray(value) || value.length > QWEN_REFERENCE_LIMIT) throw new Error("Qwen 2.1 accepts at most nine additional reference images.");
  const references = normalizeQwenReferences(value);
  if (references.length !== value.length) throw new Error("A Qwen reference image is missing.");
  if (references.some(entry => entry.role === "custom" && !entry.instruction.trim())) throw new Error("Describe how to use each custom reference, or choose a role.");
  return references;
}

export function applyQwenReferences(snapshot, profile, value) {
  const references = validateQwenReferences(value);
  const adapter = qwenReferenceAdapter({...profile, snapshot});
  if (!adapter) {
    if (references.length) throw new Error("This workflow no longer supports managed Qwen 2.1 references. Connect its source to image_1 and leave the other encoder image inputs empty.");
    return;
  }
  for (const [index, reference] of references.entries()) {
    let id = `ps_qwen_reference_${index + 2}`;
    while (Object.hasOwn(snapshot.output, id)) id += "_";
    snapshot.output[id] = {class_type: "KCPP_ChatImageReference", inputs: {image_ref: JSON.stringify(reference.image), source_name: `Edit reference ${index + 1}`}};
    snapshot.output[adapter.id].inputs[`images.image_${index + 2}`] = [id, 0];
  }
}

export function directQwenInstruction(instruction, references) {
  const entries = validateQwenReferences(references);
  const base = entries.length ? "<image1>" : "the image";
  return [`Edit ${base}.`, String(instruction || "").trim(), ...entries.map((entry, index) =>
    `Use ${REFERENCE_ROLES[entry.role].toLowerCase()} from <image${index + 2}>${entry.instruction.trim() ? `: ${entry.instruction.trim()}` : "."}`),
  "Preserve all content and attributes that are not targeted by these instructions."].filter(Boolean).join(" ");
}

export async function requestQwenEdit(fetchApi, payload, signal) {
  const response = await fetchApi("/promptstudio/prompt-studio/qwen-edit-prompt", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload), signal});
  const data = await response.json();
  if (!response.ok || !data.prompt) throw new Error(data.error || "Qwen edit prompt construction failed.");
  return data.prompt;
}
