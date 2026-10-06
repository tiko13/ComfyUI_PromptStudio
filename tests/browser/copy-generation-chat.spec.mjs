import assert from 'node:assert/strict';
import {startFixture, attachVideo, videoEnabled} from './fixture.mjs';

const fixture = await startFixture();
try {
  const profile = {
    id:'saved-create', name:'Saved creation', kind:'create', promptNodeId:'1',
    loraNodes:[{id:'3'}], modelNodes:[{id:'4'}], resultNodeIds:['5'], resultFields:['images'],
    snapshot:{workflow:{nodes:[],links:[]},output:{
      1:{class_type:'KCPP_PromptSlot',inputs:{prompt:'Default',aspect_ratio:'1:1 (Square)',megapixels:1,multiple:16}},
      2:{class_type:'KCPP_PromptStudioSampler',inputs:{seed:17,steps:20,cfg:3}},
      3:{class_type:'KCPP_PromptStudioLoraLoader',inputs:{lora_stack_json:'[]'}},
      4:{class_type:'KCPP_PromptStudioModelLoader',inputs:{unet_name:'default.safetensors'}},
      5:{class_type:'SaveImage',inputs:{images:['2',0]}},
    }},
    additionalInputs:[{id:'steps',targetNodeId:'2',targetInputName:'steps',schema:{type:'INT',min:1,max:100},defaultValue:20}],
  };
  await fixture.context.route('**/prompt-studio/workflows', route => route.fulfill({json:{templates:[profile],revision:1}}));
  await fixture.context.route('**/userdata?*', route => route.fulfill({status:503,json:{error:'Use cached workflows'}}));
  await fixture.context.route('**/scripts/api.js',async route => {
    const response = await route.fetch();
    await route.fulfill({response,body:await response.text()+
      '\napi.queuePrompt=async(_,snapshot)=>{window.copiedQueues||=[];window.copiedQueues.push(structuredClone(snapshot));return {prompt_id:"copied-result"};};'});
  });
  await fixture.context.route('**/js/prompt_studio.js',async route => {
    const response = await route.fetch();
    await route.fulfill({response,body:await response.text()+
      '\nexport {appendMessage,activateChat,saveChats,renderChatHistory};'});
  });
  const page = await fixture.newPage();
  const current = () => page.evaluate(async () => {
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    return structuredClone(state.chats.find(chat => chat.id === state.activeChatId));
  });
  const cases = ['create','edit','upscale'].flatMap((action,index) =>
    [false,true].map(previewCopy => ({index,action,previewCopy})));
  for (const {index,action,previewCopy} of cases) {
    const source = await page.evaluate(async ({action,index,previewCopy}) => {
      const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
      const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
      window.copyTest = {m,state};
      const chat = state.chats.find(c => c.id === state.activeChatId);
      const snapshot = structuredClone(state.workflowProfiles[0].snapshot);
      Object.assign(snapshot.output['1'].inputs,{prompt:'Execution only',aspect_ratio:'16:9 (Widescreen)',megapixels:1.5,secondary_instructions:'Keep the horizon'});
      Object.assign(snapshot.output['2'].inputs,{seed:98765,steps:37,cfg:6.5});
      snapshot.output['3'].inputs.lora_stack_json = JSON.stringify([{name:'saved.safetensors',strength:0.65}]);
      snapshot.output['4'].inputs.unet_name = 'saved-model.safetensors';
      if (index===2) snapshot.promptStudioSettings = {randomize_seed:false,auto_advance_source:false,use_latest_image_context:false};
      m.appendMessage('assistant','Saved result',{
        mainPrompt:'Main with  exact spacing',canonicalPrompt:'Final saved prompt',executionPrompt:'Execution only',
        images:[{filename:'synthetic.png',type:'output',subfolder:''},
          ...(previewCopy ? [{filename:'selected.png',type:'output',subfolder:'batch'}] : [])],generationAction:action,
        workflowProfileId:action==='create' ? state.workflowProfiles[0].id : 'removed-'+action,
        workflowName:'Original workflow',generationSnapshot:snapshot,
        llmAmplified:index===1,controlsFingerprint:JSON.stringify(['Default','None','None','warm palette','','Keep the tower','None',90]),
        loraState:[{nodeId:'3',selections:[{name:'saved.safetensors',strength:0.65}]}],
        modelState:[{nodeId:'4',modelName:'saved-model.safetensors'}],
        sourceImage:action==='create' ? null : {filename:'base.png',type:'input',subfolder:''},
        workflowReferenceInputs:action==='edit' ? {'ref-node':{filename:'reference.png',type:'input',subfolder:''}} : {},
        upscaleFactor:action==='upscale' ? 2 : null,
        resultNodeIds:['5'],resultFields:['images'],
      });
      m.saveChats({immediate:true});await state.chatSaveChain;
      return {id:chat.id,record:structuredClone(chat.messages.at(-1)),messages:JSON.stringify(chat.messages)};
    },{action,index,previewCopy});
    await page.setViewportSize({width:index===1 ? 390 : 1440,height:1000});
    const info = page.locator('.promptstudio-prompt-info').last();
    const preview = page.getByRole('dialog',{name:'Image preview',exact:true});
    if (previewCopy) await page.locator('.promptstudio-image-preview').last().click();
    else await info.locator(':scope > summary').click();
    const copy = (previewCopy ? preview : info).getByRole('button',{name:'Copy to new chat',exact:true});
    assert.equal(await copy.isEnabled(),true);
    if (index===1) {await copy.focus();await page.keyboard.press('Enter');} else await copy.click();
    await page.waitForFunction(id => window.copyTest.state.activeChatId !== id,source.id);
    await page.evaluate(async()=>{await window.copyTest.state.chatSaveChain;});
    let chat = await current();
    assert.equal(chat.mainPrompt,source.record.mainPrompt);
    assert.equal(chat.finalPrompt,source.record.canonicalPrompt);
    assert.equal(chat.messages.length,previewCopy ? 1 : 0);
    if (previewCopy) {
      assert.equal(await preview.isHidden(),true);
      assert.deepEqual(chat.messages[0].images,[source.record.images[1]],'Copy only the opened image from a batch');
      assert.equal(chat.messages[0].generationState,'complete');
      assert.deepEqual(chat.messages[0].generationSnapshot,source.record.generationSnapshot);
      assert.equal(await page.locator('.promptstudio-image-preview img').count(),1);
    }
    assert.equal(chat.consultMessages.length,0);
    assert.equal(chat.pendingGeneration.action,action);
    assert.deepEqual(chat.pendingGeneration.generationSnapshot,source.record.generationSnapshot);
    assert.deepEqual(chat.pendingGeneration.workflowReferenceInputs,source.record.workflowReferenceInputs);
    assert.equal(chat.studioSettings.resolution_megapixels,1.5);
    assert.equal(chat.studioSettings.secondary_instructions,'Keep the horizon');
    assert.equal(chat.studioSettings.style_modifier,'warm palette');
    if (index===2) {
      assert.equal(chat.studioSettings.randomize_seed,false);
      assert.equal(chat.studioSettings.auto_advance_source,false);
      assert.equal(chat.studioSettings.use_latest_image_context,false);
    }
    if (index===0) assert.equal(Object.values(chat.studioSettings.additional_input_selections)[0].value,37);
    assert.equal(await page.evaluate(id=>JSON.stringify(window.copyTest.state.chats.find(c=>c.id===id).messages),source.id),source.messages);
    assert.equal(await page.evaluate(()=>window.copiedQueues?.length || 0),0,'Copy never queues a render');
    const copiedId = chat.id;
    await page.reload();await page.waitForFunction(()=>window.studioReady);
    chat = await current();
    assert.equal(chat.id,copiedId);
    assert.deepEqual(chat.pendingGeneration.generationSnapshot,source.record.generationSnapshot);
    assert.match(await page.locator('#promptstudio-run-summary').textContent(),/Next generation uses saved inputs/);
    if (previewCopy) {
      assert.deepEqual(chat.messages[0].images,[source.record.images[1]]);
      const imageUrl = new URL(await page.locator('.promptstudio-image-preview img').first().getAttribute('src'),page.url());
      assert.equal(imageUrl.searchParams.get('filename'),'selected.png');
      assert.equal(imageUrl.searchParams.get('subfolder'),'batch');
    }
    await page.locator('#promptstudio-send').click();
    await page.getByRole('button',{name:'Replay saved inputs',exact:true}).click({timeout:5000});
    await page.waitForFunction(()=>window.copiedQueues?.length===1);
    assert.deepEqual(await page.evaluate(()=>window.copiedQueues[0].output),source.record.generationSnapshot.output);
    await page.reload();await page.waitForFunction(()=>window.studioReady);
  }
  // A failed server save keeps the copied draft and the existing recovery notice.
  await page.evaluate(async()=>{
    const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const source = state.chats.find(chat=>chat.messages.some(message=>message.canonicalPrompt==='Final saved prompt'));
    m.activateChat(source.id);await state.chatSaveChain;
  });
  let broken = true;
  await fixture.context.route('**/promptstudio/prompt-studio/chats',route => broken
    ? route.fulfill({status:503,json:{error:'Synthetic copy save failure'}}) : route.continue());
  const sourceId = (await current()).id;
  const savedInfo = page.locator('.promptstudio-prompt-info').last();
  await savedInfo.locator(':scope > summary').click();
  await savedInfo.getByRole('button',{name:'Copy to new chat',exact:true}).click();
  await page.waitForSelector('[data-chat-save-failure]',{state:'attached'});
  assert.notEqual((await current()).id,sourceId);
  assert.ok((await current()).pendingGeneration.generationSnapshot);
  broken = false;
  await page.evaluate(async()=>{
    const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    m.saveChats({immediate:true});await state.chatSaveChain;
  });
  await page.waitForSelector('[data-chat-save-failure]',{state:'detached'});
  assert.ok(fixture.chats.chats.some(chat=>chat.id!==sourceId && chat.pendingGeneration?.generationSnapshot));
  await page.evaluate(async()=>{
    const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    m.appendMessage('assistant','Legacy image',{mainPrompt:'Old',canonicalPrompt:'Old',images:[{filename:'old.png',type:'output',subfolder:''}]});
  });
  const legacy = page.locator('.promptstudio-prompt-info').last();
  await legacy.locator(':scope > summary').click();
  assert.equal(await legacy.getByRole('button',{name:'Copy to new chat'}).isDisabled(),true);
  await page.locator('.promptstudio-image-preview').last().click();
  const legacyPreview = page.getByRole('dialog',{name:'Image preview',exact:true});
  assert.equal(await legacyPreview.getByRole('button',{name:'Copy to new chat'}).isDisabled(),true);
  assert.match(await legacyPreview.getByRole('button',{name:'Copy to new chat'}).getAttribute('title'),/no complete saved generation inputs/);
  await page.keyboard.press('Escape');
  if (videoEnabled) {
    await attachVideo(page);
    assert.equal(await page.locator('#psvstudio-project-title').count(),1);
  }
  assert.deepEqual(fixture.errors,[]);
  console.log('Copy generation: fresh chat, exact inputs, original preserved, narrow keyboard UI, reload and create/edit/upscale replay passed.');
} finally {await fixture.close();}
