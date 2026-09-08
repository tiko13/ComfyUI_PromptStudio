import assert from 'node:assert/strict';
import {startFixture, attachVideo} from './fixture.mjs';

const fixture = await startFixture();
try {
  const profile = {
    id:'[PS] Handoff.json', path:'[PS] Handoff.json', name:'[PS] Handoff', kind:'create', promptNodeId:'1',
    snapshot:{workflow:{nodes:[],links:[]},output:{
      1:{class_type:'KCPP_PromptSlot',inputs:{prompt:'Workflow default',aspect_ratio:'1:1',megapixels:1,multiple:16}},
      2:{class_type:'KCPP_PromptStudioSampler',inputs:{seed:1,steps:20,cfg:3,sampler_name:'euler',scheduler:'normal',denoise:1}},
      3:{class_type:'KCPP_PromptStudioLoraLoader',inputs:{lora_stack_json:'[]'}},
      4:{class_type:'KCPP_PromptStudioModelLoader',inputs:{unet_name:'default.safetensors'}},
    }},
    additionalInputs:[{id:'steps',targetNodeId:'2',targetInputName:'steps',schema:{type:'INT',min:1,max:100},defaultValue:20}],
  };
  // Use the application's saved workflow cache while the fixture host is offline.
  await fixture.context.route('**/prompt-studio/workflows', route => route.fulfill({json:{templates:[profile],revision:1}}));
  await fixture.context.route('**/userdata?*', route => route.fulfill({status:503,json:{error:'Fixture uses cached workflows'}}));
  await fixture.context.route('**/js/prompt_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nexport {appendMessage, activateChat, preparePlotBase, preparePlotMainPrompt, saveChats};'});
  });
  const page = await fixture.newPage();
  const sourceId = await page.evaluate(async () => {
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const {appendMessage,saveChats} = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const chat = state.chats.find(c=>c.id===state.activeChatId);
    chat.initialized = true;
    const snapshot = structuredClone(state.workflowProfiles[0].snapshot);
    Object.assign(snapshot.output['1'].inputs,{prompt:'Final rendered scene',aspect_ratio:'16:9 (Widescreen)',megapixels:1.5,secondary_instructions:'Keep the horizon level'});
    Object.assign(snapshot.output['2'].inputs,{seed:98765,steps:37,cfg:6.5});
    snapshot.output['3'].inputs.lora_stack_json = JSON.stringify([{name:'saved.safetensors',strength:0.65}]);
    snapshot.output['4'].inputs.unet_name = 'saved-model.safetensors';
    appendMessage('assistant','Image result',{
      mainPrompt:'Main scene',canonicalPrompt:'Final rendered scene',
      images:[{filename:'synthetic.png',type:'output',subfolder:''}],
      workflowProfileId:state.workflowProfiles[0].id,
      generationSnapshot:snapshot,
      controlsFingerprint:JSON.stringify(['Default','None','None','warm palette','','Keep the tower','None',90]),
      loraState:[{nodeId:'3',selections:[{name:'saved.safetensors',strength:0.65}]}],
      modelState:[{nodeId:'4',modelName:'saved-model.safetensors'}],
    });
    await saveChats({immediate:true});
    return chat.id;
  });
  const current = () => page.evaluate(async()=>{
    const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    return structuredClone(state.chats.find(c=>c.id===state.activeChatId));
  });
  const xyz = page.getByRole('button',{name:'Create XYZ plot',exact:true});
  const dialog = page.locator('#promptstudio-plot-handoff-dialog');
  const sourceBefore = await current();
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    const a = await page.locator('.promptstudio-video-handoff').boundingBox();
    const b = await xyz.boundingBox();
    assert.ok(b.x >= a.x+a.width && b.y === a.y, 'XYZ is immediately to the right on the same row');
    assert.equal(b.width,a.width);
    await xyz.click();
    const main = await dialog.locator('[data-plot-prompt="main"]').boundingBox();
    const final = await dialog.locator('[data-plot-prompt="final"]').boundingBox();
    const cancel = await dialog.locator('[data-plot-prompt="cancel"]').boundingBox();
    assert.equal(main.x,final.x,'Prompt choices share a left edge');
    assert.equal(main.width,final.width,'Prompt choices have equal widths');
    assert.ok(final.y>=main.y+main.height && cancel.y>=final.y+final.height,'Each choice and Cancel has its own row');
    assert.ok(Math.abs(cancel.x+cancel.width-final.x-final.width)<1,'Cancel aligns to the right edge');
    assert.equal(await dialog.evaluate(el=>el.scrollWidth===el.clientWidth),true,'Dialog stays within its bounds');
    await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  }
  await page.setViewportSize({width:1440,height:1000});
  await xyz.click();
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal((await current()).id,sourceId);
  assert.equal(await xyz.evaluate(el=>el===document.activeElement),true);
  await xyz.click();
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isHidden(),true);
  assert.equal(fixture.chats.chats.length,1,'Cancel creates no session');

  for (const mode of ['final','main']) {
    await xyz.click();
    await dialog.locator(`[data-plot-prompt="${mode}"]`).click();
    await page.waitForSelector('.promptstudio-plot-builder');
    let chat = await current();
    assert.notEqual(chat.id,sourceId);
    assert.equal(chat.sessionMode,'plot');
    assert.equal(chat.plotDraft.prompt,mode==='main'?'Main scene':'Final rendered scene');
    assert.equal(chat.plotDraft.llmEnabled,mode==='main');
    assert.equal(chat.studioSettings.style_modifier,'warm palette');
    assert.equal(chat.studioSettings.resolution_aspect_ratio,'16:9 (Widescreen)');
    assert.equal(chat.studioSettings.secondary_instructions,'Keep the horizon level');
    const savedId = chat.id;
    await page.waitForFunction(async id=>{
      const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
      await state.chatSaveChain;
      const saved=await (await fetch('/promptstudio/prompt-studio/chats')).json();
      return saved.chats.some(c=>c.id===id&&c.plotDraft?.sourceSnapshot);
    },savedId);
    await page.reload();
    await page.waitForFunction(()=>window.studioReady);
    chat = await current();
    assert.equal(chat.id,savedId);
    const base = await page.evaluate(async()=>{
      const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
      const {preparePlotBase,preparePlotMainPrompt}=await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
      const chat=state.chats.find(c=>c.id===state.activeChatId);
      const main=await preparePlotMainPrompt(chat.plotDraft,{},[]);
      return preparePlotBase(chat.plotDraft,main,'Plot final',chat.studioSettings);
    });
    assert.equal(base.mainPrompt,chat.plotDraft.prompt,'Transferred Main does not invoke main creation again');
    assert.equal(base.workflowSnapshot.output['2'].inputs.seed,98765);
    assert.equal(base.workflowSnapshot.output['2'].inputs.steps,37);
    assert.equal(base.workflowSnapshot.output['2'].inputs.cfg,6.5);
    assert.equal(base.workflowSnapshot.output['4'].inputs.unet_name,'saved-model.safetensors');
    assert.deepEqual(JSON.parse(base.workflowSnapshot.output['3'].inputs.lora_stack_json),[{name:'saved.safetensors',strength:0.65}]);
    assert.ok(base.workflowSnapshot.workflow);
    const varied = await page.evaluate(async base=>{
      const {snapshotForPlotCell}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/plot/model.js');
      return snapshotForPlotCell({base,axes:[{name:'x',type:'seed',targetNodeId:'2',values:[{value:42}]}]},
        {finalPrompt:'Varied final',coordinate:[0]});
    },base);
    assert.equal(varied.output['2'].inputs.seed,42);
    assert.equal(varied.output['2'].inputs.steps,37,'Only the plotted input changes');
    await page.evaluate(async id=>(await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js')).activateChat(id),sourceId);
    const sourceAfter = await current();
    assert.deepEqual(sourceAfter.messages,sourceBefore.messages,'Source generation remains unchanged');
    assert.equal(sourceAfter.sessionMode,sourceBefore.sessionMode);
  }
  assert.equal(fixture.requests.filter(r=>r.path==='/prompt'||r.path.includes('/revise')).length,0,'Handoff never queues generation or calls the LLM');
  await attachVideo(page);
  assert.equal(await page.locator('#promptstudio-video-mount').isVisible(),true);
  assert.deepEqual(fixture.errors,[]);
  console.log('Plot handoff passed: placement, cancel/Escape, both modes, settings, frozen inputs, reload, source preservation, Video compatibility.');
} finally { await fixture.close(); }
