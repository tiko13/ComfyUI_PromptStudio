import { normalizeImageReference } from "./image-reference.js";
import { cleanModelName } from "../generation/model-name.js";

export function normalizeLoraStack(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object" && String(entry.name || "").trim())
    .map((entry) => ({
      name: String(entry.name),
      strength: Number.isFinite(Number(entry.strength)) ? Number(entry.strength) : 1,
    }));
}

export function normalizeGenerationLoraState(value) {
  if (!Array.isArray(value)) return null;
  const normalized = [];
  const nodeIds = new Set();
  for (const entry of value) {
    const nodeId = String(entry?.nodeId || "").trim();
    if (!nodeId || nodeIds.has(nodeId)) continue;
    nodeIds.add(nodeId);
    normalized.push({
      nodeId,
      loraType: String(entry?.loraType || "").trim(),
      selections: normalizeLoraStack(entry?.selections),
    });
  }
  return normalized;
}

export function normalizeGenerationModelState(value) {
  if (!Array.isArray(value)) return null;
  const normalized = [];
  const nodeIds = new Set();
  for (const entry of value) {
    const nodeId = String(entry?.nodeId || "").trim();
    const modelName = cleanModelName(entry?.modelName);
    if (!nodeId || !modelName || nodeIds.has(nodeId)) continue;
    nodeIds.add(nodeId);
    normalized.push({
      nodeId,
      modelType: String(entry?.modelType || "").trim(),
      modelName,
    });
  }
  return normalized;
}

export function normalizeGenerationSnapshot(value) {
  const output = value?.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  return { output };
}

export function normalizeLastGeneration(value) {
  if (!value || typeof value !== "object") return null;
  return {
    action: ["edit", "upscale"].includes(value.action) ? value.action : "create",
    mainPrompt: String(value.mainPrompt || value.canonicalPrompt || ""),
    canonicalPrompt: String(value.canonicalPrompt || ""),
    executionPrompt: String(value.executionPrompt || ""),
    workflowProfileId: String(value.workflowProfileId || ""),
    sourceImage: normalizeImageReference(value.sourceImage),
  };
}

export function normalizePendingGeneration(value) {
  if (!value || typeof value !== "object") return null;
  return {
    action: ["edit", "upscale"].includes(value.action) ? value.action : "create",
    mainPrompt: String(value.mainPrompt || value.canonicalPrompt || ""),
    canonicalPrompt: String(value.canonicalPrompt || ""),
    executionPrompt: String(value.executionPrompt || ""),
    workflowProfileId: String(value.workflowProfileId || ""),
    workflowName: String(value.workflowName || ""),
    loraState: normalizeGenerationLoraState(value.loraState),
    modelState: normalizeGenerationModelState(value.modelState),
    generationSnapshot: normalizeGenerationSnapshot(value.generationSnapshot),
    replayFingerprint: String(value.replayFingerprint || ""),
    sourceImage: normalizeImageReference(value.sourceImage),
    upscaleFactor: value.upscaleFactor != null && Number.isFinite(Number(value.upscaleFactor))
      ? Number(value.upscaleFactor)
      : null,
    resultNodeIds: Array.isArray(value.resultNodeIds) ? value.resultNodeIds.map(String) : [],
    resultFields: Array.isArray(value.resultFields) && value.resultFields.length
      ? value.resultFields.map(String)
      : ["images", "gifs"],
  };
}
