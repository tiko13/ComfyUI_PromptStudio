import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';

const fixture=await startFixture();
let changed=false;
try {
  await fixture.context.route('**/promptstudio/prompt-studio/provenance',route=>route.fulfill({json:{version:1,versions:{schema:'1',guide:'guide-v1'},assets:[{
    node_id:'2',input:'unet_name',category:'diffusion_models',name:'model.safetensors',status:'available',hash_state:'complete',metadata_token:'a'.repeat(64),sha256:(changed?'c':'b').repeat(64),
  }]}}));
  const page=await fixture.context.newPage();
  await page.route(fixture.origin+'/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Provenance module fixture</title>'}));
  await page.goto(fixture.origin+'/');
  await page.evaluate(async()=>{
    const module=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/generation/provenance.js');
    const snapshot={workflow:{nodes:[],extra:{keep:true}},output:{'1':{class_type:'Sampler',inputs:{seed:27,prompt:'Keep exact dialogue'}},'2':{class_type:'Loader',inputs:{unet_name:'model.safetensors'}}}};
    const runtime=await fetch('/promptstudio/prompt-studio/provenance',{method:'POST',body:JSON.stringify({snapshot})}).then(response=>response.json());
    window.provenanceFixture={module,snapshot,before:JSON.stringify(snapshot),saved:await module.captureProvenance(snapshot,{runtime,lineage:{parentId:'source'}})};
  });
  const unchanged=await page.evaluate(async()=>{
    const {module,snapshot,saved}=window.provenanceFixture;
    const runtime=await fetch('/promptstudio/prompt-studio/provenance',{method:'POST',body:JSON.stringify({snapshot})}).then(response=>response.json());
    return {comparison:await module.compareReplayProvenance(saved,snapshot,{runtime}),replay:JSON.stringify(module.replaySnapshot(snapshot).output),original:JSON.stringify(snapshot.output)};
  });
  assert.equal(unchanged.comparison.status,'unchanged');assert.deepEqual(unchanged.comparison.warnings,[]);assert.equal(unchanged.replay,unchanged.original);
  changed=true;
  const drift=await page.evaluate(async()=>{
    const {module,snapshot,saved,before}=window.provenanceFixture;
    const runtime=await fetch('/promptstudio/prompt-studio/provenance',{method:'POST',body:JSON.stringify({snapshot})}).then(response=>response.json());
    return {comparison:await module.compareReplayProvenance(saved,snapshot,{runtime}),legacy:await module.compareReplayProvenance(null,snapshot,{runtime}),unchanged:before===JSON.stringify(snapshot)};
  });
  assert.equal(drift.comparison.status,'drift');assert.match(drift.comparison.warnings[0].message,/model.safetensors.*same filename.*Restore/);
  assert.equal(drift.legacy.status,'metadata_unavailable');assert.equal(drift.unchanged,true);assert.deepEqual(fixture.errors,[]);
  console.log('Browser provenance metadata/drift comparison and immutable replay payload passed (module boundary; no queue).');
} finally {await fixture.close();}
