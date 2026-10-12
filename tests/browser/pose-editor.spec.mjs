import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {startFixture,root} from './fixture.mjs';
const fixture=await startFixture();
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
try {
 await fixture.context.route('**/promptstudio/controlnet/status',r=>r.fulfill({json:{ready:true,methods:{pose:{ready:true}}}}));
 await fixture.context.route('**/view?*',r=>r.fulfill({contentType:'image/png',body:png}));
 let submitted;
 await fixture.context.route('**/prompt',r=>{submitted=r.request().postDataJSON();return r.fulfill({json:{prompt_id:'pose-extract'}});});
 const page=await fixture.newPage();
 const setup=async()=>page.evaluate(async()=>{
  const {createEditReferenceController}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/edit-reference.js');
  const host=document.createElement('section');document.body.append(host);
  host.innerHTML='<div id="pose-tile"><input type="file" hidden><button class="promptstudio-edit-reference-choose"><img hidden><small></small></button><button class="promptstudio-edit-reference-remove">Remove</button></div>';
  const chat=JSON.parse(localStorage.getItem('pose-test')||'{"id":"pose-test","qwenEditReferences":[]}');
  const profile={id:'qwen',kind:'create',promptNodeId:'p',snapshot:{output:{p:{class_type:'KCPP_PromptSlot',inputs:{}},e:{class_type:'TextEncodeQwenImage21',inputs:{prompt:['p',0]}},s:{class_type:'KCPP_QwenImage21TurboSampler',inputs:{model:['m',0],positive:['e',0]}},d:{class_type:'VAEDecode',inputs:{vae:['v',0],samples:['s',0]}}}}};
  const state=window.poseTest={chat,profile,uploads:0,reports:[]};
  state.controller=createEditReferenceController({panel:host,tile:host.firstElementChild,activeChat:()=>chat,findChat:()=>chat,selectedProfile:()=>profile,
   upload:async file=>{state.uploads++;if(state.fail)throw Error('Upload failed');state.bytes=Array.from(new Uint8Array(await file.arrayBuffer()));return {filename:`pose-${Date.now()}.png`,type:'input',subfolder:''};},
   imageUrl:ref=>'/view?filename='+ref.filename,changed:()=>localStorage.setItem('pose-test',JSON.stringify(chat)),refresh:()=>{},report:m=>state.reports.push(m)});state.controller.render();
 });
 await setup();
 const open=async()=>page.locator('#pose-tile').getByRole('button',{name:'References',exact:true}).click();
 const refs=page.getByRole('dialog',{name:'References',exact:true}),editor=page.getByRole('dialog',{name:'Edit pose',exact:true});
 await open();await refs.getByRole('button',{name:'+ Add pose',exact:true}).click();
 await editor.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(await page.evaluate(()=>poseTest.chat.qwenEditReferences.length),0);
 assert.equal(await page.evaluate(()=>poseTest.uploads),0);
 await refs.getByRole('button',{name:'+ Add pose',exact:true}).click();
 const canvas=editor.getByLabel('Pose canvas');
 const zoom=editor.getByLabel('Zoom',{exact:true});
 const stage=editor.locator('.ps-pose-stage');
 for(const width of [1100,390]){
  await page.setViewportSize({width,height:900});await editor.getByRole('button',{name:'Fit view',exact:true}).click();
  const start=await canvas.boundingBox(),anchor={x:start.x+start.width*.28,y:start.y+start.height*.58};
  const dialogScroll=await editor.evaluate(e=>e.scrollTop);
  await page.mouse.move(anchor.x,anchor.y);
  for(const delta of [-120,-240,120,240]){
   const before=await canvas.boundingBox(),oldZoom=Number(await zoom.inputValue());
   const point={x:(anchor.x-before.x)/before.width,y:(anchor.y-before.y)/before.height};
   await page.mouse.wheel(0,delta);
   await page.waitForFunction(old=>Number(document.querySelector('.ps-pose-dialog input[aria-label="Zoom"]').value)!==old,oldZoom);
   const after=await canvas.boundingBox();
   assert.ok(Math.abs(after.x+point.x*after.width-anchor.x)<1.5,'Horizontal joint position stays under cursor');
   assert.ok(Math.abs(after.y+point.y*after.height-anchor.y)<1.5,'Vertical joint position stays under cursor');
  }
  assert.equal(await editor.evaluate(e=>e.scrollTop),dialogScroll,'Wheel zoom does not scroll the dialog');
  const bounds=await stage.boundingBox(),before=await canvas.boundingBox();
  const center={x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2};
  const point={x:(center.x-before.x)/before.width,y:(center.y-before.y)/before.height};
  await zoom.fill('12');const enlarged=await canvas.boundingBox();
  assert.ok(Math.abs(enlarged.x+point.x*enlarged.width-center.x)<1.5,'Slider zoom preserves view center');
  for(const mode of ['Move joint','Place joint']){
   await editor.getByRole('button',{name:mode,exact:true}).click();
   const panBefore=await canvas.boundingBox();
   await page.mouse.move(center.x,center.y);await page.mouse.down({button:'middle'});
   assert.equal(await canvas.evaluate(e=>getComputedStyle(e).cursor),'grabbing');
   await page.mouse.move(center.x+35,center.y+25);
   const panned=await canvas.boundingBox();
   assert.ok(Math.abs(panned.x-panBefore.x-35)<1.5,'Middle drag moves picture horizontally with the mouse');
   assert.ok(Math.abs(panned.y-panBefore.y-25)<1.5,'Middle drag moves picture vertically with the mouse');
   // Pointer capture keeps the picture grabbed beyond the viewport boundary.
   const outsideX=bounds.x+bounds.width+8;
   await page.mouse.move(outsideX,center.y+25);await page.mouse.up({button:'middle'});
   const released=await canvas.boundingBox();
   assert.ok(Math.abs(released.x-panBefore.x-(outsideX-center.x))<1.5,'Panning continues outside the viewport');
   await page.mouse.move(center.x,center.y);
   assert.deepEqual(await canvas.boundingBox(),released,'Panning stops on middle-button release');
   assert.equal(await canvas.evaluate(e=>getComputedStyle(e).cursor),'crosshair','Previous edit mode remains active');
   assert.ok(await editor.getByRole('button',{name:'Undo',exact:true}).isDisabled(),'Middle drag never moves or places a joint');
  }
  await editor.getByRole('button',{name:'Move joint',exact:true}).click();
  assert.ok(await editor.getByRole('button',{name:'Undo',exact:true}).isDisabled(),'Zoom does not edit pose data');
  await editor.getByRole('button',{name:'Fit view',exact:true}).click();
  assert.equal(await zoom.inputValue(),'1');const fit=await canvas.boundingBox(),view=await stage.boundingBox();
  assert.ok(fit.x>=view.x&&fit.y>=view.y&&fit.x+fit.width<=view.x+view.width&&fit.y+fit.height<=view.y+view.height,'Fit view restores the entire pose');
 }
 await page.setViewportSize({width:1100,height:900});await editor.getByRole('button',{name:'Fit view',exact:true}).click();
 const box=await canvas.boundingBox();
 const neck={x:box.x+box.width*.5,y:box.y+box.height*.27};
 await page.mouse.move(neck.x,neck.y);await page.mouse.wheel(0,-350);
 await page.waitForFunction(()=>Number(document.querySelector('.ps-pose-dialog input[aria-label="Zoom"]').value)>1);
 await page.mouse.down();await page.mouse.move(neck.x+20,neck.y+15);await page.mouse.up();
 assert.ok(await editor.getByRole('button',{name:'Undo',exact:true}).isEnabled());
 await editor.getByRole('button',{name:'Undo',exact:true}).click();await editor.getByRole('button',{name:'Redo',exact:true}).click();
 await editor.getByRole('button',{name:'Fit view',exact:true}).click();
 await editor.getByLabel('Edit',{exact:true}).selectOption('hand_left_keypoints_2d');await editor.getByRole('button',{name:'Add hand',exact:true}).click();
 await editor.getByLabel('Edit',{exact:true}).selectOption('pose_keypoints_2d');
 for(const width of [1100,390]){
  await page.setViewportSize({width,height:900});assert.ok(await editor.evaluate(e=>e.scrollWidth<=e.clientWidth));
  await mkdir(resolve(root,'test-results/browser'),{recursive:true});await editor.screenshot({path:resolve(root,`test-results/browser/pose-editor-${width}.png`)});
 }
 await page.evaluate(()=>poseTest.fail=true);await editor.getByRole('button',{name:'Apply pose',exact:true}).click();
 await editor.getByText('Upload failed',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>poseTest.chat.qwenEditReferences.length),0);
 await page.evaluate(()=>poseTest.fail=false);await editor.getByRole('button',{name:'Apply pose',exact:true}).click();await editor.waitFor({state:'detached'});
 const saved=await page.evaluate(()=>poseTest.chat.qwenEditReferences[0]);assert.ok(saved.pose.data.people[0].hand_left_keypoints_2d[2]);
 assert.ok(saved.pose.data.people[0].pose_keypoints_2d[3]>saved.pose.original.people[0].pose_keypoints_2d[3]);
 assert.equal(saved.use,'structure');assert.equal(saved.guide.input,'prepared');
 assert.ok(await refs.getByRole('button',{name:'+ Add pose',exact:true}).isDisabled());
 await page.reload();await page.waitForFunction(()=>window.studioReady);await setup();await open();
 await refs.getByRole('button',{name:'Edit pose',exact:true}).click();await editor.getByRole('button',{name:'Reset pose',exact:true}).click();await page.keyboard.press('Escape');
 assert.deepEqual(await page.evaluate(()=>poseTest.chat.qwenEditReferences[0]),saved,'Cancel after reset keeps saved joints');
 // Extraction retains donor crop, then reuses the edited image without extracting again.
 const extracted=structuredClone(saved.pose.original);
 await fixture.context.route('**/history/pose-extract',r=>r.fulfill({json:{'pose-extract':{status:{status_str:'success'},outputs:{ps_structure_guide:{pose_json:[JSON.stringify({data:[extracted],sourceRegion:{x:.2,y:.1,width:.5,height:.8}})]},ps_structure_preview:{images:[{filename:'preview.png',type:'temp'}]}}}}}));
 await refs.getByRole('button',{name:'Done',exact:true}).click();
 await page.evaluate(()=>{poseTest.chat.qwenEditReferences=[{id:'photo',image:{filename:'source.png',type:'input'},role:'pose',use:'structure',guide:{type:'pose',input:'photo'},targeting:{reference:{x:.2,y:.1,width:.5,height:.8}}}];poseTest.controller.render();});
 await open();await refs.getByRole('button',{name:'Extract & edit pose',exact:true}).click();await editor.waitFor();
 assert.equal(submitted.prompt.ps_structure_guide.inputs.emit_pose,true);
 await editor.getByRole('button',{name:'Apply pose',exact:true}).click();await editor.waitFor({state:'detached'});
 const result=await page.evaluate(async()=>{const {guideGraph}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/generation/structure-guide.js');const e=poseTest.chat.qwenEditReferences[0];return {e,graph:guideGraph(e)};});
 assert.equal(result.e.pose.sourceImage.filename,'source.png');assert.equal(result.graph.ps_structure_guide.inputs.input_mode,'prepared');
 assert.ok(!result.graph.ps_structure_guide.inputs.targeting,'Donor crop is already baked into the pose');
 assert.deepEqual(fixture.errors,[]);console.log('Pose editor: new/extracted poses, drag, hands, undo/redo, cancel, failed upload retry, reload, geometry and responsive layout passed.');
}finally{await fixture.close();}
