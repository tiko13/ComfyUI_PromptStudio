import { normalizeImageReference } from "../chat/image-reference.js";
import { editReferenceNodeIds } from "./edit-reference.js";
import { normalizeQwenReferences } from "./qwen-references.js";
import { currentWorkflowId } from "./workflow-migrations.js";

export function normalizeReferenceState(value) {
  const inputs = value?.workflowReferenceInputs;
  return {
    workflowReferenceInputs: inputs && typeof inputs === "object" && !Array.isArray(inputs)
      ? Object.fromEntries(Object.entries(inputs).map(([id, image]) => [id, normalizeImageReference(image)])) : {},
    qwenReferences: normalizeQwenReferences(value?.qwenReferences),
    qwenInstruction: String(value?.qwenInstruction || "").slice(0, 16000),
    editPromptModel: ["qwen_image_2_1", "workflow"].includes(value?.editPromptModel) ? value.editPromptModel : "",
    ...(typeof value?.referenceContractKey === "string" ? {referenceContractKey: value.referenceContractKey} : {}),
    ...(Number.isInteger(value?.qwenPosePromptVersion) && value.qwenPosePromptVersion > 0 ? {qwenPosePromptVersion: value.qwenPosePromptVersion} : {}),
  };
}

export function referenceInputsMatch(left, right) {
  const key = value => {
    const state = normalizeReferenceState(value);
    return JSON.stringify([Object.entries(state.workflowReferenceInputs).filter(([, image]) => image).sort(([a], [b]) => a.localeCompare(b)), state.qwenReferences]);
  };
  return key(left) === key(right);
}

export function referenceInputDescriptors(snapshot) {
  return editReferenceNodeIds(snapshot).map(id => {
    const node = snapshot.output[id];
    const title = String(node._meta?.title || "").trim();
    return { id, label: title && !/^Prompt Studio Reference Image(?: \(optional\))?$/.test(title)
      ? title : String(node.inputs?.source_name || "").trim() || `Reference ${id}`, ...(node.inputs?.required ? {required: true} : {}) };
  });
}

export function normalizeWorkflowReferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, slots]) => slots && typeof slots === "object" && !Array.isArray(slots))
    .map(([workflow, slots]) => [currentWorkflowId(workflow), Object.fromEntries(Object.entries(slots).map(([id, image]) => [id, normalizeImageReference(image)]))]));
}

export function workflowReferenceValues(owner, profile) {
  const saved = normalizeWorkflowReferences(owner?.workflowReferences)[profile?.id] || {};
  return Object.fromEntries(referenceInputDescriptors(profile?.snapshot).map(({ id }) => [id, saved[id] || null]));
}

export function applyWorkflowReferences(snapshot, values = {}) {
  for (const { id, label, required } of referenceInputDescriptors(snapshot)) {
    const image = normalizeImageReference(values[id]);
    if (required && !image) throw new Error(`${label} is required.`);
    snapshot.output[id].inputs.image_ref = image ? JSON.stringify(image) : "";
  }
}
