import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';

const fixture=await startFixture();
try {
  await fixture.context.route('**/js/prompt_studio.js',async route=>{
    const response=await route.fetch();await route.fulfill({response,body:await response.text()+'\nexport {refreshWorkflowControls,restoreChatState,updateComposeMode,captureGenerationQueueSettings,queueGeneration,prepareQwenReferenceEdit};'});
  });
  await fixture.context.route('**/scripts/api.js',async route=>{
    const response=await route.fetch();await route.fulfill({response,body:await response.text()+'\napi.queuePrompt=async(_,snapshot)=>{window.queuedSnapshots||=[];window.queuedSnapshots.push(structuredClone(snapshot));return {prompt_id:"custom-"+window.queuedSnapshots.length};};'});
  });
  await fixture.context.route('**/promptstudio/references/triage',r=>r.fulfill({json:{decision:'deep'}}));
  await fixture.context.route('**/promptstudio/prompt-studio/vision-capability',r=>r.fulfill({json:{available:true}}));
  const requests=[];
  await fixture.context.route('**/promptstudio/prompt-studio/reference-edit-prompt',route=>{
    requests.push(route.request().postDataJSON());return route.fulfill({json:{prompt:'Edit [canvas] using texture from [ref-0].'}});
  });
  const page=await fixture.newPage();
  await page.evaluate(async()=>{
    const m=await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');window.test={m,state};
    const chat=state.chats.find(c=>c.id===state.activeChatId);
    Object.assign(chat,{initialized:true,selectedSource:{filename:'base.png',type:'output',subfolder:'',width:64,height:64},mainPrompt:'Original scene.',finalPrompt:'Original scene, daylight.',currentPrompt:'Original scene, daylight.'});
    const make=maximum=>{
      const output={p:{class_type:'KCPP_PromptSlot',inputs:{prompt:''}},base:{class_type:'KCPP_ChatImageInput',inputs:{image_ref:''}},
        c:{class_type:'PS_ReferenceCollection',inputs:{minimum:0,maximum,roles:'texture,subject',references_json:'[]'}},
        config:{class_type:'PS_ReferencePrompt',inputs:{prompt:['p',0],references:['c',0],prompt_mode:'edit_instruction',reference_token:'[ref-{index}]',first_reference_index:0,source_token:'[canvas]',instructions:'Keep edits concise.'}},
        model:{class_type:'UnfamiliarModel',inputs:{prompt:['config',0],image:['base',0]}},save:{class_type:'SaveImage',inputs:{images:['model',0]}}};
      for(let i=1;i<=maximum;i++){output['r'+i]={class_type:'PS_ReferenceItem',inputs:{references:['c',0],index:i}};output.model.inputs['reference'+i]=['r'+i,0];}
      return {id:'custom'+maximum,path:'custom'+maximum,name:'Custom '+maximum,kind:'edit',promptNodeId:'p',imageNodeId:'base',resultNodeIds:['save'],loraNodes:[],modelNodes:[],snapshot:{workflow:{nodes:[],links:[]},output}};
    };
    state.workflowProfiles=[make(2),make(16)];state.workflowBusy=true;state.apiConnected=true;
    m.refreshWorkflowControls();m.restoreChatState(chat);
    document.querySelector('#promptstudio-edit-workflow').value='custom16';document.querySelector('#promptstudio-edit-workflow').dispatchEvent(new Event('change',{bubbles:true}));
    document.querySelector('input[name="promptstudio-generation-action"][value="edit"]').checked=true;
    document.querySelector('#promptstudio-use-llm-amplification').checked=true;
    document.querySelector('#promptstudio-auto-generate').checked=false;
    chat.qwenEditReferences=Array.from({length:16},(_,i)=>({id:'ref'+i,image:{filename:'ref'+i+'.png',type:'input',subfolder:''},role:'texture',instruction:''}));
    m.updateComposeMode();
  });
  const tile=page.locator('#promptstudio-edit-reference');await tile.getByRole('button',{name:'References',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'References',exact:true});
  assert.match(await dialog.textContent(),/16\/16/);assert.ok(await dialog.getByRole('button',{name:'Add reference images'}).isDisabled());
  assert.equal(await dialog.getByRole('combobox',{name:'Role for reference 1',exact:true}).inputValue(),'texture');
  await dialog.getByRole('button',{name:'Done',exact:true}).click();
  await page.evaluate(()=>{document.querySelector('#promptstudio-edit-workflow').value='custom2';document.querySelector('#promptstudio-edit-workflow').dispatchEvent(new Event('change',{bubbles:true}));window.test.m.updateComposeMode();});
  await tile.getByRole('button',{name:'References',exact:true}).click();assert.match(await dialog.textContent(),/up to 2 references/);
  assert.equal(await page.evaluate(()=>window.test.state.chats.find(c=>c.id===window.test.state.activeChatId).qwenEditReferences.length),16);
  await dialog.getByRole('button',{name:'Done',exact:true}).click();
  await page.evaluate(async()=>{
    const {m,state}=window.test;document.querySelector('#promptstudio-edit-workflow').value='custom16';document.querySelector('#promptstudio-edit-workflow').dispatchEvent(new Event('change',{bubbles:true}));m.updateComposeMode();
    await m.prepareQwenReferenceEdit({revisionOverride:'Use the supplied materials.'});
  });
  assert.equal(requests.length,1);assert.equal(requests[0].references.length,16);assert.equal(requests[0].reference_contract.limit,16);
  let saved=await page.evaluate(()=>window.test.state.chats.find(c=>c.id===window.test.state.activeChatId));
  assert.equal(saved.mainPrompt,'Original scene.');assert.equal(saved.finalPrompt,'Original scene, daylight.');
  assert.equal(saved.pendingGeneration.editPromptModel,'workflow');assert.ok(saved.pendingGeneration.referenceContractKey);
  await page.evaluate(async()=>{const {m,state}=window.test;const chat=state.chats.find(c=>c.id===state.activeChatId);await m.queueGeneration({...m.captureGenerationQueueSettings('edit'),...chat.pendingGeneration,finalPrompt:chat.finalPrompt,independent:true});});
  const queued=await page.evaluate(()=>window.queuedSnapshots?.at(-1));assert.ok(queued);
  assert.equal(JSON.parse(queued.output.c.inputs.references_json).length,16);assert.equal(queued.output.p.inputs.prompt,'Edit [canvas] using texture from [ref-0].');
  // Direct mode uses the same model conventions without the LLM endpoint.
  await page.evaluate(async()=>{document.querySelector('#promptstudio-use-llm-amplification').checked=false;await window.test.m.prepareQwenReferenceEdit({revisionOverride:'Change texture only.'});});
  assert.equal(requests.length,1);
  const direct=await page.evaluate(()=>window.queuedSnapshots.at(-1));assert.match(direct.output.p.inputs.prompt,/\[ref-15\]/,JSON.stringify(await page.evaluate(()=>{const c=window.test.state.chats.find(c=>c.id===window.test.state.activeChatId);return {messages:c.messages.slice(-2).map(m=>({text:m.text,status:m.operationStatus})),workflow:c.editWorkflowId,queue:window.queuedSnapshots.length};})));assert.doesNotMatch(direct.output.p.inputs.prompt,/<image/);
  assert.deepEqual(fixture.errors,[]);
  console.log('Custom reference capabilities: 2/16 limits, custom roles, assisted/direct edit, immutable prompts and queued mappings passed.');
} finally {await fixture.close();}
