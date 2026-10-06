import test from "node:test";
import assert from "node:assert/strict";
import {structureAdapter, applyStructureGuide, semanticReferences, normalizeGuide} from "../web/js/prompt-studio/generation/structure-guide.js";
import {normalizeQwenReferences, applyQwenReferences, directQwenInstruction} from "../web/js/prompt-studio/generation/qwen-references.js";
import {normalizeReferenceState, referenceInputsMatch} from "../web/js/prompt-studio/generation/reference-inputs.js";

const image = {filename:"pose.png", subfolder:"", type:"input"};
const guide = {id:"guide",image,use:"structure",guide:{type:"pose",strength:.7,input:"prepared",fit:"crop"}};
function profile(kind="edit") {return {kind,promptNodeId:"p",imageNodeId:"source",snapshot:{output:{
  p:{class_type:"KCPP_PromptSlot",inputs:{}},source:{class_type:"KCPP_ChatImageInput",inputs:{}},
  encode:{class_type:"TextEncodeQwenImage21",inputs:{prompt:["p",0],...(kind==="edit"?{"images.image_1":["source",0]}:{})}},
  sample:{class_type:"KCPP_QwenImage21TurboSampler",inputs:{model:["cache",0],positive:["encode",0],latent_image:["encode",2]}},
  decode:{class_type:"VAEDecode",inputs:{samples:["sample",0],vae:["vae",0]}},
}}};}
const fetchReady = async()=>({ok:true,json:async()=>({ready:true,model:"QwenImage21/control.safetensors",methods:{pose:{ready:false}}})});

test("structure-only reference is preserved but does not consume semantic image numbers",()=>{
 const refs=normalizeQwenReferences([guide,{id:"jacket",image,role:"clothing"}]);
 const p=profile(); applyQwenReferences(p.snapshot,p,refs);
 assert.equal(p.snapshot.output.encode.inputs["images.image_2"][0],"ps_qwen_reference_2");
 assert.equal(p.snapshot.output.encode.inputs["images.image_3"],undefined);
 assert.equal(semanticReferences(refs).length,1);
 assert.match(directQwenInstruction("Change jacket",refs),/clothing from <image2>/);
 assert.doesNotMatch(directQwenInstruction("Change jacket",refs),/pose from|image3/);
 assert.deepEqual(normalizeReferenceState({qwenReferences:refs}).qwenReferences,refs);
 assert.equal(referenceInputsMatch({qwenReferences:refs},{qwenReferences:[{...guide,guide:{...guide.guide,strength:.2}},refs[1]]}),false);
});

test("Create and Edit inject guide after existing model adapters and preserve VAE/dimensions",async()=>{
 for(const kind of ["create","edit"]) {
  const p=profile(kind);assert.ok(structureAdapter(p));
  await applyStructureGuide(p.snapshot,p,[guide],fetchReady);
  assert.deepEqual(p.snapshot.output.ps_structure_apply.inputs.model,["cache",0]);
  assert.deepEqual(p.snapshot.output.ps_structure_apply.inputs.vae,["vae",0]);
  assert.deepEqual(p.snapshot.output.ps_structure_guide.inputs.width,["p",2]);
  assert.deepEqual(p.snapshot.output.sample.inputs.model,["ps_structure_apply",0]);
 }
});

test("missing extractors fail closed; prepared maps need no extractor; unsupported flows stay inactive",async()=>{
 const p=profile();
 await assert.rejects(applyStructureGuide(p.snapshot,p,[{...guide,guide:{...guide.guide,input:"photo"}}],fetchReady),/Pose extraction/);
 await assert.rejects(applyStructureGuide(p.snapshot,p,[guide,{...guide,id:"second"}],fetchReady),/one structure/);
 const video=profile("video"),before=structuredClone(video.snapshot);
 await applyStructureGuide(video.snapshot,video,[guide],()=>{throw Error("must not fetch")});
 assert.deepEqual(video.snapshot,before);
 assert.equal(normalizeGuide({strength:4}).strength,1);
 assert.equal(normalizeGuide({strength:-2}).strength,0);
});
