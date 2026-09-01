import assert from "node:assert/strict";

import {
  snapshotForPlotCell,
  validatePlotDraft,
} from "../web/js/prompt-studio/plot/model.js";

const LORA_NODE_ID = "10";
const LORA_TARGET = `lora:${LORA_NODE_ID}:name`;
const STRENGTH_TARGET = `lora:${LORA_NODE_ID}:strength`;

function axis({ name, type, targetKey, targetName = "", values }) {
  return {
    id: `${name}-${type}`,
    name,
    type,
    label: type === "lora" ? "LoRA" : type === "lora_strength" ? "LoRA strength" : "Seed",
    targetKey,
    targetNodeId: type === "seed" ? "20" : LORA_NODE_ID,
    targetName,
    values: values.map((value, index) => ({
      id: `${name}-${index}`,
      label: typeof value === "object" ? value?.name || "None" : String(value),
      value,
    })),
  };
}

function plot(axes) {
  return {
    axes,
    base: {
      promptNodeId: "",
      workflowSnapshot: {
        output: {
          [LORA_NODE_ID]: {
            class_type: "KCPP_PromptStudioLoraLoader",
            inputs: { lora_stack_json: "[]" },
          },
          20: {
            class_type: "KCPP_PromptStudioSampler",
            inputs: { seed: 1 },
          },
        },
      },
      loraState: [{
        nodeId: LORA_NODE_ID,
        selections: [{ name: "global.safetensors", strength: 0.7 }],
      }],
    },
  };
}

function stackFor(snapshot) {
  return JSON.parse(snapshot.output[LORA_NODE_ID].inputs.lora_stack_json);
}

const strengthFirstAxes = [
  axis({ name: "x", type: "lora_strength", targetKey: STRENGTH_TARGET, values: [0.25] }),
  axis({
    name: "y",
    type: "lora",
    targetKey: LORA_TARGET,
    values: [{ name: "varied.safetensors", strength: 1 }],
  }),
];
const pairedDraft = {
  prompt: "portrait",
  workflowProfileId: "profile",
  zEnabled: false,
  axes: strengthFirstAxes,
};
assert.equal(validatePlotDraft(pairedDraft).valid, true, "a paired LoRA axis supplies the strength target");

const pairedSnapshot = snapshotForPlotCell(plot(strengthFirstAxes), { coordinate: [0, 0] });
assert.deepEqual(stackFor(pairedSnapshot), [
  { name: "global.safetensors", strength: 0.7 },
  { name: "varied.safetensors", strength: 0.25 },
], "the strength applies to the LoRA selected by the paired axis even when strength is X");

const missingSourceAxes = [
  axis({ name: "x", type: "lora_strength", targetKey: STRENGTH_TARGET, values: [0.5] }),
  axis({ name: "y", type: "seed", targetKey: "sampling:20:seed", values: [1] }),
];
assert.equal(validatePlotDraft({ ...pairedDraft, axes: missingSourceAxes }).valid, false,
  "an unpaired strength axis still requires a globally selected LoRA");

const fixedStrengthAxes = [
  axis({
    name: "x",
    type: "lora_strength",
    targetKey: STRENGTH_TARGET,
    targetName: "global.safetensors",
    values: [0.4],
  }),
  axis({ name: "y", type: "seed", targetKey: "sampling:20:seed", values: [1] }),
];
const fixedSnapshot = snapshotForPlotCell(plot(fixedStrengthAxes), { coordinate: [0, 0] });
assert.equal(stackFor(fixedSnapshot)[0].strength, 0.4, "global LoRA strength remains supported without a LoRA axis");

console.log("plot model LoRA strength tests passed");
