import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';

const fixture = await startFixture();
let releaseFirst, releaseSaves;
const firstGate = new Promise(resolve => {releaseFirst=resolve;});
const saveGate = new Promise(resolve => {releaseSaves=resolve;});
let secondPrepared = false, holdSaves = false;
let workflowReads = 0;
const submitted = [];
try {
  await fixture.context.route('**/js/prompt_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nexport {createNewFromCurrentPrompt,refreshWorkflowControls,renderChatHistory,workflowQueueContext,scheduleWorkflowRefresh,flushChatStore};'});
  });
  await fixture.context.route('**/userdata/*', route => {
    workflowReads++;
    return route.fulfill({status:404,json:{error:'Workflow removed'}});
  });
  await fixture.context.route('**/scripts/api.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response,body:await response.text()+'\napi.queuePrompt=async(_,snapshot)=>(await fetch("/test-submit",{method:"POST",body:JSON.stringify(snapshot)})).json();'});
  });
  await fixture.context.route('**/test-submit', async route => {
    submitted.push(route.request().postDataJSON().output['1'].inputs.prompt);
    await route.fulfill({json:{prompt_id:`ordered-${submitted.length}`}});
  });
  await fixture.context.route('**/validate-final-prompts', async route => {
    const {prompts} = route.request().postDataJSON();
    if (prompts[0] === 'First click') await firstGate;
    else secondPrepared = true;
    await route.fulfill({json:{prompts}});
  });
  await fixture.context.route('**/promptstudio/prompt-studio/chats', async route => {
    if (holdSaves && route.request().method() === 'PUT') await saveGate;
    await route.continue().catch(()=>{});
  });
  const page = await fixture.newPage();
  await page.evaluate(async () => {
    const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    window.responsive = {m,state};
    const chat = state.chats.find(c=>c.id===state.activeChatId);
    chat.initialized=true; chat.createWorkflowId='fast';
    state.apiConnected=true;
    state.workflowProfiles=[{id:'fast',path:'[PS] Fast.json',name:'[PS] Fast',kind:'create',promptNodeId:'1',resultNodeIds:['2'],
      loraNodes:[],modelNodes:[],snapshot:{workflow:{nodes:[],links:[]},output:{
        '1':{class_type:'KCPP_PromptSlot',inputs:{prompt:'initial'}},'2':{class_type:'SaveImage',inputs:{}}
      }}}];
    m.refreshWorkflowControls();
    document.querySelector('#promptstudio-use-llm-amplification').checked=true;
    document.querySelector('#promptstudio-keep-models-loaded').checked=true;
  });
  const flushed = await page.evaluate(async () => {
    const {m,state}=window.responsive;
    await m.flushChatStore();
    const chat=state.chats.find(c=>c.id===state.activeChatId);
    const version=state.chatMutationVersion;
    chat.mainPrompt='Explicit flush must save current state';
    await m.flushChatStore();
    return {id:chat.id,unchangedVersion:state.chatMutationVersion===version};
  });
  assert.equal(flushed.unchangedVersion,true);
  assert.equal(fixture.chats.chats.find(chat=>chat.id===flushed.id).mainPrompt,'Explicit flush must save current state');
  holdSaves = true;
  await page.evaluate(() => {
    const post = Worker.prototype.postMessage;
    const delayed = [];
    Worker.prototype.postMessage = function(message, ...args) {
      if (message.database === 'promptstudio-draft-outbox-v1' && message.method === 'put') {
        delayed.push([this,structuredClone(message),args]); return;
      }
      return post.call(this,message,...args);
    };
    window.releaseArchive = () => {
      Worker.prototype.postMessage = post;
      for (const [worker,message,args] of delayed) post.call(worker,message,...args);
    };
  });
  await page.evaluate(() => {
    const {m,state} = window.responsive;
    const click = prompt => {
      state.mainPrompt=state.currentPrompt=prompt;
      document.querySelector('#promptstudio-current-prompt').value=prompt;
      return m.createNewFromCurrentPrompt({applyControls:false});
    };
    window.clicksDone = Promise.all([click('First click'),click('Second click')]);
  });
  await page.waitForFunction(()=>document.querySelectorAll('[data-message-id]').length>=2);
  // Observe preparation explicitly; do not use sleeps to race the queue.
  await assert.doesNotReject(async () => {
    for (let attempt=0;!secondPrepared && attempt<100;attempt++) await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(secondPrepared,true);
  });
  assert.deepEqual(submitted,[],'Later preparation must wait for the first request');
  assert.equal(await page.evaluate(()=>window.responsive.state.chats.flatMap(chat=>chat.messages)
    .filter(message=>message.operationId).every(message=>message.operationStatus==='Queueing cached workflow…')),true);
  releaseFirst();
  assert.deepEqual(await page.evaluate(()=>window.clicksDone),[true,true]);
  assert.deepEqual(submitted,['First click','Second click'],'Stalled local archive and server saves do not block either submission');
  assert.equal(workflowReads,0,'New-seed submissions must not read or rebuild the cached workflow');
  releaseSaves();
  await page.evaluate(()=>window.releaseArchive());

  const metrics = await page.evaluate(async () => {
    const {m,state} = window.responsive;
    const chat = state.chats.find(c=>c.id===state.activeChatId);
    // Stop fixture polling while benchmarking the real rendering/input paths.
    state.generationJobs.clear();
    clearTimeout(state.chatSaveTimer); state.chatSaveTimer=null;
    await state.chatSaveChain;
    state.chatPersistenceBlocked=true;
    const graph = {workflow:{nodes:[],extra:{large:'x'.repeat(32768)}},output:{}};
    chat.messages=Array.from({length:1000},(_,i)=>({id:`long-${i}`,role:'assistant',text:`Message ${i}`,
      images:[],createdAt:i+1,updatedAt:i+1,generationSnapshot:graph}));
    m.renderChatHistory();
    const history = state.panel.querySelector('#promptstudio-history');
    const original = history.firstChild;
    const renders=[];
    for(let i=0;i<10;i++) {
      chat.messages.at(-1).text=`Progress ${i}`;
      const start=performance.now();m.renderChatHistory();renders.push(performance.now()-start);
    }
    const editor = document.querySelector('#promptstudio-main-prompt');
    const inputs=[];
    for(let i=0;i<50;i++) {
      const start=performance.now();editor.value=`Typing ${i}`;
      editor.dispatchEvent(new Event('input',{bubbles:true}));inputs.push(performance.now()-start);
    }
    if (history.firstChild!==original) throw new Error('Long history was rebuilt while typing');
    const {createSearchableSelect} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/searchable-select.js');
    const select=createSearchableSelect({items:Array.from({length:10000},(_,i)=>({name:`model-${i}`,label:`Model ${i}`})),label:'Large catalog'});
    document.body.append(select.element);select.element.querySelector('input').focus();
    const initialOptions=select.element.querySelectorAll('[role=option]').length;
    const input=select.element.querySelector('input');input.value='model-9999';input.dispatchEvent(new Event('input'));
    const matches=[...select.element.querySelectorAll('[role=option]')].map(option=>option.title);
    select.element.remove();
    return {messages:1000,renderMedianMs:renders.sort((a,b)=>a-b)[5],inputMaxMs:Math.max(...inputs),initialOptions,matches};
  });
  assert.ok(metrics.initialOptions<=80,'Large catalog must bound initial DOM work');
  assert.deepEqual(metrics.matches,['model-9999'],'Search still includes the entire catalog');
  assert.ok(metrics.inputMaxMs<50,`Input handler became a long task: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.renderMedianMs<50,`History update became a long task: ${JSON.stringify(metrics)}`);
  await page.evaluate(async () => {
    const {m} = window.responsive;
    const first=await m.workflowQueueContext('create','fast');
    first.snapshot.output['1'].inputs.prompt='Only this request';
    const second=await m.workflowQueueContext('create','fast');
    if (second.snapshot.output['1'].inputs.prompt!=='initial') throw new Error('Queue mutated the cached workflow');
    m.scheduleWorkflowRefresh({paths:['workflows/[PS] Fast.json']});
    try { await m.workflowQueueContext('create','fast'); throw new Error('Deleted workflow remained cached'); }
    catch(error) { if (!error.message.includes('404')) throw error; }
  });
  assert.equal(workflowReads,1,'An observed workflow edit invalidates only the selected source');
  console.log('Responsiveness: FIFO rapid Create new, stalled server saves, 1000 messages with saved graphs, typing and 10000-item dropdown.',metrics);
  assert.deepEqual(fixture.errors,[]);
} finally {releaseFirst();releaseSaves();await fixture.close();}
