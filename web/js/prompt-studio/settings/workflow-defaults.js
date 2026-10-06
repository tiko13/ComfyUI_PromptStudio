import { currentWorkflowId } from "../generation/workflow-migrations.js";
export const WORKFLOW_DEFAULTS_KEY = "promptstudio.workflowDefaults.v1";
const kinds = ["create", "edit", "upscale", "video"];

export function workflowDefaults() {
  try {
    const stored = JSON.parse(localStorage.getItem(WORKFLOW_DEFAULTS_KEY) || "{}");
    return Object.fromEntries(kinds.map(kind => [kind, currentWorkflowId(typeof stored?.[kind] === "string" ? stored[kind] : "")]));
  } catch (_) {
    return {};
  }
}

export function setWorkflowDefault(kind, id) {
  if (!kinds.includes(kind) || !id) throw new Error("Choose a workflow first.");
  localStorage.setItem(WORKFLOW_DEFAULTS_KEY, JSON.stringify({ ...workflowDefaults(), [kind]: id }));
}

export function newChatWorkflowSelections(fallback = {}) {
  const defaults = workflowDefaults();
  return Object.fromEntries(["create", "edit", "upscale"].map(kind => [
    `${kind}WorkflowId`, defaults[kind] || currentWorkflowId(fallback[`${kind}WorkflowId`]),
  ]));
}

export function markDefaultWorkflowOptions(select, kind) {
  const defaultId = workflowDefaults()[kind];
  for (const option of select?.options || []) {
    if (!defaultId || option.value !== defaultId) continue;
    option.textContent += " · Default";
    option.dataset.workflowDefault = "true";
  }
}
