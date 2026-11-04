import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mossCatalog,mossProfile} from './moss-fixture.mjs';
import {applySpatialInputs,normalizeSpatialSnapshot,spatialValue,spatialDefaults,spatialContractKey,layoutBinding,normalizeSpatialInput,spatialDimensions} from '../web/js/prompt-studio/generation/spatial-inputs.js';
import {namedStructureInputs,capabilityNode} from '../web/js/prompt-studio/generation/workflow-capabilities.js';
import {validateMossRecipe} from '../web/js/prompt-studio/generation/moss-recipe.js';
import {createChatModel} from '../web/js/prompt-studio/chat/model.js';
import {snapshotForPlotCell} from '../web/js/prompt-studio/plot/model.js';

test('MOSS presets reuse Studio roles and native layout, loaders, samplers and conditioning',async()=>{
 assert.equal(mossCatalog.length,4);
 for(const pack of mossCatalog){
  const p=await mossProfile(pack),dmd=pack.id.startsWith('kromoss'),controlled=pack.id.endsWith('controlled');
  const out=Object.values(p.snapshot.output),get=type=>out.find(n=>n.class_type===type);
  assert.equal(p.kind,'create');assert.equal(p.resultNodeIds.length,1);assert.equal(get('CLIPLoader').inputs.type,'moss_image');
  assert.equal(p.loraNodes.length,1);assert.equal(p.modelNodes.length,1);
  const realism=pack.id==='kromoss_realism_create';
  assert.equal(p.samplingNodes[0].controls.steps,realism?12:dmd?8:50);assert.equal(p.samplingNodes[0].controls.cfg,dmd?1:3);
  assert.equal(p.samplingNodes[0].controls.scheduler,dmd?'simple':'sgm_uniform');
  assert.equal(Boolean(get('SkipLayerGuidanceDiTSimple')),!dmd);
  assert.ok(layoutBinding(p));assert.equal(p.additionalInputs.length,dmd?1:controlled?5:2);
  assert.equal(namedStructureInputs(p).length,controlled?2:0);assert.equal(capabilityNode(p,'PS_StructureInput'),null);
  assert.equal(out.filter(n=>n.class_type==='LoraLoaderModelOnly').length,realism?3:controlled?2:1);
  assert.deepEqual(get('EmptyFlux2LatentImage').inputs.width,[p.promptNodeId,2]);
  const snap=structuredClone(p.snapshot),value=spatialValue({},p);
  if(controlled)value.guides.depth={image:{filename:'depth.png'},kind:'depth',enabled:true};
  applySpatialInputs(snap,p,value);assert.doesNotThrow(()=>validateMossRecipe(snap,p));
  const boxes=snap.output[layoutBinding(p).boxesId].inputs;
  assert.deepEqual(boxes.editor_state,{__value__:[]});
  assert.deepEqual(boxes.last_incoming,{__value__:[]});
  // ComfyUI treats every bare array input as a [node ID, output slot] link.
  for(const node of Object.values(snap.output))for(const input of Object.values(node.inputs)){
   if(!Array.isArray(input))continue;
   assert.equal(input.length,2);assert.ok(snap.output[input[0]]);assert.ok(Number.isInteger(input[1]));
  }
  if(controlled){get('MOSSImageControl').inputs.end_percent=-1;assert.throws(()=>validateMossRecipe(p.snapshot,p),/Control requires/);}
 }
});

test('realism keeps BF16, chains both turbo adapters and photo style, and rejects bypasses and duplicates',async()=>{
 const p=await mossProfile(mossCatalog.find(p=>p.id==='kromoss_realism_create'));
 const out=p.snapshot.output;
 const get=type=>Object.entries(out).find(([,n])=>n.class_type===type);
 assert.equal(get('KCPP_PromptStudioModelLoader')[1].inputs.unet_name,'Kromoss/kromoss_bf16.safetensors');
 const join=get('StringConcatenate');
 assert.equal(join[1].inputs.string_a,'photo');
 assert.deepEqual(join[1].inputs.string_b,[p.promptNodeId,0]);
 assert.deepEqual(out[layoutBinding(p).id].inputs.prompt,[join[0],0]);
 assert.doesNotThrow(()=>validateMossRecipe(p.snapshot,p));
 const record=asset=>p.snapshot.workflow.nodes.find(n=>n.properties?.promptstudio_asset===asset);
 for(const asset of ['kromoss_dmd','moss_snapshot']) {
  const id=String(record(asset).id),snap=structuredClone(p.snapshot);
  snap.output[id].inputs.strength_model=1;
  assert.throws(()=>validateMossRecipe(snap,p),/Realism requires/);
  snap.output[id].inputs.strength_model=0.5;
  snap.output[id].inputs.model=[get('KCPP_PromptStudioModelLoader')[0],0];
  assert.throws(()=>validateMossRecipe(snap,p),/Realism requires/);
  delete snap.output[id];
  assert.throws(()=>validateMossRecipe(snap,p),/Realism requires/);
  const duplicate=structuredClone(p.snapshot);
  duplicate.output[get('KCPP_PromptStudioLoraLoader')[0]].inputs.lora_stack_json=JSON.stringify([{name:out[id].inputs.lora_name,strength:0.5}]);
  assert.throws(()=>validateMossRecipe(duplicate,p),/duplicate/);
 }
 const bypass=structuredClone(p.snapshot);
 bypass.output[get('ModelSamplingAuraFlow')[0]].inputs.model=[String(record('kromoss_dmd2').id),0];
 assert.throws(()=>validateMossRecipe(bypass,p),/feed the flow sampler/);
});

test('layouts, maps, character numbering and snapshots stay isolated across chats and recipes',async()=>{
 const p=await mossProfile(mossCatalog.find(p=>p.id==='moss_sft_controlled')),value=normalizeSpatialInput({contract:spatialContractKey(p),alignment:'crop',elements:[
  {id:'sign',type:'text',x:.2,y:.1,width:.3,height:.2,text:'HELLO',description:'wooden sign'},
  {id:'person',type:'character',x:.5,y:.2,width:.4,height:.7,description:'woman',palette:['#ff0000']}
 ],guides:{color:{image:{filename:'color.png'},kind:'color'},depth:{image:{filename:'depth.png'},kind:'depth',invert:true}}});
 const snap=structuredClone(p.snapshot);applySpatialInputs(snap,p,value);const binding=layoutBinding(p);
 assert.equal(snap.output[binding.id].inputs.character_boxes,'2');
 assert.deepEqual(snap.output[binding.boxesId].inputs.editor_state,{__value__:[]});
 assert.deepEqual(snap.output[binding.boxesId].inputs.last_incoming,{__value__:[]});
 assert.equal(snap.workflow.nodes.find(n=>String(n.id)===binding.boxesId).widgets_values[2].length,2);
 assert.deepEqual(JSON.parse(snap.output[binding.boxesId].inputs.bboxes)[0].bbox,[100,200,300,500]);
 const slots=namedStructureInputs(p);assert.equal(JSON.parse(snap.output[slots[0].id].inputs.reference_json).guide.fit,'crop');
 assert.equal(snap.workflow.nodes.find(n=>String(n.id)===slots[0].id).widgets_values[2],snap.output[slots[0].id].inputs.reference_json);
 assert.equal(JSON.parse(snap.output[slots[1].id].inputs.reference_json).guide.invert,true);
 const before=JSON.stringify(snap);value.elements[0].text='CHANGED';assert.equal(JSON.stringify(snap),before);
 assert.equal(p.snapshot.output[binding.id].inputs.character_boxes,'');
 const model=createChatModel({getDefaultLoraSelections:()=>({}),getDefaultModelSelections:()=>({}),normalizeLlmProvider:x=>x,
  promptVersion:(mainPrompt,finalPrompt)=>({mainPrompt,finalPrompt}),normalizePromptVersion:x=>x});
 const chat=model.normalizeChat({id:'chat',messages:[],spatialInputs:{[p.id]:value}});
 assert.equal(spatialValue(chat,p).elements[0].text,'CHANGED');assert.equal(spatialValue({},p).elements.length,0);
 assert.equal(spatialValue(chat,{...p,id:'other'}).elements.length,0);
 const changed=structuredClone(p);changed.snapshot.output[slots[0].id].inputs.control_key='regions';
 assert.throws(()=>applySpatialInputs(structuredClone(changed.snapshot),changed,value),/connections changed/);
 value.enabled=false;value.guides.color.enabled=false;applySpatialInputs(snap,p,value);
 assert.equal(snap.output[binding.boxesId].inputs.bboxes,'[]');assert.equal(snap.output[slots[0].id].inputs.reference_json,'');
});

test('layout contracts reject ambiguous wiring and preserve non-square workflow defaults',async()=>{
 const p=await mossProfile(mossCatalog[0]),binding=layoutBinding(p);
 p.snapshot.output[p.promptNodeId].inputs.resolution_width=1536;p.snapshot.output[p.promptNodeId].inputs.resolution_height=768;
 p.snapshot.output[binding.boxesId].inputs.editor_state=[{x:768,y:384,width:384,height:192,metadata:{desc:'box'}}];
 assert.equal(spatialDefaults(p).elements[0].x,.5);assert.equal(spatialDefaults(p).elements[0].y,.5);
 p.snapshot.output[binding.boxesId].inputs.editor_state={__value__:p.snapshot.output[binding.boxesId].inputs.editor_state};
 assert.equal(spatialDefaults(p).elements[0].x,.5);assert.equal(spatialDefaults(p).elements[0].y,.5);
 p.snapshot.output[binding.id].inputs.width=1024;assert.throws(()=>layoutBinding(p),/dimensions/);
 assert.deepEqual(spatialDimensions({aspect_ratio:'2:3 (Portrait Photo)',megapixels:1,multiple:32}),{width:832,height:1248});
});

test('control recipe requires a map and duplicate recipe LoRAs fail early',async()=>{
 const p=await mossProfile(mossCatalog.find(p=>p.id==='moss_sft_controlled'));
 assert.throws(()=>validateMossRecipe(p.snapshot,p),/Add a color or depth/);
 const value=spatialValue({},p);value.guides.depth={kind:'depth',image:{filename:'x.png'}};applySpatialInputs(p.snapshot,p,value);
 const user=Object.values(p.snapshot.output).find(n=>n.class_type==='KCPP_PromptStudioLoraLoader');
 user.inputs.lora_stack_json=JSON.stringify([{name:'other/moss_sft_destripe_top64_bf16.safetensors',strength:1}]);
 assert.throws(()=>validateMossRecipe(p.snapshot,p),/duplicate/);
 value.guides.color={kind:'color',image:{filename:'regions.png',width:100,height:200}};
 value.guides.depth.image={filename:'depth.png',width:100,height:100};
 assert.throws(()=>applySpatialInputs(p.snapshot,p,value),/matching aspect ratios/);
});

test('plot cells preserve captured maps and validate adapters after axis overrides',async()=>{
 const p=await mossProfile(mossCatalog.find(p=>p.id==='moss_sft_controlled'));
 const value=spatialValue({},p);value.guides.depth={kind:'depth',image:{filename:'saved-depth.png'}};
 applySpatialInputs(p.snapshot,p,value);
 const plot={axes:[],base:{workflowSnapshot:p.snapshot,promptNodeId:p.promptNodeId,resultNodeIds:p.resultNodeIds}};
 const cell=snapshotForPlotCell(plot,{finalPrompt:'A different scene'});
 const slot=namedStructureInputs(p)[1];
 assert.equal(JSON.parse(cell.output[slot.id].inputs.reference_json).image.filename,'saved-depth.png');
 cell.output[slot.id].inputs.reference_json='';
 assert.notEqual(p.snapshot.output[slot.id].inputs.reference_json,'');
 plot.base.workflowSnapshot.output[slot.id].inputs.reference_json='';
 assert.throws(()=>snapshotForPlotCell(plot,{finalPrompt:'A scene'}),/Add a color or depth/);
});

test('old MOSS submissions and plot cells repair list widgets without changing captured layout or links',async()=>{
 const p=await mossProfile(mossCatalog[0]),binding=layoutBinding(p),before=structuredClone(p.snapshot);
 const snap=structuredClone(before),boxes=snap.output[binding.boxesId].inputs;
 boxes.bboxes='[{"desc":"captured box","bbox":[0,0,500,500]}]';
 boxes.editor_state=[{x:1,y:2,width:3,height:4},{x:5,y:6,width:7,height:8}];
 const captured=structuredClone(boxes.editor_state);
 normalizeSpatialSnapshot(snap);
 assert.deepEqual(boxes.editor_state,{__value__:captured});assert.deepEqual(boxes.last_incoming,{__value__:[]});
 assert.equal(boxes.bboxes,'[{"desc":"captured box","bbox":[0,0,500,500]}]');
 assert.deepEqual(snap.workflow,before.workflow);assert.deepEqual(p.snapshot,before);
 const once=structuredClone(snap);normalizeSpatialSnapshot(snap);assert.deepEqual(snap,once);
 boxes.editor_state=[p.promptNodeId,0];normalizeSpatialSnapshot(snap);assert.deepEqual(boxes.editor_state,[p.promptNodeId,0]);
 const plot={axes:[],base:{workflowSnapshot:before,promptNodeId:p.promptNodeId,resultNodeIds:p.resultNodeIds}};
 const cell=snapshotForPlotCell(plot,{finalPrompt:'Office scene'});
 assert.deepEqual(cell.output[binding.boxesId].inputs.editor_state,{__value__:[]});
 assert.deepEqual(cell.output[binding.boxesId].inputs.last_incoming,{__value__:[]});
 assert.deepEqual(plot.base.workflowSnapshot,before);
});
