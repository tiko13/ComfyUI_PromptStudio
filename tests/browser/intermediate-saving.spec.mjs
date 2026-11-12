import assert from 'node:assert/strict';
import {startFixture,attachVideo,videoEnabled} from './fixture.mjs';
const fixture=await startFixture();
const thumbnail='data:image/webp;base64,UklGRjQAAABXRUJQVlA4ICgAAACQAQCdASoIAAgAAUAmJZACdLoAA5gA/vSIh/VcnYnxw/ubHOLZDAAA';
const references=[
 {filename:'saved.webp',type:'output',subfolder:'',intermediate:true},
 {filename:'cached.webp',type:'temp',subfolder:'',intermediate:true,previewThumbnail:thumbnail},
 {filename:'StudioChoice_temp_legacy.png',type:'temp',subfolder:''},
 {filename:'offline.webp',type:'temp',subfolder:'',intermediate:true,previewThumbnail:thumbnail},
];
let purged=false;
try{
 await fixture.context.route('**/js/prompt_studio.js',async route=>{
  const response=await route.fetch();await route.fulfill({response,body:await response.text()+'\nwindow.savingImage={state,appendMessage,flushChatStore};'});
 });
 await fixture.context.route('**/js/promptstudio_video_studio.js',async route=>{
  const response=await route.fetch();await route.fulfill({response,body:await response.text()+'\nwindow.savingVideo={state,newProject,renderAll,persistProjects};'});
 });
 await fixture.context.route('**/view?*',route=>{
  const filename=new URL(route.request().url()).searchParams.get('filename');
  const missing=purged&&['cached.webp','StudioChoice_temp_legacy.png'].includes(filename);
  return route.fulfill(filename==='offline.webp'?{status:500,body:'Unavailable'}:missing?{status:404,body:'Purged'}:
   {contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="steelblue"/></svg>'});
 });
 const page=await fixture.newPage();
 await page.evaluate(async refs=>{
  const {appendMessage,flushChatStore}=window.savingImage;
  appendMessage('assistant','',{messageId:'intermediate-saving',canonicalPrompt:'Saved and unsaved stages',images:refs});
  await flushChatStore();
 },references);
 const message=page.locator('[data-message-id="intermediate-saving"]');
 await message.locator('img[alt="cached.webp"]').waitFor();
 await page.waitForFunction(()=>document.querySelector('img[alt="cached.webp"]')?.naturalWidth>0);
 purged=true;
 await page.reload();await page.waitForFunction(()=>window.studioReady||window.bootError);
 const expired=message.getByText('Unsaved intermediate expired',{exact:true});
 await expired.first().waitFor();
 await page.waitForFunction(()=>document.querySelectorAll('[data-message-id="intermediate-saving"] .studio-intermediate-unavailable').length===3);
 assert.equal(await expired.count(),2);
 assert.equal(await message.getByText('Intermediate preview unavailable',{exact:true}).count(),1);
 assert.equal(await message.locator('img[alt="Thumbnail of the unsaved intermediate"]').count(),2);
 assert.equal(await message.locator('img[alt="saved.webp"]').count(),1);
 assert.equal(await message.locator('img[alt="cached.webp"]').count(),0);
 assert.equal(await message.getByRole('button',{name:'Unsaved intermediate expired',exact:true}).first().isDisabled(),true);
 const thumbnailBox=await message.locator('img[alt="Thumbnail of the unsaved intermediate"]').first().boundingBox();
 assert.ok(thumbnailBox.width<=128&&thumbnailBox.height<=128);
 if(videoEnabled){
  await attachVideo(page);
  await page.evaluate(async refs=>{
   const {state,newProject,renderAll,persistProjects}=window.savingVideo;
   if(!state.projects.length)await newProject();
   const project=state.projects.find(item=>item.id===state.activeProjectId);
   project.generations.unshift({id:'saved-stages',prompt_id:'finished',status:'complete',kind:'base',
    document:structuredClone(project.document),outputs:[refs[0]],choiceStages:[{promptId:'finished',outputs:refs}],
    created_at:Date.now(),updated_at:Date.now(),workflow_name:'Choice',workflow_snapshot:{workflow:{nodes:[]},output:{}}});
   renderAll();await persistProjects({immediate:true});
  },references);
  await page.locator('#psvstudio-preview').getByText('Unsaved intermediate expired',{exact:true}).first().waitFor();
  await page.reload();await page.waitForFunction(()=>window.studioReady||window.bootError);await attachVideo(page);
  const preview=page.locator('#psvstudio-preview');
  await page.waitForFunction(()=>document.querySelectorAll('#psvstudio-preview .studio-intermediate-unavailable').length===3);
  assert.equal(await preview.getByText('Unsaved intermediate expired',{exact:true}).count(),2);
  assert.equal(await preview.getByText('Intermediate preview unavailable',{exact:true}).count(),1);
  assert.equal(await preview.locator('img[alt="Thumbnail of the unsaved intermediate"]').count(),2);
  assert.equal(await preview.locator('img[alt="saved.webp"]').count(),1);
 }
 assert.deepEqual(fixture.errors,[]);
 console.log('Saved intermediates survive reload; purged temporary images retain small thumbnails, legacy placeholders, and accurate offline explanations'+(videoEnabled?' in both studios.':'.'));
}finally{await fixture.close();}
