import assert from 'node:assert/strict';
import {startFixture,attachVideo} from './fixture.mjs';
const fixture=await startFixture();
try {
 const page=await fixture.newPage();
 const imageSummary=page.locator('#promptstudio-run-summary');
 assert.match(await imageSummary.innerText(),/Main from chat; controls shape Final/);
 await page.locator('#promptstudio-auto-generate').uncheck();
 assert.match(await imageSummary.innerText(),/Update prompts only/);
 await page.locator('#promptstudio-revision').fill('Make the dress casual');
 assert.match(await imageSummary.innerText(),/discussion or a prompt change; generation is off/);
 await attachVideo(page);
 await page.locator('#psvstudio-new-project').click();
 const videoSummary=page.locator('#psvstudio-run-summary');
 assert.match(await videoSummary.innerText(),/Compiled from authored shots/);
 await page.locator('#psvstudio-new-seed').uncheck();
 assert.match(await videoSummary.innerText(),/Workflow seed/);
 await page.getByRole('button',{name:'Edit shot',exact:true}).click();
 await page.getByLabel('Subjects and positions',{exact:true}).fill('Temporary unsaved shot edit');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('button',{name:'Edit shot',exact:true}).click();
 assert.notEqual(await page.getByLabel('Subjects and positions',{exact:true}).inputValue(),'Temporary unsaved shot edit');
 await page.keyboard.press('Escape');
 for(const width of [768,390]) {
  await page.setViewportSize({width,height:1000});
  assert.equal(await videoSummary.isVisible(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 }
 assert.deepEqual(fixture.errors,[]);
 console.log('Workspace action summary, seed source, shot Cancel, and narrow layouts passed.');
} finally {await fixture.close();}
