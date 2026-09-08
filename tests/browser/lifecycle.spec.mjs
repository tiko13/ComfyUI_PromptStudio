import assert from 'node:assert/strict';
import {startFixture, attachVideo, config} from './fixture.mjs';

const fixture=await startFixture();
const doc=structuredClone(config.default_document);
const operation={id:'prepare-a',prompt_id:'',status:'validating',kind:'base',preparation_kind:'base',
  workflow_id:'synthetic',workflow_name:'Synthetic',workflow_director_node_id:'1',
  workflow_snapshot:{workflow:{nodes:[]},output:{'1':{class_type:'PSV_MiniMaxH3Director',inputs:{}}}},
  result_node_ids:['2'],result_fields:['videos'],document:doc,outputs:[],created_at:1,updated_at:1};
const project=(id,name,generations)=>({id,name,brief:'',workflow_id:'',document:structuredClone(doc),generations,created_at:1,updated_at:1});
fixture.projects={revision:1,projects:[project('a','Project A',[operation]),project('b','Project B',[])],active_project_id:'a'};
let releaseCompile,compiling=false;
const gate=new Promise(resolve=>{releaseCompile=resolve;});
try {
  await fixture.context.route('**/scripts/api.js',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:(await response.text())+'\napi.queuePrompt=async()=>({prompt_id:"video-a"});'});
  });
  await fixture.context.route('**/promptstudio-video/document/compile',async route=>{
    compiling=true;await gate;
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({valid:true,document:doc,
      compiled_prompt:'Synthetic courier shot.',resolved_mode:'t2va',frame_count:124,effective_duration:5})});
  });
  await fixture.context.route('**/lifecycle-popup',route=>route.fulfill({status:200,contentType:'text/html',body:
    '<!doctype html><html><body><main id="promptstudio-image-mount"></main><main id="promptstudio-video-mount"></main></body></html>'}));
  const page=await fixture.newPage();
  assert.equal(compiling,true);
  const owner=await page.evaluate(async()=>{
    const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const chat=state.chats.find(item=>item.id===state.activeChatId);
    chat.messages.push({id:'image-job-a',role:'assistant',text:'Preparing synthetic image',createdAt:Date.now(),updatedAt:Date.now(),
      promptId:'image-a',generationState:'queued',images:[]});
    state.studioPreparations.set('prepare-image-a',{chatId:chat.id,kind:'revision'});return chat.id;
  });
  await page.locator('#promptstudio-new-chat').click();
  assert.deepEqual(await page.evaluate(async owner=>{
    const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const {api}=await import('/scripts/api.js');
    api.dispatchEvent(new CustomEvent('execution_start',{detail:{prompt_id:'image-a'}}));
    api.dispatchEvent(new CustomEvent('progress',{detail:{prompt_id:'image-a',value:3,max:10}}));
    return {switched:state.activeChatId!==owner,owner:state.studioPreparations.get('prepare-image-a')?.chatId,
      status:state.chats.find(item=>item.id===owner).messages.find(item=>item.promptId==='image-a').generationState,
      progress:state.generationProgress.get('image-a')?.value};
  },owner),{switched:true,owner,status:'generating',progress:3});
  await attachVideo(page);
  await page.locator('.psvstudio-project').filter({hasText:'Project B'}).click();
  const queued=page.waitForResponse(async response=>response.url().endsWith('/promptstudio-video/projects')
    &&response.request().method()==='PUT'&&response.request().postData()?.includes('"prompt_id":"video-a"'));
  releaseCompile();await queued;
  await page.evaluate(async()=>{
    const {api}=await import('/scripts/api.js');
    api.dispatchEvent(new CustomEvent('execution_start',{detail:{prompt_id:'video-a'}}));
    api.dispatchEvent(new CustomEvent('progress',{detail:{prompt_id:'video-a',value:4,max:10}}));
  });
  await page.locator('.psvstudio-project').filter({hasText:'Project A'}).click();
  await page.waitForFunction(()=>document.querySelector('#psvstudio-generation-list .psvstudio-progress span')?.style.getPropertyValue('--progress')==='40%');
  assert.equal(fixture.projects.projects.find(item=>item.id==='b').generations.length,0);
  await page.evaluate(async()=>{
    const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    state.popup=null;state.panel.hidden=false;document.querySelector('#promptstudio-image-mount').hidden=false;
  });
  const popupPromise=fixture.context.waitForEvent('page');
  await page.evaluate(()=>{window.__lifecyclePopup=window.open('/lifecycle-popup','lifecycle-popup');});
  const popup=await popupPromise;await popup.waitForLoadState();
  await page.evaluate(async()=>{
    const input=document.querySelector('#promptstudio-revision');input.value='Preserve the caret';input.focus();input.setSelectionRange(3,8);
    window.__lifecycleImageInput=input;
    await window.__promptstudioPromptStudioHost.attach(window.__lifecyclePopup);
    await window.__promptstudioPromptStudioHost.attach(window.__lifecyclePopup);
  });
  assert.deepEqual(await popup.evaluate(()=>({same:document.activeElement===opener.__lifecycleImageInput,
    selection:[document.activeElement.selectionStart,document.activeElement.selectionEnd]})),{same:true,selection:[3,8]});
  await page.evaluate(async()=>{
    const input=document.querySelector('#psvstudio-project-title');input.focus();input.setSelectionRange(1,5);window.__lifecycleVideoInput=input;
    const video=document.createElement('video');video.dataset.lifecycle='preserved';document.querySelector('#psvstudio-preview').append(video);window.__lifecycleVideo=video;
    await window.__promptstudioVideoStudioHost.attach(window.__lifecyclePopup);
    await window.__promptstudioVideoStudioHost.attach(window.__lifecyclePopup);
  });
  assert.deepEqual(await popup.evaluate(()=>({same:document.activeElement===opener.__lifecycleVideoInput,
    selection:[document.activeElement.selectionStart,document.activeElement.selectionEnd],
    media:document.querySelector('[data-lifecycle="preserved"]')===opener.__lifecycleVideo})),{same:true,selection:[1,5],media:true});
  await popup.close();
  await page.waitForFunction(()=>document.querySelector('#promptstudio-revision')&&document.querySelector('#psvstudio-project-title'));
  const registrations=await page.evaluate(async()=>{
    const {extensions}=await import('/scripts/app.js');
    await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    await import('/extensions/PromptStudio_Video/js/promptstudio_video_studio.js');return extensions.map(item=>item.name);
  });
  assert.equal(new Set(registrations).size,registrations.length);
  assert.equal(fixture.requests.some(request=>request.path==='/interrupt'),false);
  assert.deepEqual(fixture.errors,[]);
  console.log('Lifecycle browser checks passed: preparation/session switching, background progress, popup caret/media identity, docking, unique registration; synthetic transport only.');
} finally {releaseCompile();await fixture.close();}
