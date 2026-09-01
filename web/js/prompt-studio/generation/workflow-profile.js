import {
  LORA_LOADER_TYPE,
  MODEL_LOADER_TYPE,
  SAMPLER_CONTROL_TYPE,
} from "../core/constants.js";
import { cleanModelName } from "./model-name.js";
import { normalizePromptStudioInputDescriptors } from "./prompt-studio-input.js";

export function workflowNameFromPath(path) {
  const filename = String(path || "").replaceAll("\\", "/").split("/").pop() || "";
  return filename.replace(/\.json$/i, "");
}

export function isPromptStudioWorkflowPath(path) {
  const normalized = String(path || "").replaceAll("\\", "/");
  const filename = normalized.split("/").pop() || "";
  return normalized.startsWith("workflows/")
    && filename.startsWith("[PS]")
    && filename.toLowerCase().endsWith(".json");
}

export function normalizeWorkflowProfile(profile) {
  const snapshot = profile?.snapshot && typeof profile.snapshot === "object" ? profile.snapshot : null;
  const path = String(profile?.path || profile?.id || "").replaceAll("\\", "/");
  const snapshotLoraNodes = Object.entries(snapshot?.output || {})
    .filter(([, node]) => node?.class_type === LORA_LOADER_TYPE)
    .map(([id, node]) => ({
      id: String(id),
      loraType: String(node.inputs?.lora_type || "").trim(),
    }));
  const loraNodes = Array.isArray(profile?.loraNodes)
    ? profile.loraNodes.map((node) => ({
      id: String(node?.id || ""),
      loraType: String(node?.loraType || "").trim(),
    })).filter((node) => node.id)
    : snapshotLoraNodes;
  const snapshotModelNodes = Object.entries(snapshot?.output || {})
    .filter(([, node]) => node?.class_type === MODEL_LOADER_TYPE)
    .map(([id, node]) => ({
      id: String(id),
      modelType: String(node.inputs?.model_type || "").trim(),
      modelName: cleanModelName(node.inputs?.unet_name),
    }));
  const modelNodes = Array.isArray(profile?.modelNodes)
    ? profile.modelNodes.map((node) => ({
      id: String(node?.id || ""),
      modelType: String(node?.modelType || "").trim(),
      modelName: cleanModelName(node?.modelName),
    })).filter((node) => node.id)
    : snapshotModelNodes;
  const snapshotSamplingNodes = Object.entries(snapshot?.output || {})
    .filter(([, node]) => node?.class_type === SAMPLER_CONTROL_TYPE)
    .map(([id, node]) => ({
      id: String(id),
      label: `Sampler ${id}`,
      controls: {
        seed: Number(node.inputs?.seed ?? 0),
        steps: Number(node.inputs?.steps ?? 20),
        cfg: Number(node.inputs?.cfg ?? 8),
        sampler: String(node.inputs?.sampler_name || ""),
        scheduler: String(node.inputs?.scheduler || ""),
        denoise: Number(node.inputs?.denoise ?? 1),
      },
    }));
  const samplingNodes = Array.isArray(profile?.samplingNodes)
    ? profile.samplingNodes.map((node) => ({
      id: String(node?.id || ""),
      label: String(node?.label || `Sampler ${node?.id || ""}`).trim(),
      controls: {
        seed: Number(node?.controls?.seed ?? 0),
        steps: Number(node?.controls?.steps ?? 20),
        cfg: Number(node?.controls?.cfg ?? 8),
        sampler: String(node?.controls?.sampler || ""),
        scheduler: String(node?.controls?.scheduler || ""),
        denoise: Number(node?.controls?.denoise ?? 1),
      },
    })).filter((node) => node.id)
    : snapshotSamplingNodes;
  return {
    id: path,
    path,
    name: String(profile?.name || workflowNameFromPath(path) || "Workflow").trim() || "Workflow",
    kind: ["edit", "upscale"].includes(profile?.kind) ? profile.kind : "create",
    promptMode: "full_prompt",
    promptNodeId: String(profile?.promptNodeId || ""),
    imageNodeId: String(profile?.imageNodeId || ""),
    upscaleNodeId: String(profile?.upscaleNodeId || ""),
    loraNodes,
    modelNodes,
    samplingNodes,
    additionalInputs: normalizePromptStudioInputDescriptors(profile?.additionalInputs),
    promptStudioInputVersion: Number(profile?.promptStudioInputVersion || 0),
    resultNodeIds: Array.isArray(profile?.resultNodeIds) ? profile.resultNodeIds.map(String) : [],
    resultFields: ["images", "gifs"],
    snapshot,
    updatedAt: Number(profile?.updatedAt || Date.now()),
    sourceModified: Number(profile?.sourceModified || 0),
    stale: Boolean(profile?.stale),
    error: String(profile?.error || ""),
  };
}
