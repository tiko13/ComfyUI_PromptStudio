import assert from 'node:assert/strict';
import {test} from 'node:test';
import {declaredReferenceAdapter, validateDeclaredCapabilities} from '../web/js/prompt-studio/generation/workflow-capabilities.js';
import {qwenReferenceAdapter, referenceEditAdapter, applyQwenReferences, validateQwenReferences, directQwenInstruction, qwenCreateInstruction, referenceContractKey} from '../web/js/prompt-studio/generation/qwen-references.js';
import {applyWorkflowReferences, normalizeReferenceState} from '../web/js/prompt-studio/generation/reference-inputs.js';
import {applyStructureGuide, structureAdapter} from '../web/js/prompt-studio/generation/structure-guide.js';
import {applyReferenceMask, maskAdapter} from '../web/js/prompt-studio/generation/reference-targeting.js';
import {normalizeReferenceClarification, referenceContextMatches} from '../web/js/prompt-studio/generation/reference-grounding.js';
import {workflowHelpFacts} from '../web/js/prompt-studio/generation/help-context.js';

export function customProfile(maximum=16) {
  const output = {
    prompt: {class_type:'KCPP_PromptSlot',inputs:{prompt:''}},
    source: {class_type:'KCPP_ChatImageInput',inputs:{image_ref:''}},
    refs: {class_type:'PS_ReferenceCollection',inputs:{minimum:0,maximum,roles:'custom,texture,subject',references_json:'[]'}},
    settings: {class_type:'PS_ReferencePrompt',inputs:{prompt:['prompt',0],references:['refs',0],prompt_mode:'edit_instruction',reference_token:'[ref-{index}]',first_reference_index:0,source_token:'[canvas]',instructions:'Use concise commands.'}},
    unfamiliar: {class_type:'MyOwnImageModel',inputs:{text:['settings',0],source:['source',0]}},
    save: {class_type:'SaveImage',inputs:{images:['unfamiliar',0]}},
  };
  for(let i=1;i<=maximum;i++) {output[`sub:${i}`]={class_type:'PS_ReferenceItem',inputs:{references:['refs',0],index:i}};output.unfamiliar.inputs[`donor${i}`]=[`sub:${i}`,0];}
  return {id:'custom',kind:'edit',promptNodeId:'prompt',imageNodeId:'source',resultNodeIds:['save'],snapshot:{workflow:{nodes:[]},output}};
}
const image = name => ({filename:name,type:'input',subfolder:''});
const references = count => Array.from({length:count},(_,i)=>({image:image(`${i}.png`),role:'texture',instruction:''}));

test('unfamiliar model supports sixteen references, custom roles, tokens, and frozen snapshots',()=>{
  const profile=customProfile(), adapter=qwenReferenceAdapter(profile);
  validateDeclaredCapabilities(profile);assert.equal(adapter.limit,16);assert.equal(adapter.roles.texture,'texture');
  const snapshot=structuredClone(profile.snapshot), refs=references(16);
  applyQwenReferences(snapshot,profile,refs);
  assert.equal(JSON.parse(snapshot.output.refs.inputs.references_json).length,16);
  assert.equal(profile.snapshot.output.refs.inputs.references_json,'[]');
  const prompt=directQwenInstruction('Replace the material.',refs,adapter);
  assert.match(prompt,/Edit \[canvas\]/);assert.match(prompt,/\[ref-15\]/);assert.doesNotMatch(prompt,/<image/);assert.match(prompt,/Use concise commands/);
  assert.equal(workflowHelpFacts(profile).reference_limit,16);assert.equal(workflowHelpFacts(profile).reference_mode,'workflow');
});
test('smaller limits, minima, unsupported roles and invalid wiring fail explicitly',()=>{
  const profile=customProfile(2), adapter=declaredReferenceAdapter(profile);
  assert.throws(()=>validateQwenReferences(references(3),'edit',adapter),/at most 2/);
  profile.snapshot.output.refs.inputs.minimum=2;
  assert.throws(()=>validateQwenReferences(references(1),'edit',declaredReferenceAdapter(profile)),/at least 2/);
  assert.throws(()=>validateQwenReferences([{...references(1)[0],role:'clothing'}],'edit',adapter),/role/);
  delete profile.snapshot.output['sub:2'];assert.throws(()=>validateDeclaredCapabilities(profile),/every advertised/);
  profile.snapshot.output.refs.inputs.maximum=-1;assert.throws(()=>declaredReferenceAdapter(profile),/maximum/);
});
test('prompt convention controls edit routing and full scene reference formatting',()=>{
  const profile=customProfile(2);assert.ok(referenceEditAdapter(profile));
  profile.snapshot.output.settings.inputs.prompt_mode='full_prompt';assert.equal(referenceEditAdapter(profile),null);
  const result=qwenCreateInstruction('A completed scene.',references(2),declaredReferenceAdapter(profile));
  assert.match(result,/Edit \[canvas\]/);assert.match(result,/\[ref-0\]/);assert.doesNotMatch(result,/Create a new composition/);
});
test('dead reference branches and dynamic declarations cannot advertise unsupported inputs',()=>{
  const profile=customProfile(2);
  delete profile.snapshot.output.unfamiliar.inputs.donor2;
  profile.snapshot.output.unused={class_type:'Unused',inputs:{image:['sub:2',0]}};
  assert.throws(()=>validateDeclaredCapabilities(profile),/every advertised/);
  const configured=customProfile(2);
  configured.additionalInputs=[{targetNodeId:'refs',targetInputName:'maximum'}];
  assert.throws(()=>validateDeclaredCapabilities(configured),/Additional Inputs/);
});
test('guide-only declarations reject semantic references and require only their extractor',async()=>{
  const profile=customProfile(0), out=profile.snapshot.output;
  delete out.refs;delete out.settings.inputs.references;
  out.guide={class_type:'PS_StructureInput',inputs:{width:512,height:512}};
  out.unfamiliar.inputs.guide=['guide',0];
  const adapter=declaredReferenceAdapter(profile);assert.ok(adapter.guideOnly);assert.equal(adapter.limit,1);
  assert.throws(()=>validateQwenReferences(references(1),'edit',adapter),/structure guide only/);
  const entry={...references(1)[0],use:'structure',guide:{type:'depth',input:'photo',strength:.5}};
  const status=ready=>async()=>({ok:true,json:async()=>({ready:false,methods:{depth:{ready}}})});
  await assert.rejects(()=>applyStructureGuide(profile.snapshot,profile,[entry],status(false)),/Depth extraction/);
  await applyStructureGuide(profile.snapshot,profile,[entry],status(true));
  assert.equal(JSON.parse(out.guide.inputs.reference_json).guide.type,'depth');
});
test('required named image inputs remain model independent',()=>{
  const snapshot={output:{input:{class_type:'KCPP_ChatImageReference',inputs:{source_name:'Identity',required:true}},custom:{class_type:'Unknown',inputs:{image:['input',0]}}}};
  assert.throws(()=>applyWorkflowReferences(snapshot),/Identity is required/);
  applyWorkflowReferences(snapshot,{input:image('identity.png')});assert.match(snapshot.output.input.inputs.image_ref,/identity.png/);
});
test('saved contract, custom roles and clarification survive normalization and invalidate changed settings',()=>{
  const profile=customProfile();const state={editPromptModel:'workflow',referenceContractKey:referenceContractKey(profile),qwenReferences:references(12),sourceImage:image('source.png'),workflowProfileId:'custom',question:'Which person?',userText:''};
  const normalized=normalizeReferenceState(state);assert.equal(normalized.qwenReferences.length,12);assert.equal(normalized.qwenReferences[0].role,'texture');
  const pending=normalizeReferenceClarification(state);assert.ok(pending);assert.ok(referenceContextMatches(pending,state));
  profile.snapshot.output.settings.inputs.source_token='base';assert.equal(referenceContextMatches(pending,{...state,referenceContractKey:referenceContractKey(profile)}),false);
});
test('explicit guide and mask connections support unfamiliar decoders and clear stale injected values',async()=>{
  const profile=customProfile(1), out=profile.snapshot.output;
  assert.equal(structureAdapter(profile),null);assert.equal(maskAdapter(profile),null);
  out.guide={class_type:'PS_StructureInput',inputs:{reference_json:'old',width:512,height:512}};
  out.unfamiliar.inputs.control=['guide',0];
  out.mask={class_type:'PS_EditMask',inputs:{source:['source',0],generated:['unfamiliar',0],mask_json:'old'}};
  out.save.inputs.images=['mask',0];assert.ok(structureAdapter(profile));assert.ok(maskAdapter(profile));
  await applyStructureGuide(profile.snapshot,profile,[],()=>assert.fail('no setup call for absent guide'));
  applyReferenceMask(profile.snapshot,profile,[],image('source.png'));
  assert.equal(out.guide.inputs.reference_json,'');assert.equal(out.mask.inputs.mask_json,'');
  const entry={...references(1)[0],use:'structure',guide:{type:'pose',input:'prepared',strength:.7},pose:{image:image('pose.png')},targeting:{target:{x:0,y:0,width:1,height:1}}};
  await applyStructureGuide(profile.snapshot,profile,[entry],()=>assert.fail('prepared custom guide needs no Qwen model'));
  assert.equal(JSON.parse(out.guide.inputs.reference_json).pose.image.filename,'pose.png');
  const mask={image:image('mask.png'),sourceImage:image('source.png'),region:{x:0,y:0,width:1,height:1},sourceDigest:'a'.repeat(64),enabled:true};
  applyReferenceMask(profile.snapshot,profile,[{editMask:mask,targeting:{target:mask.region}}],mask.sourceImage);
  assert.equal(JSON.parse(out.mask.inputs.mask_json).sourceDigest,mask.sourceDigest);
});
