import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';

const fixture=await startFixture();
try {
 const page=await fixture.context.newPage();
 await page.route(fixture.origin+'/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Intent module verification</title>'}));
 await page.goto(fixture.origin+'/');
 const result=await page.evaluate(async()=>{
  const api=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/chat/intent-provenance.js');
  const old={mainPrompt:'A cat by a window.',finalPrompt:'A cat by a window beside a brass lamp.'};
  const session=api.createIntentSession(null,{turnId:'u2',userText:'Remove the lamp',...old});
  const sidecar={version:1,revision:1,last_turn_id:'u2',locked_literals:[],exclusions:[{id:'lamp',text:'lamp',evidence:{source:'user',turn_id:'u2',quote:'Remove the lamp'}}],source_tags:[],suppressed_sources:[{source:'secondary',source_id:'secondary_instructions'}],edit_scope:{kind:'final_only',targets:['lamp'],spans:[]},manual_final:null};
  session.accept({intent_provenance:sidecar});
  const saved=api.promptIntentVersion(old.mainPrompt,'A cat by a window.',session.snapshot());
  localStorage.setItem('synthetic-intent',JSON.stringify(saved));
  const restored=api.restorePromptIntentVersion(JSON.parse(localStorage.getItem('synthetic-intent')));
  const manual=api.recordManualFinal(restored.intentProvenance,'My exact Final.');
  const replay={workflow:{nodes:[],extra:{keep:true}},output:{'1':{inputs:{seed:39,prompt:'Historical Final'}}},intentProvenance:null};
  return {restored,manual,secondary:api.effectiveSecondaryInstructions(restored.intentProvenance,'Add a brass lamp'),replay:api.intentReplayRecord(replay),historical:replay,request:session.payload({mode:'render'})};
 });
 assert.equal(result.restored.mainPrompt,'A cat by a window.');
 assert.equal(result.restored.finalPrompt,'A cat by a window.');
 assert.equal(result.secondary,'');
 assert.equal(result.manual.manual_final.text,'My exact Final.');
 assert.equal(result.request.intent_provenance.exclusions[0].text,'lamp');
 assert.deepEqual(result.replay,result.historical);
 await fixture.context.route('**/extensions/ComfyUI_PromptStudio/js/prompt_studio.js',async route=>{
  const response=await route.fetch();await route.fulfill({response,body:(await response.text())+'\nwindow.intentActions={reviseAndMaybeGenerate,queueGeneration,undoPrompt,syncCanonicalEditor,commitPromptEditorVersion,restoreChatState,controlsFingerprint};'});
 });
 await fixture.context.route('**/scripts/api.js',async route=>{
  const response=await route.fetch();await route.fulfill({response,body:(await response.text())+'\napi.queuePrompt=async(_,snapshot)=>{window.intentQueued=structuredClone(snapshot);return {prompt_id:"intent-replay"};};'});
 });
 const calls=[];
 let failFinal=false;
 const sidecar=result.restored.intentProvenance;
 await fixture.context.route('**/promptstudio/prompt-studio/revise',async route=>{
  const request=route.request().postDataJSON();calls.push(request);
  if(failFinal&&request.mode!=='revise_main')return route.fulfill({status:400,json:{error:'Synthetic preservation rejection'}});
  await route.fulfill({json:{prompt:'A cat by a window.',intent_provenance:{...sidecar,last_turn_id:request.intent_turn_id},warning:'secondary addition was skipped to preserve your exclusion for lamp.'}});
 });
 const appPage=await fixture.newPage();
 await appPage.evaluate(async()=>{
  const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
  const chat=state.chats.find(c=>c.id===state.activeChatId);
  Object.assign(chat,{initialized:true,mainPrompt:'A cat by a window.',finalPrompt:'A cat by a window beside a brass lamp.',currentPrompt:'A cat by a window beside a brass lamp.',renderedMainPrompt:'A cat by a window.',renderedFinalPrompt:'A cat by a window beside a brass lamp.',mainPromptDirty:false,intentProvenance:null,versions:[{mainPrompt:'A cat by a window.',finalPrompt:'A cat by a window beside a brass lamp.',intentProvenance:null}],versionIndex:0});
  window.intentActions.restoreChatState(chat);
  state.workflowProfiles=[{id:'synthetic',name:'[PS] Synthetic',kind:'create',promptNodeId:'1',loraNodes:[],modelNodes:[]}];
  const select=document.querySelector('#promptstudio-create-workflow');select.replaceChildren(new Option('[PS] Synthetic','synthetic'));select.value='synthetic';
  document.querySelector('#promptstudio-auto-generate').checked=false;
  document.querySelector('#promptstudio-use-llm-amplification').checked=true;
  chat.controlsFingerprint=window.intentActions.controlsFingerprint();
 });
 assert.equal(await appPage.evaluate(()=>window.intentActions.reviseAndMaybeGenerate({revisionOverride:'Remove the lamp',recordRevision:false})),true);
 assert.equal(calls.length,2);
 assert.equal(calls[0].intent_tracking,true);
 assert.equal(calls[1].intent_provenance.exclusions[0].text,'lamp');
 assert.equal(calls[0].intent_turn_id,calls[1].intent_turn_id);
 const current=()=>appPage.evaluate(async()=>{const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');return structuredClone(state.chats.find(c=>c.id===state.activeChatId));});
 let chat=await current();
 assert.equal(chat.mainPrompt,'A cat by a window.');assert.equal(chat.finalPrompt,chat.mainPrompt);assert.equal(chat.pendingGeneration.intentProvenance.exclusions[0].text,'lamp');
 failFinal=true;
 assert.equal(await appPage.evaluate(()=>window.intentActions.reviseAndMaybeGenerate({revisionOverride:'Make the light warm',recordRevision:false})),false);
 assert.deepEqual((await current()).intentProvenance,chat.intentProvenance,'A failed second stage cannot publish intent metadata');
 await appPage.evaluate(()=>{window.intentActions.syncCanonicalEditor('My exact manual Final.',{userEdit:true});window.intentActions.commitPromptEditorVersion();});
 assert.equal((await current()).intentProvenance.manual_final.text,'My exact manual Final.');
 await appPage.evaluate(()=>window.intentActions.undoPrompt());
 assert.equal((await current()).finalPrompt,'A cat by a window.');
 assert.equal((await current()).intentProvenance.manual_final,null);
 await appPage.waitForFunction(async()=>{
  const store=await (await fetch('/promptstudio/prompt-studio/chats')).json();
  return store.chats.some(chat=>chat.finalPrompt==='A cat by a window.'&&chat.intentProvenance?.exclusions?.[0]?.text==='lamp'&&chat.intentProvenance?.manual_final===null);
 });
 await appPage.reload();await appPage.waitForFunction(()=>window.studioReady||window.bootError);
 assert.equal(await appPage.evaluate(()=>window.bootError),undefined);
 assert.equal((await current()).intentProvenance.exclusions[0].text,'lamp','The application reload retains the committed exclusion');
 assert.equal((await current()).mainPrompt,'A cat by a window.');
 const saved={workflow:{nodes:[],links:[],extra:{original:true}},output:{'3':{class_type:'Sampler',inputs:{seed:39,prompt:'Historical lamp stays in exact replay'}}}};
 await appPage.evaluate(snapshot=>{window.intentReplayPromise=window.intentActions.queueGeneration({generationSnapshot:snapshot,workflowProfileId:'removed-profile',resultNodeIds:['3'],resultFields:['images'],preserveSeed:true,independent:true});},saved);
 await appPage.getByRole('dialog',{name:'Review saved replay'}).waitFor();
 assert.equal(await appPage.evaluate(()=>window.intentQueued),undefined);
 await appPage.getByRole('button',{name:'Replay saved inputs',exact:true}).click();
 await appPage.waitForFunction(()=>Boolean(window.intentQueued));
 assert.deepEqual(await appPage.evaluate(()=>window.intentQueued),saved,'Exact replay preserves saved inputs without any current compatible profile');
 assert.deepEqual(fixture.errors,[]);
 console.log('Browser intent: real revision handlers share metadata atomically; manual Final/Undo preserve sidecars; saved replay reviews and queues exact inputs without a current profile. Controlled provider and queue fixture.');
} finally {await fixture.close();}
