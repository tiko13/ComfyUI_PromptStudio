import assert from "node:assert/strict";
import test from "node:test";
import {qwenReferenceAdapter, applyQwenReferences, qwenCreateInstruction, validateQwenReferences} from "../web/js/prompt-studio/generation/qwen-references.js";
import {applyStructureGuide} from "../web/js/prompt-studio/generation/structure-guide.js";
import {workflowHelpFacts} from "../web/js/prompt-studio/generation/help-context.js";
const ref = (id, role="subject") => ({id, image:{filename:id+".png",type:"input",subfolder:""},role,instruction:""});
function profile() {return {kind:"create",promptNodeId:"p",snapshot:{output:{
 p:{class_type:"KCPP_PromptSlot",inputs:{prompt:"A new scene"}},
 e:{class_type:"TextEncodeQwenImage21",inputs:{prompt:["p",0]}},
 l:{class_type:"EmptyLatentImage",inputs:{width:768,height:1024,batch_size:1}},
 s:{class_type:"KCPP_QwenImage21TurboSampler",inputs:{model:["model",0],positive:["e",0],latent_image:["l",0]}},
 d:{class_type:"VAEDecode",inputs:{samples:["s",0],vae:["vae",0]}}
}}};}
test("Qwen 2.1 Create accepts ten refs, uses decoder VAE and preserves its canvas",()=>{
 const p=profile(), before=structuredClone(p.snapshot), refs=Array.from({length:10},(_,i)=>ref(String(i)));
 assert.equal(qwenReferenceAdapter(p).limit,10);
 assert.equal(workflowHelpFacts(p).reference_mode,"qwen-create");
 const snapshot=structuredClone(p.snapshot);applyQwenReferences(snapshot,p,refs);
 refs.forEach((r,i)=>assert.deepEqual(JSON.parse(snapshot.output[snapshot.output.e.inputs[`images.image_${i+1}`][0]].inputs.image_ref),r.image));
 assert.deepEqual(snapshot.output.e.inputs.vae,["vae",0]);
 assert.deepEqual(snapshot.output.s,before.output.s);assert.deepEqual(snapshot.output.l,before.output.l);
 assert.deepEqual(p.snapshot,before);
 assert.throws(()=>validateQwenReferences([...refs,ref("extra")],"create"),/ten/);
 assert.throws(()=>validateQwenReferences(refs,"edit"),/nine/);
 assert.throws(()=>qwenCreateInstruction("Scene",[ref("custom","custom")]),/Describe/);
});
test("Create rejects other models, prewired images and reference-sized canvases",()=>{
 for(const kind of ["edit","video","upscale"]) {const p=profile();p.kind=kind;assert.equal(qwenReferenceAdapter(p),null);}
 for(const type of ["CLIPTextEncode","TextEncodeQwenImageEditPlus"]) {const p=profile();p.snapshot.output.e.class_type=type;assert.equal(qwenReferenceAdapter(p),null);}
 const wired=profile();wired.snapshot.output.e.inputs["images.image_1"]=["existing",0];assert.equal(qwenReferenceAdapter(wired),null);
 const sized=profile();sized.snapshot.output.s.inputs.latent_image=["e",2];assert.equal(qwenReferenceAdapter(sized),null);
 const noVae=profile();delete noVae.snapshot.output.d;assert.equal(qwenReferenceAdapter(noVae),null);
});
test("Create combines normal references and ControlNet, numbering only semantic sources",async()=>{
 for(const use of ["structure","both"]) {
  const p=profile(), guide={...ref("guide","pose"),use,guide:{type:"edges",input:"prepared",strength:.6}},refs=[guide,ref("identity")];
  const prompt=qwenCreateInstruction("A person in a garden.",refs);
  assert.match(prompt,/new composition/);assert.match(prompt,new RegExp(`subject / identity from <image${use==="both"?2:1}>`));
  applyQwenReferences(p.snapshot,p,refs);
  await applyStructureGuide(p.snapshot,p,refs,async()=>({ok:true,json:async()=>({ready:true,model:"control.safetensors"})}));
  assert.equal(p.snapshot.output.ps_structure_apply.inputs.strength,.6);
  assert.deepEqual(p.snapshot.output.s.inputs.latent_image,["l",0]);
  assert.equal(Object.keys(p.snapshot.output.e.inputs).filter(k=>k.startsWith("images.image_")).length,use==="both"?2:1);
 }
 assert.equal(qwenCreateInstruction("Untouched prompt",[]),"Untouched prompt");
 assert.equal(qwenCreateInstruction("Only guide",[{...ref("guide"),use:"structure"}]),"Only guide");
});
