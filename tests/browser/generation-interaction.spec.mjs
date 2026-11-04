import assert from 'node:assert/strict';
import {startFixture, attachVideo, config, videoEnabled} from './fixture.mjs';

const fixture = await startFixture();
fixture.projects={revision:1,active_project_id:'busy-video',projects:[{id:'busy-video',name:'Busy Video',
  document:structuredClone(config.default_document),created_at:1,updated_at:1,generations:[]}]};
try {
  await fixture.context.route('**/js/prompt_studio.js',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nexport {renderChatHistory,updateActiveLlmOperationProgress};'});
  });
  await fixture.context.route('**/js/promptstudio_video_studio.js',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nexport {state,renderGenerations};'});
  });
  const page=await fixture.newPage();
  const image=await page.evaluate(async()=>{
    const m=await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const {api}=await import('/scripts/api.js');
    await state.chatSaveChain;
    state.chatPersistenceBlocked=true;
    const chat=state.chats.find(chat=>chat.id===state.activeChatId);
    chat.initialized=true;
    chat.messages=Array.from({length:1000},(_,i)=>({id:`stream-${i}`,role:'assistant',text:`Older result ${i}`,
      images:[],createdAt:i+1,generationSnapshot:{output:{node:{inputs:{data:'x'.repeat(1024)}}}}}));
    chat.messages.push({id:'running',role:'assistant',text:'',images:[],promptId:'streaming',operationId:'running',
      generationState:'generating',operationPhase:'generating',operationStatus:'Generating'});
    chat.messages.push({id:'thinking',role:'assistant',text:'',images:[],operationId:'thinking',operationPhase:'llm_processing'});
    m.renderChatHistory();
    const history=document.querySelector('#promptstudio-history');
    const cancel=history.querySelector('[data-message-id="running"] .promptstudio-operation-cancel');
    const progress=history.querySelector('[data-message-id="running"] [role=progressbar]');
    const editor=document.querySelector('#promptstudio-main-prompt');
    const {createSearchableSelect}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/searchable-select.js');
    const select=createSearchableSelect({items:Array.from({length:10000},(_,i)=>({name:`model-${i}`,label:`Model ${i}`})),label:'Streaming catalog'});
    state.panel.append(select.element);
    const input=select.element.querySelector('input');input.focus();
    const mutationVersion=state.chatMutationVersion;
    const oldText=chat.messages[0].text;
    let historyReads=0;
    Object.defineProperty(chat.messages[0],'text',{configurable:true,get(){historyReads++;return oldText;}});
    let mutations=0;
    const observer=new MutationObserver(records=>{mutations+=records.length;});observer.observe(history,{childList:true,subtree:true});
    const durations=[];
    for(let frame=0;frame<30;frame++) {
      const start=performance.now();
      for(let event=0;event<8;event++) api.dispatchEvent(new CustomEvent(event%2?'progress':'progress_state',{detail:{prompt_id:'streaming',
        value:frame*8+event,max:240,nodes:{sampler:{state:'running',value:frame*8+event,max:240}}}}));
      m.updateActiveLlmOperationProgress({busy:true,generated_tokens:frame,provider:'koboldcpp'});
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
      durations.push(performance.now()-start);
      await new Promise(resolve=>requestAnimationFrame(resolve));
    }
    const records=observer.takeRecords();observer.disconnect();
    const result={maxBatchMs:Math.max(...durations),medianBatchMs:durations.sort((a,b)=>a-b)[15],
      stableCancel:cancel===history.querySelector('[data-message-id="running"] .promptstudio-operation-cancel'),
      stableProgress:progress===history.querySelector('[data-message-id="running"] [role=progressbar]'),
      selection:input.getAttribute('aria-activedescendant'),focus:document.activeElement===input,
      progressValue:history.querySelector('[data-message-id="running"] [role=progressbar]').getAttribute('aria-valuenow'),
      saves:state.chatMutationVersion-mutationVersion,mutations:mutations+records.length,historyReads};
    Object.defineProperty(chat.messages[0],'text',{configurable:true,writable:true,value:oldText});
    const typing=[];
    editor.focus();
    for (let frame=0;frame<20;frame++) {
      const start=performance.now();
      api.dispatchEvent(new CustomEvent('progress',{detail:{prompt_id:'streaming',value:frame,max:20}}));
      m.updateActiveLlmOperationProgress({busy:true,generated_tokens:100+frame,provider:'koboldcpp'});
      editor.value='Typing during generation';editor.dispatchEvent(new Event('input',{bubbles:true}));
      typing.push(performance.now()-start);
      await new Promise(resolve=>requestAnimationFrame(resolve));
    }
    result.typingMedianMs=typing.sort((a,b)=>a-b)[10];
    result.editorFocus=document.activeElement===editor;
    result.text=chat.mainPrompt;
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));
    result.wrapSelection=input.getAttribute('aria-activedescendant');
    result.wrapOptions=select.element.querySelectorAll('[role=option]').length;
    input.value='no matching model';input.dispatchEvent(new Event('input'));
    result.empty=select.element.querySelector('[role=status]')?.textContent;
    select.element.remove();
    return result;
  });
  console.log('Interaction during Image generation:',image);
  assert.equal(image.stableCancel,true,'Progress updates must preserve interactive controls');
  assert.equal(image.stableProgress,true,'Progress updates must patch the existing bar');
  assert.equal(image.focus,true);
  assert.match(image.selection,/-30$/);
  assert.equal(image.progressValue,'100');
  assert.equal(image.saves,0,'Transient progress must not schedule history persistence');
  assert.equal(image.historyReads,0,'LLM/progress ticks must not traverse historical message content');
  assert.equal(image.text,'Typing during generation');
  assert.equal(image.editorFocus,true);
  assert.match(image.wrapSelection,/-9999$/);
  assert.ok(image.wrapOptions<=80,'Keyboard wrap must keep large dropdown DOM bounded');
  assert.equal(image.empty,'No matching LoRAs');
  assert.ok(image.medianBatchMs<16,JSON.stringify(image));
  assert.ok(image.typingMedianMs<16,JSON.stringify(image));
  if(videoEnabled) {
    await attachVideo(page);
    const video=await page.evaluate(async()=>{
      const {state,renderGenerations}=await import('/extensions/PromptStudio_Video/js/promptstudio_video_studio.js');
      const {api}=await import('/scripts/api.js');
      const project=state.projects.find(project=>project.id===state.activeProjectId);
      project.generations=Array.from({length:300},(_,i)=>({id:`video-${i}`,prompt_id:`v-${i}`,status:i===299?'generating':'complete',
        workflow_name:'Saved workflow',document:project.document,outputs:[],frame_count:121,effective_duration:5}));
      renderGenerations();
      const list=state.panel.querySelector('#psvstudio-generation-list');
      const bodies=[...list.querySelectorAll('.psvstudio-generation-body')];
      const before=state.projectMutation, durations=[];
      for(let frame=0;frame<30;frame++) {
        const start=performance.now();
        for(let event=0;event<8;event++) api.dispatchEvent(new CustomEvent('progress',{detail:{prompt_id:'v-299',value:frame*8+event,max:240}}));
        durations.push(performance.now()-start);
        await new Promise(resolve=>requestAnimationFrame(resolve));
      }
      return {maxBatchMs:Math.max(...durations),medianBatchMs:durations.sort((a,b)=>a-b)[15],
        unchangedBodies:bodies.filter((body,i)=>list.children[i].querySelector('.psvstudio-generation-body')===body).length,
        saves:state.projectMutation-before,progress:state.generationProgress.get('v-299').value};
    });
    console.log('Interaction during Video generation:',video);
    assert.equal(video.unchangedBodies,300,'Progress must not rebuild the generation archive');
    assert.equal(video.saves,0);assert.equal(video.progress,239);
    assert.ok(video.medianBatchMs<16,JSON.stringify(video));
  }
  assert.deepEqual(fixture.errors,[]);
} finally {await fixture.close();}
