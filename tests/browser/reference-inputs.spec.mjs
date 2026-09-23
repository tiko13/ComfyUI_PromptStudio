import assert from "node:assert/strict";
import {mkdir} from "node:fs/promises";
import {resolve} from "node:path";
import {startFixture,root} from "./fixture.mjs";
const fixture=await startFixture();
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=","base64");
try {
 await fixture.context.route("**/js/prompt_studio.js",async route=>{const response=await route.fetch();await route.fulfill({response,body:await response.text()+"\nexport {updateComposeMode,refreshWorkflowControls,captureGenerationQueueSettings,queueGeneration,restoreChatState,reviseAndMaybeGenerate,createNewFromCurrentPrompt,queueBackgroundReroll,armStoredGenerationReplay,requestImageUpscale};"});});
 await fixture.context.route("**/scripts/api.js",async route=>{const response=await route.fetch();await route.fulfill({response,body:await response.text()+'\napi.queuePrompt=async(_,snapshot)=>{window.queuedSnapshots||=[];window.queuedSnapshots.push(structuredClone(snapshot));return {prompt_id:"input-test-"+window.queuedSnapshots.length};};'});});
 let uploads=0, requests=[];
 await fixture.context.route("**/promptstudio/prompt-studio/import-image",route=>route.fulfill({json:{image:{filename:"upload-"+(++uploads)+".png",subfolder:"imports",type:"promptstudio",width:64,height:64}}}));
 await fixture.context.route("**/promptstudio/prompt-studio/image?*",route=>route.fulfill({contentType:"image/png",body:png}));
 await fixture.context.route("**/promptstudio/prompt-studio/vision-capability",r=>r.fulfill({json:{available:true}}));
 await fixture.context.route("**/promptstudio/prompt-studio/qwen-edit-prompt",r=>{
   const payload=r.request().postDataJSON();requests.push(payload);
   return r.fulfill({json:{prompt:"Edit <image1> using the jacket from <image2> and the pose from <image3>. Preserve everything else."}});
 });
 const page=await fixture.newPage();
 async function activate(){await page.evaluate(async()=>{
  const m=await import("/extensions/ComfyUI_PromptStudio/js/prompt_studio.js");
  const {state}=await import("/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js");window.test={m,state};
  const chat=state.chats.find(c=>c.id===state.activeChatId);
  Object.assign(chat,{initialized:true,selectedSource:{filename:"base.png",type:"output",subfolder:"",width:64,height:64},
    mainPrompt:"Original scene.",finalPrompt:"Original scene, daylight.",currentPrompt:"Original scene, daylight."});
  const output={p:{class_type:"KCPP_PromptSlot",inputs:{prompt:""}},
    a:{class_type:"KCPP_ChatImageReference",inputs:{image_ref:"",source_name:"Texture"},_meta:{title:"Jacket guide"}},
    b:{class_type:"KCPP_ChatImageReference",inputs:{image_ref:"",source_name:"Upscale detail"}},
    sink:{class_type:"CustomNode",inputs:{image:["a",0],detail:["b",0]}},save:{class_type:"SaveImage",inputs:{images:["sink",0]}}};
  const multi={id:"multi",path:"multi",name:"[PS] Custom",kind:"create",promptNodeId:"p",resultNodeIds:["save"],loraNodes:[],modelNodes:[],snapshot:{workflow:{nodes:[],links:[]},output}};
  const single=structuredClone(multi);single.id="single";single.path="single";delete single.snapshot.output.b;delete single.snapshot.output.sink.inputs.detail;
  const qwen=structuredClone(multi);qwen.id="qwen";qwen.path="qwen";qwen.kind="edit";qwen.imageNodeId="base";
  qwen.snapshot.output.base={class_type:"KCPP_ChatImageInput",inputs:{image_ref:""}};
  qwen.snapshot.output.encoder={class_type:"TextEncodeQwenImage21",inputs:{prompt:["p",0],"images.image_1":["base",0]}};
  qwen.snapshot.output.sink.inputs.conditioning=["encoder",0];
  const upscale=structuredClone(qwen);upscale.id="upscale";upscale.path="upscale";upscale.kind="upscale";upscale.upscaleNodeId="base";upscale.snapshot.output.base.class_type="KCPP_PromptStudioUpscale";delete upscale.snapshot.output.encoder;delete upscale.snapshot.output.sink.inputs.conditioning;upscale.snapshot.output.sink.inputs.source=["base",0];
  state.workflowProfiles=[single,multi,qwen,upscale];state.workflowBusy=true;state.apiConnected=true;
  m.refreshWorkflowControls();m.restoreChatState(chat);
  document.querySelector("#promptstudio-use-llm-amplification").checked=true;
  document.querySelector("#promptstudio-auto-generate").checked=false;
  document.querySelector('input[name="promptstudio-generation-action"][value="create"]').checked=true;
  document.querySelector("#promptstudio-create-workflow").value="single";m.updateComposeMode();
 });}
 const chat=()=>page.evaluate(()=>window.test.state.chats.find(c=>c.id===window.test.state.activeChatId));
 async function select(id,action){await page.evaluate(({id,action})=>{document.querySelector('input[name="promptstudio-generation-action"][value="'+action+'"]').checked=true;document.querySelector("#promptstudio-"+action+"-workflow").value=id;window.test.m.updateComposeMode();},{id,action});}
 async function upload(button,n=1){const chooser=page.waitForEvent("filechooser");await button.click();await (await chooser).setFiles(Array.from({length:n},(_,i)=>({name:"reference"+i+".png",mimeType:"image/png",buffer:png})));await page.waitForFunction(()=>document.querySelector("#promptstudio-edit-reference").getAttribute("aria-busy")==="false");}
 await activate();
 const tile=page.locator("#promptstudio-edit-reference");
 assert.ok(await tile.isVisible());
 await tile.locator("input").setInputFiles({name:"single.png",mimeType:"image/png",buffer:png});
 await page.waitForFunction(()=>document.querySelector("#promptstudio-edit-reference").dataset.filled==="true");
 await page.evaluate(()=>window.test.m.queueGeneration({...window.test.m.captureGenerationQueueSettings("create"),action:"create",executionPrompt:"A scene",independent:true}));
 assert.equal(await page.evaluate(()=>JSON.parse(window.queuedSnapshots[0].output.a.inputs.image_ref).filename),"upload-1.png");
 await select("multi","create");await tile.getByRole("button",{name:"References",exact:true}).click();
 const dialog=page.getByRole("dialog",{name:"References",exact:true});
 assert.equal(await dialog.locator(".ps-reference-row").count(),2);
 await upload(dialog.getByRole("button",{name:"Choose image for Jacket guide"}));
 await upload(dialog.getByRole("button",{name:"Choose image for Upscale detail"}));
 await dialog.getByRole("button",{name:"Done"}).click();
 await page.evaluate(()=>window.test.m.queueGeneration({...window.test.m.captureGenerationQueueSettings("create"),action:"create",executionPrompt:"A scene",independent:true}));
 assert.deepEqual(await page.evaluate(()=>["a","b"].map(id=>JSON.parse(window.queuedSnapshots[1].output[id].inputs.image_ref).filename)),["upload-2.png","upload-3.png"]);
 await select("qwen","edit");await tile.getByRole("button",{name:"References",exact:true}).click();
 assert.equal(await dialog.locator(".ps-reference-row").count(),2,"Workflow slots are separate from Qwen edit references");
 await upload(dialog.getByRole("button",{name:"Add reference images"}),2);
 await dialog.getByRole("combobox",{name:"Role for reference 1"}).selectOption("clothing");
 await dialog.getByRole("textbox",{name:"Instruction for reference 1"}).fill("Use only the jacket");
 await dialog.getByRole("combobox",{name:"Role for reference 2"}).selectOption("pose");
 await upload(dialog.getByRole("button",{name:"Choose image for Upscale detail"}));
 for(const width of [1440,390]){
   await page.setViewportSize({width,height:900});
   assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth));
   assert.ok(await dialog.evaluate(el=>el.getBoundingClientRect().right<=innerWidth));
   await mkdir(resolve(root,"test-results/browser"),{recursive:true});
   await dialog.screenshot({path:resolve(root,"test-results/browser/references-"+width+".png")});
 }
 await dialog.getByRole("button",{name:"Done"}).click();
 // Selected roles fully specify an edit; both text fields may be empty.
 await page.evaluate(()=>{
   const {state,m}=window.test,chat=state.chats.find(c=>c.id===state.activeChatId);
   chat.qwenEditReferences[0].instruction="";
   document.querySelector("#promptstudio-revision").value="";m.updateComposeMode();
 });
 assert.match(await page.locator("#promptstudio-revision").getAttribute("placeholder"),/Optional/);
 await page.locator("#promptstudio-send").click();
 await page.waitForFunction(()=>window.test.state.chats.find(c=>c.id===window.test.state.activeChatId).pendingGeneration?.editPromptModel==="qwen_image_2_1");
 assert.equal(requests.length,1);assert.equal(requests[0].user_text,"");
 assert.equal(requests[0].references[0].role,"clothing");assert.equal(requests[0].references[0].instruction,"");
 assert.equal((await chat()).mainPrompt,"Original scene.");assert.equal((await chat()).finalPrompt,"Original scene, daylight.");
 await page.evaluate(()=>{
   const {state,m}=window.test,chat=state.chats.find(c=>c.id===state.activeChatId);
   chat.pendingGeneration=null;
   document.querySelector("#promptstudio-use-llm-amplification").checked=false;m.updateComposeMode();
 });
 assert.equal(await page.locator("#promptstudio-revision").inputValue(),"","Direct Qwen edit must not inject the scene prompt");
 await page.locator("#promptstudio-send").click();
 await page.waitForFunction(()=>window.queuedSnapshots.at(-1)?.output.encoder);
 assert.equal(requests.length,1,"Direct role-only edit does not call the LLM");
 const directPrompt=await page.evaluate(()=>window.queuedSnapshots.at(-1).output.p.inputs.prompt);
 assert.match(directPrompt,/clothing from <image2>/);assert.doesNotMatch(directPrompt,/Original scene/);
 assert.equal((await chat()).mainPrompt,"Original scene.");assert.equal((await chat()).finalPrompt,"Original scene, daylight.");
 await page.evaluate(()=>{
   const {state,m}=window.test,chat=state.chats.find(c=>c.id===state.activeChatId);
   chat.pendingGeneration=null;chat.qwenEditReferences[0].instruction="Use only the jacket";
   document.querySelector("#promptstudio-use-llm-amplification").checked=true;m.updateComposeMode();
 });
 requests=[];
 await page.locator("#promptstudio-revision").fill("Replace the jacket and match the pose");
 await page.evaluate(()=>window.test.m.reviseAndMaybeGenerate());
 assert.equal(requests.length,1);assert.equal(requests[0].references.length,2);
 assert.equal(requests[0].references[0].image.filename,"upload-4.png");
 assert.equal(requests[0].references[1].image.filename,"upload-5.png");
 assert.equal(requests[0].source_image.filename,"base.png");
 assert.equal((await chat()).mainPrompt,"Original scene.");assert.equal((await chat()).finalPrompt,"Original scene, daylight.");
 assert.equal((await chat()).pendingGeneration.editPromptModel,"qwen_image_2_1");
 await page.evaluate(()=>window.test.m.createNewFromCurrentPrompt({generationAction:"edit"}));
 assert.equal(requests.length,1,"Prepared instruction is reused");
 const snapshot=await page.evaluate(()=>window.queuedSnapshots.at(-1));
 assert.equal(JSON.parse(snapshot.output[snapshot.output.encoder.inputs["images.image_2"][0]].inputs.image_ref).filename,"upload-4.png");
 assert.equal(JSON.parse(snapshot.output[snapshot.output.encoder.inputs["images.image_3"][0]].inputs.image_ref).filename,"upload-5.png");
 assert.equal(JSON.parse(snapshot.output.b.inputs.image_ref).filename,"upload-6.png");
 assert.equal(snapshot.output.a.inputs.image_ref,"","Custom workflow slots do not consume Qwen references");
 await page.waitForFunction(()=>{const {state}=window.test;return !state.chatSaveTimer&&!state.chatSaveInFlight;});
 await page.reload();await page.waitForFunction(()=>window.studioReady);await activate();await select("qwen","edit");
 assert.equal((await chat()).qwenEditReferences.length,2);assert.equal((await chat()).qwenEditReferences[0].instruction,"Use only the jacket");
 assert.equal((await chat()).workflowReferences.qwen.b.filename,"upload-6.png");
 await tile.getByRole("button",{name:"References",exact:true}).click();
 async function transfer(locator,kind) {
   await locator.evaluate((element,{kind,b64})=>{
     const data=new DataTransfer();data.items.add(new File([Uint8Array.from(atob(b64),c=>c.charCodeAt(0))],"pasted.png",{type:"image/png"}));
     element.focus();element.dispatchEvent(kind==="paste" ? new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:data}) : new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:data}));
   },{kind,b64:png.toString("base64")});
   await page.waitForFunction(()=>document.querySelector("#promptstudio-edit-reference").getAttribute("aria-busy")==="false");
 }
 await transfer(dialog.getByRole("button",{name:"Replace reference 1",exact:true}),"paste");
 assert.equal((await chat()).qwenEditReferences.length,2);
 assert.equal((await chat()).qwenEditReferences[0].image.filename,"upload-7.png");
 assert.equal((await chat()).qwenEditReferences[0].instruction,"Use only the jacket");
 await transfer(dialog.getByRole("button",{name:"Replace reference 2",exact:true}),"drop");
 assert.equal((await chat()).qwenEditReferences[1].image.filename,"upload-8.png");
 assert.equal((await chat()).qwenEditReferences[1].role,"pose");
 await transfer(dialog.getByRole("button",{name:"Add reference images"}),"paste");
 assert.equal((await chat()).qwenEditReferences.length,3);
 await transfer(dialog.getByRole("button",{name:"Choose image for Jacket guide"}),"drop");
 assert.equal((await chat()).workflowReferences.qwen.a.filename,"upload-10.png");
 assert.equal((await chat()).qwenEditReferences.length,3,"Workflow drop must not append a Qwen reference");
 await upload(dialog.getByRole("button",{name:"Add reference images"}),6);
 assert.equal(await dialog.getByRole("button",{name:"Add reference images"}).isDisabled(),true);
 await dialog.getByRole("button",{name:"Remove reference 1",exact:true}).click();
 assert.equal((await chat()).qwenEditReferences.length,8);
 assert.equal(await dialog.getByRole("combobox",{name:"Role for reference 1"}).inputValue(),"pose","Roles remain bound to images after removal");
 await dialog.getByRole("textbox",{name:"Instruction for reference 1"}).focus();
 await page.keyboard.press("Tab");
 assert.ok(await dialog.evaluate(el=>el.contains(document.activeElement)),"Keyboard focus remains inside References");
 await page.keyboard.press("Escape");assert.equal(await dialog.count(),0);
 await page.evaluate(()=>{document.querySelector("#promptstudio-upscale-workflow").value="upscale";window.test.m.requestImageUpscale({filename:"upscale-base.png",type:"output",subfolder:""});});
 const upscaleDialog=page.locator("#promptstudio-upscale-dialog");
 await upscaleDialog.getByRole("button",{name:"References",exact:true}).click();
 assert.equal(await dialog.locator(".ps-reference-row").count(),2);
 await upload(dialog.getByRole("button",{name:"Choose image for Jacket guide"}));
 await page.waitForFunction(()=>document.querySelector(".promptstudio-upscale-reference").getAttribute("aria-busy")==="false");
 await transfer(dialog.getByRole("button",{name:"Choose image for Upscale detail"}),"paste");
 await page.waitForFunction(()=>document.querySelector(".promptstudio-upscale-reference").getAttribute("aria-busy")==="false");
 await dialog.getByRole("button",{name:"Done"}).click();
 const countBefore=await page.evaluate(()=>window.queuedSnapshots?.length || 0);
 await upscaleDialog.locator('button[type="submit"]').click();
 await page.waitForFunction(n=>(window.queuedSnapshots?.length || 0)>n,countBefore);
 const upscaled=await page.evaluate(()=>window.queuedSnapshots.at(-1));
 assert.equal(JSON.parse(upscaled.output.a.inputs.image_ref).filename,"upload-17.png");
 assert.equal(JSON.parse(upscaled.output.b.inputs.image_ref).filename,"upload-18.png");
 assert.equal(JSON.parse(upscaled.output.base.inputs.image_ref).filename,"upscale-base.png");
 assert.deepEqual(fixture.errors,[]);
 console.log("Universal and Qwen references: independent mapping, preparation, persistence, limits, and desktop/mobile popup passed.");
}finally{await fixture.close();}
