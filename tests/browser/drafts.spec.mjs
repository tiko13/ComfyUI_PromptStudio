import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';
const fixture=await startFixture();
const moduleUrl='/extensions/ComfyUI_PromptStudio/js/prompt-studio/chat/draft-outbox.js';
try {
 const page=await fixture.newPage();
 await page.evaluate(async url=>{
  const {createDraftOutbox}=await import(url);
  const outbox=createDraftOutbox({database:'test-drafts'});
  await outbox.put('video:tab',{mutation:1,revision:7,projects:[{id:'p1',name:'Unsent edit'}],deletedProjectIds:['intentionally-deleted']});
  await outbox.put('video:tab',{mutation:2,revision:7,projects:[{id:'p1',name:'Newer unsent edit'}],deletedProjectIds:['intentionally-deleted']});
  if(await outbox.acknowledge('video:tab',1)) throw new Error('Stale acknowledgement removed a newer edit');
  await outbox.close();
 },moduleUrl);
 await page.reload();await page.waitForFunction(()=>window.studioReady);
 const restored=await page.evaluate(async url=>{
  const {createDraftOutbox}=await import(url);const outbox=createDraftOutbox({database:'test-drafts'});
  const result=await outbox.get('video:tab');await outbox.acknowledge('video:tab',2);
  if(await outbox.get('video:tab'))throw new Error('Acknowledged draft remains');
  await outbox.close();return result;
 },moduleUrl);
 assert.equal(restored.projects[0].name,'Newer unsent edit');
 assert.deepEqual(restored.deletedProjectIds,['intentionally-deleted']);
 assert.ok(restored.saved_at>0);
 await page.evaluate(async url=>{
  const {createDraftOutbox,showDraftStorageFailure}=await import(url);
  const outbox=createDraftOutbox({indexedDB:{open(){throw new DOMException('Quota exhausted','QuotaExceededError');}}});
  try {await outbox.put('test',{mutation:1});throw new Error('Missing storage error');}
  catch(error){showDraftStorageFailure(document.querySelector('#promptstudio-prompt-studio'),{text:'preserved draft'},error.message);}
 },moduleUrl);
 assert.match(await page.locator('[data-draft-failure]').innerText(),/Quota exhausted/);
 const downloading=page.waitForEvent('download');
 await page.getByRole('button',{name:'Export unsaved draft',exact:true}).click();
 const download=await downloading;assert.match(download.suggestedFilename(),/promptstudio-draft.*\.json/);
 assert.equal(fixture.requests.some(request=>request.path==='/prompt'),false);
 console.log('IndexedDB reload, acknowledgement ordering, retained tombstones, denied storage and draft export passed.');
} finally {await fixture.close();}
