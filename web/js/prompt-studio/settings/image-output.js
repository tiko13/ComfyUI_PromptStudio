import { serializedWorkflowNodes } from "../generation/prompt-studio-input.js";

export const IMAGE_OUTPUT_SETTINGS_KEY = "promptstudio.imageOutput.v1";
export const IMAGE_OUTPUT_DEFAULTS = Object.freeze({
  format: "webp", mode: "lossy", quality: 80, lossless_effort: 80,
  webp_method: 6, png_compression: 4, png_optimize: false,
});
const integer = (value, fallback, min, max) => value !== "" && value != null && Number.isFinite(Number(value))
  ? Math.max(min, Math.min(max, Math.round(Number(value)))) : fallback;

export function normalizeImageOutputSettings(value = {}) {
  return {
    format: value?.format === "png" ? "png" : "webp",
    mode: value?.mode === "lossless" ? "lossless" : "lossy",
    quality: integer(value?.quality, 80, 1, 100),
    lossless_effort: integer(value?.lossless_effort, 80, 1, 100),
    webp_method: integer(value?.webp_method, 6, 0, 6),
    png_compression: integer(value?.png_compression, 4, 0, 9),
    png_optimize: value?.png_optimize === true,
  };
}

export function getImageOutputSettings() {
  try { return normalizeImageOutputSettings(JSON.parse(localStorage.getItem(IMAGE_OUTPUT_SETTINGS_KEY) || "{}")); }
  catch { return { ...IMAGE_OUTPUT_DEFAULTS }; }
}

export function saveImageOutputSettings(value) {
  const settings = normalizeImageOutputSettings(value);
  localStorage.setItem(IMAGE_OUTPUT_SETTINGS_KEY, JSON.stringify(settings));
  return settings;
}

const widgetNames = ["filename_prefix", "mode", "compression", "save", "format", "png_compression", "png_optimize", "webp_method", "force"];
const widgetDefaults = ["ComfyUI", "lossy", 80, "yes", "webp", 4, false, 6, false];

// Keep the embedded, draggable workflow consistent with the executable prompt.
export function syncImageOutputWorkflow(snapshot) {
  for (const { id, node } of serializedWorkflowNodes(snapshot?.workflow)) {
    const output = snapshot.output?.[id];
    if (node.type !== "Save_as_webp_cond" || output?.class_type !== node.type) continue;
    const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    node.widgets_values = widgetNames.map((name, index) => {
      const value = output.inputs?.[name];
      return value !== undefined && !Array.isArray(value) ? value : values[index] ?? widgetDefaults[index];
    });
    if (node.widgets_values_named) node.widgets_values_named = Object.fromEntries(widgetNames.map((name, index) => [name, node.widgets_values[index]]));
  }
}

export function applyImageOutputSettings(snapshot, value = getImageOutputSettings()) {
  const settings = normalizeImageOutputSettings(value);
  for (const node of Object.values(snapshot?.output || {})) {
    if (node.class_type !== "Save_as_webp_cond") continue;
    const inputs = node.inputs ||= {};
    // Connected controls are workflow-authored expressions, including a dynamic force input.
    if (inputs.force === true || widgetNames.slice(1).some(name => Array.isArray(inputs[name]))) continue;
    Object.assign(inputs, {
      format: settings.format, mode: settings.mode,
      compression: settings.mode === "lossless" ? settings.lossless_effort : settings.quality,
      webp_method: settings.webp_method, png_compression: settings.png_compression,
      png_optimize: settings.png_optimize,
    });
  }
  syncImageOutputWorkflow(snapshot);
}
