import assert from 'node:assert/strict';
import {startFixture, attachVideo, videoEnabled} from './fixture.mjs';

const fixture = await startFixture();
try {
  const profile = {id:'plot-workflow', name:'Saved plot workflow', kind:'create', promptNodeId:'1',
    loraNodes:[{id:'3'}], modelNodes:[{id:'4'}], resultNodeIds:['5'], resultFields:['images'],
    snapshot:{workflow:{nodes:[],links:[]},output:{
      1:{class_type:'KCPP_PromptSlot',inputs:{prompt:'Base final',aspect_ratio:'16:9 (Widescreen)',megapixels:1.5,multiple:16}},
      2:{class_type:'KCPP_PromptStudioSampler',inputs:{seed:17,steps:20,cfg:6.5}},
      3:{class_type:'KCPP_PromptStudioLoraLoader',inputs:{lora_stack_json:'[]'}},
      4:{class_type:'KCPP_PromptStudioModelLoader',inputs:{unet_name:'base.safetensors'}},
      5:{class_type:'SaveImage',inputs:{images:['2',0]}},
    }},
    additionalInputs:[{id:'steps',targetNodeId:'2',targetInputName:'steps',schema:{type:'INT',min:1,max:100},defaultValue:20}],
  };
  await fixture.context.route('**/prompt-studio/workflows', route => route.fulfill({json:{templates:[profile],revision:1}}));
  await fixture.context.route('**/userdata?*', route => route.fulfill({status:503,json:{error:'Use cached workflows'}}));
  await fixture.context.route('**/view?*', route => route.fulfill({contentType:'image/svg+xml',body:
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="navy"/></svg>'}));
  const revisions = [];
  await fixture.context.route('**/promptstudio/prompt-studio/revise', route => {
    revisions.push(route.request().postDataJSON());
    return route.fulfill({json:{prompt:`Rebuilt final ${revisions.length}`}});
  });
  await fixture.context.route('**/scripts/api.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response,body:await response.text()+
      '\napi.queuePrompt=async(_,snapshot)=>{window.copiedQueues||=[];window.copiedQueues.push(structuredClone(snapshot));return {prompt_id:"plot-copy"};};'});
  });
  await fixture.context.route('**/js/prompt_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response,body:await response.text()+
      '\nexport {renderChatHistory,activateChat,saveChats,openImageLightbox,promptNeedsRender};'});
  });
  const page = await fixture.newPage();
  for (const [index, width] of [1440,390,1440].entries()) {
    const source = await page.evaluate(async ({profile,index}) => {
      const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
      const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
      const {snapshotForPlotCell} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/plot/model.js');
      const chat = state.chats.find(c => c.id === state.activeChatId);
      const axes = index === 0 ? [
        {name:'x',label:'Model',type:'model',targetNodeId:'4',values:[{label:'First',value:'first.safetensors'},{label:'Selected',value:'selected.safetensors'}]},
        {name:'y',label:'Seed',type:'seed',targetNodeId:'2',values:[{label:'12345',value:12345}]},
        {name:'z',label:'Steps',type:'steps',targetNodeId:'2',values:[{label:'37',value:37}]},
      ] : [
        {name:'x',label:'LoRA',type:'lora',targetNodeId:'3',values:[{label:'A',value:{name:'A.safetensors',strength:1}},{label:'B',value:{name:'B.safetensors',strength:1}}]},
        {name:'y',label:'Strength',type:'lora_strength',targetNodeId:'3',values:[{label:'.25',value:.25}]},
        {name:'z',label:'Style',type:'style_modifier',values:[{label:'Cell style',value:'cell style'}]},
      ];
      const plot = {id:`copy-plot-${index}`,title:'Copy plot',status:'complete',prepared:true,action:'create',
        workflowProfileId:index === 1 ? 'removed-workflow' : state.workflowProfiles[0].id,workflowName:profile.name,
        llmEnabled:index > 0,axes,
        controlSettings:{...chat.studioSettings,randomize_seed:false,auto_advance_source:false,use_latest_image_context:false,style_modifier:'saved style'},
        base:{workflowSnapshot:structuredClone(profile.snapshot),promptNodeId:'1',mainPrompt:'Base main',finalPrompt:'Base final',
          loraState:[{nodeId:'3',selections:[]}],modelState:[{nodeId:'4',modelName:'base.safetensors'}],resultNodeIds:['5'],resultFields:['images']},
        cells:[0,1].map(x => ({id:`cell-${x}`,coordinate:[x,0,0],status:'complete',mainPrompt:`Main  ${x}`,finalPrompt:`Final  ${x}`,
          images:[{filename:'plot.png',subfolder:'',type:'output'}]})),createdAt:1,updatedAt:1};
      chat.sessionMode = 'plot'; chat.plotId = plot.id; chat.initialized = true;
      state.plotRuns.set(plot.id,plot); m.renderChatHistory(); m.saveChats({immediate:true}); await state.chatSaveChain;
      return {chatId:chat.id,plotId:plot.id,plot:JSON.stringify(plot),messages:JSON.stringify(chat.messages),
        expected:snapshotForPlotCell(plot,plot.cells[1])};
    },{profile,index});
    await page.setViewportSize({width,height:1000});
    const cell = page.locator('[data-cell-id="cell-1"]');
    await cell.click();
    const preview = page.getByRole('dialog',{name:'Image preview',exact:true});
    const copy = preview.getByRole('button',{name:'Copy to new chat',exact:true});
    assert.equal(await copy.isVisible(),true);
    assert.equal(await preview.getByRole('button',{name:'Compare saved inputs'}).isVisible(),true);
    assert.equal(await preview.getByRole('link',{name:'Open image in new tab'}).isVisible(),true);
    const box = await copy.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width,'Copy action fits narrow screens');
    await page.keyboard.press('Escape');
    assert.equal(await cell.evaluate(el=>el === document.activeElement),true);
    // Reusing the lightbox for a normal image clears the previous plot action.
    await page.evaluate(async () => {
      const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
      m.openImageLightbox('/view?filename=normal.png','Normal image',document.querySelector('#promptstudio-send'));
    });
    assert.equal(await page.locator('[data-copy-to-chat]').count(),0);
    await page.keyboard.press('Escape');
    await cell.click();
    await preview.getByRole('button',{name:'Compare saved inputs'}).click();
    const comparison = page.getByRole('dialog',{name:'Compare saved results'});
    assert.match(await comparison.textContent(),index ? /B.safetensors/ : /selected.safetensors/);
    await page.keyboard.press('Escape');
    await cell.click();
    if (index) {await copy.focus(); await page.keyboard.press('Enter');} else await copy.click();
    await preview.waitFor({state:'hidden'});
    await page.waitForFunction(async id => {
      const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
      await state.chatSaveChain;
      return state.activeChatId !== id && !!state.chats.find(c=>c.id===state.activeChatId)?.pendingGeneration;
    },source.chatId);
    const copied = await page.evaluate(async source => {
      const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
      return {chat:structuredClone(state.chats.find(c=>c.id===state.activeChatId)),
        plot:JSON.stringify(state.plotRuns.get(source.plotId)),
        messages:JSON.stringify(state.chats.find(c=>c.id===source.chatId).messages),queues:window.copiedQueues?.length || 0};
    },source);
    assert.equal(copied.plot,source.plot);
    assert.equal(copied.messages,source.messages);
    assert.equal(copied.queues,0,'Copy does not generate');
    assert.notEqual(copied.chat.sessionMode,'plot');
    assert.equal(copied.chat.mainPrompt,'Main  1');
    assert.equal(copied.chat.finalPrompt,'Final  1');
    assert.equal(copied.chat.messages.length,1);
    const first = copied.chat.messages[0];
    assert.deepEqual(first.images,[{filename:'plot.png',subfolder:'',type:'output'}]);
    assert.equal(first.generationState,'complete');
    assert.equal(first.mainPrompt,'Main  1');
    assert.equal(first.canonicalPrompt,'Final  1');
    assert.deepEqual(first.generationSnapshot.output,source.expected.output);
    assert.equal(revisions.length,0,'Copy never rebuilds a prompt');
    const firstImage = page.locator('.promptstudio-message .promptstudio-image-preview img').first();
    await firstImage.waitFor({state:'visible'});
    assert.equal(new URL(await firstImage.getAttribute('src'),page.url()).searchParams.get('filename'),'plot.png');
    assert.deepEqual(copied.chat.pendingGeneration.generationSnapshot.output,source.expected.output);
    assert.deepEqual(copied.chat.pendingGeneration.generationSnapshot.workflow,source.expected.workflow);
    assert.equal(copied.chat.studioSettings.style_modifier,index ? 'cell style' : 'saved style');
    assert.equal(copied.chat.studioSettings.randomize_seed,false);
    assert.equal(copied.chat.studioSettings.resolution_megapixels,1.5);
    if (!index) {
      assert.equal(copied.chat.pendingGeneration.modelState[0].modelName,'selected.safetensors');
      assert.equal(Object.values(copied.chat.studioSettings.additional_input_selections)[0].value,37);
    } else assert.deepEqual(copied.chat.pendingGeneration.loraState[0].selections,[{name:'B.safetensors',strength:.25}]);
    await page.reload(); await page.waitForFunction(()=>window.studioReady);
    await firstImage.waitFor({state:'visible'});
    assert.equal(await page.evaluate(async () =>
      (await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js')).promptNeedsRender()),false,
      'Restored prompt controls already match the saved Final prompt');
    assert.equal(revisions.length,0,'Reload never rebuilds a prompt');
    assert.match(await page.locator('#promptstudio-run-summary').textContent(),/Next generation uses saved inputs/);
    await page.locator('#promptstudio-send').click();
    await page.getByRole('button',{name:'Replay saved inputs',exact:true}).click();
    await page.waitForFunction(()=>window.copiedQueues?.length===1);
    assert.deepEqual(await page.evaluate(()=>window.copiedQueues[0].output),source.expected.output);
    assert.equal(revisions.length,0,'Unchanged Generate reuses the saved prompt');
    await page.reload(); await page.waitForFunction(()=>window.studioReady);
    if (index === 2) {
      await page.locator('#promptstudio-reroll').click();
      await page.waitForFunction(()=>window.copiedQueues?.length===1);
      assert.equal(revisions.length,1,'Reroll explicitly rebuilds the Final prompt');
      assert.equal(await page.evaluate(()=>window.copiedQueues[0].output['1'].inputs.prompt),'Rebuilt final 1');
      const modifier = page.locator('#promptstudio-style-modifier');
      await modifier.evaluate(el => { el.value='changed style'; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); });
      assert.equal(await page.evaluate(async () =>
        (await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js')).promptNeedsRender()),true);
      await page.locator('#promptstudio-send').click();
      await page.waitForFunction(()=>window.copiedQueues?.length===2);
      assert.equal(revisions.length,2,'Changed prompt controls rebuild the Final prompt');
      assert.equal(await page.evaluate(()=>window.copiedQueues[1].output['1'].inputs.prompt),'Rebuilt final 2');
    }
  }
  if (videoEnabled) {
    await attachVideo(page);
    assert.equal(await page.locator('#psvstudio-project-title').count(),1);
  }
  assert.deepEqual(fixture.errors,[]);
  console.log('Plot copy passed: per-cell inputs, models, paired LoRAs, LLM settings, no auto-generation, reload/replay, missing workflow, narrow keyboard UI.');
} finally {await fixture.close();}
