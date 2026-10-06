import assert from "node:assert/strict";
import {startFixture} from "./fixture.mjs";
const fixture=await startFixture();
try {
 await fixture.context.route("**/js/prompt_studio.js",async r=>{const response=await r.fetch();await r.fulfill({response,body:await response.text()+"\nexport {updateComposeMode,refreshWorkflowControls,captureGenerationQueueSettings,queueGeneration,restoreChatState};"});});
 await fixture.context.route("**/scripts/api.js",async r=>{const response=await r.fetch();await r.fulfill({response,body:await response.text()+'\napi.queuePrompt=async(_,s)=>{window.controlnetQueued=structuredClone(s);return {prompt_id:"structure-queue"};};'});});
 await fixture.context.route("**/promptstudio/controlnet/status",r=>r.fulfill({json:{ready:true,model:"control.safetensors",methods:{edges:{ready:true}}}}));
 const page=await fixture.newPage();
 await page.evaluate(async()=>{
  const m=await import("/extensions/ComfyUI_PromptStudio/js/prompt_studio.js");
  const {state}=await import("/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js");
  const chat=state.chats.find(c=>c.id===state.activeChatId);window.guideQueueTest={m,state,chat};
  Object.assign(chat,{initialized:true,mainPrompt:"A red teapot",finalPrompt:"A red teapot",currentPrompt:"A red teapot",
   qwenEditReferences:[{id:"guide",image:{filename:"guide.png",type:"input",subfolder:""},use:"structure",guide:{type:"edges",input:"prepared",strength:.65,fit:"crop"}}]});
  const output={p:{class_type:"KCPP_PromptSlot",inputs:{prompt:""}},e:{class_type:"TextEncodeQwenImage21",inputs:{prompt:["p",0]}},
   latent:{class_type:"EmptyLatentImage",inputs:{width:768,height:1024,batch_size:1}},
   s:{class_type:"KCPP_QwenImage21TurboSampler",inputs:{model:["model",0],positive:["e",0],seed:123,latent_image:["latent",0]}},
   d:{class_type:"VAEDecode",inputs:{samples:["s",0],vae:["vae",0]}},save:{class_type:"SaveImage",inputs:{images:["d",0]}}};
  state.workflowProfiles=[{id:"guide-create",path:"guide-create",name:"[PS] Qwen Create",kind:"create",promptNodeId:"p",resultNodeIds:["save"],loraNodes:[],modelNodes:[],snapshot:{workflow:{nodes:[],links:[]},output}}];
  state.workflowBusy=true;state.apiConnected=true;m.refreshWorkflowControls();m.restoreChatState(chat);
  document.querySelector('input[name="promptstudio-generation-action"][value="create"]').checked=true;
  document.querySelector("#promptstudio-create-workflow").value="guide-create";m.updateComposeMode();
 });
 assert.ok(await page.locator("#promptstudio-edit-reference").isVisible(),"Create exposes References for ControlNet");
 const capture=await page.evaluate(()=>guideQueueTest.m.captureGenerationQueueSettings("create"));
 assert.equal(capture.qwenReferences[0].guide.strength,.65);
 await page.evaluate(()=>guideQueueTest.m.queueGeneration({...guideQueueTest.m.captureGenerationQueueSettings("create"),action:"create",executionPrompt:"A red teapot",independent:true}));
 const output=await page.evaluate(()=>window.controlnetQueued.output);
 assert.equal(output.ps_structure_apply.inputs.strength,.65);
 assert.equal(output.ps_structure_guide.inputs.fit,"crop");
 assert.equal(output.e.inputs["images.image_1"],undefined,"A structural guide must not become a semantic edit reference");
 await page.locator("#promptstudio-edit-reference").getByRole("button",{name:"References",exact:true}).click();
 const dialog=page.getByRole("dialog",{name:"References",exact:true});
 assert.match(await dialog.textContent(),/1\/10/);
 await dialog.getByLabel("Use for reference 1",{exact:true}).selectOption("both");
 await dialog.getByLabel("Role for reference 1",{exact:true}).selectOption("object");
 await page.keyboard.press("Escape");
 await page.evaluate(()=>guideQueueTest.m.queueGeneration({...guideQueueTest.m.captureGenerationQueueSettings("create"),action:"create",executionPrompt:"A red teapot",finalPrompt:"A red teapot",independent:true}));
 const combined=await page.evaluate(()=>{
  window.replayCombined=structuredClone(guideQueueTest.state.generationJobs.get("structure-queue").retryOptions);
  return window.controlnetQueued;
 });
 assert.equal(combined.output.ps_structure_apply.inputs.strength,.65);
 assert.deepEqual(combined.output.e.inputs.vae,["vae",0]);
 assert.deepEqual(combined.output.s.inputs.latent_image,["latent",0]);
 assert.match(combined.output.p.inputs.prompt,/object from <image1>/);
 assert.equal(combined.output.e.inputs["images.image_2"],undefined);
 await page.evaluate(async()=>{
  const {m,chat}=guideQueueTest;chat.qwenEditReferences[0].use="reference";
  await m.queueGeneration({...m.captureGenerationQueueSettings("create"),action:"create",executionPrompt:window.controlnetQueued.output.p.inputs.prompt,finalPrompt:"A red teapot",independent:true});
 });
 const repeated=await page.evaluate(()=>window.controlnetQueued.output);
 assert.equal(repeated.ps_structure_apply,undefined,"Ordinary references work without ControlNet");
 assert.equal(repeated.p.inputs.prompt.split("new composition").length-1,1,"Repeat must not duplicate reference instructions");
 await page.evaluate(async()=>{
  const {m,chat}=guideQueueTest;chat.qwenEditReferences=[];
  await m.queueGeneration({...m.captureGenerationQueueSettings("create"),action:"create",executionPrompt:window.controlnetQueued.output.p.inputs.prompt,finalPrompt:"A red teapot",independent:true});
 });
 const cleared=await page.evaluate(()=>window.controlnetQueued.output);
 assert.equal(cleared.p.inputs.prompt,"A red teapot");
 assert.equal(cleared.e.inputs["images.image_1"],undefined);
 const replay=page.evaluate(()=>guideQueueTest.m.queueGeneration({...window.replayCombined,preserveSeed:true,randomizeSeed:false,independent:true}));
 await page.getByRole('button',{name:'Replay saved inputs',exact:true}).click({timeout:5000});
 await replay;
 assert.deepEqual(await page.evaluate(()=>window.controlnetQueued.output),combined.output,"Saved replay retains exact references and guide after current references were removed");
 assert.equal(await page.evaluate(()=>guideQueueTest.chat.lastGeneration.canonicalPrompt),"A red teapot","Reference instructions stay out of Final Prompt");
 assert.deepEqual(fixture.errors,[]);
 console.log("Qwen Create: menu, ordinary and combined reference queueing, independent canvas, repeat and removal passed.");
}finally{await fixture.close();}
