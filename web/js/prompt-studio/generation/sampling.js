import { SAMPLER_CONTROL_TYPE } from "../core/constants.js";

export const QWEN_TURBO_SAMPLER = "KCPP_QwenImage21TurboSampler";
export const QWEN_OFFICIAL_TURBO_SAMPLER = "KCPP_QwenImage21OfficialTurboSampler";
export const isStudioSampler = type => [SAMPLER_CONTROL_TYPE, QWEN_TURBO_SAMPLER, QWEN_OFFICIAL_TURBO_SAMPLER].includes(type);

export function samplingControls(node) {
  if (node?.class_type === QWEN_OFFICIAL_TURBO_SAMPLER) {
    return { seed: Number(node.inputs?.seed ?? 0), steps: 8, cfg: 1, sampler: "euler", scheduler: "Qwen official Turbo", denoise: 1 };
  }
  if (node?.class_type === QWEN_TURBO_SAMPLER) {
    return { seed: Number(node.inputs?.seed ?? 0), steps: 6, cfg: 1, sampler: "euler", scheduler: "Viggle v0.3", denoise: 1 };
  }
  return {
    seed: Number(node.inputs?.seed ?? 0), steps: Number(node.inputs?.steps ?? 20), cfg: Number(node.inputs?.cfg ?? 8),
    sampler: String(node.inputs?.sampler_name || ""), scheduler: String(node.inputs?.scheduler || ""), denoise: Number(node.inputs?.denoise ?? 1),
  };
}

export function samplerSupportsField(node, field) {
  return [QWEN_TURBO_SAMPLER, QWEN_OFFICIAL_TURBO_SAMPLER].includes(node?.class_type) ? field === "seed" : node?.class_type === SAMPLER_CONTROL_TYPE;
}
