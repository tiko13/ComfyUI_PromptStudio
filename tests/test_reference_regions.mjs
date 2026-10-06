import assert from "node:assert/strict";
import {test} from "node:test";
import {applyReferenceMask,validateTargetSource} from "../web/js/prompt-studio/generation/reference-targeting.js";
import {normalizeQwenReferences} from "../web/js/prompt-studio/generation/qwen-references.js";
import {normalizeGuide} from "../web/js/prompt-studio/generation/structure-guide.js";
const source={filename:"source.png",type:"input",subfolder:""},region={x:.1,y:.1,width:.3,height:.5};
const entry={image:{filename:"donor.png",type:"input"},role:"clothing",targeting:{target:region,targetImage:source},editMask:{image:{filename:"mask.png",type:"promptstudio"},sourceImage:source,sourceDigest:"a".repeat(64),region,enabled:true}};
function profile(){return {kind:"edit",imageNodeId:"base",resultNodeIds:["save"],snapshot:{output:{base:{class_type:"KCPP_ChatImageInput",inputs:{}},d:{class_type:"VAEDecode",inputs:{}},save:{class_type:"SaveImage",inputs:{images:["d",0]}}}}};}
test("mask persists and attaches only to compatible output without modifying diffusion",()=>{
  const refs=normalizeQwenReferences([entry]),p=profile();
  assert.equal(refs[0].editMask.sourceDigest,"a".repeat(64));
  applyReferenceMask(p.snapshot,p,refs,source);
  assert.deepEqual(p.snapshot.output.save.inputs.images,["ps_reference_composite",0]);
  assert.deepEqual(p.snapshot.output.ps_reference_composite.inputs.source,["base",0]);
  assert.throws(()=>applyReferenceMask(profile().snapshot,profile(),[entry,entry],source),/one active/);
  assert.throws(()=>applyReferenceMask(profile().snapshot,{...profile(),kind:"create"},[entry],source),/does not support/);
  const webp=profile();webp.snapshot.output.save.class_type="Save_as_webp_cond";webp.snapshot.output.save.inputs.mode="lossy";
  applyReferenceMask(webp.snapshot,webp,[entry],source);assert.equal(webp.snapshot.output.save.inputs.mode,"lossless");
  const jpeg=profile();jpeg.snapshot.output.save.class_type="UnverifiedJpegSaver";
  assert.throws(()=>applyReferenceMask(jpeg.snapshot,jpeg,[entry],source),/does not support/);
});
test("stale source or changed target region cannot reuse mask",()=>{
  assert.throws(()=>validateTargetSource([entry],{...source,filename:"changed.png"}),/source image changed|mask no longer/);
  assert.throws(()=>validateTargetSource([{...entry,targeting:{target:{...region,width:.4},targetImage:source}}],source),/mask no longer/);
});
test("whole-guide scope survives normalization without changing legacy defaults",()=>{
  for(const type of ["pose","depth","edges","sketch"])assert.equal(normalizeGuide({type,scope:"whole"}).scope,"whole");
  assert.equal(normalizeGuide({type:"pose"}).scope,undefined);
});
