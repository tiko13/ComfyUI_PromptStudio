import test from "node:test";
import assert from "node:assert/strict";
import {normalizeRegion, normalizeTargeting, validateTargetSource} from "../web/js/prompt-studio/generation/reference-targeting.js";
import {normalizeQwenReferences, directQwenInstruction, requestQwenEdit} from "../web/js/prompt-studio/generation/qwen-references.js";
import {normalizeReferenceClarification, referenceContextMatches} from "../web/js/prompt-studio/generation/reference-grounding.js";
import {referenceInputsMatch} from "../web/js/prompt-studio/generation/reference-inputs.js";
import {guideGraph} from "../web/js/prompt-studio/generation/structure-guide.js";
const image = {filename:"source.png", type:"input", subfolder:""};
const region = {x:.1, y:.2, width:.3, height:.4};
const entry = {id:"guide", image, role:"pose", use:"structure", guide:{type:"pose", strength:.8},
  instruction:"Only the person on the left", targeting:{reference:region,target:region,targetImage:image}};

test("targeting survives normalization, changes invalidate preparation, source binding is enforced", () => {
  const refs = normalizeQwenReferences([entry]);
  assert.deepEqual(refs[0].targeting, entry.targeting);
  assert.equal(normalizeRegion({...region,width:2}),null);
  assert.equal(normalizeRegion({...region,x:NaN}),null);
  assert.equal(normalizeTargeting({}),null);
  assert.equal(referenceInputsMatch({qwenReferences:refs},{qwenReferences:[{...entry,targeting:null}]}),false);
  validateTargetSource(refs,image);
  assert.throws(()=>validateTargetSource(refs,{...image,filename:"new.png"}),/source image changed/);
  const graph=guideGraph(refs[0]);
  assert.deepEqual(JSON.parse(graph.ps_structure_guide.inputs.targeting),entry.targeting);
});

test("direct guides carry their type and instruction but never invent execution image tags", () => {
  const prompt=directQwenInstruction("",[entry]);
  assert.match(prompt,/ControlNet pose guide/); assert.match(prompt,/person on the left/);
  assert.match(prompt,/10% from the left/); assert.doesNotMatch(prompt,/<image/);
  assert.doesNotMatch(directQwenInstruction("Recolor the jacket",[{...entry,guide:{type:"pose",strength:0}}]),/ControlNet|person on the left/);
  assert.match(directQwenInstruction("",[{...entry,use:"reference"}]),/pose from <image2>/);
});

test("empty-text Qwen clarification persists and is invalidated by changes in any submitted input", async () => {
  const state={editPromptModel:"qwen_image_2_1",sourceImage:image,workflowProfileId:"qwen",qwenReferences:[entry],question:"Which person?",userText:""};
  const pending=normalizeReferenceClarification(state);
  assert.ok(pending); assert.equal(referenceContextMatches(pending,state),true);
  assert.equal(referenceContextMatches(pending,{...state,workflowProfileId:"other"}),false);
  assert.equal(referenceContextMatches(pending,{...state,qwenReferences:[{...entry,instruction:"Right person"}]}),false);
  await assert.rejects(requestQwenEdit(async()=>({ok:true,json:async()=>({prompt:"",clarification:"Which person?"})}),{}),{name:"QwenClarificationNeeded",message:"Which person?"});
});
