import assert from "node:assert/strict";
import {test} from "node:test";
import {editReferenceNodeIds, supportsEditReference, applyEditReference} from "../web/js/prompt-studio/generation/edit-reference.js";
import {normalizeWorkflowProfile} from "../web/js/prompt-studio/generation/workflow-profile.js";
import {normalizePendingGeneration} from "../web/js/prompt-studio/chat/generation-state.js";
const reference={filename:"jacket.png",subfolder:"imports",type:"promptstudio"};
function graph(){return {workflow:{nodes:[]},output:{
  "30:7":{class_type:"KCPP_ChatImageReference",inputs:{image_ref:"old saved reference"}},
  "30:8":{class_type:"Krea2EditModelPatch",inputs:{source_image_b:["30:7",0]}},
  "30:9":{class_type:"Krea2EditGroundedEncode",inputs:{image_b:["30:7",0]}},
  "unused":{class_type:"KCPP_ChatImageReference",inputs:{image_ref:""}},
}};}
test("reference discovery follows connected flattened nodes and edit role",()=>{
 const snapshot=graph();
 assert.deepEqual(editReferenceNodeIds(snapshot),["30:7"]);
 const profile=normalizeWorkflowProfile({kind:"edit",snapshot});
 assert.deepEqual(profile.referenceNodeIds,["30:7"]);
 assert.equal(supportsEditReference(profile),true);
 assert.equal(supportsEditReference({...profile,kind:"create"}),false);
});
test("empty optional reference clears stale defaults without changing base image",()=>{
 const snapshot=graph();snapshot.output.base={class_type:"KCPP_ChatImageInput",inputs:{image_ref:"base.png"}};
 applyEditReference(snapshot,reference);
 assert.deepEqual(JSON.parse(snapshot.output["30:7"].inputs.image_ref),reference);
 applyEditReference(snapshot,null);
 assert.equal(snapshot.output["30:7"].inputs.image_ref,"");
 assert.equal(snapshot.output.base.inputs.image_ref,"base.png");
 assert.throws(()=>applyEditReference({output:{}},reference),/no longer supports/);
});
test("queued references survive normalization and do not mutate saved replay",()=>{
 const snapshot=graph();applyEditReference(snapshot,reference);
 const saved=normalizePendingGeneration({action:"edit",referenceImage:reference,generationSnapshot:snapshot});
 applyEditReference(snapshot,null);
 assert.deepEqual(saved.referenceImage,reference);
 assert.deepEqual(JSON.parse(saved.generationSnapshot.output["30:7"].inputs.image_ref),reference);
});
