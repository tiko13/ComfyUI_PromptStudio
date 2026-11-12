import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';
const fixture=await startFixture({contextOptions:{hasTouch:true}});
try{
 await fixture.context.route('**/js/prompt_studio.js',async route=>{
   const response=await route.fetch();await route.fulfill({response,body:await response.text()+'\nwindow.scaleTest={appendMessage,state,saveChats};'});
 });
 await fixture.context.route('**/view?*',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#345"/></svg>'}));
 const page=await fixture.newPage();
 await page.evaluate(()=>window.scaleTest.appendMessage('assistant','',{messageId:'scale-result',canonicalPrompt:'A landscape',images:[{filename:'scale.svg',type:'output',width:800,height:500}]}));
 const message=page.locator('[data-message-id="scale-result"]');
 const scale=page.locator('#promptstudio-image-scale');
 const settings=async()=>{
   if(await page.locator('.promptstudio-inspector').evaluate(n=>getComputedStyle(n).position==='absolute')
     &&await page.locator('#promptstudio-mobile-toggle-inspector').getAttribute('aria-expanded')!=='true')await page.locator('#promptstudio-mobile-toggle-inspector').click();
   await page.locator('#promptstudio-toggle-studio-settings').click();
 };
 const close=async()=>{
   await page.locator('#promptstudio-close-studio-settings').click();
   if(await page.locator('#promptstudio-close-inspector').isVisible())await page.locator('#promptstudio-close-inspector').click();
 };
 for(const [width,height] of [[390,844],[820,1180],[1366,1024],[1600,1000]]){
   await page.setViewportSize({width,height});await settings();
   await scale.focus();await scale.press('End');
   const full=(await message.boundingBox()).width;
   await scale.press('Home');for(let i=0;i<8;i++)await scale.press('ArrowRight');
   assert.equal(await page.locator('#promptstudio-image-scale-value').textContent(),'50%');
   assert.ok(Math.abs((await message.boundingBox()).width/full-.5)<.01,`50% scale must halve the card width at ${width}px`);
   await scale.press('Home');
   const small=(await message.boundingBox()).width;
   assert.ok(Math.abs(small-Math.max(48,full*.1))<2,'Small thumbnails respect scale with a minimum touch target');
   await close();await message.scrollIntoViewIfNeeded();
   const actions=message.locator('.promptstudio-image-compact-actions');
   assert.equal(await actions.evaluate(n=>n.scrollWidth<=n.clientWidth),true,'Small action row cannot overflow');
   await message.getByRole('button',{name:'More actions for scale.svg'}).click();
   const sheet=page.getByRole('dialog',{name:'Image actions',exact:true});
   assert.equal(await sheet.getByRole('button',{name:'Edit image',exact:true}).isVisible(),true);
   await sheet.getByRole('button',{name:'Details',exact:true}).click();
   const details=page.getByRole('dialog',{name:'Image details',exact:true});await details.waitFor();
   assert.match(await details.innerText(),/A landscape/);
   await page.keyboard.press('Escape');await details.waitFor({state:'detached'});
 }
 await settings();await scale.press('End');await scale.press('ArrowLeft');
 await close();
 await page.reload();await page.waitForFunction(()=>window.studioReady);
 assert.equal(await scale.inputValue(),'95','Image scale survives refresh');
 assert.deepEqual(fixture.errors,[]);
 console.log('Image scale: actual slider updates, 100/50/10%, phone/tablet/wide touch, usable small-card actions and persistence passed.');
}finally{await fixture.close();}
