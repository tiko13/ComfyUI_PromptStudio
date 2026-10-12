import { normalizeImageReference } from "../chat/image-reference.js";
import { normalizePoseReference } from "./pose.js";
import { normalizeGuide, isStructureReference, semanticReferences } from "./structure-guide.js";
import { normalizeTargeting, targetingInstruction, normalizeEditMask } from "./reference-targeting.js";
import { declaredReferenceAdapter, referenceToken, DEFAULT_REFERENCE_ROLES } from "./workflow-capabilities.js";

export const QWEN_REFERENCE_LIMIT = 9;
export const QWEN_POSE_PROMPT_VERSION = 2;
export function canReuseQwenPosePrompt(saved, references) {
  return !references.some(entry => isStructureReference(entry) && entry.pose && entry.guide?.type === "pose" && normalizeGuide(entry.guide).strength > 0)
    || saved?.qwenPosePromptVersion === QWEN_POSE_PROMPT_VERSION;
}
export const QWEN_CREATE_REFERENCE_LIMIT = 10;
export const REFERENCE_ROLES = Object.freeze(DEFAULT_REFERENCE_ROLES);

export function normalizeQwenReferences(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => ({id: String(entry?.id || `reference-${index}`),
    image: normalizeImageReference(entry?.image), role: /^[a-z][a-z0-9_]{0,63}$/.test(entry?.role) ? entry.role : "custom",
    instruction: String(entry?.instruction || "").slice(0, 4000),
    ...(entry?.analysis === "deep" ? {analysis: "deep"} : {}),
    ...(normalizePoseReference(entry?.pose) ? {pose: normalizePoseReference(entry.pose)} : {}),
    ...(normalizeEditMask(entry?.editMask) ? {editMask: normalizeEditMask(entry.editMask)} : {}),
    ...(normalizeTargeting(entry?.targeting) ? {targeting: normalizeTargeting(entry.targeting)} : {}),
    ...(isStructureReference(entry) || entry?.guide ? {use: isStructureReference(entry) ? entry.use : "reference", guide: normalizeGuide(entry.guide)} : {})})).filter(entry => entry.image);
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
  const declared = declaredReferenceAdapter(profile);
  if (declared) return declared;
  if (!["create", "edit"].includes(profile?.kind) || !profile.promptNodeId || (profile.kind === "edit" && !profile.imageNodeId)) return null;
  const output = profile.snapshot?.output || {};
  const encoders = Object.entries(output).filter(([, node]) => node.class_type === "TextEncodeQwenImage21"
    && (profile.kind === "create" || dependsOn(output, node.inputs?.["images.image_1"], profile.imageNodeId))
    && dependsOn(output, node.inputs?.prompt, profile.promptNodeId));
  if (encoders.length !== 1) return null;
  const [id, encoder] = encoders[0];
  // Prewired reference inputs belong to the workflow, not the managed list.
  if (Object.entries(encoder.inputs).some(([key, value]) => /^images\.image_\d+$/.test(key) && (profile.kind === "create" || key !== "images.image_1") && value != null)) return null;
  if (profile.kind === "create") {
    const samplers = Object.entries(output).filter(([, node]) => Array.isArray(node.inputs?.model)
      && dependsOn(output, node.inputs?.positive, id));
    const decoders = Object.values(output).filter(node => ["VAEDecode", "VAEDecodeTiled"].includes(node.class_type)
      && samplers.some(([sampler]) => dependsOn(output, node.inputs?.samples, sampler)));
    if (decoders.length !== 1 || !Array.isArray(decoders[0].inputs.vae)) return null;
    // Create owns its canvas. Do not silently turn a reference-sized graph into Create.
    if (!samplers.length || samplers.some(([, node]) => dependsOn(output, node.inputs?.latent_image, id))) return null;
    return {id, model: "qwen_image_2_1", mode: "create", limit: QWEN_CREATE_REFERENCE_LIMIT, firstImage: 1, vae: decoders[0].inputs.vae};
  }
  return {id, model: "qwen_image_2_1", mode: "edit", limit: QWEN_REFERENCE_LIMIT, firstImage: 2};
}

export function validateQwenReferences(value, mode = "edit", adapter = null) {
  const limit = adapter?.limit ?? (mode === "create" ? QWEN_CREATE_REFERENCE_LIMIT : QWEN_REFERENCE_LIMIT);
  if (!Array.isArray(value) || value.length > limit) throw new Error(adapter?.explicit ? `This workflow accepts at most ${limit} references.` : `Qwen 2.1 ${mode === "create" ? "Create accepts at most ten reference images" : "Edit accepts at most nine additional reference images"}.`);
  const references = normalizeQwenReferences(value);
  if (references.length !== value.length) throw new Error("A reference image is missing.");
  if (adapter?.guideOnly && semanticReferences(references).length) throw new Error("This workflow accepts a structure guide only; connect a Reference Collection for semantic references.");
  if (semanticReferences(references).length < (adapter?.minimum || 0)) throw new Error(`This workflow requires at least ${adapter.minimum} references.`);
  if (adapter?.roles && semanticReferences(references).some(entry => !Object.hasOwn(adapter.roles, entry.role))) throw new Error("A saved reference role is not supported by this workflow. Choose a supported role.");
  if (references.filter(isStructureReference).length > 1) throw new Error("Use one structure guide at a time.");
  if (semanticReferences(references).some(entry => entry.role === "custom" && !entry.instruction.trim())) throw new Error("Describe how to use each custom reference, or choose a role.");
  return references;
}

export function applyQwenReferences(snapshot, profile, value) {
  const adapter = qwenReferenceAdapter({...profile, snapshot});
  const references = semanticReferences(validateQwenReferences(value, profile?.kind, adapter));
  if (!adapter) {
    if (references.length) throw new Error("This workflow no longer supports managed Qwen 2.1 references. Use a compatible Qwen Create or Edit workflow with unassigned reference inputs.");
    return;
  }
  if (adapter.explicit) {
    if (adapter.collectionId) snapshot.output[adapter.collectionId].inputs.references_json = JSON.stringify(references);
    return;
  }
  for (const [index, reference] of references.entries()) {
    const slot = index + adapter.firstImage;
    let id = `ps_qwen_reference_${slot}`;
    while (Object.hasOwn(snapshot.output, id)) id += "_";
    snapshot.output[id] = {class_type: "KCPP_ChatImageReference", inputs: {image_ref: JSON.stringify(reference.image), source_name: `${adapter.mode === "create" ? "Create" : "Edit"} reference ${index + 1}`}};
    snapshot.output[adapter.id].inputs[`images.image_${slot}`] = [id, 0];
  }
  if (references.length && adapter.vae) snapshot.output[adapter.id].inputs.vae = [...adapter.vae];
}

export function qwenCreateInstruction(prompt, references, adapter = null) {
  const all = validateQwenReferences(references, "create", adapter);
  const entries = semanticReferences(all);
  const guides = all.filter(entry => isStructureReference(entry) && normalizeGuide(entry.guide).strength > 0 && entry.instruction.trim());
  if (!entries.length && !guides.length && !adapter?.instructions) return String(prompt || "");
  return [String(prompt || "").trim(), entries.length ? (adapter?.mode === "edit" ? `Edit ${adapter.sourceToken}. Preserve content not targeted by the scene description or reference instructions.` : "Create a new composition using the following reference sources. No reference is a canvas to preserve.") : "",
    ...entries.map((entry, index) => `Use ${(adapter?.roles?.[entry.role] || REFERENCE_ROLES[entry.role] || entry.role).toLowerCase()} from ${referenceToken(adapter || {firstImage: 1}, index)}${entry.instruction.trim() ? `: ${entry.instruction.trim()}` : "."} ${targetingInstruction(adapter?.mode === "edit" ? entry : {...entry, targeting: {...entry.targeting, target: null}})}`.trim()),
    ...guides.map(entry => `Follow the supplied ControlNet ${normalizeGuide(entry.guide).type} guide. ${entry.instruction || ""}`.trim()),
    entries.length ? "Take only the requested attributes from each reference; follow the scene description for all other content." : "", adapter?.instructions || ""].filter(Boolean).join(" ");
}

export function directQwenInstruction(instruction, references, adapter = null) {
  const entries = semanticReferences(validateQwenReferences(references, "edit", adapter));
  const base = adapter?.explicit ? adapter.sourceToken : entries.length ? "<image1>" : "the image";
  return [`Edit ${base}.`, String(instruction || "").trim(), ...entries.map((entry, index) =>
    `Use ${(adapter?.roles?.[entry.role] || REFERENCE_ROLES[entry.role] || entry.role).toLowerCase()} from ${referenceToken(adapter, index)}${entry.instruction.trim() ? `: ${entry.instruction.trim()}` : "."} ${targetingInstruction(entry)}`.trim()),
  ...validateQwenReferences(references, "edit", adapter).filter(entry => isStructureReference(entry) && normalizeGuide(entry.guide).strength > 0).map(entry =>
    `Follow ${entry.guide?.scope === "whole" ? "the entire" : "the supplied"} ControlNet ${normalizeGuide(entry.guide).type} guide. ${entry.instruction || ""} ${targetingInstruction(entry)}`.trim()),
  ...validateQwenReferences(references, "edit", adapter).filter(entry => isStructureReference(entry) && entry.guide?.type === "sketch" && normalizeGuide(entry.guide).strength > 0).map(() => "The control map supplies contours only. Keep the source image's original medium, full colors, materials and textures; do not turn the result into a line drawing."),
  "Preserve all content and attributes that are not targeted by these instructions.", adapter?.instructions || ""].filter(Boolean).join(" ");
}

export function referenceEditAdapter(profile) {
  const adapter = qwenReferenceAdapter(profile);
  return adapter && adapter.promptMode !== "full_prompt" ? adapter : null;
}

export function referenceContractKey(profile) {
  const adapter = qwenReferenceAdapter(profile);
  return adapter?.explicit ? JSON.stringify(adapter) : "";
}

export async function requestQwenEdit(fetchApi, payload, signal) {
  const response = await fetchApi(payload.reference_contract ? "/promptstudio/prompt-studio/reference-edit-prompt" : "/promptstudio/prompt-studio/qwen-edit-prompt", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload), signal, timeoutMs: null});
  const data = await response.json();
  if (data.clarification) {
    const error = new Error(data.clarification); error.name = "QwenClarificationNeeded"; throw error;
  }
  if (!response.ok || !data.prompt) throw new Error(data.error || "Reference edit prompt construction failed.");
  return data.prompt;
}
