import assert from 'node:assert/strict';
import {startFixture,attachVideo,videoEnabled} from './fixture.mjs';
const fixture=await startFixture();
let requests=0,active=0,maximum=0,baselineRequests=0;
try {
 await fixture.context.addInitScript(()=>{
  const originalSet=window.setInterval,originalClear=window.clearInterval;window.activeIntervals=new Set();
  window.setInterval=(...args)=>{const id=originalSet(...args);window.activeIntervals.add(id);return id;};
  window.clearInterval=id=>{window.activeIntervals.delete(id);originalClear(id);};
 });
 await fixture.context.route('**/promptstudio/prompt-studio/llm/status',async route=>{
  if(route.request().headers()['x-test-baseline']==='true') {
   baselineRequests++;await route.fulfill({json:{provider:'koboldcpp',reachable:true,busy:false}});return;
  }
  requests++;maximum=Math.max(maximum,++active);await new Promise(resolve=>setTimeout(resolve,60));active--;
  await route.fulfill({json:{provider:'koboldcpp',reachable:true,busy:false}});
 });
 const page=await fixture.newPage();if (videoEnabled) await attachVideo(page);
 const intervals=await page.evaluate(()=>window.activeIntervals.size);
 for(let i=0;i<10;i++)await page.evaluate(async video=>{
  await window.__promptstudioPromptStudioHost.attach(window);if (video) await window.__promptstudioVideoStudioHost.attach(window);
 },videoEnabled);
 assert.equal(await page.evaluate(()=>window.activeIntervals.size),intervals,'Reattachment must not add interval owners');
 await page.evaluate(()=>{
  document.querySelector('#promptstudio-image-mount').hidden=false;document.querySelector('#promptstudio-video-mount').hidden=false;
  document.querySelector('#promptstudio-prompt-studio').hidden=false;
  const video=document.querySelector('.psvstudio-app');if(video)video.hidden=false;
  document.dispatchEvent(new Event('visibilitychange'));
 });
 await page.waitForTimeout(2100);const before=requests;
 await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 await page.waitForTimeout(300);
 assert.equal(requests-before,1,'Visible studios share one fresh provider-health request');
 assert.equal(maximum,1,'Identical provider-health requests must not overlap');
 const start=requests;await page.waitForTimeout(6500);const measured=requests-start;
 assert.ok(measured<=3,`Expected one shared 3-second loop, observed ${measured} requests`);
 // Measure the previous two-independent-interval scheduling pattern on the same fixture.
 await page.evaluate(()=>{
  const poll=()=>fetch('/promptstudio/prompt-studio/llm/status',{method:'POST',headers:{'x-test-baseline':'true'},body:'{}'});
  window.baselineTimers=[setInterval(poll,3000),setInterval(poll,3000)];
 });
 await page.waitForTimeout(6500);await page.evaluate(()=>window.baselineTimers.forEach(clearInterval));
 assert.equal(baselineRequests,4);assert.ok(measured<baselineRequests);
 await fixture.context.setOffline(true);await page.evaluate(()=>window.dispatchEvent(new Event('offline')));
 await page.waitForTimeout(3300);const offline=requests;await page.waitForTimeout(500);assert.equal(requests,offline);
 await fixture.context.setOffline(false);await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 await page.waitForFunction(()=>document.querySelector('#promptstudio-kobold-control')?.dataset.state==='idle');
 assert.deepEqual(fixture.errors,[]);
 console.log(`Polling: ${baselineRequests} requests with two independent 3s intervals versus ${measured} shared requests / 6.5s; max concurrency ${maximum}; 10 reattachments and reconnect passed.`);
} finally {await fixture.close();}
