import assert from 'node:assert/strict';
import {startFixture,attachVideo,config} from './fixture.mjs';

const fixture=await startFixture();
const savedSnapshot={workflow:{nodes:[],extra:{comparison:true}},output:{
  '1':{class_type:'PSV_MiniMaxH3Director',inputs:{document_json:JSON.stringify(config.default_document)}},
  '2':{class_type:'Sampler',inputs:{seed:1729}},
}};
fixture.projects={revision:1,active_project_id:'comparison-project',projects:[{id:'comparison-project',name:'Compare saved video',
  document:structuredClone(config.default_document),generations:[{id:'saved-video',status:'complete',workflow_id:'missing-profile',workflow_name:'Saved workflow',
    workflow_snapshot:savedSnapshot,document:structuredClone(config.default_document),compiled_prompt:'Saved exact prompt',
    outputs:[],frame_count:124,effective_duration:5,result_node_ids:['2'],result_fields:['videos'],created_at:1,updated_at:1}],created_at:1,updated_at:1}]};
try {
  await fixture.context.route('**/scripts/api.js',async route=>{const response=await route.fetch();await route.fulfill({response,body:await response.text()+
    '\napi.queuePrompt=async(_,snapshot)=>{window.comparisonQueued||=[];window.comparisonQueued.push(structuredClone(snapshot));return {prompt_id:"comparison-replay"};};'});});
  await fixture.context.route('**/js/promptstudio_video_studio.js',async route=>{const response=await route.fetch();await route.fulfill({response,body:await response.text()+
    '\nexport {state,markProjectChanged,pendingGenerationRestore};'});});
  await fixture.context.route('**/js/prompt_studio.js',async route=>{const response=await route.fetch();await route.fulfill({response,body:await response.text()+
    '\nexport {renderChatHistory,openPlotResultComparison,activateChat,syncCanonicalEditor,restoreChatState};'});});
  const page=await fixture.newPage();
  await page.evaluate(async()=>{
    const {createResultComparison,imageComparisonRecord,videoComparisonRecord}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/result-comparison.js');
    const snapshot=seed=>({workflow:{nodes:[]},output:{'2':{inputs:{seed,prompt:'<d>Keep exact words</d>',model_path:'C:\\private\\model.safetensors'}}}});
    const image=(id,seed,final)=>({id,mainPrompt:'<d>Keep  exact words</d>\nsubject',canonicalPrompt:final,executionPrompt:final,
      generationSnapshot:snapshot(seed),images:[{filename:'synthetic.svg'}],controlsFingerprint:JSON.stringify({style:seed===1?'studio':'cinema'})});
    window.__comparisonSaved=[image('baseline',1,'<d>Keep  exact words</d>\nred room'),image('candidate',2,'<d>Keep  exact words</d>\nblue room')];
    window.__comparisonOriginal=JSON.stringify(window.__comparisonSaved);window.__comparisonRestores=[];
    const trigger=document.createElement('button');trigger.textContent='Compare test records';trigger.id='compare-test';document.body.append(trigger);
    window.__comparison=createResultComparison({container:document.body,
      getItems:()=>window.__comparisonSaved.map(imageComparisonRecord),
      mediaUrl:()=>'/comparison-image.svg',onRestore:record=>{window.__comparisonRestores.push(record);},
      onExport:value=>{window.__comparisonExport=value;}});
    trigger.addEventListener('click',()=>window.__comparison.open('candidate',trigger));
    window.__videoComparison=()=>{
      const item=videoComparisonRecord({id:'clip',document:{main_description:'Saved video',duration_seconds:5},compiled_prompt:'<d>Exact dialogue</d>',
        effective_duration:5.125,total_effective_duration:10.25,frame_count:123,parent_generation_id:'parent',root_generation_id:'root',depth:1,
        workflow_snapshot:snapshot(5),outputs:[]});
      createResultComparison({container:document.body,getItems:()=>[item]}).open('clip');
    };
  });
  await fixture.context.route('**/comparison-image.svg',route=>route.fulfill({status:200,contentType:'image/svg+xml',body:
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="skyblue"/><circle cx="100" cy="100" r="40" fill="navy"/></svg>'}));
  await page.locator('#compare-test').focus();await page.keyboard.press('Enter');
  const dialog=page.getByRole('dialog',{name:'Compare saved results'});
  await dialog.waitFor({state:'visible'});
  assert.equal(await page.evaluate(()=>window.__comparisonRestores.length),0);
  assert.equal(await page.getByRole('combobox',{name:'Baseline',exact:true}).inputValue(),'0');
  assert.equal(await page.getByRole('combobox',{name:'Candidate',exact:true}).inputValue(),'1');
  assert.equal(await dialog.locator('del').first().textContent(),'red');assert.equal(await dialog.locator('ins').first().textContent(),'blue');
  assert.match(await dialog.textContent(),/2.seed = 2/);assert.match(await dialog.textContent(),/\/2\/inputs\/seed/);
  const zoom=page.getByRole('slider',{name:'Linked image zoom'});await zoom.focus();await page.keyboard.press('ArrowRight');
  const surface=dialog.locator('.ps-comparison-surface').first();await surface.focus();await page.keyboard.press('ArrowRight');
  const transforms=await dialog.locator('.ps-comparison-surface img').evaluateAll(images=>images.map(image=>image.style.transform));
  assert.equal(transforms[0],transforms[1]);assert.match(transforms[0],/-20px/);assert.match(transforms[0],/1.25/);
  await page.getByRole('checkbox',{name:'Unzoomed side-by-side view'}).check();
  assert.equal(await zoom.isDisabled(),true);
  assert.deepEqual(await dialog.locator('.ps-comparison-surface img').evaluateAll(images=>images.map(image=>image.style.transform)),['translate(0px, 0px) scale(1)','translate(0px, 0px) scale(1)']);
  const baseline=page.getByRole('combobox',{name:'Baseline',exact:true});await baseline.focus();await page.keyboard.press('ArrowDown');
  assert.equal(await baseline.inputValue(),'1');assert.equal(await page.evaluate(()=>window.__comparisonRestores.length),0);
  await page.getByRole('button',{name:'Restore candidate inputs'}).focus();await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(()=>({count:window.__comparisonRestores.length,seed:window.__comparisonRestores[0].snapshot.output['2'].inputs.seed,
    unchanged:JSON.stringify(window.__comparisonSaved)===window.__comparisonOriginal})),{count:1,seed:2,unchanged:true});
  await page.getByRole('button',{name:'Export saved comparison'}).click();
  assert.deepEqual(await page.evaluate(()=>({path:window.__comparisonExport.candidate.generationSnapshot.output['2'].inputs.model_path,
    exact:window.__comparisonExport.candidate.mainPrompt})),{path:'model.safetensors',exact:'<d>Keep  exact words</d>\nsubject'});
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>document.activeElement.id),'compare-test');
  await page.evaluate(()=>window.__videoComparison());
  assert.match(await dialog.textContent(),/Authored 5s · effective 5.125s · cumulative 10.25s · 123 frames/);
  assert.match(await dialog.textContent(),/parent parent · root root · depth 1/);
  await page.keyboard.press('Escape');
  const directIds=await page.evaluate(async()=>{
    const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const base=state.chats.find(item=>item.id===state.activeChatId);
    for(const [id,text] of [['direct-a','First direct prompt'],['direct-b','Second direct prompt']]){
      state.chats.push({...structuredClone(base),id,sessionMode:'chat',plotId:'',mainPrompt:text,finalPrompt:text,currentPrompt:text,
        renderedMainPrompt:text,renderedFinalPrompt:text,pendingGeneration:null,messages:[],
        versions:[{mainPrompt:text,finalPrompt:text}],versionIndex:0,studioSettings:{...base.studioSettings,use_llm_amplification:false}});
    }
    return ['direct-a','direct-b'];
  });
  for(const [index,id] of directIds.entries()) {
    await page.evaluate(async id=>{const image=await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');image.activateChat(id);},id);
    assert.equal(await page.locator('#promptstudio-revision').inputValue(),index?'Second direct prompt':'First direct prompt');
  }
  await page.evaluate(async()=>{const image=await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');image.syncCanonicalEditor('Edited exact Final',{userEdit:true});});
  assert.equal(await page.locator('#promptstudio-revision').inputValue(),'Edited exact Final');
  await page.locator('#promptstudio-revision').fill('Unsent direct draft');
  await page.evaluate(async()=>{const image=await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');image.restoreChatState(state.chats.find(item=>item.id===state.activeChatId));});
  assert.equal(await page.locator('#promptstudio-revision').inputValue(),'Unsent direct draft');
  await page.setViewportSize({width:390,height:844});await page.locator('#compare-test').click();
  assert.equal(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth),true);
  await page.keyboard.press('Escape');assert.deepEqual(fixture.errors,[]);
  await page.setViewportSize({width:1440,height:1000});await attachVideo(page);
  await page.locator('[data-generation-id="saved-video"]').getByRole('button',{name:'Compare saved inputs'}).click();
  await page.getByRole('button',{name:'Restore candidate inputs'}).click();
  await page.waitForFunction(()=>document.querySelector('.ps-result-comparison [role="status"]')?.textContent.includes('restored'));
  assert.equal(await page.evaluate(()=>window.comparisonQueued?.length||0),0);
  assert.ok(fixture.projects.projects[0].pending_generation_restore);
  await page.keyboard.press('Escape');await page.reload();await page.waitForFunction(()=>window.studioReady||window.bootError);await attachVideo(page);
  assert.match(await page.locator('#psvstudio-run-summary').textContent(),/Next generation uses saved inputs/);
  // Background progress is not an authored edit and must not disarm saved inputs.
  assert.equal(await page.evaluate(async()=>{const video=await import('/extensions/PromptStudio_Video/js/promptstudio_video_studio.js');
    const project=video.state.projects[0];project.generations[0].updated_at++;video.markProjectChanged({project});return !!video.pendingGenerationRestore(project);}),true);
  await page.locator('#psvstudio-generate').click();
  await page.getByRole('dialog',{name:'Review saved replay'}).getByRole('button',{name:'Cancel',exact:true}).click();
  assert.match(await page.locator('#psvstudio-run-summary').textContent(),/Next generation uses saved inputs/);
  assert.equal(await page.evaluate(()=>window.comparisonQueued?.length||0),0);
  await page.locator('#psvstudio-generate').click();
  await page.getByRole('button',{name:'Replay saved inputs',exact:true}).click();
  await page.waitForFunction(()=>window.comparisonQueued?.length===1);
  const queued=await page.evaluate(()=>window.comparisonQueued[0]);assert.deepEqual(queued.workflow,savedSnapshot.workflow);assert.equal(queued.output['2'].inputs.seed,1729);
  await page.waitForFunction(()=>!document.querySelector('#psvstudio-run-summary')?.textContent.includes('Next generation uses saved inputs'));
  assert.deepEqual(fixture.projects.projects[0].generations.find(item=>item.id==='saved-video').workflow_snapshot,savedSnapshot);
  // Arm again after marking the synthetic replay finished, then edit the document.
  await page.evaluate(async()=>{const video=await import('/extensions/PromptStudio_Video/js/promptstudio_video_studio.js');
    for(const generation of video.state.projects[0].generations)generation.status='complete';});
  await page.locator('[data-generation-id="saved-video"]').getByRole('button',{name:'Compare saved inputs'}).click();
  await page.getByRole('button',{name:'Restore candidate inputs'}).click();
  await page.waitForFunction(()=>document.querySelector('.ps-result-comparison [role="status"]')?.textContent.includes('restored'));
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(async()=>{const video=await import('/extensions/PromptStudio_Video/js/promptstudio_video_studio.js');
    const project=video.state.projects[0];project.document.shots[0].composition='An explicit authored edit.';video.markProjectChanged({project,render:true});return !!project.pending_generation_restore;}),false);
  await page.evaluate(async()=>{
    document.querySelector('#promptstudio-video-mount').hidden=true;document.querySelector('#promptstudio-image-mount').hidden=false;
    window.__promptstudioPromptStudioHost.setStandaloneVisibility(true);await window.__promptstudioPromptStudioHost.attach(window);
    const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const {renderChatHistory}=await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const chat=state.chats.find(item=>item.id===state.activeChatId);
    chat.messages=[1,2].map(seed=>({id:`image-${seed}`,role:'assistant',text:'Saved result',generationState:'complete',generationAction:'create',
      mainPrompt:'Exact saved Main',canonicalPrompt:`Exact saved Final ${seed}`,executionPrompt:`Exact saved Final ${seed}`,workflowProfileId:'missing-image-profile',
      workflowName:'Saved image workflow',images:[{filename:'synthetic.png',type:'output',subfolder:''}],
      generationSnapshot:{workflow:{nodes:[],extra:{image:true}},output:{'9':{class_type:'Sampler',inputs:{seed,prompt:`Exact saved Final ${seed}`}}}},
      resultNodeIds:['9'],resultFields:['images'],createdAt:1,updatedAt:1}));
    renderChatHistory();
    document.querySelector('[data-message-id="image-2"] details').open=true;
  });
  await page.locator('[data-message-id="image-2"]').getByRole('button',{name:'Compare saved inputs'}).click();
  await page.getByRole('button',{name:'Restore candidate inputs'}).click();
  await page.waitForFunction(()=>document.querySelector('.ps-result-comparison [role="status"]')?.textContent.includes('restored'));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#promptstudio-current-prompt').inputValue(),'Exact saved Final 2');
  assert.match(await page.locator('#promptstudio-run-summary').textContent(),/Next generation uses saved inputs/);
  await page.reload();await page.waitForFunction(()=>window.studioReady||window.bootError);
  assert.equal(await page.locator('#promptstudio-current-prompt').inputValue(),'Exact saved Final 2');
  assert.match(await page.locator('#promptstudio-run-summary').textContent(),/Next generation uses saved inputs/);
  const queuesBefore=await page.evaluate(()=>window.comparisonQueued?.length||0);
  await page.locator('#promptstudio-send').click();
  await page.getByRole('button',{name:'Replay saved inputs',exact:true}).click({timeout:5000});
  await page.waitForFunction(before=>window.comparisonQueued?.length===before+1,queuesBefore);
  assert.equal(await page.evaluate(()=>window.comparisonQueued.at(-1).output['9'].inputs.seed),2);
  const originalPlot=await page.evaluate(async()=>{
    const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const {renderChatHistory}=await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const chat=state.chats.find(item=>item.id===state.activeChatId);
    const plot={id:'comparison-plot',title:'Paired LoRA comparison',status:'complete',workflowProfileId:'missing-image-profile',workflowName:'Saved plot',action:'create',
      axes:[{name:'x',label:'LoRA',type:'lora',targetNodeId:'10',values:[{label:'A',value:{name:'A.safetensors',strength:1}},{label:'B',value:{name:'B.safetensors',strength:1}}]},
        {name:'y',label:'Strength',type:'lora_strength',targetNodeId:'10',values:[{label:'.25',value:.25}]}],
      base:{mainPrompt:'plot main',finalPrompt:'plot final',promptNodeId:'30',loraState:[{nodeId:'10',selections:[]}],modelState:[],resultNodeIds:['30'],resultFields:['images'],
        workflowSnapshot:{workflow:{nodes:[]},output:{'10':{class_type:'KCPP_PromptStudioLoraLoader',inputs:{lora_stack_json:'[]'}},'30':{inputs:{prompt:'plot final',seed:42}}}}},
      cells:[0,1].map(index=>({id:`plot-${index}`,coordinate:[index,0],status:'complete',mainPrompt:'plot main',finalPrompt:`plot final ${index}`,
        images:[{filename:'plot.png',subfolder:'',type:'output'}]})),createdAt:1,updatedAt:1};
    chat.sessionMode='plot';chat.plotId=plot.id;chat.initialized=true;state.plotRuns.set(plot.id,plot);renderChatHistory();
    return JSON.stringify(plot);
  });
  await page.locator('[data-cell-id="plot-1"]').click();
  await page.getByRole('dialog',{name:'Image preview',exact:true}).getByRole('button',{name:'Compare saved inputs'}).click();
  assert.match(await dialog.textContent(),/B.safetensors/);assert.match(await dialog.textContent(),/0.25/);
  await page.getByRole('button',{name:'Restore candidate into new Image session'}).click();
  await page.waitForFunction(()=>document.querySelector('.ps-result-comparison [role="status"]')?.textContent.includes('restored'));
  assert.deepEqual(await page.evaluate(async original=>{const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const chat=state.chats.find(item=>item.id===state.activeChatId);return {normal:chat.sessionMode!=='plot',samePlot:JSON.stringify(state.plotRuns.get('comparison-plot'))===original,
      loras:JSON.parse(chat.pendingGeneration.generationSnapshot.output['10'].inputs.lora_stack_json),seed:chat.pendingGeneration.generationSnapshot.output['30'].inputs.seed};},originalPlot),
    {normal:true,samePlot:true,loras:[{name:'B.safetensors',strength:.25}],seed:42});
  await page.keyboard.press('Escape');
  assert.deepEqual(fixture.errors,[]);
  console.log('Comparison browser checks passed: exact diffs, immutable saved selection, linked keyboard pan/zoom, accessible fallback, explicit restore, safe export, Video timing/lineage, focus return and narrow layout.');
} finally {await fixture.close();}
