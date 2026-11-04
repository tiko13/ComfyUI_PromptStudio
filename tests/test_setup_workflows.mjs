import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createWorkflowTemplateBuilder} from '../web/js/prompt-studio/generation/workflow-template.js';
import {qwenReferenceAdapter} from '../web/js/prompt-studio/generation/qwen-references.js';
import {structureAdapter} from '../web/js/prompt-studio/generation/structure-guide.js';
import {applyImageOutputSettings} from '../web/js/prompt-studio/settings/image-output.js';
import {applyQwenReferences, directQwenInstruction, validateQwenReferences} from '../web/js/prompt-studio/generation/qwen-references.js';
import {maskAdapter} from '../web/js/prompt-studio/generation/reference-targeting.js';

const catalog = JSON.parse(readFileSync(new URL('../setup/catalog.json', import.meta.url)));

async function withWorkflowBuilder(check) {
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
    await check(build);
  } finally { globalThis.LiteGraph = originalRegistry; }
}

test('bundled Qwen workflows retain executable links, Studio roles and model controls', async () => {
  await withWorkflowBuilder(async build => {
    const packs = catalog.packs.filter(p => p.family === 'Qwen Image 2.1');
    assert.equal(packs.length, 15);
    for (const pack of packs) {
      const workflow = JSON.parse(readFileSync(new URL('../setup/workflows/' + pack.file, import.meta.url)));
      const profile = await build({path: pack.file, modified: 1}, workflow);
      assert.equal(profile.kind, pack.role, pack.file);
      assert.equal(profile.resultNodeIds.length, 1);
      assert.equal(profile.modelNodes[0].modelType, 'QwenImage21');
      assert.equal(profile.loraNodes.length, 1, 'Turbo keeps the separate user LoRA stack');
      const steps = pack.id.endsWith('turbo8') ? 8 : pack.id.endsWith('base40') ? 40 : 25;
      assert.equal(profile.samplingNodes[0].controls.steps, steps);
      assert.equal(Boolean(profile.imageNodeId), pack.role === 'edit');
      assert.equal(qwenReferenceAdapter(profile)?.limit, pack.role === 'edit' ? 9 : 10, pack.file);
      assert.ok(structureAdapter(profile), pack.file);
      if (pack.role === 'edit') {
        const encoder = Object.values(profile.snapshot.output).find(n => n.class_type === 'TextEncodeQwenImage21');
        assert.equal(encoder.inputs.resolution, 0, pack.file);
        // A user's lossy global preference must respect the workflow's nodes.
        applyImageOutputSettings(profile.snapshot, {format: 'webp', mode: 'lossy', quality: 50});
        const saver = Object.values(profile.snapshot.output).find(n => n.class_type === 'Save_as_webp_cond');
        assert.equal(saver.inputs.format, 'png', pack.file);
        assert.equal(saver.inputs.mode, 'lossless', pack.file);
        assert.equal(saver.inputs.force, true, pack.file);
      }
    }
  });
});

test('FIBO presets use native conditioning and shared Studio contracts without model-specific adapters', async () => {
  await withWorkflowBuilder(async build => {
    const packs = catalog.packs.filter(p => p.family === 'FIBO 2');
    assert.equal(packs.length, 3);
    for (const pack of packs) {
      const workflow = JSON.parse(readFileSync(new URL('../setup/workflows/' + pack.file, import.meta.url)));
      const profile = await build({path: pack.file, modified: 1}, workflow);
      const edit = pack.role === 'edit', turbo = pack.id === 'fibo2_turbo_edit';
      assert.equal(profile.kind, pack.role);
      assert.equal(profile.modelNodes[0].modelType, turbo ? 'Fibo2EditTurbo' : 'Fibo2Dev');
      assert.equal(profile.loraNodes[0].loraType, 'Fibo2');
      assert.equal(profile.resultNodeIds.length, 1);
      const output = profile.snapshot.output;
      const find = type => Object.entries(output).find(([, n]) => n.class_type === type);
      const [encoderId, encoder] = find('TextEncodeFibo2');
      const [, sampler] = find('KCPP_PromptStudioSampler');
      assert.deepEqual(sampler.inputs.positive, [encoderId, 0]);
      assert.deepEqual(sampler.inputs.negative, [encoderId, 1]);
      assert.deepEqual(sampler.inputs.latent_image, [encoderId, 2]);
      assert.equal(sampler.inputs.steps, turbo ? 4 : 50);
      assert.equal(sampler.inputs.cfg, turbo ? 1 : 5);
      assert.equal(sampler.inputs.denoise, 1);
      assert.equal(sampler.inputs.scheduler, 'simple');
      assert.equal(sampler.inputs.sampler_name, 'euler');
      assert.equal(encoder.inputs.negative_prompt, '');
      assert.equal(find('CLIPLoader')[1].inputs.type, 'fibo2');
      assert.deepEqual(encoder.inputs.vae, [find('VAELoader')[0], 0]);
      assert.deepEqual(find('VAEDecode')[1].inputs.vae, encoder.inputs.vae);
      assert.equal(Object.keys(encoder.inputs).filter(k => k.startsWith('images.image_')).length, 4);
      const adapter = qwenReferenceAdapter(profile);
      assert.ok(adapter.explicit);
      assert.equal(adapter.model, 'workflow');
      assert.equal(adapter.limit, edit ? 3 : 4);
      assert.equal(adapter.firstImage, edit ? 2 : 1);
      assert.equal(adapter.token, '<image_{index}>');
      assert.equal(adapter.promptMode, edit ? 'edit_instruction' : 'full_prompt');
      assert.equal(structureAdapter(profile), null, 'No Qwen ControlNet capability leaks into FIBO');
      assert.equal(Boolean(maskAdapter(profile)), edit);
      if (edit) {
        assert.deepEqual(encoder.inputs['images.image_1'], [profile.imageNodeId, 0]);
        assert.equal(encoder.inputs.width, 0);
        assert.equal(encoder.inputs.height, 0);
        assert.deepEqual(find('PS_EditMask')[1].inputs.source, [profile.imageNodeId, 0]);
      } else {
        assert.deepEqual(encoder.inputs.width, [profile.promptNodeId, 2]);
        assert.deepEqual(encoder.inputs.height, [profile.promptNodeId, 3]);
      }
      const references = Array.from({length: adapter.limit}, (_, i) => ({image:{filename:`ref${i}.png`,subfolder:'',type:'input'},role:'subject',instruction:''}));
      assert.throws(() => validateQwenReferences([...references, references[0]], profile.kind, adapter), /at most/);
      const snapshot = structuredClone(profile.snapshot);
      applyQwenReferences(snapshot, profile, references);
      assert.equal(JSON.parse(snapshot.output[adapter.collectionId].inputs.references_json).length, adapter.limit);
      assert.equal(output[adapter.collectionId].inputs.references_json, '[]', 'Template stays clean');
      if (edit) assert.match(directQwenInstruction('Replace the clothing.', references, adapter), /<image_4>/);
      applyImageOutputSettings(snapshot, {format:'webp',mode:'lossy',quality:50});
      assert.equal(snapshot.output[profile.resultNodeIds[0]].inputs.format, 'png');
      assert.equal(snapshot.output[profile.resultNodeIds[0]].inputs.force, true);
    }
  });
});
