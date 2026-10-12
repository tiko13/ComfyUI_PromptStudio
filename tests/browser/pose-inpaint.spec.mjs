import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';
const fixture=await startFixture();
try {
 await fixture.context.route('**/promptstudio/controlnet/status',r=>r.fulfill({json:{ready:true,methods:{pose:{ready:true}}}}));
 const page=await fixture.newPage();
 await page.evaluate(async()=>{
  const {structureControls}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/structure-controls.js');
  const sheet=document.createElement('link');sheet.rel='stylesheet';sheet.href='/extensions/ComfyUI_PromptStudio/css/reference-inputs.css';document.head.append(sheet);
  const source={filename:'source.png',type:'input',subfolder:''};
  const profile={kind:'edit',imageNodeId:'source',promptNodeId:'prompt',resultNodeIds:['save'],snapshot:{output:{
   source:{class_type:'KCPP_ChatImageInput',inputs:{}},guide:{class_type:'PS_StructureInput',inputs:{source:['source',0],width:160,height:100,preserve_background:true}},
   control:{class_type:'PS_ApplyQwenStructure',inputs:{guide:['guide',0],strength:['guide',1],inpaint_image:['guide',2],inpaint_mask:['guide',3]}},
   render:{class_type:'Decoder',inputs:{model:['control',0]}},mask:{class_type:'PS_EditMask',inputs:{generated:['render',0],source:['source',0],inpaint_mask:['guide',3]}},
   save:{class_type:'SaveImage',inputs:{images:['mask',0]}}
  }}};
  const bitmap=document.createElement('canvas');bitmap.width=160;bitmap.height=100;const ctx=bitmap.getContext('2d');ctx.fillStyle='#247650';ctx.fillRect(0,0,160,100);
  const host=document.createElement('section');host.id='inpaint-test';document.body.prepend(host);
  const state=window.maskTest={entry:{id:'pose',use:'structure',image:source,guide:{type:'pose',input:'prepared',strength:.8}},source,saves:0,uploads:0};
  const fetchApi=async(path,options)=>{
   if(path.endsWith('/status'))return {ok:true,json:async()=>({ready:true})};
   const body=JSON.parse(options.body);
   if(body.mask_data){state.uploads++;state.maskPNG=body.mask_data;if(state.fail)return {ok:false,json:async()=>({error:'Source changed; reopen the editor.'})};}
   return {ok:true,json:async()=>({width:160,height:100,source_digest:'a'.repeat(64),...(body.mask_data?{mask:{...source,filename:'mask.png'}}:{})})};
  };
  const render=()=>host.replaceChildren(structureControls({doc:document,entry:state.entry,index:0,profile,entries:[state.entry],
   sourceImage:source,fetchApi,imageUrl:ref=>ref.filename==='mask.png'?state.maskPNG:bitmap.toDataURL(),report:m=>{state.error=m;},
   save:patch=>{state.saves++;Object.assign(state.entry,patch);localStorage.setItem('painted-mask-test',JSON.stringify(state.entry));render();}}));
  render();state.render=render;state.profile=profile;state.fetchApi=fetchApi;state.imageUrl=ref=>ref.filename==='mask.png'?state.maskPNG:bitmap.toDataURL();
 });
 const controls=page.locator('#inpaint-test'),keep=controls.getByRole('checkbox',{name:'Preserve background for reference 1'});
 assert.equal(await keep.isChecked(),true);
 await controls.getByRole('button',{name:'Edit background mask',exact:true}).click();
 const editor=page.getByRole('dialog',{name:'Edit background mask',exact:true});
 await editor.waitFor();await editor.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(await page.evaluate(()=>maskTest.saves),0);
 await controls.getByRole('button',{name:'Edit background mask',exact:true}).click();await editor.waitFor();
 await page.setViewportSize({width:390,height:850});
 assert.ok(await editor.evaluate(el=>el.getBoundingClientRect().right<=innerWidth));
 const canvas=editor.getByLabel('Background mask canvas'),box=await canvas.boundingBox();
 const paint=async()=>{await page.mouse.move(box.x+box.width*.3,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.6,box.y+box.height*.5,{steps:3});await page.mouse.up();};
 await paint();await editor.getByRole('button',{name:'Undo',exact:true}).click();await paint();
 await page.evaluate(()=>maskTest.fail=true);
 await editor.getByRole('button',{name:'Apply mask',exact:true}).click();
 await editor.getByText('Source changed; reopen the editor.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>maskTest.saves),0);
 await page.evaluate(()=>maskTest.fail=false);
 await editor.getByRole('button',{name:'Apply mask',exact:true}).click();await editor.waitFor({state:'hidden'});
 const pixels=await page.evaluate(async()=>{const image=new Image();image.src=maskTest.maskPNG;await image.decode();const c=document.createElement('canvas');c.width=160;c.height=100;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return [ctx.getImageData(0,0,1,1).data[0],ctx.getImageData(70,50,1,1).data[0]];});
 assert.deepEqual(pixels,[0,255]);
 assert.equal(await page.evaluate(()=>maskTest.entry.editMask.mode),'painted');
 await keep.uncheck();assert.equal(await page.evaluate(()=>maskTest.entry.guide.preserve_background),false);
 assert.equal(await page.evaluate(()=>maskTest.entry.editMask.enabled),true);
 await page.evaluate(()=>{maskTest.entry=JSON.parse(localStorage.getItem('painted-mask-test'));maskTest.render();});
 assert.equal(await keep.isChecked(),false);await keep.check();
 await controls.getByRole('button',{name:'Edit background mask',exact:true}).click();await editor.waitFor();
 await editor.getByLabel('Mask brush mode').selectOption('Erase');await paint();
 await editor.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(await page.evaluate(()=>maskTest.uploads),2);
 await page.evaluate(async()=>{
  const {createEditReferenceController}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/edit-reference.js');
  const panel=document.createElement('section');document.body.prepend(panel);
  panel.innerHTML='<div id="native-mask-reference"><input type="file" hidden><button class="promptstudio-edit-reference-choose"><img hidden><small></small></button><button class="promptstudio-edit-reference-remove">Remove</button></div>';
  maskTest.chat={id:'native-mask',qwenEditReferences:[maskTest.entry]};
  const controller=createEditReferenceController({panel,tile:panel.firstElementChild,activeChat:()=>maskTest.chat,findChat:()=>maskTest.chat,
   selectedProfile:()=>maskTest.profile,sourceImage:()=>maskTest.source,fetchApi:maskTest.fetchApi,imageUrl:maskTest.imageUrl,
   upload:()=>{throw Error('Unexpected upload');},changed:()=>{},refresh:()=>{},report:m=>maskTest.error=m});controller.render();
 });
 await page.locator('#native-mask-reference').getByRole('button',{name:'References',exact:true}).click();
 const refs=page.getByRole('dialog',{name:'References',exact:true});
 const expand=refs.getByRole('button',{name:'Expand reference 1',exact:true});
 if(await expand.getAttribute('aria-expanded')==='false')await expand.click();
 await refs.getByRole('button',{name:'Edit background mask',exact:true}).click();await editor.waitFor();
 await editor.getByRole('button',{name:'Apply mask',exact:true}).click();await editor.waitFor({state:'hidden'});
 assert.equal(await page.evaluate(()=>maskTest.chat.qwenEditReferences[0].editMask.mode),'painted');
 await refs.getByRole('checkbox',{name:'Preserve background for reference 1'}).uncheck();
 assert.equal(await page.evaluate(()=>maskTest.chat.qwenEditReferences[0].guide.preserve_background),false);
 assert.deepEqual(fixture.errors,[]);
 console.log('PASS: mask brush, undo, cancellation, rejected save, exact PNG, persistent checkbox and narrow layout');
} finally {await fixture.close();}
