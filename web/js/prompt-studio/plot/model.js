import {
  LORA_LOADER_TYPE,
  MODEL_LOADER_TYPE,
  SAMPLER_CONTROL_TYPE,
} from "../core/constants.js";

export const PLOT_MAX_CELLS = 512;

// Outer loops change the most expensive workflow state least often. Seed is
// deliberately innermost because it never requires loading or patching a model.
const PLOT_EXECUTION_PRIORITY = Object.freeze({
  model: 0,
  lora: 1,
  lora_strength: 1,
  model_profile: 2,
  style_preset: 2,
  framing_preset: 2,
  style_modifier: 2,
  framing_modifier: 2,
  embellishment_level: 2,
  thinking_mode: 2,
  target_output_length: 2,
  additional_instructions: 2,
  seed: 3,
});

export const PLOT_AXIS_TYPES = Object.freeze([
  { id: "model", label: "Model", kind: "catalog" },
  { id: "lora", label: "LoRA", kind: "catalog" },
  { id: "lora_strength", label: "LoRA strength", kind: "number", min: -100, max: 100, step: 0.05 },
  { id: "seed", label: "Seed", kind: "integer", min: 0, max: Number.MAX_SAFE_INTEGER, step: 1 },
  { id: "sampler", label: "Sampler", kind: "sampler" },
  { id: "scheduler", label: "Scheduler", kind: "scheduler" },
  { id: "steps", label: "Steps", kind: "integer", min: 1, max: 10000, step: 1 },
  { id: "cfg", label: "CFG", kind: "number", min: 0, max: 100, step: 0.1 },
  { id: "denoise", label: "Denoise strength", kind: "number", min: 0, max: 1, step: 0.01 },
  { id: "model_profile", label: "Model profile", kind: "llm_catalog", scope: "llm", controlKey: "model_profile" },
  { id: "style_preset", label: "Style", kind: "llm_catalog", scope: "llm", controlKey: "style_preset" },
  { id: "framing_preset", label: "Framing", kind: "llm_catalog", scope: "llm", controlKey: "framing_preset" },
  { id: "style_modifier", label: "Style modifier", kind: "text", scope: "llm", controlKey: "style_modifier" },
  { id: "framing_modifier", label: "Framing modifier", kind: "text", scope: "llm", controlKey: "framing_modifier" },
  { id: "embellishment_level", label: "Embellishment", kind: "llm_catalog", scope: "llm", controlKey: "embellishment_level" },
  { id: "thinking_mode", label: "Thinking", kind: "llm_catalog", scope: "llm", controlKey: "thinking_mode" },
  { id: "target_output_length", label: "Target length", kind: "integer", min: 20, max: 200, step: 5, scope: "llm", controlKey: "target_output_length" },
  { id: "additional_instructions", label: "Additional instructions", kind: "text", scope: "llm", controlKey: "additional_instructions" },
]);

export function plotAxisType(type) {
  return PLOT_AXIS_TYPES.find((entry) => entry.id === String(type || "")) || PLOT_AXIS_TYPES[0];
}

export function isLlmPlotAxisType(type) {
  return plotAxisType(type).scope === "llm";
}

export function plotAxisTargets(profile, type) {
  const requested = String(type || "");
  const axisType = plotAxisType(requested);
  if (axisType.scope === "llm") {
    return [{
      key: `llm:${axisType.controlKey}`,
      nodeId: "",
      label: "LLM prompt renderer",
      controlKey: axisType.controlKey,
    }];
  }
  if (requested === "model") {
    return (profile?.modelNodes || []).map((node) => ({
      key: `model:${node.id}`,
      nodeId: String(node.id),
      label: `${node.modelType || "Model"} · node ${node.id}`,
      catalogType: String(node.modelType || ""),
    }));
  }
  if (["lora", "lora_strength"].includes(requested)) {
    return (profile?.loraNodes || []).map((node) => ({
      key: `lora:${node.id}:${requested === "lora" ? "name" : "strength"}`,
      nodeId: String(node.id),
      label: `${node.loraType || "LoRA"} · node ${node.id}`,
      catalogType: String(node.loraType || ""),
    }));
  }
  const field = requested === "sampler" ? "sampler_name" : requested;
  return (profile?.samplingNodes || []).map((node) => ({
    key: `sampling:${node.id}:${field}`,
    nodeId: String(node.id),
    label: node.label || `Sampler ${node.id}`,
    currentValue: node.controls?.[requested],
  }));
}

export function normalizePlotValue(value) {
  if (!value || typeof value !== "object") return null;
  const label = String(value.label ?? value.value ?? "").trim();
  if (!label) return null;
  return {
    id: String(value.id || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    label,
    value: value.value,
  };
}

export function normalizePlotAxis(axis, name, profile) {
  const type = plotAxisType(axis?.type).id;
  const targets = plotAxisTargets(profile, type);
  const target = targets.find((entry) => entry.key === String(axis?.targetKey || "")) || targets[0] || null;
  return {
    id: String(axis?.id || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    name,
    type,
    label: String(axis?.label || plotAxisType(type).label),
    targetKey: target?.key || "",
    targetNodeId: target?.nodeId || "",
    targetName: String(axis?.targetName || ""),
    values: Array.isArray(axis?.values) ? axis.values.map(normalizePlotValue).filter(Boolean) : [],
  };
}

export function normalizePlotDraft(value, profile) {
  const source = value && typeof value === "object" ? value : {};
  return {
    title: String(source.title || ""),
    action: source.action === "edit" ? "edit" : "create",
    workflowProfileId: String(profile?.id || source.workflowProfileId || ""),
    prompt: String(source.prompt || ""),
    llmEnabled: source.llmEnabled === true,
    zEnabled: source.zEnabled === true,
    axes: [
      normalizePlotAxis(source.axes?.[0] || { type: "seed" }, "x", profile),
      normalizePlotAxis(source.axes?.[1] || { type: "sampler" }, "y", profile),
      normalizePlotAxis(source.axes?.[2] || { type: "scheduler" }, "z", profile),
    ],
  };
}

export function plotCellCount(axes) {
  return axes.reduce((total, axis) => total * Math.max(0, axis.values?.length || 0), 1);
}

export function validatePlotDraft(draft) {
  const axes = draft.axes.slice(0, draft.zEnabled ? 3 : 2);
  const errors = [];
  if (!String(draft.prompt || "").trim()) errors.push("Enter a base prompt.");
  if (!draft.workflowProfileId) errors.push("Select a creation or editing workflow.");
  const targets = new Set();
  for (const axis of axes) {
    if (isLlmPlotAxisType(axis.type) && draft.llmEnabled !== true) {
      errors.push(`${axis.name.toUpperCase()} uses an LLM axis, but LLM mode is disabled.`);
    }
    if (!axis.targetKey) errors.push(`${axis.name.toUpperCase()} has no compatible workflow target.`);
    if (!axis.values.length) errors.push(`${axis.name.toUpperCase()} needs at least one value.`);
    if (axis.targetKey && targets.has(axis.targetKey)) errors.push("Two axes cannot control the same workflow field.");
    targets.add(axis.targetKey);
    if (axis.type === "lora_strength" && !axis.targetName) errors.push(`${axis.name.toUpperCase()} LoRA strength needs a LoRA name.`);
  }
  const total = plotCellCount(axes);
  if (total > PLOT_MAX_CELLS) errors.push(`Plots support at most ${PLOT_MAX_CELLS} cells.`);
  return { valid: errors.length === 0, errors, total, axes };
}

function coordinatesFor(axes) {
  const coordinates = [];
  const zCount = axes[2]?.values.length || 1;
  for (let z = 0; z < zCount; z += 1) {
    for (let y = 0; y < axes[1].values.length; y += 1) {
      for (let x = 0; x < axes[0].values.length; x += 1) {
        coordinates.push(axes.length === 3 ? [x, y, z] : [x, y]);
      }
    }
  }
  return coordinates;
}

export function buildPlotRun({ draft, profile, base, plotId, chatId }) {
  const validation = validatePlotDraft(draft);
  if (!validation.valid) throw new Error(validation.errors.join(" "));
  const createdAt = Date.now();
  const title = String(draft.title || "").trim()
    || `${draft.axes[0].label} × ${draft.axes[1].label}` + (draft.zEnabled ? ` × ${draft.axes[2].label}` : "");
  return {
    version: 1, revision: 0, id: plotId, chatId, title, status: "pending",
    action: draft.action, workflowProfileId: profile.id, workflowName: profile.name,
    llmEnabled: draft.llmEnabled === true,
    createdAt, updatedAt: createdAt, axes: structuredClone(validation.axes), base: structuredClone(base),
    cells: coordinatesFor(validation.axes).map((coordinate, index) => ({
      id: `${plotId}-${index + 1}`, coordinate, status: "pending", promptId: "", images: [], error: "",
      mainPrompt: "", finalPrompt: "", attempts: 0, createdAt, updatedAt: createdAt,
    })),
    artifacts: { composites: [], overview: null, manifest: null },
  };
}

export function orderPlotCellsForExecution(plot, cells = plot?.cells) {
  const axes = Array.isArray(plot?.axes) ? plot.axes : [];
  const executionAxes = axes
    .map((axis, index) => ({
      index,
      priority: PLOT_EXECUTION_PRIORITY[axis?.type] ?? 2,
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index);
  return [...(Array.isArray(cells) ? cells : [])].sort((left, right) => {
    for (const axis of executionAxes) {
      const difference = Number(left?.coordinate?.[axis.index] ?? 0)
        - Number(right?.coordinate?.[axis.index] ?? 0);
      if (difference) return difference;
    }
    return 0;
  });
}

function selectedAxisValue(plot, cell, axisIndex) {
  const axis = plot.axes[axisIndex];
  return axis?.values?.[cell.coordinate[axisIndex]] || null;
}

function loraStateFor(plot, nodeId) {
  return structuredClone((plot.base.loraState || []).find((entry) => String(entry.nodeId) === String(nodeId))?.selections || []);
}

export function plotControlOverridesForCell(plot, cell) {
  const overrides = {};
  for (let axisIndex = 0; axisIndex < (plot?.axes || []).length; axisIndex += 1) {
    const axis = plot.axes[axisIndex];
    const type = plotAxisType(axis?.type);
    if (type.scope !== "llm" || !type.controlKey) continue;
    const selected = selectedAxisValue(plot, cell, axisIndex);
    if (selected) overrides[type.controlKey] = selected.value;
  }
  return overrides;
}

export function plotPromptGroupKey(plot, cell) {
  return JSON.stringify(plotControlOverridesForCell(plot, cell));
}

export function snapshotForPlotCell(plot, cell) {
  const snapshot = structuredClone(plot.base.workflowSnapshot);
  const promptNode = snapshot.output?.[String(plot.base.promptNodeId || "")];
  if (promptNode && String(cell?.finalPrompt || "").trim()) {
    promptNode.inputs ||= {};
    promptNode.inputs.prompt = String(cell.finalPrompt);
  }
  const loraStacks = new Map();
  for (let axisIndex = 0; axisIndex < plot.axes.length; axisIndex += 1) {
    const axis = plot.axes[axisIndex];
    const selected = selectedAxisValue(plot, cell, axisIndex);
    if (!selected) continue;
    if (isLlmPlotAxisType(axis.type)) continue;
    const node = snapshot.output?.[String(axis.targetNodeId)];
    if (!node) throw new Error(`${axis.name.toUpperCase()} target node is missing from the stored workflow.`);
    if (axis.type === "model") {
      if (node.class_type !== MODEL_LOADER_TYPE) throw new Error("Model plot target is incompatible.");
      node.inputs.unet_name = String(selected.value);
    } else if (axis.type === "lora") {
      if (node.class_type !== LORA_LOADER_TYPE) throw new Error("LoRA plot target is incompatible.");
      const stack = loraStacks.get(axis.targetNodeId) || loraStateFor(plot, axis.targetNodeId);
      const entry = selected.value && typeof selected.value === "object" ? selected.value : null;
      const comparisonNames = new Set(axis.values.map((item) => String(item.value?.name || "")).filter(Boolean));
      const fixed = stack.filter((item) => !comparisonNames.has(String(item.name || "")));
      if (entry?.name) fixed.push({ name: String(entry.name), strength: Number(entry.strength ?? 1) });
      loraStacks.set(axis.targetNodeId, fixed);
      node.inputs.lora_stack_json = JSON.stringify(fixed);
    } else if (axis.type === "lora_strength") {
      if (node.class_type !== LORA_LOADER_TYPE) throw new Error("LoRA strength target is incompatible.");
      const stack = loraStacks.get(axis.targetNodeId) || loraStateFor(plot, axis.targetNodeId);
      const requested = String(axis.targetName || "");
      const item = stack.find((entry) => String(entry.name || "") === requested);
      if (!item) throw new Error(`LoRA '${requested}' is not present in the base stack.`);
      item.strength = Number(selected.value);
      loraStacks.set(axis.targetNodeId, stack);
      node.inputs.lora_stack_json = JSON.stringify(stack);
    } else {
      if (node.class_type !== SAMPLER_CONTROL_TYPE) throw new Error("Sampling plot target is incompatible.");
      const field = axis.type === "sampler" ? "sampler_name" : axis.type;
      node.inputs[field] = ["seed", "steps"].includes(axis.type)
        ? Math.trunc(Number(selected.value))
        : ["cfg", "denoise"].includes(axis.type) ? Number(selected.value) : String(selected.value);
    }
  }
  return snapshot;
}

export function plotCellLabel(plot, cell) {
  return plot.axes.map((axis, index) => `${axis.label}: ${selectedAxisValue(plot, cell, index)?.label || ""}`).join(" · ");
}
