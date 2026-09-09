import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';

const fixture=await startFixture();
const before='A classroom with a sign "OPEN".';
const edited='A garden with a sign "OPEN".';
const metadata={version:1,revision:2,last_turn_id:'u2',locked_literals:[
  {id:'setting',kind:'literal',text:'classroom',evidence:{source:'user',turn_id:'u1',quote:'classroom'}},
  {id:'sign',kind:'visible_text',text:'OPEN',evidence:{source:'user',turn_id:'u1',quote:'OPEN'}},
],exclusions:[{id:'lamp',text:'lamp',evidence:{source:'user',turn_id:'u2',quote:'Remove the lamp'}}],
source_tags:[],suppressed_sources:[],edit_scope:{kind:'create',targets:[]},manual_final:null};
try {
  await fixture.context.route('**/extensions/ComfyUI_PromptStudio/js/prompt_studio.js',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nwindow.manualMainActions={restoreChatState,undoPrompt,reviseAndMaybeGenerate,controlsFingerprint};'});
  });
  const calls=[];
  await fixture.context.route('**/promptstudio/prompt-studio/revise',async route=>{
    const request=route.request().postDataJSON();calls.push(request);
    const stale=request.intent_provenance.locked_literals.find(item=>!edited.includes(item.text));
    if(stale)return route.fulfill({status:400,json:{error:`locked_literal_changed: ${stale.text}`}});
    await route.fulfill({json:{prompt:edited,intent_provenance:request.intent_provenance}});
  });
  const page=await fixture.newPage();
  const current=()=>page.evaluate(async()=>{
    const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    return structuredClone(state.chats.find(chat=>chat.id===state.activeChatId));
  });
  const configure=()=>page.evaluate(async()=>{
    const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    state.workflowProfiles=[{id:'synthetic',name:'[PS] Synthetic',kind:'create',promptNodeId:'1',loraNodes:[],modelNodes:[]}];
    const select=document.querySelector('#promptstudio-create-workflow');
    select.replaceChildren(new Option('[PS] Synthetic','synthetic'));select.value='synthetic';
    document.querySelector('#promptstudio-auto-generate').checked=false;
    document.querySelector('#promptstudio-use-llm-amplification').checked=true;
    const chat=state.chats.find(chat=>chat.id===state.activeChatId);
    chat.controlsFingerprint=window.manualMainActions.controlsFingerprint();
  });
  await page.evaluate(async({before,metadata})=>{
    const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const chat=state.chats.find(chat=>chat.id===state.activeChatId);
    Object.assign(chat,{initialized:true,mainPrompt:before,finalPrompt:before,currentPrompt:before,
      renderedMainPrompt:before,renderedFinalPrompt:before,mainPromptDirty:false,intentProvenance:metadata,
      messages:[{id:'u1',role:'user',text:before,images:[],createdAt:Date.now()}],
      versions:[{mainPrompt:before,finalPrompt:before,intentProvenance:metadata}],versionIndex:0});
    window.manualMainActions.restoreChatState(chat);
  },{before,metadata});
  await configure();
  const editor=page.locator('#promptstudio-main-prompt');
  await editor.fill('');
  await editor.fill(before);
  await editor.press('Tab');
  assert.deepEqual((await current()).intentProvenance,metadata,'Temporary typing must not discard locks');
  await editor.fill(edited);
  await editor.press('Tab');
  let chat=await current();
  assert.deepEqual(chat.intentProvenance.locked_literals.map(item=>item.id),['sign']);
  assert.deepEqual(chat.intentProvenance.exclusions,metadata.exclusions);
  assert.equal(chat.intentProvenance.edit_scope,null);
  assert.equal(chat.finalPrompt,before,'Manual Main leaves Final pending rebuild');
  await page.evaluate(()=>window.manualMainActions.undoPrompt());
  chat=await current();
  assert.equal(chat.mainPrompt,before);
  assert.deepEqual(chat.intentProvenance,metadata,'Undo restores the original constraints');

  // Persist an input draft without blur, then rebuild after reload.
  await editor.fill(edited);
  await page.evaluate(async()=>{
    const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    for(let attempt=0;attempt<100;attempt++) {
      await state.chatSaveChain;
      if(!state.chatSaveTimer&&!state.chatSaveInFlight)return;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw new Error('Chat draft did not finish saving');
  });
  assert.ok(fixture.chats.chats.some(chat=>chat.mainPrompt===edited&&chat.mainPromptDirty));
  await page.reload();
  await page.waitForFunction(()=>window.studioReady||window.bootError);
  assert.equal(await page.evaluate(()=>window.bootError),undefined);
  assert.equal((await current()).mainPrompt,edited);
  await configure();
  await page.evaluate(()=>window.manualMainActions.reviseAndMaybeGenerate({controlsOnly:true,recordRevision:false}));
  assert.equal(calls.length,1,'Manual Main rebuild uses only the Final render stage');
  assert.equal(calls[0].mode,'render');
  assert.equal(calls[0].revision,edited);
  assert.deepEqual(calls[0].intent_provenance.locked_literals.map(item=>item.id),['sign']);
  chat=await current();
  assert.equal(chat.mainPrompt,edited);
  assert.equal(chat.finalPrompt,edited);
  assert.deepEqual(chat.pendingGeneration.intentProvenance.exclusions,metadata.exclusions);
  // Existing saved drafts from the old frontend already have the edited version
  // paired with stale metadata. Refreshing must repair those too.
  await page.evaluate(async({before,edited,metadata})=>{
    const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const chat=state.chats.find(chat=>chat.id===state.activeChatId);
    Object.assign(chat,{mainPrompt:edited,finalPrompt:before,currentPrompt:before,renderedMainPrompt:before,
      renderedFinalPrompt:before,mainPromptDirty:true,intentProvenance:metadata,pendingGeneration:null,
      versions:[{mainPrompt:edited,finalPrompt:before,intentProvenance:metadata}],versionIndex:0});
    window.manualMainActions.restoreChatState(chat);
  },{before,edited,metadata});
  await page.evaluate(()=>window.manualMainActions.reviseAndMaybeGenerate({controlsOnly:true,recordRevision:false}));
  assert.equal(calls.length,2);
  assert.deepEqual(calls[1].intent_provenance.locked_literals.map(item=>item.id),['sign']);
  assert.equal((await current()).finalPrompt,edited);
  assert.deepEqual(fixture.errors,[]);
  console.log('Manual Main: typing, commit, Undo, draft reload and Create-mode rebuild pass with controlled provider responses.');
} finally {await fixture.close();}
