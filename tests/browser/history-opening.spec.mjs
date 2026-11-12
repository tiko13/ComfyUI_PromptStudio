import assert from 'node:assert/strict';
import {startFixture,attachVideo,videoEnabled,config} from './fixture.mjs';

const messages=id=>Array.from({length:100},(_,i)=>({id:`${id}-${i}`,role:'assistant',text:`Message ${i}`,
 images:[{filename:`${id}-${i}.svg`,type:'output'}],createdAt:i+1}));
for(const width of [1366,1024,390]){
 const fixture=await startFixture({contextOptions:{hasTouch:true,viewport:{width,height:1024},reducedMotion:'no-preference'}});
 fixture.chats={revision:1,activeChatId:'one',chats:['one','two'].map((id,i)=>({id,createdAt:i+1,updatedAt:i+1,
   initialized:true,mainPrompt:'Test',currentPrompt:'Test',messages:messages(id)}))};
 fixture.projects={revision:1,active_project_id:'video',projects:[{id:'video',name:'History',document:structuredClone(config.default_document),generations:[],created_at:1,updated_at:1}]};
 const releases={},requested=new Set();
 const ready=Object.fromEntries(['one','two'].map(id=>[id,new Promise(resolve=>{releases[id]=resolve;})]));
 try{
   // Old saved images can lack dimensions. Release only after opening the
   // thread, to reproduce late layout changes without eagerly decoding it.
   await fixture.context.route('**/view?*',async route=>{
     const file=new URL(route.request().url()).searchParams.get('filename');requested.add(file);
     await ready[file.split('-')[0]];
     await route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200"><rect width="800" height="1200" fill="#345"/></svg>'});
   });
   if(videoEnabled)await fixture.context.route('**/js/promptstudio_video_studio.js',async route=>{
     const response=await route.fetch();await route.fulfill({response,body:await response.text()+'\nexport {directorSession};'});
   });
   const page=await fixture.newPage();
   const atEnd=selector=>page.waitForFunction(selector=>{const n=document.querySelector(selector);return n.clientHeight>0&&n.scrollHeight>n.clientHeight&&n.scrollHeight-n.scrollTop-n.clientHeight<3;},selector);
   const history=page.locator('#promptstudio-history');
   const decoded=()=>history.locator('.promptstudio-message:last-child img').evaluate(n=>n.decode());
   await atEnd('#promptstudio-history');
   releases.one();await decoded();await atEnd('#promptstudio-history');
   assert.ok(requested.size<30,`Opening ${width}px fetched ${requested.size}/100 images; only a nearby buffer should load`);
   assert.equal(requested.has('one-50.svg'),false,'Middle images remain unloaded');
   await history.locator('[data-message-id="one-50"] img').scrollIntoViewIfNeeded();
   await history.locator('[data-message-id="one-50"] img').evaluate(n=>n.decode());
   assert.equal(requested.has('one-50.svg'),true,'Scrolling up loads older images on demand');
   await page.locator('#promptstudio-mobile-toggle-chats').click();
   await page.locator('.promptstudio-chat-row[data-active="false"] .promptstudio-chat-item').click();
   await page.waitForFunction(()=>!document.querySelector('.promptstudio-main').inert);
   await atEnd('#promptstudio-history');
   // Reader intent cancels deferred frame/image follow-to-end callbacks.
   await history.evaluate(n=>{n.scrollTo({top:100,behavior:'instant'});n.dispatchEvent(new Event('scroll'));});
   releases.two();
   await history.locator('img').first().evaluate(n=>n.decode());
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.ok(await history.evaluate(n=>n.scrollHeight-n.scrollTop-n.clientHeight)>1000,'Late images must not pull the reader back down');
   await page.locator('#promptstudio-mobile-toggle-chats').click();
   await page.locator('.promptstudio-chat-row[data-active="true"] .promptstudio-chat-item').click();
   await decoded();await atEnd('#promptstudio-history');
   await page.reload();await page.waitForFunction(()=>window.studioReady);await decoded();await atEnd('#promptstudio-history');
   if(videoEnabled){
     await attachVideo(page);
     await page.evaluate(async()=>{
       const video=await import('/extensions/PromptStudio_Video/js/promptstudio_video_studio.js');
       video.directorSession('video','project').messages=Array.from({length:70},(_,i)=>({id:`director-${i}`,role:i%2?'assistant':'user',text:`Director message ${i}: ${'A long conversation. '.repeat(12)}`}));
     });
     const open=()=>page.locator('#psvstudio-video-director').click();
     await open();await atEnd('#psvstudio-director-history');
     await page.locator('#psvstudio-director-history').evaluate(n=>{n.scrollTop=100;});
     await page.keyboard.press('Escape');await open();await atEnd('#psvstudio-director-history');
   }
   assert.deepEqual(fixture.errors,[]);
 }finally{Object.values(releases).forEach(release=>release());await fixture.close();}
}
console.log('Chat opening: latest message on tablet landscape/portrait and phone, lazy images, reader scroll, reopen/reload and optional Video Director passed.');
