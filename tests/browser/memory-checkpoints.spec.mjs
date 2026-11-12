import assert from 'node:assert/strict';
import {startFixture,attachVideo,videoEnabled} from './fixture.mjs';

const fixture=await startFixture();
try {
  await fixture.context.route('**/js/prompt_studio.js',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nexport {flushChatStore,normalizeChat};'});
  });
  if(videoEnabled)await fixture.context.route('**/js/promptstudio_video_studio.js',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nexport {state,persistProjects,writeProjectDraft,videoDraftPending};'});
  });
  const page=await fixture.newPage();
  await page.evaluate(async()=>{
    const m=await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    await m.flushChatStore();
    const template=state.chats.find(c=>c.id===state.activeChatId);
    // More than 12 MiB of saved execution graphs, without private user data.
    for(let i=0;i<12;i++){
      const chat=structuredClone(template);
      chat.id=`archive-${i}`;chat.initialized=true;
      chat.messages=[{id:`message-${i}`,role:'assistant',text:'Saved image',images:[],
        generationSnapshot:{output:{payload:`graph-${i}:`+'x'.repeat(1024*1024)}}}];
      state.chats.push(m.normalizeChat(chat));
      await m.flushChatStore();
    }
    window.memoryTest={m,state};
    const post=Worker.prototype.postMessage;
    window.memoryTransfers=[];
    Worker.prototype.postMessage=function(message,...args){
      const value=message.args?.[1]||message.value;
      if(value&&(message.method==='putReceipt'||message.method==='encode'||message.method==='records')){
        const records=value.chats||value.projects||(Array.isArray(value)?value:[]);
        window.memoryTransfers.push({method:message.method,ids:records.map(record=>record.id),
          baseline:Object.keys(value.chatBaseline||{}),base:(value.base||[]).map(record=>record.id)});
      }
      return post.call(this,message,...args);
    };
  });
  const cdp=await fixture.context.newCDPSession(page);
  const heap=async()=>{await cdp.send('HeapProfiler.collectGarbage');return (await cdp.send('Runtime.getHeapUsage')).usedSize;};
  const before=await heap();
  const result=await page.evaluate(async()=>{
    const {m,state}=window.memoryTest;
    const chat=state.chats.find(c=>c.id===state.activeChatId);
    for(let i=0;i<25;i++){chat.mainPrompt=`Edit ${i}`;await m.flushChatStore();}
    const transfers=window.memoryTransfers.splice(0);
    // Change an older chat too: incrementality must not assume only the active chat can change.
    const old=state.chats.find(c=>c.id==='archive-3');old.messages[0].text='Edited old result';
    await m.flushChatStore();
    return {id:chat.id,transfers,older:window.memoryTransfers.splice(0)};
  });
  const after=await heap();
  assert.ok(result.transfers.length>25);
  assert.ok(result.transfers.every(x=>x.ids.every(id=>id===result.id)), 'Unchanged archives must never cross the worker boundary');
  assert.ok(result.transfers.every(x=>x.baseline.every(id=>id===result.id)),'Recovery baselines must exclude unrelated archives');
  assert.ok(result.older.some(x=>x.ids.includes('archive-3')),'An edited inactive chat is still saved');
  assert.equal(fixture.chats.chats.find(c=>c.id==='archive-3').messages[0].text,'Edited old result');
  assert.ok(after-before<12*1024*1024,`Repeated saves retained ${(after-before)/1048576} MiB`);
  await page.reload();await page.waitForFunction(()=>window.studioReady);
  const afterReload=await page.evaluate(async()=>{
    const {createDraftOutbox,draftTabKey}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/chat/draft-outbox.js');
    const post=Worker.prototype.postMessage;
    const transferred=[];
    let done;
    const checkpoint=new Promise(resolve=>{done=resolve;});
    Worker.prototype.postMessage=function(message,...args){
      if(message.method==='putReceipt'&&message.args[1]?.composerText==='Unsent after reload'){
        transferred.push(...message.args[1].chats.map(chat=>chat.id));done();
      }
      return post.call(this,message,...args);
    };
    const input=document.querySelector('#promptstudio-revision');
    input.value='Unsent after reload';input.dispatchEvent(new Event('input',{bubbles:true}));
    await checkpoint;
    Worker.prototype.postMessage=post;
    // Check persistence through the same database after the worker's receipt.
    const box=createDraftOutbox();
    let saved;
    for(let i=0;i<100;i++){
      saved=await box.get(draftTabKey('image'));
      if(saved?.composerText==='Unsent after reload')break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    await box.close();
    return {transferred,text:saved?.composerText};
  });
  assert.deepEqual(afterReload.transferred.filter(id=>id.startsWith('archive-')),[],
    'Reloaded graph identities must not turn unchanged histories into worker payloads');
  assert.equal(afterReload.text,'Unsent after reload');
  if(videoEnabled){
    await attachVideo(page);
    await page.locator('#psvstudio-new-project').click();
    const video=await page.evaluate(async()=>{
      const v=await import('/extensions/PromptStudio_Video/js/promptstudio_video_studio.js');
      const {storageSnapshot}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/storage-snapshot.js');
      await v.persistProjects({immediate:true});
      const old={id:'video-archive',name:'Saved',generations:[{id:'result',status:'complete',workflow_snapshot:{output:{payload:'v'.repeat(1024*1024)}}}]};
      v.state.projects.push(old);v.state.projectBase.push(storageSnapshot(old));
      window.memoryTransfers=[];
      const post=Worker.prototype.postMessage;
      Worker.prototype.postMessage=function(message,...args){
        const value=message.args?.[1]||message.value;
        if(value&&(message.method==='putReceipt'||message.method==='encode'))window.memoryTransfers.push({
          method:message.method,ids:(value.projects||[]).map(p=>p.id),base:(value.base||[]).map(p=>p.id)});
        return post.call(this,message,...args);
      };
      const current=v.state.projects.find(p=>p.id===v.state.activeProjectId);
      current.name='Updated video';v.state.projectMutation++;
      await v.persistProjects({immediate:true});
      v.writeProjectDraft();
      await v.videoDraftPending;
      Worker.prototype.postMessage=post;
      return window.memoryTransfers;
    });
    assert.ok(video.some(x=>x.method==='encode'));
    assert.ok(video.every(x=>!x.ids.includes('video-archive')&&!x.base.includes('video-archive')),'Video checkpoints must omit unchanged project graphs');
  }
  assert.deepEqual(fixture.errors,[]);
  console.log(JSON.stringify({unchangedHistoryMiB:12,saveCycles:25,retainedHeapDeltaMiB:(after-before)/1048576,video:videoEnabled}));
} finally {await fixture.close();}
