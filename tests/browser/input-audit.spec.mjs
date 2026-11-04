import assert from 'node:assert/strict';
import {startFixture,attachVideo,videoEnabled,config} from './fixture.mjs';

const fixture=await startFixture();
config.aspect_presets=[];
config.modes=['auto'];
fixture.projects={revision:1,active_project_id:'editing',projects:[{id:'editing',name:'Editing',
  document:structuredClone(config.default_document),generations:[],created_at:1,updated_at:1}]};
try {
  await fixture.context.route('**/js/prompt_studio.js',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nexport {renderPlotWorkspace,renderKnownReferenceHighlights};'});
  });
  await fixture.context.route('**/js/promptstudio_video_studio.js',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nexport {state,renderInspector,renderTimeline,undoTimeline,showGlobalSettings};'});
  });
  const page=await fixture.newPage();
  const image=await page.evaluate(async()=>{
    const m=await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const {normalizePlotDraft}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/plot/model.js');
    await state.chatSaveChain;
    const editor=state.panel.querySelector('#promptstudio-main-prompt');
    editor.value='A long prompt\n'.repeat(400);editor.dispatchEvent(new Event('input'));
    m.renderKnownReferenceHighlights();
    const content=state.panel.querySelector('#promptstudio-main-prompt-highlight-content');
    const textNode=content.firstChild;
    for(let i=0;i<20;i++) {editor.scrollTop=i*10;editor.dispatchEvent(new Event('scroll'));}
    await new Promise(resolve=>requestAnimationFrame(resolve));
    const stableHighlights=textNode===content.firstChild;
    const chat=state.chats.find(chat=>chat.id===state.activeChatId);
    chat.sessionMode='plot';chat.plotDraft=normalizePlotDraft({title:'Audit',prompt:'Before'});
    m.renderPlotWorkspace();
    const prompt=state.panel.querySelector('.promptstudio-plot-basics textarea');
    const sidebar=state.panel.querySelector('#promptstudio-chat-list').firstChild;
    const axes=chat.plotDraft.axes;
    const start=performance.now();
    for(let i=0;i<50;i++){prompt.value=`Latest plot prompt ${i}`;prompt.dispatchEvent(new Event('input'));}
    const inputMs=performance.now()-start;
    await new Promise(resolve=>requestAnimationFrame(resolve));
    return {stableHighlights,stableSidebar:sidebar===state.panel.querySelector('#promptstudio-chat-list').firstChild,
      stableAxes:axes===chat.plotDraft.axes,text:chat.plotDraft.prompt,inputMs};
  });
  assert.equal(image.stableHighlights,true,'Scrolling must retain highlight text nodes');
  assert.equal(image.stableSidebar,true,'Plot typing must not rebuild the session list');
  assert.equal(image.stableAxes,true,'Plot typing must not renormalize unrelated axes');
  assert.equal(image.text,'Latest plot prompt 49');
  console.log('Image input audit:',image);
  if(videoEnabled) {
    await attachVideo(page);
    const video=await page.evaluate(async()=>{
      const m=await import('/extensions/PromptStudio_Video/js/promptstudio_video_studio.js');
      const {state}=m,project=state.projects.find(project=>project.id===state.activeProjectId);
      const shot=project.document.shots[0];
      project.document.shots=Array.from({length:100},(_,i)=>({...structuredClone(shot),id:`shot-${i}`,start:i*.04}));
      m.renderTimeline();m.renderInspector();m.showGlobalSettings();
      let reads=0;const shots=project.document.shots;
      Object.defineProperty(project.document,'shots',{configurable:true,get(){reads++;return shots;}});
      const title=state.panel.querySelector('#psvstudio-project-title');
      const row=state.panel.querySelector('#psvstudio-project-list').firstChild;
      const titleStart=performance.now();
      for(let i=0;i<50;i++){title.value=`Title ${i}`;title.dispatchEvent(new Event('input'));}
      const titleMs=performance.now()-titleStart,titleReads=reads;
      const stableSidebar=row===state.panel.querySelector('#psvstudio-project-list').firstChild;
      const brief=[...document.querySelectorAll('textarea')].find(input=>input.closest('label')?.textContent.includes('Video overview'));
      if(!brief) throw new Error('Production brief is missing');
      reads=0;const before=project.document.main_description;
      const inputStart=performance.now();
      for(let i=0;i<50;i++){brief.value=`Brief ${i}`;brief.dispatchEvent(new Event('input'));}
      const inputMs=performance.now()-inputStart,inputReads=reads;
      const latest=project.document.main_description;
      // Undo before the presentation frame must include the last keystroke.
      m.undoTimeline();const undone=project.document.main_description;
      m.undoTimeline(true);const redone=project.document.main_description;
      brief.value='Before checkbox';brief.dispatchEvent(new Event('input'));
      const silence=[...document.querySelectorAll('input[type=checkbox]')].find(input=>input.closest('label')?.textContent.includes('Complete silence'));
      const originalSilence=Boolean(project.document.complete_silence);
      silence.checked=!originalSilence;silence.dispatchEvent(new Event('change'));
      m.undoTimeline();
      const discreteUndo={text:project.document.main_description,silence:Boolean(project.document.complete_silence)};
      m.undoTimeline();const typingUndo=project.document.main_description;
      return {titleMs,titleReads,inputMs,inputReads,latest,before,undone,redone,
        discreteUndo,originalSilence,typingUndo,stableSidebar,projectName:project.name};
    });
    console.log('Video input audit:',video);
    assert.equal(video.titleReads,0,'Renaming must not scan or serialize the document');
    assert.equal(video.inputReads,0,'Brief keystrokes must not serialize the document');
    assert.equal(video.latest,'Brief 49');assert.equal(video.undone,video.before);assert.equal(video.redone,'Brief 49');
    assert.equal(video.projectName,'Title 49');
    assert.deepEqual(video.discreteUndo,{text:'Before checkbox',silence:video.originalSilence});
    assert.equal(video.typingUndo,'Brief 49');
    assert.equal(video.stableSidebar,true,'Renaming must preserve the project list');
  }
  assert.deepEqual(fixture.errors,[]);
} finally {await fixture.close();}
