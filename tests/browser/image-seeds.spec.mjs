import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';

const fixture = await startFixture();
try {
  await fixture.context.route('**/js/prompt_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nexport {createNewFromCurrentPrompt,generateDirectPrompt,queueGeneration,refreshWorkflowControls,restoreChatState,controlsFingerprint,syncCanonicalEditor};'});
  });
  await fixture.context.route('**/scripts/api.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response,body:await response.text()+'\napi.queuePrompt=async(_,s)=>{(window.seedSubmissions ||= []).push(structuredClone(s));return {prompt_id:"seed-"+window.seedSubmissions.length};};'});
  });
  const page = await fixture.newPage();
  await page.evaluate(async () => {
    const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const chat = state.chats.find(c => c.id === state.activeChatId);
    state.workflowProfiles = [{id:'seed',path:'seed',name:'Seed test',kind:'create',promptNodeId:'1',resultNodeIds:['4'],
      loraNodes:[],modelNodes:[],snapshot:{workflow:{nodes:[],links:[]},output:{
        '1':{class_type:'KCPP_PromptSlot',inputs:{prompt:'Initial'}},
        '2':{class_type:'KCPP_PromptStudioSampler',inputs:{seed:17}},
        '3':{class_type:'RandomNoise',inputs:{noise_seed:23}},
        '4':{class_type:'SaveImage',inputs:{}},
      }}}];
    state.workflowBusy = true; state.apiConnected = true;
    Object.assign(chat,{initialized:true,createWorkflowId:'seed',mainPrompt:'A teapot',finalPrompt:'A red teapot',
      currentPrompt:'A red teapot',renderedMainPrompt:'A teapot',renderedFinalPrompt:'A red teapot'});
    m.refreshWorkflowControls(); m.restoreChatState(chat);
    document.querySelector('#promptstudio-use-llm-amplification').checked = true;
    document.querySelector('#promptstudio-keep-models-loaded').checked = true;
    document.querySelector('#promptstudio-randomize-seed').checked = true;
    chat.controlsFingerprint = m.controlsFingerprint();
    window.seedTest = {m,state,chat};
  });
  const generate = async () => {
    const count = await page.evaluate(() => window.seedSubmissions?.length || 0);
    await page.locator('#promptstudio-send').click();
    await page.waitForFunction(count => window.seedSubmissions?.length === count + 1
      && window.seedTest.chat.messages.some(m => m.promptId === `seed-${count + 1}` && m.generationSnapshot),count);
  };
  const seeds = () => page.evaluate(() => window.seedSubmissions.map(s => s.output['2'].inputs.seed));
  await generate();
  await generate();
  assert.notEqual((await seeds())[1],17,'An unchanged prompt gets a fresh seed');
  await page.evaluate(() => window.seedTest.m.syncCanonicalEditor('A blue teapot',{userEdit:true}));
  await generate();
  await generate();
  const values = await seeds();
  assert.equal(values[2],17,'Changed Final keeps the workflow seed');
  assert.notEqual(values[3],17,'Repeating the manually edited Final gets a fresh seed');
  await page.evaluate(() => {
    const {state,chat} = window.seedTest;
    // A restored/manual editor already contains the last submitted Final, but
    // its backing state and control fingerprint have not caught up.
    state.currentPrompt = 'An older draft';
    chat.messages.at(-1).controlsFingerprint = 'older control bookkeeping';
    chat.messages.push({id:'draft',role:'assistant',canonicalPrompt:'An ungenerated proposal',mainPrompt:'A teapot'});
  });
  await generate();
  assert.notEqual((await seeds())[4],17,'Repeat detection uses the last queued prompts, not stale UI state or a draft');
  await page.evaluate(() => {
    document.querySelector('#promptstudio-randomize-seed').checked = false;
  });
  await generate();
  assert.equal((await seeds())[5],17,'Unchecked preserves workflow seed on repeats');
  await page.evaluate(() => { document.querySelector('#promptstudio-randomize-seed').checked = true; });
  const snapshot = await page.evaluate(() => window.seedSubmissions[1]);
  const replay = page.evaluate(snapshot => window.seedTest.m.queueGeneration({generationSnapshot:snapshot,
    workflowProfileId:'seed',resultNodeIds:['4'],resultFields:['images'],independent:true}),snapshot);
  await page.getByRole('button',{name:'Replay saved inputs',exact:true}).click();
  await replay;
  assert.equal((await seeds())[6],values[1],'Saved replay retains the recorded seed even when Use new seed is checked');
  console.log('Image seeds: unchanged repeats, changed Final, stale editor/control state, unchecked option and exact replay passed.');
  assert.deepEqual(fixture.errors,[]);
} finally { await fixture.close(); }
