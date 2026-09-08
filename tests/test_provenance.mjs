import assert from 'node:assert/strict';
import {test} from 'node:test';
import {captureProvenance,compareReplayProvenance,replaySnapshot,exportGenerationProvenance} from '../web/js/prompt-studio/generation/provenance.js';
import {normalizePendingGeneration} from '../web/js/prompt-studio/chat/generation-state.js';

const snapshot={workflow:{nodes:[{id:1,type:'Sampler'}],extra:{keep:true}},output:{'30:1':{class_type:'Sampler',inputs:{seed:4294967295,steps:20,prompt:'Exact "dialogue"'}},'2':{class_type:'Loader',inputs:{unet_name:'model.safetensors'}}},metadata:{retain:'unknown'}};
const runtime={version:1,versions:{schema:'1',prompt_policy:'4',guide:'sha256-guide',runtime:'frontend1',extension:'abc'},assets:[{node_id:'2',input:'unet_name',category:'diffusion_models',name:'model.safetensors',status:'available',hash_state:'complete',metadata_token:'a'.repeat(64),sha256:'b'.repeat(64)}]};

test('unchanged replay preserves byte-equivalent executable inputs and envelope without warnings',async()=>{
  const saved=await captureProvenance(snapshot,{runtime,lineage:{parentId:'source'}}),before=JSON.stringify(snapshot);
  const replay=replaySnapshot(snapshot);replay.transport={requestId:'ephemeral'};
  const result=await compareReplayProvenance(saved,replay,{runtime});
  assert.equal(result.status,'unchanged');assert.deepEqual(result.warnings,[]);
  assert.equal(JSON.stringify(replay.output),JSON.stringify(snapshot.output));assert.equal(JSON.stringify(snapshot),before);
  assert.deepEqual(saved.resolvedSeeds,[{node_id:'30:1',input:'seed',value:4294967295}]);
  assert.deepEqual(saved.lineage,{parentId:'source'});
  replay.output['30:1'].inputs.seed=0;assert.equal(snapshot.output['30:1'].inputs.seed,4294967295);
  assert.deepEqual(normalizePendingGeneration({generationSnapshot:snapshot,provenance:saved}).provenance,saved);
});

test('same-filename model replacement and policy/guide drift produce actionable specific warnings',async()=>{
  const saved=await captureProvenance(snapshot,{runtime}),current=structuredClone(runtime);
  current.assets[0].sha256='c'.repeat(64);current.versions.prompt_policy='5';current.versions.guide='new-guide';
  const before=JSON.stringify(snapshot);const result=await compareReplayProvenance(saved,snapshot,{runtime:current});
  assert.equal(result.status,'drift');assert.match(result.warnings.find(item=>item.code==='asset_changed').message,/model.safetensors.*same filename.*Restore/);
  assert.deepEqual(result.warnings.filter(item=>item.code==='version_changed').map(item=>item.dependency),['prompt_policy','guide']);
  assert.equal(JSON.stringify(snapshot),before);
});

test('old records remain replayable with explicit unavailable metadata; modified input has separate warning',async()=>{
  const old=await compareReplayProvenance(null,snapshot,{runtime});assert.equal(old.status,'metadata_unavailable');assert.match(old.warnings[0].message,/still be replayed/);
  assert.deepEqual(replaySnapshot(snapshot),snapshot);
  const saved=await captureProvenance(snapshot,{runtime}),changed=replaySnapshot(snapshot);changed.output['30:1'].inputs.steps=21;
  const result=await compareReplayProvenance(saved,changed,{runtime});assert.equal(result.warnings[0].code,'executable_changed');
});

test('pending large hashes use metadata identity and completed equal content ignores timestamp-only changes',async()=>{
  const pending=structuredClone(runtime);delete pending.assets[0].sha256;pending.assets[0].hash_state='pending';
  const saved=await captureProvenance(snapshot,{runtime:pending});
  assert.equal((await compareReplayProvenance(saved,snapshot,{runtime:pending})).status,'unchanged');
  pending.assets[0].metadata_token='d'.repeat(64);assert.equal((await compareReplayProvenance(saved,snapshot,{runtime:pending})).warnings[0].code,'asset_changed');
  const strong=await captureProvenance(snapshot,{runtime}),touched=structuredClone(runtime);touched.assets[0].metadata_token='e'.repeat(64);
  assert.equal((await compareReplayProvenance(strong,snapshot,{runtime:touched})).status,'unchanged');
});

test('export preserves lineage, prompts and envelopes while redacting structured absolute paths in a clone',async()=>{
  const generation={id:'g1',parent_generation_id:'g0',compiled_prompt:'Exact <d>hello</d>',workflow_snapshot:replaySnapshot(snapshot),provenance:await captureProvenance(snapshot,{runtime}),filePath:'C:\\Users\\private\\video.mp4'};
  generation.workflow_snapshot.output['2'].inputs.unet_name='/private/models/model.safetensors';
  generation.workflow_snapshot.output['2'].inputs.lora_stack_json=JSON.stringify([{name:'C:\\private\\style.safetensors',strength:1}]);
  const before=JSON.stringify(generation),result=exportGenerationProvenance(generation);
  assert.equal(result.filePath,'video.mp4');assert.equal(result.workflow_snapshot.output['2'].inputs.unet_name,'model.safetensors');
  assert.equal(result.parent_generation_id,'g0');assert.equal(result.compiled_prompt,generation.compiled_prompt);
  assert.deepEqual(result.workflow_snapshot.workflow,generation.workflow_snapshot.workflow);assert.equal(result.exportMetadata.privatePathsRedacted.length,3);
  assert.equal(JSON.parse(result.workflow_snapshot.output['2'].inputs.lora_stack_json)[0].name,'style.safetensors');
  assert.equal(JSON.stringify(generation),before);
});

test('same-filename LoRA replacement is named independently of unchanged model dependencies',async()=>{
  const original=structuredClone(runtime);original.assets.push({...original.assets[0],node_id:'4',input:'lora_stack_json[0]',category:'loras',name:'style.safetensors'});
  const saved=await captureProvenance(snapshot,{runtime:original}),changed=structuredClone(original);changed.assets[1].sha256='f'.repeat(64);
  const result=await compareReplayProvenance(saved,snapshot,{runtime:changed});assert.equal(result.warnings.length,1);
  assert.equal(result.warnings[0].asset,'style.safetensors');assert.match(result.warnings[0].message,/loras/);
});
