import assert from 'node:assert/strict';
import AxeBuilder from '@axe-core/playwright';
import {startFixture,root} from './fixture.mjs';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
const fixture=await startFixture({contextOptions:{hasTouch:true}});
try{
 const page=await fixture.newPage();
 await mkdir(resolve(root,'test-results/browser'),{recursive:true});
 const composer=page.locator('.promptstudio-compose'),options=page.locator('.promptstudio-compose-options');
 for(const [width,height] of [[1194,834],[1366,1024],[1600,1000],[1024,768],[844,390]]){
   await page.setViewportSize({width,height});
   await page.waitForFunction(()=>document.querySelector('#promptstudio-prompt-studio').hasAttribute('data-compact-composer'));
   await page.locator('#promptstudio-revision').fill('Keep this draft');
   // Resize and textarea autosizing settle on animation frames. Observe stable
   // geometry before comparing separate bounding-box reads across those frames.
   await page.evaluate(async()=>{
     await document.fonts.ready;
     let previous='',stable=0;
     while(stable<2){
       await new Promise(requestAnimationFrame);
       const current=JSON.stringify(['.promptstudio-compose','#promptstudio-revision','#promptstudio-send']
         .map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return [r.x,r.y,r.width,r.height];}));
       stable=current===previous?stable+1:0;previous=current;
     }
   });
   const size=await composer.boundingBox();
   assert.ok(size.height<=80,`Landscape composer at ${width}x${height}: ${size.height}px`);
   const input=await page.locator('#promptstudio-revision').boundingBox(),send=await page.locator('#promptstudio-send').boundingBox();
   assert.ok(Math.abs(input.y-send.y)<3,'Input and Send share one row');
   await options.locator('summary').click();
   assert.ok(Math.abs((await composer.boundingBox()).height-size.height)<3,'More must float above the composer');
   assert.equal(await page.locator('#promptstudio-reroll').isVisible(),true);
   await page.locator('#promptstudio-auto-generate').uncheck();
   await page.keyboard.press('Escape');
   assert.equal(await options.evaluate(n=>n.open),false);
   assert.equal(await page.locator('#promptstudio-auto-generate').isChecked(),false);
   assert.equal(await page.locator('#promptstudio-revision').inputValue(),'Keep this draft');
   if(width===1366){
     await page.screenshot({path:resolve(root,'test-results/browser/compact-composer-landscape.png')});
     await options.locator('summary').click();
     const audit=await new AxeBuilder({page}).include('.promptstudio-compose').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
     assert.deepEqual(audit.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);
     await page.locator('#promptstudio-constraints').click();
     const dialog=page.getByRole('dialog',{name:'Constraints',exact:true});await dialog.waitFor();
     assert.equal(await options.evaluate(n=>n.open),false);
     await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
     assert.equal(await options.locator('summary').evaluate(n=>n===document.activeElement),true,'Modal dismissal returns to visible More');
   }
 }
 await page.locator('#promptstudio-revision').fill('Long draft\nsecond line\nthird line\nfourth line\nfifth line');
 const editingHeight=(await page.locator('#promptstudio-revision').boundingBox()).height;
 assert.ok(editingHeight>44&&editingHeight<=112,'Long drafts expand only within the compact editing limit');
 await options.locator('summary').click();
 assert.equal((await page.locator('#promptstudio-revision').boundingBox()).height,44);
 await page.setViewportSize({width:1024,height:1366});
 await page.waitForFunction(()=>!document.querySelector('#promptstudio-prompt-studio').hasAttribute('data-compact-composer'));
 assert.equal(await page.locator('.promptstudio-actions #promptstudio-reroll').count(),1,'Portrait restores existing controls');
 assert.match(await page.locator('#promptstudio-revision').inputValue(),/fifth line/);
 await page.setViewportSize({width:390,height:844});
 assert.equal(await options.locator('summary').textContent(),'Options');
 assert.equal(await page.locator('#promptstudio-auto-generate').isChecked(),false);
 assert.deepEqual(fixture.errors,[]);
 console.log('Compact landscape composer: <=80px, one input row, upward More, accessible controls, draft/settings retention and rotation passed.');
}finally{await fixture.close();}
