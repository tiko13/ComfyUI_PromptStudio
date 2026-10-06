import assert from "node:assert/strict";
import {mkdir} from "node:fs/promises";
import {resolve} from "node:path";
import {startFixture,root} from "./fixture.mjs";
const fixture=await startFixture();
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=","base64");
try {
 await fixture.context.route("**/promptstudio/controlnet/status",r=>r.fulfill({json:{ready:true,model:"control.safetensors",methods:Object.fromEntries(["edges","depth","pose","sketch"].map(k=>[k,{ready:true}]))}}));
 let submitted;
 await fixture.context.route("**/prompt",r=>{submitted=r.request().postDataJSON();return r.fulfill({json:{prompt_id:"guide-preview"}});});
 await fixture.context.route("**/history/guide-preview",r=>r.fulfill({json:{"guide-preview":{status:{status_str:"success"},outputs:{ps_structure_preview:{images:[{filename:"guide.png",type:"temp",subfolder:""}]}}}}}));
 await fixture.context.route("**/view?*",r=>r.fulfill({contentType:"image/png",body:png}));
 const page=await fixture.newPage();
 await page.evaluate(async()=>{
  const {createEditReferenceController}=await import("/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/edit-reference.js");
  const host=document.createElement("section");document.body.append(host);
  host.innerHTML='<div id="test-reference-tile"><input type="file" hidden><button class="promptstudio-edit-reference-choose"><img hidden><small></small></button><button class="promptstudio-edit-reference-remove">Remove</button></div>';
  const image={filename:"reference.png",type:"input",subfolder:""};
  const chat={id:"reference-test",qwenEditReferences:[{id:"one",image,role:"subject"},{id:"two",image,role:"clothing"},{id:"three",image,role:"custom",use:"structure",guide:{type:"pose",strength:.8}}]};
  const profile={id:"qwen",kind:"edit",promptNodeId:"p",imageNodeId:"base",snapshot:{output:{
   p:{class_type:"KCPP_PromptSlot",inputs:{}},base:{class_type:"KCPP_ChatImageInput",inputs:{}},
   e:{class_type:"TextEncodeQwenImage21",inputs:{prompt:["p",0],"images.image_1":["base",0]}},
   s:{class_type:"KCPP_QwenImage21TurboSampler",inputs:{model:["model",0],positive:["e",0]}},d:{class_type:"VAEDecode",inputs:{vae:["vae",0],samples:["s",0]}}
  }}};
  const state={chat,profile,saveCount:0,reports:[]};window.guideTest=state;
  state.controller=createEditReferenceController({panel:host,tile:host.firstElementChild,activeChat:()=>chat,findChat:()=>chat,selectedProfile:()=>state.profile,
   upload:async()=>image,imageUrl:ref=>"/view?filename="+ref.filename,changed:()=>state.saveCount++,refresh:()=>{},report:msg=>state.reports.push(msg),sourceImage:()=>image,
   guideDimensions:()=>({width:768,height:1024})});state.controller.render();
 });
 await page.locator("#test-reference-tile").getByRole("button",{name:"References",exact:true}).click();
 const dialog=page.getByRole("dialog",{name:"References",exact:true});
 await dialog.getByRole("button",{name:"Expand reference 3",exact:true}).click();
 assert.equal(await dialog.locator(".ps-reference-detail:visible").count(),1);
 await dialog.getByRole("slider").fill("0.6");
 await dialog.getByLabel("Guide for reference 3",{exact:true}).selectOption("depth");
 assert.equal(await page.evaluate(()=>guideTest.chat.qwenEditReferences[2].guide.strength),.6);
 await dialog.getByRole("button",{name:"Show guide",exact:true}).click();
 await dialog.getByAltText("Extracted structure guide").waitFor({state:"visible"});
 assert.equal(submitted.prompt.ps_structure_guide.inputs.guide_type,"depth");
 assert.equal(submitted.prompt.ps_structure_guide.inputs.height,1024);
 for(const width of [1100,390]) {
  await page.setViewportSize({width,height:850});
  assert.ok(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth));
  await mkdir(resolve(root,"test-results/browser"),{recursive:true});
  await dialog.screenshot({path:resolve(root,`test-results/browser/controlnet-${width}.png`)});
 }
 await dialog.getByRole("button",{name:"Expand reference 1",exact:true}).click();
 await dialog.getByLabel("Use for reference 1",{exact:true}).selectOption("both");
 assert.equal(await page.evaluate(()=>guideTest.reports.length),1,"A second structural guide is refused");
 await page.keyboard.press("Escape");assert.equal(await dialog.count(),0);
 await page.evaluate(async()=>{
  const {profile,chat,controller}=guideTest;
  profile.kind="create";delete profile.snapshot.output.e.inputs["images.image_1"];
  chat.qwenEditReferences=[];
  await controller.attach([new File(["test"],"new.png",{type:"image/png"})]);
 });
 await page.locator("#test-reference-tile").getByRole("button",{name:"References",exact:true}).click();
 assert.match(await dialog.textContent(),/1\/10/);
 assert.equal(await dialog.getByLabel("Use for reference 1",{exact:true}).inputValue(),"reference","Create uploads default to ordinary references");
 assert.ok(await dialog.getByLabel("Role for reference 1",{exact:true}).isEnabled());
 await page.keyboard.press("Escape");
 await page.evaluate(async()=>{
  const {chat,controller}=guideTest;
  await controller.attach(Array.from({length:9},(_,i)=>new File(["test"],i+".png",{type:"image/png"})));
  await controller.attach([new File(["test"],"eleventh.png",{type:"image/png"})]);
 });
 assert.equal(await page.evaluate(()=>guideTest.chat.qwenEditReferences.length),10);
 assert.match(await page.evaluate(()=>guideTest.reports.at(-1)),/10/);
 await page.evaluate(()=>{
  const {chat,profile,controller}=guideTest;profile.kind="edit";profile.snapshot.output.e.inputs["images.image_1"]=["base",0];controller.render();
 });
 await page.locator("#test-reference-tile").getByRole("button",{name:"References",exact:true}).click();
 assert.match(await dialog.textContent(),/Remove a reference before generating/);
 assert.equal(await page.evaluate(()=>guideTest.chat.qwenEditReferences.length),10,"Switching to Edit must not discard the tenth reference");
 await page.keyboard.press("Escape");
 await page.evaluate(()=>{guideTest.chat.qwenEditReferences=[{id:"one",image:{filename:"guide.png",type:"input"},use:"structure",guide:{type:"depth"}}];});
 await page.evaluate(()=>{guideTest.profile={id:"other",kind:"create",snapshot:{output:{}}};guideTest.controller.render();});
 await page.locator("#test-reference-tile").getByRole("button",{name:"References",exact:true}).click();
 assert.ok(await dialog.getByLabel("Use for reference 1",{exact:true}).isDisabled());
 assert.equal(await page.evaluate(()=>guideTest.chat.qwenEditReferences[0].guide.type),"depth");
 console.log("Structure guides: compact multi-reference accordion, preview queue, strength persistence, one-guide limit, inactive workflows, narrow layout and Escape passed.");
}finally{await fixture.close();}
