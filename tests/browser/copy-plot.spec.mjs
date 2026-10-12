import assert from 'node:assert/strict';
import {startFixture, attachVideo, videoEnabled} from './fixture.mjs';

const fixture = await startFixture();
try {
  const profile = {id:'[PS] Copy plot.json',name:'Copy plot workflow',kind:'create',promptNodeId:'1',
    snapshot:{workflow:{nodes:[],links:[]},output:{
      1:{class_type:'KCPP_PromptSlot',inputs:{prompt:'Default',aspect_ratio:'1:1',megapixels:1,multiple:16}},
      2:{class_type:'KCPP_PromptStudioSampler',inputs:{seed:1,steps:20,cfg:3,sampler_name:'euler',scheduler:'normal',denoise:1}},
      3:{class_type:'KCPP_PromptStudioLoraLoader',inputs:{lora_stack_json:'[]'}},
      4:{class_type:'KCPP_PromptStudioModelLoader',inputs:{unet_name:'default.safetensors'}},
    }},
    additionalInputs:[{id:'steps',targetNodeId:'2',targetInputName:'steps',schema:{type:'INT',min:1,max:100},defaultValue:20}],
  };
  await fixture.context.route('**/prompt-studio/workflows',route=>route.fulfill({json:{templates:[profile],revision:1}}));
  await fixture.context.route('**/userdata?*',route=>route.fulfill({status:503,json:{error:'Use cached workflows'}}));
  await fixture.context.route('**/scripts/api.js',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:await response.text()+'\napi.queuePrompt=async()=>{window.copyPlotQueues=(window.copyPlotQueues||0)+1;return {prompt_id:"unexpected"};};'});
  });
  await fixture.context.route('**/js/prompt_studio.js',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nexport {activateChat,renderChatHistory,saveChats,preparePlotBase};'});
  });
  const page=await fixture.newPage();
  const current=()=>page.evaluate(async()=>{
    const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    return structuredClone(state.chats.find(c=>c.id===state.activeChatId));
  });
  for (const [index,width] of [1440,390].entries()) {
    await page.setViewportSize({width,height:1000});
    const source=await page.evaluate(async index=>{
      const m=await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
      const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
      const {normalizePlotDraft,buildPlotRun}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/plot/model.js');
      const chat=state.chats.find(c=>c.id===state.activeChatId);
      const profile=state.workflowProfiles[0];
      const snapshot=structuredClone(profile.snapshot);
      Object.assign(snapshot.output['1'].inputs,{prompt:'Saved base',aspect_ratio:'16:9 (Widescreen)',megapixels:1.5,secondary_instructions:'Keep horizon level'});
      Object.assign(snapshot.output['2'].inputs,{seed:98765,steps:37,cfg:6.5});
      snapshot.output['3'].inputs.lora_stack_json=JSON.stringify([{name:'saved.safetensors',strength:.65}]);
      snapshot.output['4'].inputs.unet_name='saved-model.safetensors';
      chat.sessionMode='plot'; chat.initialized=true; chat.plotId=`original-${index}`;
      chat.plotDraft=normalizePlotDraft({title:'Saved comparison',prompt:'Original base prompt',
        workflowProfileId:profile.id,llmEnabled:!!index,zEnabled:!!index,sourceMainPrompt:'Original base prompt',
        axes:[
          {type:'lora',targetKey:'lora:3:name',values:[{label:'First',value:{name:'A.safetensors',strength:1}},{label:'Second',value:{name:'B.safetensors',strength:1}}]},
          {type:'lora_strength',targetKey:'lora:3:strength',values:[{label:'.25',value:.25},{label:'.75',value:.75}]},
          {type:'style_modifier',values:[{label:'Cool',value:'cool palette'},{label:'Warm',value:'warm palette'}]},
        ]},profile);
      const plot=buildPlotRun({draft:chat.plotDraft,profile,plotId:chat.plotId,chatId:chat.id,
        base:{workflowSnapshot:snapshot,promptNodeId:'1',mainPrompt:'Saved base',finalPrompt:'Saved final',
          loraState:[{nodeId:'3',selections:[{name:'saved.safetensors',strength:.65}]}],
          modelState:[{nodeId:'4',modelName:'saved-model.safetensors'}]}});
      plot.status='complete'; plot.prepared=true;
      plot.controlSettings={...structuredClone(chat.studioSettings),style_modifier:'saved style',temperature:.45,
        resolution_aspect_ratio:'16:9 (Widescreen)',resolution_megapixels:1.5,secondary_instructions:'Keep horizon level'};
      plot.artifacts={composites:[{filename:'composite.png',type:'output',subfolder:''}],manifest:{filename:'plot.json',type:'output',subfolder:''}};
      for (const cell of plot.cells) {cell.status='complete';cell.finalPrompt='Cell final';}
      state.plotRuns.set(plot.id,plot);
      // Controls can change after a run: copying must use the run's frozen settings.
      chat.studioSettings.style_modifier='later unrelated change';
      m.activateChat(chat.id); m.renderChatHistory(); await m.saveChats({immediate:true});
      return {chatId:chat.id,plot:structuredClone(plot),draft:structuredClone(chat.plotDraft)};
    },index);
    const copy=page.getByRole('button',{name:'Copy plot',exact:true});
    assert.equal(await copy.locator('..').getByRole('link',{name:'Open plot data',exact:true}).count(),1);
    await copy.focus(); await page.keyboard.press('Enter');
    await page.waitForSelector('.promptstudio-plot-builder');
    let chat=await current();
    assert.notEqual(chat.id,source.chatId);
    assert.equal(chat.sessionMode,'plot');
    assert.equal(chat.plotId,'');
    assert.equal(chat.pendingGeneration,null);
    assert.deepEqual(chat.messages,[]);
    assert.equal(chat.plotDraft.prompt,source.draft.prompt);
    assert.equal(chat.plotDraft.sourceMainPrompt,source.draft.sourceMainPrompt);
    assert.equal(chat.plotDraft.title,source.plot.title);
    assert.equal(chat.plotDraft.llmEnabled,!!index);
    assert.equal(chat.plotDraft.zEnabled,!!index);
    assert.deepEqual(chat.plotDraft.axes.slice(0,index?3:2),source.plot.axes);
    assert.deepEqual(chat.plotDraft.sourceSnapshot,source.plot.base.workflowSnapshot);
    assert.equal(chat.studioSettings.style_modifier,'saved style');
    assert.equal(chat.studioSettings.temperature,.45);
    assert.equal(chat.studioSettings.resolution_megapixels,1.5);
    assert.equal(await page.evaluate(()=>window.copyPlotQueues||0),0,'Copy does not queue generation');
    assert.equal(fixture.requests.filter(r=>r.path.includes('/revise')||r.path.includes('/plots')&&r.method==='PUT').length,0);
    const copiedId=chat.id;
    await page.evaluate(async()=>{
      const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
      await state.chatSaveChain;
    });
    await page.reload(); await page.waitForFunction(()=>window.studioReady);
    chat=await current();
    assert.equal(chat.id,copiedId);
    assert.equal(chat.plotId,'');
    assert.deepEqual(chat.plotDraft.axes.slice(0,index?3:2),source.plot.axes);
    assert.deepEqual(chat.plotDraft.sourceSnapshot,source.plot.base.workflowSnapshot);
    await page.locator('.promptstudio-plot-basics textarea').fill('Small prompt adjustment');
    const base=await page.evaluate(async()=>{
      const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
      const m=await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
      const chat=state.chats.find(c=>c.id===state.activeChatId);
      return m.preparePlotBase(chat.plotDraft,chat.plotDraft.prompt,chat.plotDraft.prompt,chat.studioSettings);
    });
    assert.equal(base.workflowSnapshot.output['1'].inputs.prompt,'Small prompt adjustment');
    assert.equal(base.workflowSnapshot.output['2'].inputs.seed,98765);
    assert.equal(base.workflowSnapshot.output['2'].inputs.steps,37);
    assert.equal(base.workflowSnapshot.output['2'].inputs.cfg,6.5);
    assert.equal(base.workflowSnapshot.output['4'].inputs.unet_name,'saved-model.safetensors');
    assert.deepEqual(JSON.parse(base.workflowSnapshot.output['3'].inputs.lora_stack_json),[{name:'saved.safetensors',strength:.65}]);
    assert.equal(await page.evaluate(()=>window.copyPlotQueues||0),0);
    assert.equal(fixture.requests.filter(r=>r.path.includes('/revise')||r.path.includes('/plots')&&r.method==='PUT').length,0);
    const original=fixture.chats.chats.find(c=>c.id===source.chatId);
    assert.equal(original.plotId,source.plot.id);
    assert.deepEqual(original.plotDraft,source.draft,'Editing the copy leaves the original draft intact');
  }
  if(videoEnabled) {await attachVideo(page);assert.equal(await page.locator('#psvstudio-project-title').count(),1);}
  assert.deepEqual(fixture.errors,[]);
  console.log('Copy plot passed: XY/XYZ, LLM mode, frozen settings and inputs, keyboard/narrow UI, reload, editable prompt, no generation, original preserved.');
} finally {await fixture.close();}
