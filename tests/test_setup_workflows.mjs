import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createWorkflowTemplateBuilder} from '../web/js/prompt-studio/generation/workflow-template.js';
import {qwenReferenceAdapter} from '../web/js/prompt-studio/generation/qwen-references.js';
import {structureAdapter} from '../web/js/prompt-studio/generation/structure-guide.js';

const catalog = JSON.parse(readFileSync(new URL('../setup/catalog.json', import.meta.url)));

test('bundled Qwen workflows retain executable links, Studio roles and model controls', async () => {
  const originalRegistry = globalThis.LiteGraph;
  class Save_as_webp_cond {}
  Save_as_webp_cond.nodeData = {output_node: true, input: {required: {images: ['IMAGE']}}};
  globalThis.LiteGraph = {registered_node_types: {Save_as_webp_cond}};
  class Graph {
    configure(data) { this.data = data; this._nodes = []; return []; }
    clear() {}
  }
  const graph = new Graph();
  const app = {graph, async graphToPrompt(privateGraph) {
    assert.notEqual(privateGraph, graph);
    const workflow = privateGraph.data;
    const output = {};
    for (const node of workflow.nodes.filter(n => n.type !== 'MarkdownNote')) {
      const inputs = {...node.widgets_values_named};
      for (const socket of node.inputs || []) {
        if (socket.link == null) continue;
        const link = workflow.links.find(link => link[0] === socket.link);
        assert.ok(link, `${node.id}.${socket.name} has no link`);
        assert.equal(link[3], node.id);
        const source = workflow.nodes.find(n => n.id === link[1]);
        assert.ok(source?.outputs?.[link[2]]?.links?.includes(link[0]), 'Origin socket must include the link');
        inputs[socket.name] = [String(link[1]), link[2]];
      }
      output[String(node.id)] = {class_type: node.type, inputs};
    }
    return {workflow, output};
  }};
  try {
    const build = createWorkflowTemplateBuilder({app, nodeClassName: n => n.type}).buildWorkflowTemplate;
    const packs = catalog.packs.filter(p => p.family === 'Qwen Image 2.1');
    assert.equal(packs.length, 15);
    for (const pack of packs) {
      const workflow = JSON.parse(readFileSync(new URL('../setup/workflows/' + pack.file, import.meta.url)));
      const profile = await build({path: pack.file, modified: 1}, workflow);
      assert.equal(profile.kind, pack.role, pack.file);
      assert.equal(profile.resultNodeIds.length, 1);
      assert.equal(profile.modelNodes[0].modelType, 'QwenImage21');
      assert.equal(profile.loraNodes.length, 1, 'Turbo keeps the separate user LoRA stack');
      const steps = pack.id.endsWith('turbo6') ? 6 : pack.id.endsWith('base40') ? 40 : 25;
      assert.equal(profile.samplingNodes[0].controls.steps, steps);
      assert.equal(Boolean(profile.imageNodeId), pack.role === 'edit');
      assert.equal(qwenReferenceAdapter(profile)?.limit, pack.role === 'edit' ? 9 : 10, pack.file);
      assert.ok(structureAdapter(profile), pack.file);
    }
  } finally { globalThis.LiteGraph = originalRegistry; }
});
