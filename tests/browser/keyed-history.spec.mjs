import assert from 'node:assert/strict';
import {startFixture, attachVideo, config, videoEnabled} from './fixture.mjs';

const fixture = await startFixture();
fixture.projects = {revision:1,active_project_id:'history-project',projects:[{
  id:'history-project',name:'History fixture',document:structuredClone(config.default_document),generations:[],created_at:1,updated_at:1,
}]};
try {
  // Expose existing renderers only in this isolated test response; production has no test hooks.
  await fixture.context.route('**/js/prompt_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: await response.text() + '\nexport {renderChatHistory,renderConsultHistory};'});
  });
  await fixture.context.route('**/js/promptstudio_video_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: await response.text() + '\nexport {state,renderDirectorDialog,directorSession,ensureDirectorDialog};'});
  });
  const page = await fixture.newPage();
  const results = await page.evaluate(async () => {
    const image = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const chat = state.chats.find(item => item.id === state.activeChatId);
    const messages = prefix => Array.from({length:500}, (_, i) => ({id:`${prefix}-${i}`,role:i%2?'assistant':'user',
      text:`Synthetic message ${i}: preserve this selected text.`,images:[],createdAt:1,updatedAt:1}));
    chat.messages = messages('image');
    chat.messages[200].images = [{filename:'synthetic.png',subfolder:'',type:'output'}];
    chat.messages[200].canonicalPrompt = 'A synthetic subject';
    chat.messages[200].mainPrompt = 'A synthetic subject';
    image.renderChatHistory();
    function check(history, render, change, textSelector) {
      const cards = [...history.children];
      const anchor = cards[200];
      history.scrollTop = anchor.offsetTop - history.offsetTop;
      history.dispatchEvent(new Event('scroll'));
      const top = anchor.getBoundingClientRect().top;
      const text = anchor.querySelector(textSelector).firstChild;
      const range = document.createRange(); range.setStart(text,0); range.setEnd(text,9);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      const selected = selection.toString();
      const details = anchor.querySelector('details'); if(details) details.open = true;
      const media = anchor.querySelector('img');
      const times = [];
      let mutations = 0;
      const observer = new MutationObserver(() => {}); observer.observe(history,{childList:true,subtree:true,characterData:true});
      for(let i=0;i<20;i++) { change(i); const start=performance.now(); render(); times.push(performance.now()-start); mutations += observer.takeRecords().length; }
      observer.disconnect();
      const answer = {count:cards.length, identical:cards.every((card,i)=>history.children[i]===card),
        selection:selection.toString()===selected, textIdentity:anchor.querySelector(textSelector).firstChild===text,
        anchorDelta:Math.abs(anchor.getBoundingClientRect().top-top),
        media:!media||anchor.querySelector('img')===media, details:!details||details.open,
        mutations, medianMs:times.sort((a,b)=>a-b)[10], maxMs:Math.max(...times)};
      selection.removeAllRanges();
      return answer;
    }
    const imageResult = check(state.panel.querySelector('#promptstudio-history'),()=>image.renderChatHistory(),
      i=>{chat.messages[499].text=`Pending ${i}`;},'.promptstudio-message-text');
    // A changed card also retains its image nested inside an interactive preview and open inspector.
    const imageCard = state.panel.querySelector('[data-message-id="image-200"]');
    const imageNode = imageCard.querySelector('img');
    chat.messages[200].text += ' changed'; image.renderChatHistory();
    imageResult.changedCardMedia = imageCard.querySelector('img') === imageNode;
    imageResult.changedCardDetails = imageCard.querySelector('details').open;
    chat.consultMessages = messages('consult');
    state.panel.querySelector('#promptstudio-consult').hidden = false;
    const last = chat.consultMessages[499];
    last.variants = [{id:'v1',text:last.text},{id:'v2',text:'Alternative synthetic response'}];
    last.variantIndex = 0;
    image.renderConsultHistory();
    const consultResult = check(state.panel.querySelector('#promptstudio-consult-history'),()=>image.renderConsultHistory(),
      i=>{last.text=`Pending ${i}`;},'.promptstudio-consult-message-text');
    const next = state.panel.querySelector('#promptstudio-consult-history article:last-child button:last-child');
    next.focus(); next.click();
    consultResult.variant = last.variantIndex === 1;
    consultResult.focus = document.activeElement?.getAttribute('aria-label') === 'Regenerate answer';
    // Per-message deletion path should remove only its card; delete storage happens in its existing handler.
    const before = [...state.panel.querySelector('#promptstudio-history').children];
    chat.messages.splice(250,1); image.renderChatHistory();
    imageResult.deletion = !before[250].isConnected && before.filter((_,i)=>i!==250).every(card=>card.isConnected);
    return {image:imageResult,consult:consultResult};
  });
  if (videoEnabled) {
    await attachVideo(page);
    results.director = await page.evaluate(async () => {
      const video = await import('/extensions/PromptStudio_Video/js/promptstudio_video_studio.js');
      const session = video.directorSession();
      session.messages = Array.from({length:500},(_,i)=>({id:`director-${i}`,role:i%2?'assistant':'user',text:`Director message ${i}`}));
      const dialog = video.ensureDirectorDialog(); dialog.showModal(); video.renderDirectorDialog();
      const history = dialog.querySelector('#psvstudio-director-history');
      const cards = [...history.children]; const anchor = cards[200];
      history.scrollTop = anchor.offsetTop-history.offsetTop;
      const top = anchor.getBoundingClientRect().top;
      const text = anchor.querySelector('.psvstudio-director-message-text').firstChild;
      const range = document.createRange(); range.setStart(text,0); range.setEnd(text,8);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      const times = []; let mutations = 0;
      const observer = new MutationObserver(()=>{}); observer.observe(history,{childList:true,subtree:true,characterData:true});
      for(let i=0;i<20;i++) {session.messages[499].variants[0].text=`Pending ${i}`;const start=performance.now();video.renderDirectorDialog();times.push(performance.now()-start);mutations+=observer.takeRecords().length;}
      observer.disconnect();
      return {count:cards.length,identical:cards.every((card,i)=>history.children[i]===card),selection:getSelection().toString()==='Director',
        textIdentity:anchor.querySelector('.psvstudio-director-message-text').firstChild===text,
        anchorDelta:Math.abs(anchor.getBoundingClientRect().top-top),mutations,medianMs:times.sort((a,b)=>a-b)[10],maxMs:Math.max(...times)};
    });
  }
  results.playback = await page.evaluate(async () => {
    const {reconcileKeyedHistory} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/keyed-history.js');
    const history = document.createElement('div'); document.body.append(history);
    const canvas = document.createElement('canvas'); canvas.width=32; canvas.height=32;
    const stream = canvas.captureStream(10);
    const rows=[{id:'media',text:'before'},{id:'pending',text:'before'}];
    const render=()=>reconcileKeyedHistory(history,rows,{create:row=>{
      const card=document.createElement('article');const text=document.createElement('p');text.textContent=row.text;card.append(text);
      if(row.id==='media'){const media=document.createElement('video');media.muted=true;media.srcObject=stream;card.append(media);}
      return card;
    }});
    const paint=setInterval(()=>canvas.getContext('2d').fillRect(0,0,32,32),30);
    render(); const media=history.querySelector('video');await media.play();
    await new Promise(resolve=>setTimeout(resolve,150));const start=media.currentTime;
    rows[0].text='changed';rows[1].text='progress';const counts=render();
    await new Promise(resolve=>setTimeout(resolve,150));
    const result={identity:history.querySelector('video')===media,playing:!media.paused,advanced:media.currentTime>start,counts};
    clearInterval(paint);stream.getTracks().forEach(track=>track.stop());history.remove();return result;
  });
  for(const name of ['image','consult',...(videoEnabled ? ['director'] : [])]) {
    const result=results[name];assert.equal(result.count,500,name);assert.equal(result.identical,true,name);
    assert.equal(result.selection,true,name);assert.equal(result.textIdentity,true,name);assert.ok(result.anchorDelta<2,JSON.stringify(result));
    assert.ok(result.mutations<200,`${name}: ${result.mutations} mutations`);
  }
  for(const key of ['media','details','changedCardMedia','changedCardDetails','deletion'])assert.equal(results.image[key],true,key);
  assert.equal(results.consult.variant,true);assert.equal(results.consult.focus,true);
  assert.equal(results.playback.identity,true);assert.equal(results.playback.playing,true);assert.equal(results.playback.advanced,true);
  assert.deepEqual(fixture.errors,[]);
  console.log(JSON.stringify(results,null,2));
} finally {await fixture.close();}
