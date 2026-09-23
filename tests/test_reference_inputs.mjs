import assert from "node:assert/strict";
import {test} from "node:test";
import {referenceInputDescriptors, workflowReferenceValues, applyWorkflowReferences, normalizeReferenceState, referenceInputsMatch} from "../web/js/prompt-studio/generation/reference-inputs.js";
import {qwenReferenceAdapter, applyQwenReferences, validateQwenReferences} from "../web/js/prompt-studio/generation/qwen-references.js";
import {normalizePendingGeneration} from "../web/js/prompt-studio/chat/generation-state.js";
const image = name => ({filename:name,subfolder:"imports",type:"promptstudio"});
const reference = (name, role = "clothing") => ({id:name,image:image(name),role,instruction:""});
function graph() {return {workflow:{nodes:[]},output:{
  p:{class_type:"KCPP_PromptSlot",inputs:{prompt:""}},
  base:{class_type:"KCPP_ChatImageInput",inputs:{image_ref:""}},
  encoder:{class_type:"TextEncodeQwenImage21",inputs:{"images.image_1":["base",0],prompt:["p",0]}},
  "sub:7":{class_type:"KCPP_ChatImageReference",_meta:{title:"Upscale guide"},inputs:{image_ref:"stale",source_name:"Fallback"}},
  "sub:8":{class_type:"KCPP_ChatImageReference",inputs:{image_ref:"stale",source_name:"Texture"}},
  sink:{class_type:"Custom",inputs:{guide:["sub:7",0],texture:["sub:8",0]}},
  unused:{class_type:"KCPP_ChatImageReference",inputs:{image_ref:"unused"}}
}};}
const profile = () => ({id:"qwen",kind:"edit",imageNodeId:"base",promptNodeId:"p",snapshot:graph()});
test("universal slots use titles, node IDs and workflow identity without model or mode gates",()=>{
 const snapshot=graph(), owner={workflowReferences:{a:{"sub:7":image("a.png")},b:{"sub:7":image("b.png")}}};
 assert.deepEqual(referenceInputDescriptors(snapshot),[{id:"sub:7",label:"Upscale guide"},{id:"sub:8",label:"Texture"}]);
 for(const kind of ["create","edit","upscale"]) {
   const values=workflowReferenceValues(owner,{id:"a",kind,snapshot});
   applyWorkflowReferences(snapshot,values);
   assert.equal(JSON.parse(snapshot.output["sub:7"].inputs.image_ref).filename,"a.png");
   assert.equal(snapshot.output["sub:8"].inputs.image_ref,"");
 }
 assert.equal(workflowReferenceValues(owner,{id:"b",snapshot})["sub:7"].filename,"b.png");
 assert.equal(snapshot.output.unused.inputs.image_ref,"unused");
});
test("Qwen is explicit, requires the source and prompt wiring, and never absorbs custom inputs",()=>{
 const p=profile(); assert.equal(qwenReferenceAdapter(p).limit,9);
 for(const class_type of ["TextEncodeQwenImageEditPlus","CLIPTextEncode"]) {const other=profile();other.snapshot.output.encoder.class_type=class_type;assert.equal(qwenReferenceAdapter(other),null);}
 const wrong=profile();wrong.snapshot.output.encoder.inputs["images.image_1"]=["sub:7",0];assert.equal(qwenReferenceAdapter(wrong),null);
 const fixed=profile();fixed.snapshot.output.encoder.inputs["images.image_2"]=["sub:7",0];assert.equal(qwenReferenceAdapter(fixed),null);
 const refs=Array.from({length:9},(_,i)=>reference("ref"+i+".png"));
 const snapshot=structuredClone(p.snapshot);applyWorkflowReferences(snapshot,{"sub:7":image("guide.png")});applyQwenReferences(snapshot,p,refs);
 assert.equal(Object.keys(snapshot.output.encoder.inputs).filter(k=>k.startsWith("images.image_")).length,10);
 assert.deepEqual(snapshot.output.encoder.inputs["images.image_1"],["base",0]);
 refs.forEach((ref,i)=>assert.deepEqual(JSON.parse(snapshot.output[snapshot.output.encoder.inputs["images.image_"+(i+2)][0]].inputs.image_ref),ref.image));
 assert.equal(JSON.parse(snapshot.output["sub:7"].inputs.image_ref).filename,"guide.png");
 assert.equal(p.snapshot.output.encoder.inputs["images.image_2"],undefined);
 assert.throws(()=>validateQwenReferences([...refs,reference("tenth.png")]),/nine/);
 assert.throws(()=>validateQwenReferences([reference("blank.png","custom")]),/Describe/);
});
test("references and roles survive saved generation normalization and invalidate stale preparation",()=>{
 const saved=normalizePendingGeneration({workflowReferenceInputs:{"sub:7":image("guide.png")},qwenReferences:[reference("jacket.png")],qwenInstruction:"Use this jacket",editPromptModel:"qwen_image_2_1"});
 assert.equal(saved.qwenInstruction,"Use this jacket");assert.equal(saved.editPromptModel,"qwen_image_2_1");
 const other=normalizeReferenceState(saved);assert.ok(referenceInputsMatch(saved,other));
 other.qwenReferences[0].instruction="Use only the sleeves";
 assert.equal(referenceInputsMatch(saved,other),false);
 assert.equal(saved.qwenReferences[0].instruction,"");
});

