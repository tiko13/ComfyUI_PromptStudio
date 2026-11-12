import assert from 'node:assert/strict';
import AxeBuilder from '@axe-core/playwright';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {startFixture,attachVideo,videoEnabled,root} from './fixture.mjs';
const fixture=await startFixture({contextOptions:{hasTouch:true,reducedMotion:'no-preference'}});
try {
  await fixture.context.route('**/js/prompt_studio.js',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nwindow.touchTest={appendMessage};'});
  });
  if(videoEnabled) await fixture.context.route('**/js/promptstudio_video_studio.js',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nwindow.videoTouchTest={showMediaPreview};'});
  });
  await fixture.context.route('**/view?*',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#304966"/><circle cx="580" cy="130" r="70" fill="#e7b97e"/></svg>'}));
  const page=await fixture.newPage();
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>window.touchTest.appendMessage('assistant','',{messageId:'touch-result',images:[{filename:'touch.png',type:'output',width:800,height:500}]}));
  const preview=page.locator('[data-message-id="touch-result"] .promptstudio-image-preview');
  const host=page.locator('#promptstudio-lightbox'), image=host.locator('img');
  const cdp=await fixture.context.newCDPSession(page);
  const touch=(type,points,timestamp)=>cdp.send('Input.dispatchTouchEvent',{type,...(timestamp?{timestamp}:{}),touchPoints:points.map((p,id)=>({x:p[0],y:p[1],id,radiusX:2,radiusY:2}))});
  const settle=async target=>target.evaluate(async n=>{await Promise.all(n.getAnimations().map(a=>a.finished.catch(()=>{})));});
  const center=async target=>{const box=await target.boundingBox();return [box.x+box.width/2,box.y+box.height/2];};
  const drag=async(target,dy,cancel=false)=>{
    await settle(target); const [x,y]=await center(target);
    await touch('touchStart',[[x,y]]);
    for(const fraction of [.25,.5,.75,1])await touch('touchMove',[[x,y+dy*fraction]]);
    await touch(cancel?'touchCancel':'touchEnd',[]);
  };
  await preview.tap(); await image.waitFor();
  await image.evaluate(n=>n.decode()); await settle(image);
  await mkdir(resolve(root,'test-results/browser'),{recursive:true});
  await page.screenshot({path:resolve(root,'test-results/browser/touch-image-viewer.png')});
  assert.equal(await image.evaluate(n=>getComputedStyle(n).touchAction),'none');
  const audit=await new AxeBuilder({page}).include('#promptstudio-lightbox').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  assert.deepEqual(audit.violations.map(v=>v.id),[]);
  await drag(image,25); await settle(image);
  assert.equal(await host.isVisible(),true,'Short drag returns to rest');
  await drag(image,200,true); await settle(image);
  assert.equal(await host.isVisible(),true,'System cancellation never dismisses');
  let [x,y]=await center(image);
  await touch('touchStart',[[x-40,y],[x+40,y]]);
  await touch('touchMove',[[x-95,y],[x+95,y]]);
  await touch('touchEnd',[]);
  assert.ok(await image.evaluate(n=>new DOMMatrixReadOnly(getComputedStyle(n).transform).a)>2,'Pinch zooms the image');
  await drag(image,180);
  assert.equal(await host.isVisible(),true,'Panning a zoomed image cannot dismiss it');
  await host.getByRole('button',{name:'Zoom image in or reset to fit'}).click(); await settle(image);
  [x,y]=await center(image); await page.touchscreen.tap(x,y);await page.touchscreen.tap(x,y);await settle(image);
  assert.ok(await image.evaluate(n=>new DOMMatrixReadOnly(getComputedStyle(n).transform).a)>2,'Double tap zooms');
  await page.keyboard.press('ArrowRight');
  assert.ok(await image.evaluate(n=>new DOMMatrixReadOnly(getComputedStyle(n).transform).e)<0,'Keyboard can pan a zoomed image');
  await host.getByRole('button',{name:'Zoom image in or reset to fit'}).click();await settle(image);
  await drag(image,210); await host.waitFor({state:'hidden'});
  assert.equal(await preview.evaluate(n=>n===document.activeElement),true,'Dismiss restores thumbnail focus');
  assert.equal(await page.locator('[data-message-id="touch-result"]').count(),1,'Dismiss never deletes the image');
  await page.emulateMedia({reducedMotion:'reduce'});
  await preview.tap();await host.waitFor({state:'visible'});await image.evaluate(n=>n.decode());
  assert.equal(await image.evaluate(n=>n.getAnimations().length),0,'Reduced motion avoids opening zoom');
  // Explicit input timestamps distinguish a fast flick from a slow drag,
  // independently of machine load and CDP delivery latency.
  [x,y]=await center(image);const flickTime=Date.now()/1000-.1;
  await touch('touchStart',[[x,y]],flickTime);
  await touch('touchMove',[[x,y+30]],flickTime+.01);
  await touch('touchMove',[[x,y+60]],flickTime+.02);
  await touch('touchEnd',[],flickTime+.03);
  await host.waitFor({state:'hidden'});
  assert.equal(await page.locator('[data-message-id="touch-result"]').count(),1,'A short fast flick closes without deletion');
  await preview.tap();await host.waitFor({state:'visible'});
  await host.getByRole('button',{name:'Close image preview'}).click();await host.waitFor({state:'hidden'});
  await page.locator('[data-message-id="touch-result"]').getByRole('button',{name:'More actions for touch.png'}).tap();
  const sheet=page.getByRole('dialog',{name:'Image actions',exact:true});
  await page.screenshot({path:resolve(root,'test-results/browser/touch-image-sheet.png')});
  await drag(sheet.locator('header strong'),160);
  await sheet.waitFor({state:'detached'});
  if(videoEnabled){
    await page.setViewportSize({width:1600,height:1000});await attachVideo(page);
    await page.evaluate(()=>window.videoTouchTest.showMediaPreview({kind:'image',path:'touch.png',name:'Reference'},'Reference'));
    const videoPreview=page.getByRole('dialog',{name:'Reference preview',exact:true});
    await videoPreview.locator('img').evaluate(n=>n.decode());
    await drag(videoPreview.locator('img'),230);
    await videoPreview.waitFor({state:'detached'});
  }
  assert.deepEqual(fixture.errors,[]);
  console.log('Touch media: pinch, pan, double tap, short/cancelled drags, flick dismissal, focus, retained images, sheet swipe, accessibility and reduced motion passed.');
}finally{await fixture.close();}
