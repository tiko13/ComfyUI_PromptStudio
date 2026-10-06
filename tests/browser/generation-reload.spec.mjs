import assert from 'node:assert/strict';
import {startFixture, attachVideo, config, videoEnabled} from './fixture.mjs';

const fixture = await startFixture();
const message = (id, extra = {}) => ({id, role:'assistant', label:'ComfyUI', text:'',
  operationId:id, operationPhase:'generating', operationStatus:'Generating',
  generationState:'generating', promptId:id, images:[], createdAt:1, updatedAt:1, ...extra});
const submission = (id, operationId) => [0,id,{}, {extra_pnginfo:{workflow:{extra:{promptstudio_submission:operationId}}}}];
const completed = (id, operationId = id, video = false) => ({prompt:submission(id,operationId),
  status:{completed:true}, outputs:{'2':{[video?'videos':'images']:[{filename:video?'result.mp4':'result.png',type:'output',subfolder:''}]}}});
fixture.chats = {revision:1,activeChatId:'a',chats:[{id:'a',title:'Reload recovery',initialized:true,
  mainPrompt:'A test image',finalPrompt:'A test image',createdAt:1,updatedAt:1,messages:[
    message('finishing'), message('starting',{promptId:'',generationState:'',operationPhase:'queueing'}),
    message('orphan',{promptId:'',generationState:'',operationPhase:'preparing_workflow'}),
    message('reconnect'),
  ]}]};
if (videoEnabled) fixture.projects = {revision:1,active_project_id:'v',projects:[{id:'v',name:'Video reload',
  document:structuredClone(config.default_document),created_at:1,updated_at:1,generations:[{
    id:'v-submission',prompt_id:'',status:'queueing',kind:'base',document:structuredClone(config.default_document),
    outputs:[],result_node_ids:['2'],result_fields:['videos'],created_at:1,updated_at:1,
  }]}]};
let releaseFinish;
const finishGate = new Promise(resolve => {releaseFinish = resolve;});
let finishingRequests = 0, reconnectRequests = 0, queued = 0;
try {
  await fixture.context.route('**/scripts/api.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response,body:(await response.text())+'\napi.queuePrompt=async()=>{throw new Error("Recovery must never queue");};'});
  });
  await fixture.context.route('**/prompt', route => {queued++; return route.abort();});
  await fixture.context.route('**/promptstudio/prompt-studio/image-size', route => route.fulfill({json:{width:64,height:64}}));
  await fixture.context.route('**/history?*', route => route.fulfill({json:{
    'accepted-start':completed('accepted-start','starting'),
    'accepted-video':completed('accepted-video','v-submission',true),
  }}));
  await fixture.context.route('**/history/*', async route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1));
    if (id === 'finishing' && ++finishingRequests === 1) {
      await finishGate;
      return route.fulfill({json:{}}).catch(()=>{});
    }
    if (id === 'reconnect' && ++reconnectRequests === 1) return route.abort('failed');
    await route.fulfill({json:{[id]:completed(id,id,id==='accepted-video')}});
  });
  const page = await fixture.newPage();
  const exposeState = () => page.evaluate(async () => {
    window.recoveryState = (await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js')).state;
  });
  await exposeState();
  await page.waitForFunction(() => ['starting','reconnect'].every(id => window.recoveryState.chats[0].messages.find(m=>m.id===id)?.generationState==='complete'));
  // Destroy the page while its completion lookup is in flight, then recover from history.
  await page.reload(); releaseFinish();
  await page.waitForFunction(()=>window.studioReady||window.bootError);
  assert.equal(await page.evaluate(()=>window.bootError),undefined);
  await exposeState();
  await page.waitForFunction(() => {
    const messages = window.recoveryState.chats.find(c=>c.id==='a')?.messages;
    return messages?.length === 4 && messages.every(m=>['complete','error'].includes(m.generationState));
  });
  const result = await page.evaluate(async () => {
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const {api} = await import('/scripts/api.js');
    // A delayed start notification must not resurrect a completed record.
    api.dispatchEvent(new CustomEvent('execution_start',{detail:{prompt_id:'finishing'}}));
    return state.chats[0].messages.map(m=>({id:m.id,status:m.generationState,images:m.images.length,text:m.text}));
  });
  for (const id of ['finishing','starting','reconnect']) {
    assert.equal(result.find(m=>m.id===id).status,'complete',id);
    assert.equal(result.find(m=>m.id===id).images,1,id);
  }
  assert.equal(result.find(m=>m.id==='orphan').status,'error');
  assert.match(result.find(m=>m.id==='orphan').text,/nothing was resubmitted/);
  assert.equal(await page.locator('#promptstudio-history .promptstudio-generation-progress').count(),0);
  if (videoEnabled) {
    await attachVideo(page);
    await page.locator('#psvstudio-generation-list [data-status="complete"]').waitFor();
    assert.equal(fixture.projects.projects[0].generations[0].prompt_id,'accepted-video');
    assert.equal(fixture.projects.projects[0].generations[0].status,'complete');
  }
  assert.equal(queued,0);
  assert.deepEqual(fixture.errors,[]);
  console.log('Generation reload recovery passed: lost queue response, completed history, transient disconnect, interrupted preparation, delayed events, no duplicate submissions.',{videoEnabled});
} finally {releaseFinish();await fixture.close();}

// Exercise real submission/persistence code at both sides of queue acceptance.
for (const boundary of ['queue-response','handoff']) {
  const f = await startFixture();
  let release, accepted = null, submissions = 0, handoffWaiting = false;
  const gate = new Promise(resolve=>{release=resolve;});
  const snapshot = {workflow:{nodes:[],extra:{saved:true}},output:{'2':{class_type:'SaveImage',inputs:{}}}};
  try {
    await f.context.route('**/js/prompt_studio.js',async route=>{
      const response=await route.fetch();
      await route.fulfill({response,body:await response.text()+'\nexport {queueGeneration};'});
    });
    await f.context.route('**/scripts/api.js',async route=>{
      const response=await route.fetch();
      await route.fulfill({response,body:await response.text()+
        '\napi.queuePrompt=async(_,snapshot)=>(await fetch("/test-submit",{method:"POST",body:JSON.stringify(snapshot)})).json();'});
    });
    await f.context.route('**/test-submit',async route=>{
      submissions++;
      accepted = route.request().postDataJSON();
      if (boundary==='queue-response') await gate;
      await route.fulfill({json:{prompt_id:'real-submission'}}).catch(()=>{});
    });
    await f.context.route('**/llm/release',route=>route.fulfill({json:{handoff_token:'test-handoff'}}));
    await f.context.route('**/llm/handoff-complete',async route=>{
      handoffWaiting=true;
      if (boundary==='handoff') await gate;
      await route.fulfill({json:{}}).catch(()=>{});
    });
    await f.context.route('**/history?*',route=>route.fulfill({json:accepted ? {
      'real-submission':completed('real-submission',accepted.workflow.extra.promptstudio_submission),
    } : {}}));
    await f.context.route('**/history/real-submission',route=>route.fulfill({json:{'real-submission':completed('real-submission')}}));
    await f.context.route('**/promptstudio/prompt-studio/image-size',route=>route.fulfill({json:{width:64,height:64}}));
    const page=await f.newPage();
    await page.evaluate(async snapshot=>{
      const {queueGeneration}=await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
      document.querySelector('#promptstudio-keep-models-loaded').checked=false;
      window.queueTask=queueGeneration({generationSnapshot:snapshot,executionPrompt:'Reload test',mainPrompt:'Reload test',finalPrompt:'Reload test',resultNodeIds:['2'],resultFields:['images']});
    },snapshot);
    await page.getByRole('button',{name:'Replay saved inputs',exact:true}).click();
    for(let attempt=0;attempt<100 && (!accepted || (boundary==='handoff' && !handoffWaiting));attempt++) await new Promise(resolve=>setTimeout(resolve,50));
    assert.ok(accepted,`${boundary}: queue accepted`);
    const operationId=accepted.workflow.extra.promptstudio_submission;
    const saved=()=>f.chats.chats.flatMap(c=>c.messages).find(m=>m.operationId===operationId);
    assert.ok(saved(),`${boundary}: intent is durable before submission`);
    assert.deepEqual(saved().generationSnapshot.output,snapshot.output);
    if(boundary==='handoff') {
      for(let attempt=0;attempt<100 && !saved()?.promptId;attempt++) await new Promise(resolve=>setTimeout(resolve,50));
      assert.equal(saved().promptId,'real-submission','Prompt ID is durable while handoff is still waiting');
    }
    await page.reload();release();
    await page.waitForFunction(()=>window.studioReady||window.bootError);
    assert.equal(await page.evaluate(()=>window.bootError),undefined);
    await page.evaluate(async()=>{window.recoveryState=(await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js')).state;});
    await page.waitForFunction(()=>window.recoveryState.chats.some(c=>c.messages.some(m=>m.promptId==='real-submission'&&m.generationState==='complete')));
    assert.equal(submissions,1,'Reload must never submit twice');
    assert.deepEqual(f.errors,[]);
    console.log(`Actual Image queue reload passed at ${boundary}.`);
  } finally {release();await f.close();}
}
