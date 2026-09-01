import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const moduleSource = readFileSync(
  new URL("../web/js/prompt-studio/generation/prompt-studio-input.js", import.meta.url),
  "utf8",
);
const {
  PROMPT_STUDIO_INPUT_TYPE,
  applyPromptStudioInputValues,
  extractPromptStudioInputs,
  normalizePromptStudioInputDescriptor,
  promptStudioInputSelectionKey,
  registerPromptStudioInputNode,
  selectedPromptStudioInputValue,
} = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`);

const descriptor = normalizePromptStudioInputDescriptor({
  id: "9",
  targetNodeId: "4",
  targetInputName: "steps",
  label: "Steps",
  targetLabel: "steps",
  targetNodeLabel: "Sampler",
  schema: { type: "INT" },
  defaultValue: 20,
});
assert.equal(descriptor.schema.min, null);
assert.equal(descriptor.schema.max, null);
assert.equal(descriptor.schema.step, null);

const key = promptStudioInputSelectionKey("workflow", descriptor.id);
assert.equal(selectedPromptStudioInputValue("workflow", descriptor, {
  [key]: { value: 31.6, schemaFingerprint: descriptor.schemaFingerprint },
}), 32);
assert.equal(selectedPromptStudioInputValue("workflow", descriptor, {
  [key]: { value: 44, schemaFingerprint: "stale" },
}), 20);

const snapshot = { output: { "4": { inputs: { steps: 20 } } } };
applyPromptStudioInputValues(snapshot, { id: "workflow", additionalInputs: [descriptor] }, {
  [key]: { value: 28, schemaFingerprint: descriptor.schemaFingerprint },
});
assert.equal(snapshot.output["4"].inputs.steps, 28);

class PrimitiveNode {
  constructor(title) {
    this.title = title;
    this.outputs = [{ links: [] }];
  }

  onConnectOutput() {
    return true;
  }
}

const LiteGraph = {
  registered_node_types: { PrimitiveNode },
  registerNodeType(type, nodeType) {
    this.registered_node_types[type] = nodeType;
  },
};
registerPromptStudioInputNode(LiteGraph);
const PromptStudioInputNode = LiteGraph.registered_node_types[PROMPT_STUDIO_INPUT_TYPE];
assert.equal(PromptStudioInputNode.title, "Prompt Studio Input");
assert.equal(PromptStudioInputNode.category, "Prompt Studio");

const target = {
  id: 4,
  title: "Sampler",
  constructor: {
    nodeData: {
      input: { required: { steps: ["INT", { min: 1, max: 100, step: 1 }] } },
    },
  },
  inputs: [{ name: "steps", widget: { name: "steps" } }],
  widgets: [{ name: "steps", options: {} }],
};
const source = { id: 9, type: PROMPT_STUDIO_INPUT_TYPE, outputs: [{ links: [12] }] };
const inputNode = new PromptStudioInputNode();
assert.equal(inputNode.onConnectOutput(0, "INT", target.inputs[0], target, 0), true);
inputNode.outputs[0].links = [99];
assert.equal(inputNode.onConnectOutput(0, "INT", target.inputs[0], target, 0), false);
inputNode.outputs[0].links = [];
assert.equal(inputNode.onConnectOutput(0, "MODEL", { name: "model", type: "MODEL" }, target, 0), false);
const graph = {
  _nodes: [source, target],
  links: { 12: { target_id: 4, target_slot: 0 } },
  getNodeById(id) {
    return String(id) === "4" ? target : null;
  },
};
const extracted = extractPromptStudioInputs(
  graph,
  { output: { "4": { inputs: { steps: 24 } } } },
  { nodes: [{ id: 9, title: "Render steps" }] },
);
assert.equal(extracted.length, 1);
assert.equal(extracted[0].label, "Render steps");
assert.equal(extracted[0].defaultValue, 24);
assert.deepEqual(extracted[0].schema, {
  type: "INT",
  min: 1,
  max: 100,
  step: 1,
  multiline: false,
  labelOn: "true",
  labelOff: "false",
  options: [],
});

class SamplerNode {}
SamplerNode.nodeData = {
  input: { required: { steps: ["INT", { min: 1, max: 100, step: 1 }] } },
};
LiteGraph.registered_node_types.KCPP_PromptStudioSampler = SamplerNode;
globalThis.LiteGraph = LiteGraph;
const nestedWorkflow = {
  nodes: [{ id: 30, type: "subgraph-type" }],
  definitions: {
    subgraphs: [{
      id: "subgraph-type",
      nodes: [
        {
          id: 69,
          type: PROMPT_STUDIO_INPUT_TYPE,
          title: "PromptStudioInput",
          outputs: [{ links: [117] }],
        },
        {
          id: 68,
          type: "KCPP_PromptStudioSampler",
          inputs: [{ name: "model" }, { name: "positive" }, { name: "negative" }, { name: "latent" }, { name: "seed" }, { name: "steps", widget: { name: "steps" } }],
        },
      ],
      links: [{ id: 117, origin_id: 69, origin_slot: 0, target_id: 68, target_slot: 5, type: "INT" }],
    }],
  },
};
const nested = extractPromptStudioInputs(
  { _nodes: [] },
  { output: { "30:68": { inputs: { steps: 8 }, _meta: { title: "Prompt Studio Sampler" } } } },
  nestedWorkflow,
);
assert.equal(nested.length, 1);
assert.equal(nested[0].id, "30:69");
assert.equal(nested[0].targetNodeId, "30:68");
assert.equal(nested[0].label, "steps");
assert.equal(nested[0].defaultValue, 8);

console.log("Prompt Studio Input frontend contract passed.");
