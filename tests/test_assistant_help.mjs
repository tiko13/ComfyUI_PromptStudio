import assert from "node:assert/strict";
import {test} from "node:test";
import {workflowHelpFacts, helpControlLabels} from "../web/js/prompt-studio/generation/help-context.js";
import {QWEN_REFERENCE_LIMIT} from "../web/js/prompt-studio/generation/qwen-references.js";

test("reference help follows executable capabilities, not workflow names", () => {
  const profile = {id:"a", name:"Renamed workflow", kind:"edit", imageNodeId:"base", promptNodeId:"p", snapshot:{output:{
    base:{class_type:"KCPP_ChatImageInput",inputs:{}}, p:{class_type:"KCPP_PromptSlot",inputs:{}},
    enc:{class_type:"TextEncodeQwenImage21",inputs:{"images.image_1":["base",0],prompt:["p",0]}}
  }}};
  assert.equal(workflowHelpFacts(profile).reference_mode,"qwen");
  assert.equal(workflowHelpFacts(profile).reference_limit,QWEN_REFERENCE_LIMIT);
  profile.snapshot.output.enc.inputs["images.image_2"]=["prewired",0];
  assert.equal(workflowHelpFacts(profile).reference_mode,"none");
  profile.name="Qwen ten image workflow";
  assert.equal(workflowHelpFacts(profile).reference_mode,"none");
  profile.snapshot.output.ref={class_type:"KCPP_ChatImageReference",inputs:{source_name:"Jacket guide"}};
  profile.snapshot.output.edit={class_type:"Krea2Edit",inputs:{source_image_b:["ref",0]}};
  assert.equal(workflowHelpFacts(profile).reference_mode,"single");
  profile.snapshot.output.edit.class_type="CustomInput";
  assert.equal(workflowHelpFacts(profile).reference_mode,"inputs");
  assert.equal(workflowHelpFacts(profile).reference_inputs,"Jacket guide");
  assert.equal(workflowHelpFacts(null).reference_mode,"unknown");
});

test("help labels use current controls",()=>{
  const panel={querySelector:selector=>({getAttribute:()=>selector.includes("choose")?"New reference label":null,textContent:"Current model label"})};
  assert.deepEqual(helpControlLabels(panel),{send_label:"Current model label",auto_generate_label:"Current model label",activity_label:"Current model label",diagnostics_label:"Current model label",reference_label:"New reference label",model_label:"Current model label"});
});
