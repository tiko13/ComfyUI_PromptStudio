import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';

const fixture=await startFixture();
const metadata={version:1,revision:3,last_turn_id:'u1',locked_literals:[{id:'sign',text:'OPEN',kind:'visible_text',evidence:{source:'user',turn_id:'u1',quote:'OPEN'}}],
 exclusions:['lamp','mirror'].map(text=>({id:text,text,evidence:{source:'user',turn_id:'u1',quote:`Remove the ${text}`}})),
 source_tags:[],suppressed_sources:[{source:'style',source_id:'style_preset',constraint_id:'mirror'}],edit_scope:null,manual_final:null};
try {
 await fixture.context.route('**/extensions/ComfyUI_PromptStudio/js/prompt_studio.js',async route=>{
  const response=await route.fetch();await route.fulfill({response,body:await response.text()+'\nwindow.constraintsActions={restoreChatState,undoPrompt,flushChatStore,updateComposeMode};'});
 });
 const page=await fixture.newPage();
 const current=()=>page.evaluate(async()=>{const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');return structuredClone(state.chats.find(c=>c.id===state.activeChatId));});
 await page.evaluate(async metadata=>{
  const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
  const chat=state.chats.find(c=>c.id===state.activeChatId);
  Object.assign(chat,{initialized:true,mainPrompt:'A sign reads OPEN.',finalPrompt:'A sign reads OPEN.',currentPrompt:'A sign reads OPEN.',renderedMainPrompt:'A sign reads OPEN.',renderedFinalPrompt:'A sign reads OPEN.',mainPromptDirty:false,intentProvenance:metadata,
   versions:[{mainPrompt:'A sign reads OPEN.',finalPrompt:'A sign reads OPEN.',intentProvenance:metadata}],versionIndex:0});
  window.constraintsActions.restoreChatState(chat);window.constraintsActions.updateComposeMode();
 },metadata);
 const button=page.getByRole('button',{name:'Constraints',exact:true});
 assert.equal(await page.locator('#promptstudio-reset-constraints').count(),0);
 const placement=await button.evaluate(button=>({previous:button.previousElementSibling?.getAttribute('aria-label'),inside:button.closest('[role="radiogroup"]')!==null}));
 assert.deepEqual(placement,{previous:'Generation action',inside:false});
 await button.click();
 const dialog=page.getByRole('dialog',{name:'Constraints',exact:true});
 await dialog.getByRole('button',{name:'Delete constraint: mirror',exact:true}).click();
 await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
 assert.deepEqual((await current()).intentProvenance,metadata,'Escape discards draft deletions');
 assert.equal(await button.evaluate(el=>el===el.ownerDocument.activeElement),true);
 await button.click();
 await dialog.getByRole('button',{name:'Delete constraint: mirror',exact:true}).click();
 await dialog.getByLabel('Constraint text',{exact:true}).fill('vase');
 await dialog.getByRole('button',{name:'Add constraint',exact:true}).click();
 await dialog.getByLabel('Constraint type',{exact:true}).selectOption('literal');
 await dialog.getByLabel('Constraint text',{exact:true}).fill('HELLO');
 await dialog.getByRole('button',{name:'Add constraint',exact:true}).click();
 await dialog.getByRole('button',{name:'Save',exact:true}).click();await dialog.waitFor({state:'detached'});
 let chat=await current();
 assert.deepEqual(chat.intentProvenance.exclusions.map(item=>item.text),['lamp','vase']);
 assert.deepEqual(chat.intentProvenance.locked_literals.map(item=>item.text),['OPEN','HELLO']);
 assert.deepEqual(chat.intentProvenance.suppressed_sources,[]);
 assert.equal(chat.mainPrompt,'A sign reads OPEN.');assert.equal(chat.finalPrompt,chat.mainPrompt);
 assert.equal(chat.controlsFingerprint,'');assert.equal(chat.pendingGeneration,null);
 await page.evaluate(()=>window.constraintsActions.undoPrompt());
 assert.deepEqual((await current()).intentProvenance,metadata,'Undo restores the entire previous constraint set');
 await button.click();
 await dialog.getByRole('button',{name:'Delete constraint: mirror',exact:true}).click();
 await dialog.getByRole('button',{name:'Save',exact:true}).click();await dialog.waitFor({state:'detached'});
 await page.evaluate(()=>window.constraintsActions.flushChatStore());
 await page.reload();await page.waitForFunction(()=>window.studioReady||window.bootError);
 assert.equal(await page.evaluate(()=>window.bootError),undefined);
 chat=await current();assert.deepEqual(chat.intentProvenance.exclusions.map(item=>item.text),['lamp']);
 assert.deepEqual(chat.intentProvenance.locked_literals,metadata.locked_literals);
 await page.setViewportSize({width:390,height:844});await button.scrollIntoViewIfNeeded();await button.click();
 const bounds=await dialog.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=390);
 await dialog.getByLabel('Constraint text',{exact:true}).fill('lamp');
 await dialog.getByRole('button',{name:'Add constraint',exact:true}).click();
 assert.match(await dialog.getByRole('status').textContent(),/already/);
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.deepEqual((await current()).intentProvenance.exclusions.map(item=>item.text),['lamp']);
 assert.deepEqual(fixture.errors,[]);
 console.log('Constraints: placement, individual add/delete, exact text, Save/Cancel/Escape, Undo, reload, focus and mobile passed.');
} finally {await fixture.close();}
