import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {startFixture,root} from './fixture.mjs';
const fixture=await startFixture();
try {
 const page=await fixture.newPage();
 await page.evaluate(async()=>{
  const {openInpaintMaskEditor}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/inpaint-mask-editor.js');
  const sheet=document.createElement('link');sheet.rel='stylesheet';sheet.href='/extensions/ComfyUI_PromptStudio/css/reference-inputs.css';document.head.append(sheet);
  const png=(mask=false,large=false)=>{const c=document.createElement('canvas');c.width=400;c.height=300;const x=c.getContext('2d');x.fillStyle=mask?'black':'#336655';x.fillRect(0,0,400,300);if(mask){x.fillStyle='white';x.fillRect(150,40,large?180:70,230);}return c.toDataURL();};
  const state=window.estimateTest={applied:[],requests:[],source:png(),mask:png(true),large:png(true,true)};
  state.open=async(mask)=>openInpaintMaskEditor({doc:document,source:{filename:'source.png'},mask,
   imageUrl:ref=>ref.filename==='source.png'?state.source:ref.filename==='large.png'?state.large:state.mask,
   fetchApi:async(_path,options)=>{const body=JSON.parse(options.body);if(body.mask_data)state.savedPNG=body.mask_data;return {ok:true,json:async()=>({width:400,height:300,source_digest:'a'.repeat(64),mask:{filename:'saved.png'}})};},
   estimate:async({padding,signal})=>{state.requests.push(padding);if(state.delay)await new Promise(resolve=>state.release=resolve);state.cancelled=signal.aborted;return {filename:padding>10?'large.png':'mask.png'};},
   apply:record=>state.applied.push(record)});
  await state.open();
 });
 const dialog=page.getByRole('dialog',{name:'Edit background mask',exact:true}),canvas=dialog.getByLabel('Background mask canvas');
 await dialog.getByText(/^Estimated both body positions/).waitFor();
 assert.equal(await page.evaluate(()=>estimateTest.applied.length),0);
 assert.deepEqual(await page.evaluate(()=>estimateTest.requests),[10]);
 const read=()=>canvas.evaluate(c=>Array.from(c.getContext('2d').getImageData(280,100,1,1).data));
 const before=await read();
 await dialog.getByLabel('Mask padding',{exact:true}).fill('30');
 assert.deepEqual(await page.evaluate(()=>estimateTest.requests),[10]);
 await dialog.getByRole('button',{name:'Estimate from poses',exact:true}).click();
 await page.waitForFunction(()=>estimateTest.requests.length===2);
 await dialog.getByText(/^Estimated both body positions/).waitFor();
 assert.notDeepEqual(await read(),before);await dialog.getByRole('button',{name:'Undo',exact:true}).click();assert.deepEqual(await read(),before);
 for(const width of [1000,390]){
  await page.setViewportSize({width,height:900});
  await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  const ring=dialog.locator('.ps-mask-brush-cursor');await ring.waitFor({state:'visible'});
  let circle=await ring.boundingBox();
  assert.ok(Math.abs(circle.width-15*box.width/400)<.2);
  assert.ok(Math.abs(circle.x+circle.width/2-(box.x+box.width/2))<.2);
  assert.equal(await canvas.evaluate(c=>getComputedStyle(c).cursor),'none');
  await dialog.getByLabel('Mask brush size',{exact:true}).fill('10');
  await canvas.scrollIntoViewIfNeeded();const next=await canvas.boundingBox();await page.mouse.move(next.x+next.width/2,next.y+next.height/2);
  circle=await ring.boundingBox();assert.ok(Math.abs(circle.width-30*next.width/400)<.2);
  await dialog.getByLabel('Mask brush size',{exact:true}).fill('5');
 }
 await dialog.getByLabel('Mask brush mode').selectOption('Erase');
 const box=await canvas.boundingBox();await page.mouse.move(box.x+box.width*.6,box.y+box.height*.6);
 assert.equal(await dialog.locator('.ps-mask-brush-cursor').evaluate(c=>getComputedStyle(c).borderStyle),'dashed');
 await mkdir(resolve(root,'development-internal','pose-mask-estimate'),{recursive:true});
 await page.screenshot({path:resolve(root,'development-internal','pose-mask-estimate','editor.png')});
 await dialog.getByRole('button',{name:'Apply mask',exact:true}).click();await dialog.waitFor({state:'hidden'});
 assert.equal(await page.evaluate(()=>estimateTest.applied.length),1);
 await page.evaluate(()=>estimateTest.open(estimateTest.applied[0]));
 await dialog.waitFor();assert.equal(await page.evaluate(()=>estimateTest.requests.length),2);
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.evaluate(async()=>{estimateTest.delay=true;await estimateTest.open();});await dialog.waitFor();
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.evaluate(()=>estimateTest.release());await page.waitForFunction(()=>estimateTest.cancelled===true);
 assert.equal(await page.evaluate(()=>estimateTest.applied.length),1);
 assert.deepEqual(fixture.errors,[]);
 console.log('PASS: automatic estimate, padding, undo, saved-mask retention, brush circle dimensions and cancellation');
} finally {await fixture.close();}
