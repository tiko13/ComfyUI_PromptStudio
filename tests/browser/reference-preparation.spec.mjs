import assert from "node:assert/strict";
import {startFixture, root} from "./fixture.mjs";
import {mkdir} from "node:fs/promises";
import {resolve} from "node:path";
const fixture = await startFixture();
try {
  const page = await fixture.newPage();
  await page.evaluate(async () => {
    const {createEditReferenceController} = await import("/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/edit-reference.js");
    const source = document.createElement("canvas"); source.width = 80; source.height = 60;
    const ctx = source.getContext("2d"); ctx.fillStyle = "red"; ctx.fillRect(0, 0, 40, 60); ctx.fillStyle = "lime"; ctx.fillRect(40, 0, 40, 60);
    const urls = {"original.png": source.toDataURL()}, original = {filename: "original.png", subfolder: "", type: "input"};
    const chat = {id: "prepare", qwenEditReferences: [{id: "ref", image: original, role: "clothing", instruction: "Use this jacket", targeting: {reference: {x: .1,y:.1,width:.5,height:.5},target:{x:0,y:0,width:.5,height:1},targetImage:original}}]};
    const profile = {id:"qwen",kind:"edit",imageNodeId:"i",promptNodeId:"p",snapshot:{output:{i:{class_type:"KCPP_ChatImageInput",inputs:{}},p:{class_type:"KCPP_ChatPrompt",inputs:{}},e:{class_type:"TextEncodeQwenImage21",inputs:{"images.image_1":["i",0],prompt:["p",0]}}}}};
    const panel = document.createElement("section"); panel.innerHTML = '<div id="prepare-tile"><input type="file" hidden><button class="promptstudio-edit-reference-choose"><img hidden><small></small></button><button class="promptstudio-edit-reference-remove">Remove</button></div>'; document.body.prepend(panel);
    window.preparation = {chat, profile, urls, original, calls:0, panel};
    window.preparation.controller = createEditReferenceController({panel,tile:panel.firstElementChild,activeChat:()=>chat,findChat:()=>chat,selectedProfile:()=>profile,sourceImage:()=>original,
      imageUrl:ref=>urls[ref.filename],changed:()=>{},refresh:()=>{},report:message=>{throw Error(message);},
      upload:async file=>{
        const state=window.preparation; state.calls++; const bitmap=await createImageBitmap(file); const c=document.createElement("canvas");c.width=bitmap.width;c.height=bitmap.height;c.getContext("2d").drawImage(bitmap,0,0);
        state.saved={width:c.width,height:c.height,pixels:[...c.getContext("2d").getImageData(0,0,c.width,c.height).data]};
        const name=`prepared-${state.calls}.png`;urls[name]=c.toDataURL();bitmap.close();return {filename:name,type:"input",subfolder:""};
      }}); window.preparation.controller.render();
  });
  await page.locator("#prepare-tile").getByRole("button",{name:"References",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"References",exact:true});
  await dialog.locator(".ps-reference-preparation summary").click();
  const editor=dialog.locator(".ps-reference-preparation"), canvas=editor.locator("canvas");
  await editor.getByRole("button",{name:"Hide brush",exact:true}).click();
  const circle=editor.locator(".ps-reference-brush-circle"), size=editor.getByRole("slider");
  let previewBounds=await canvas.boundingBox();
  await page.mouse.move(previewBounds.x+previewBounds.width*.3,previewBounds.y+previewBounds.height*.4);
  let outline=await circle.boundingBox();assert.ok(outline);
  assert.ok(Math.abs(outline.x+outline.width/2-(previewBounds.x+previewBounds.width*.3))<1);
  assert.ok(Math.abs(outline.y+outline.height/2-(previewBounds.y+previewBounds.height*.4))<1);
  assert.ok(Math.abs(outline.width-Math.min(previewBounds.width,previewBounds.height)*.1)<1);
  assert.ok(Math.abs(outline.height-outline.width)<1);
  await size.scrollIntoViewIfNeeded();const sliderBounds=await size.boundingBox();
  await page.mouse.move(sliderBounds.x+sliderBounds.width*.25,sliderBounds.y+sliderBounds.height/2);await page.mouse.down();
  const initialDiameter=(await circle.boundingBox()).width;
  await page.mouse.move(sliderBounds.x+sliderBounds.width*.8,sliderBounds.y+sliderBounds.height/2,{steps:8});
  outline=await circle.boundingBox();assert.ok(outline.width>initialDiameter*2,"Circle must resize during slider drag before release");
  assert.match(await editor.locator("output").textContent(),/px/);
  await page.mouse.up();
  await size.evaluate(el=>{el.value="10";el.dispatchEvent(new Event("input",{bubbles:true}));});
  await canvas.scrollIntoViewIfNeeded();previewBounds=await canvas.boundingBox();
  await page.mouse.move(previewBounds.x+previewBounds.width/2,previewBounds.y+previewBounds.height/2);
  await canvas.focus();await page.keyboard.press("Space");
  await editor.getByLabel("Crop left percent for Reference 1",{exact:true}).fill("25");
  await editor.getByLabel("Crop left percent for Reference 1",{exact:true}).press("Tab");
  await editor.getByLabel("Crop width percent for Reference 1",{exact:true}).fill("50");
  await editor.getByLabel("Crop width percent for Reference 1",{exact:true}).press("Tab");
  for(const width of [1440,390]) {await page.setViewportSize({width,height:900});assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth));}
  await mkdir(resolve(root,"test-results/browser"),{recursive:true});await dialog.screenshot({path:resolve(root,"test-results/browser/reference-preparation.png")});
  await editor.getByRole("button",{name:"Use prepared reference",exact:true}).click();
  await page.waitForFunction(()=>preparation.chat.qwenEditReferences[0].image.filename==="prepared-1.png");
  const result=await page.evaluate(async()=>{
    const {normalizeQwenReferences,applyQwenReferences}=await import("/extensions/ComfyUI_PromptStudio/js/prompt-studio/generation/qwen-references.js");
    const state=window.preparation, refs=normalizeQwenReferences(JSON.parse(JSON.stringify(state.chat.qwenEditReferences))), snapshot=structuredClone(state.profile.snapshot);
    applyQwenReferences(snapshot,state.profile,refs);return {saved:state.saved,entry:refs[0],snapshot};
  });
  assert.equal(result.saved.width,40);assert.equal(result.saved.height,60);
  const pixel=(x,y)=>result.saved.pixels.slice((y*40+x)*4,(y*40+x)*4+4);
  assert.deepEqual(pixel(20,30),[128,128,128,255]);assert.deepEqual(pixel(0,0),[255,0,0,255]);assert.deepEqual(pixel(39,0),[0,255,0,255]);
  assert.equal(result.entry.targeting.reference,null);assert.ok(result.entry.targeting.target);
  assert.equal(JSON.parse(result.snapshot.output.ps_qwen_reference_2.inputs.image_ref).filename,"prepared-1.png");
  // Pointer crop, undo, keep-only brush and closing without apply.
  await dialog.locator(".ps-reference-preparation summary").click();
  await editor.getByRole("button",{name:"Crop rectangle",exact:true}).click();
  const bounds=await canvas.boundingBox();await page.mouse.move(bounds.x+bounds.width*.1,bounds.y+bounds.height*.1);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*.8,bounds.y+bounds.height*.8);await page.mouse.up();
  assert.equal(await editor.getByLabel("Crop width percent for Reference 1",{exact:true}).inputValue(),"70");
  await editor.getByRole("button",{name:"Undo",exact:true}).click();
  assert.equal(await editor.getByLabel("Crop width percent for Reference 1",{exact:true}).inputValue(),"100");
  await editor.getByRole("button",{name:"Hide all",exact:true}).click();await canvas.focus();await page.keyboard.press("ArrowRight");await page.keyboard.press("Space");
  await page.keyboard.press("Escape");assert.equal(await page.evaluate(()=>preparation.calls),1);
  // A single generic input retains its upload tile and gets a separate editor button.
  await page.evaluate(()=>{
    const s=preparation;s.chat.qwenEditReferences=[];Object.assign(s.profile,{id:"generic",kind:"create",promptNodeId:null,imageNodeId:null,snapshot:{output:{ref:{class_type:"KCPP_ChatImageReference",inputs:{source_name:"Guide"}},use:{class_type:"Other",inputs:{image:["ref",0]}}}}});
    s.chat.workflowReferences={generic:{ref:s.original}};s.panel.firstElementChild.style.cssText="position:relative;width:100px;height:90px";s.controller.render();
  });
  await page.getByRole("button",{name:"Crop or mask reference image",exact:true}).click();
  assert.equal(await dialog.locator(".ps-reference-preparation").count(),1);
  await dialog.getByRole("button",{name:"Done",exact:true}).click();
  assert.deepEqual(fixture.errors,[]);console.log("Reference crop/mask pixels, queue/replay reference, keyboard/pointer, undo, cancel and narrow layout passed.");
} finally {await fixture.close();}
