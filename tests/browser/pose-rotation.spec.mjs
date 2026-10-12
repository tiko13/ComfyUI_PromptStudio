import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {startFixture,root} from './fixture.mjs';
const fixture=await startFixture();
try{
 const page=await fixture.newPage();
 await page.evaluate(async()=>{
  const {defaultPose}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/generation/pose.js');
  const {openPoseEditor}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/pose-editor.js');
  const style=document.createElement('link');style.rel='stylesheet';style.href='/extensions/ComfyUI_PromptStudio/css/reference-inputs.css';
  const loaded=new Promise((resolve,reject)=>{style.onload=resolve;style.onerror=reject;});document.head.append(style);await loaded;
  const data=defaultPose();window.rotationTest={original:structuredClone(data),saved:null};
  window.rotationTest.open=()=>openPoseEditor({doc:document,data:rotationTest.saved?.data||data,original:data,apply:async result=>{rotationTest.saved={data:result.data,original:result.original};}});
  rotationTest.open();
 });
 const editor=page.getByRole('dialog',{name:'Edit pose',exact:true}),canvas=editor.getByLabel('Pose canvas');
 // ResizeObserver and scrollbar layout run after zoom/viewport changes. Sample
 // the ring coordinates only once its canvas geometry has settled across frames.
 const settledCanvas=()=>canvas.evaluate(async node=>{
  let previous='',stable=0;
  for(let frame=0;frame<60;frame++){
   await new Promise(requestAnimationFrame);
   const {x,y,width,height}=node.getBoundingClientRect(),current=JSON.stringify([x,y,width,height]);
   stable=current===previous?stable+1:0;previous=current;
   if(stable>=3)return {x,y,width,height};
  }
  throw new Error('Pose canvas layout did not settle');
 });
 await editor.getByRole('button',{name:'Fit view',exact:true}).click();
 const box=await settledCanvas(),elbow={x:box.x+box.width*.32,y:box.y+box.height*.43};
 await page.mouse.click(elbow.x,elbow.y);
 assert.equal(await canvas.getAttribute('data-rotation-joint'),'3');
 assert.ok(await editor.getByRole('button',{name:'Undo',exact:true}).isDisabled(),'Selecting a joint creates no edit');
 await page.mouse.move(elbow.x+32,elbow.y);await page.mouse.down();
 await page.mouse.move(elbow.x+16,elbow.y-32*Math.sqrt(3)/2,{steps:8});await page.mouse.up();
 assert.ok(await editor.getByRole('button',{name:'Undo',exact:true}).isEnabled());
 await editor.getByRole('button',{name:'Undo',exact:true}).click();
 assert.ok(await editor.getByRole('button',{name:'Undo',exact:true}).isDisabled(),'One gesture is one undo step');
 await editor.getByRole('button',{name:'Redo',exact:true}).click();
 await mkdir(resolve(root,'test-results/browser'),{recursive:true});
 await editor.screenshot({path:resolve(root,'test-results/browser/pose-rotation.png')});
 await editor.getByRole('button',{name:'Apply pose',exact:true}).click();await editor.waitFor({state:'detached'});
 const state=await page.evaluate(()=>rotationTest);
 const a=state.saved.data.people[0].pose_keypoints_2d,b=state.original.people[0].pose_keypoints_2d;
 assert.deepEqual(a.slice(0,12),b.slice(0,12));assert.deepEqual(a.slice(15),b.slice(15));
 assert.notDeepEqual(a.slice(12,14),b.slice(12,14));
 assert.ok(Math.abs(Math.hypot(a[12]-a[9],a[13]-a[10])-Math.hypot(b[12]-b[9],b[13]-b[10]))<1e-6);
 // Zoomed ring keeps its 32 CSS-pixel radius; Shift snaps a 22-degree gesture.
 // Force wrapped instructions regardless of the platform's font metrics.
 await page.addStyleTag({content:'.ps-pose-rotation-hint { font-size: 14px; }'});
 await page.evaluate(()=>rotationTest.open());
 await editor.getByLabel('Joint',{exact:true}).selectOption('3');
 await page.setViewportSize({width:390,height:900});await editor.getByRole('button',{name:'Fit view',exact:true}).click();
 let view=await settledCanvas(),pivot={x:view.x+view.width*.32,y:view.y+view.height*.43};
 await page.mouse.move(pivot.x,pivot.y);await page.mouse.wheel(0,-450);
 await page.waitForFunction(()=>Number(document.querySelector('input[aria-label="Zoom"]').value)>2);
 view=await settledCanvas();pivot={x:view.x+view.width*.32,y:view.y+view.height*.43};
 await page.keyboard.down('Shift');await page.mouse.move(pivot.x+32,pivot.y);await page.mouse.down();
 await page.mouse.move(pivot.x+32*Math.cos(22*Math.PI/180),pivot.y+32*Math.sin(22*Math.PI/180),{steps:5});
 assert.match(await editor.locator('.ps-pose-rotation-hint').textContent(),/15°/);
 const during=await canvas.boundingBox();
 assert.ok(Math.abs(during.y-view.y)<1,'Wrapped hint must not move the canvas during rotation');
 await page.mouse.up();await page.keyboard.up('Shift');
 await editor.getByLabel('Joint',{exact:true}).selectOption('10');assert.equal(await canvas.getAttribute('data-rotation-joint'),'');
 await editor.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>rotationTest.saved.data),state.saved.data,'Cancel discards rotation draft');
 assert.deepEqual(fixture.errors,[]);
 console.log('Joint rings: selection, limb rotation, fixed pivot/length, one-step undo/redo, saved data, zoomed narrow view, snapping and endpoints passed.');
}finally{await fixture.close();}
