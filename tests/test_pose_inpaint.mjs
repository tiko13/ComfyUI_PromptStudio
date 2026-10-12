import assert from 'node:assert/strict';
import {test} from 'node:test';
import {poseInpaintAdapter} from '../web/js/prompt-studio/generation/workflow-capabilities.js';
import {applyStructureGuide, normalizeGuide} from '../web/js/prompt-studio/generation/structure-guide.js';
import {applyReferenceMask, normalizeEditMask, validateTargetSource} from '../web/js/prompt-studio/generation/reference-targeting.js';

export const profile = () => ({kind:'edit',imageNodeId:'source',promptNodeId:'prompt',resultNodeIds:['save'],snapshot:{output:{
 source:{class_type:'KCPP_ChatImageInput',inputs:{}},
 guide:{class_type:'PS_StructureInput',inputs:{source:['source',0],width:512,height:512,preserve_background:true}},
 control:{class_type:'PS_ApplyQwenStructure',inputs:{guide:['guide',0],strength:['guide',1],inpaint_image:['guide',2],inpaint_mask:['guide',3],control_model:'custom'}},
 render:{class_type:'SamplerAndDecode',inputs:{model:['control',0]}},
 mask:{class_type:'PS_EditMask',inputs:{generated:['render',0],source:['source',0],inpaint_mask:['guide',3]}},
 save:{class_type:'SaveImage',inputs:{images:['mask',0]}}
}}});
const source={filename:'source.png',type:'input',subfolder:''};
const mask={image:{...source,filename:'mask.png'},sourceImage:source,sourceDigest:'a'.repeat(64),region:{x:0,y:0,width:1,height:1},enabled:true,mode:'painted'};
const entry=()=>({use:'structure',image:{...source,filename:'pose.png'},guide:{type:'pose',input:'prepared',strength:.8},editMask:structuredClone(mask)});

test('native wiring is required and create/partial graphs do not advertise preservation',()=>{
 const p=profile();assert.equal(poseInpaintAdapter(p).preserveBackground,true);
 assert.equal(poseInpaintAdapter({...p,kind:'create'}),null);
 delete p.snapshot.output.control.inputs.inpaint_mask;assert.equal(poseInpaintAdapter(p),null);
});
test('reviewed mask survives normalization and can differ from guide placement',()=>{
 assert.equal(normalizeEditMask(mask).mode,'painted');assert.equal(normalizeGuide({type:'pose',preserve_background:false}).preserve_background,false);
 validateTargetSource([entry()],source);
 assert.throws(()=>validateTargetSource([entry()],{...source,filename:'another.png'}),/no longer matches/);
 const off=entry();off.guide.preserve_background=false;
 validateTargetSource([off],{...source,filename:'another.png'});
});
test('on requires review; off keeps saved mask but bypasses generic composite injection',async()=>{
 const p=profile(),e=entry(), fetchApi=()=>{throw Error('Prepared custom guide needs no network');};
 const unreviewed={...e,editMask:null};
 await assert.rejects(()=>applyStructureGuide(p.snapshot,p,[unreviewed],fetchApi),/reviewed mask/);
 await applyStructureGuide(p.snapshot,p,[e],fetchApi);
 assert.equal(JSON.parse(p.snapshot.output.guide.inputs.reference_json).editMask.mode,'painted');
 applyReferenceMask(p.snapshot,p,[e],source);assert.equal(p.snapshot.output.mask.inputs.mask_json,'');
 e.guide.preserve_background=false;
 await applyStructureGuide(p.snapshot,p,[e],fetchApi);applyReferenceMask(p.snapshot,p,[e],source);
 assert.equal(JSON.parse(p.snapshot.output.guide.inputs.reference_json).guide.preserve_background,false);
 assert.equal(p.snapshot.output.mask.inputs.mask_json,'');assert.ok(e.editMask.enabled);
});
test('switching workflows or reference use retains the painted mask without applying it elsewhere',()=>{
 const p=profile(),e=entry();delete p.snapshot.output.control.inputs.inpaint_mask;
 validateTargetSource([e],{...source,filename:'different.png'},p);
 applyReferenceMask(p.snapshot,p,[e],source);assert.equal(p.snapshot.output.mask.inputs.mask_json,'');
 e.use='reference';validateTargetSource([e],{...source,filename:'different.png'},profile());
 assert.equal(e.editMask.mode,'painted');
});
