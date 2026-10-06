import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';
const fixture = await startFixture();
const image = {filename:'imported.png',subfolder:'promptstudio',type:'input',width:64,height:64};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const final = 'A cinematic close-up watercolor of a red cat sitting beside a blue mug.';
const main = 'A red cat sitting beside a blue mug.';
let captions=0, visions=0, fail=false, release;
try {
  await fixture.context.route('**/js/prompt_studio.js', async route => {
    const response=await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nexport {saveChats,renderChatHistory,restoreChatState,captionImageIntoPrompts};'});
  });
  await fixture.context.route('**/view?*',route=>route.fulfill({contentType:'image/png',body:png}));
  await fixture.context.route('**/prompt-studio/import-image',route=>route.fulfill({json:{image}}));
  await fixture.context.route('**/prompt-studio/vision-capability',route=>{visions++;return route.fulfill({json:{available:true}});});
  await fixture.context.route('**/prompt-studio/caption-image',async route=>{
    captions++;
    assert.equal(route.request().postDataJSON().derive_main_prompt,true);
    if(release===null) await new Promise(resolve=>release=resolve);
    await route.fulfill({status:fail?500:200,json:fail?{error:'Caption failed'}:{prompt:final,main_prompt:main}});
  });
  const page=await fixture.newPage();
  async function connect() {await page.evaluate(async()=>{
    const m=await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    window.captionTest={m,state};
  });}
  const chat=()=>page.evaluate(()=>structuredClone(window.captionTest.state.chats.find(c=>c.id===window.captionTest.state.activeChatId)));
  await connect();
  await page.evaluate(()=>{document.querySelector('#promptstudio-use-llm-amplification').checked=false;});
  // A real drop imports without LLM calls, even when amplification is disabled.
  await page.locator('#promptstudio-history').evaluate((el,b64)=>{
    const data=new DataTransfer();data.items.add(new File([Uint8Array.from(atob(b64),c=>c.charCodeAt(0))],'cat.png',{type:'image/png'}));
    el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));
  },png.toString('base64'));
  const offer=page.locator('.promptstudio-caption-offer');
  await offer.waitFor();
  assert.match(await offer.textContent(),/Do you want to create prompts for this image\?/);
  let imported=await chat();
  assert.equal(imported.messages[0].role,'user');
  assert.equal(imported.mainPrompt,'');assert.equal(imported.finalPrompt,'');
  assert.equal(imported.selectedSource.filename,image.filename);
  assert.equal(captions,0);assert.equal(visions,0);
  assert.equal(await page.locator('input[name="promptstudio-generation-action"][value="edit"]').isDisabled(),false);
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    const bounds=await page.locator('.promptstudio-image-actions').evaluate(el=>{
      const a=el.querySelector('.promptstudio-caption-image').getBoundingClientRect(),b=el.querySelector('.promptstudio-upscale-image').getBoundingClientRect();
      return {left:a.right,right:b.left,w:a.width,h:a.height,edge:b.right,viewport:innerWidth,scroll:el.scrollWidth,client:el.clientWidth};
    });
    assert.ok(bounds.left<=bounds.right);assert.ok(Math.abs(bounds.w-bounds.h)<2,JSON.stringify(bounds));
    assert.ok(bounds.edge<=bounds.viewport);assert.ok(bounds.scroll<=bounds.client);
  }
  await page.getByRole('button',{name:'Not now',exact:true}).focus();
  await page.keyboard.press('Enter');await offer.waitFor({state:'detached'});
  await page.evaluate(async()=>{window.captionTest.m.saveChats({immediate:true});await window.captionTest.state.chatSaveChain;});
  await page.reload();await page.waitForFunction(()=>window.studioReady);await connect();
  assert.equal(await offer.count(),0,'Dismissal survives reload');
  assert.equal((await chat()).selectedSource.filename,image.filename);
  assert.equal(captions,0);assert.equal(visions,0);
  // The square control is keyboard-accessible and independent of amplification.
  const captionButton=page.getByRole('button',{name:'Caption this image into Main and Final prompts',exact:true});
  await captionButton.focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>!window.captionTest.state.busy && window.captionTest.state.currentPrompt.includes('cinematic'));
  let result=await chat();assert.equal(result.finalPrompt,final);assert.equal(result.mainPrompt,main);
  assert.equal(result.messages.filter(m=>m.images.length).length,1);
  assert.equal(result.versions.at(-1).finalPrompt,final);
  assert.equal(captions,1);assert.equal(visions,1);
  assert.equal(fixture.requests.filter(r=>r.path.endsWith('/revise')||r.path==='/prompt').length,0);
  // Failed captioning is atomic and the imported image remains usable.
  fail=true;await captionButton.click();
  await page.waitForFunction(()=>!window.captionTest.state.busy && document.querySelector('#promptstudio-status').textContent.includes('Caption failed'));
  assert.equal((await chat()).finalPrompt,final);assert.equal((await chat()).mainPrompt,main);
  // A stale result cannot overwrite a newer manual edit.
  fail=false;release=null;await captionButton.click();
  await page.waitForFunction(()=>window.captionTest.state.busy);
  while(typeof release!=='function') await new Promise(r=>setTimeout(r,10));
  await page.evaluate(()=>{const {state}=window.captionTest;state.chats.find(c=>c.id===state.activeChatId).mainPrompt='Newer scene';});
  release();await page.waitForFunction(()=>!window.captionTest.state.busy);
  assert.equal((await chat()).mainPrompt,'Newer scene');
  // The under-image question invokes the same explicit action.
  await page.evaluate(()=>{const {state,m}=window.captionTest,c=state.chats.find(c=>c.id===state.activeChatId);c.initialized=false;c.messages[0].captionOffer='pending';m.restoreChatState(c);m.renderChatHistory();});
  await page.getByRole('button',{name:'Create prompts',exact:true}).click();
  await page.waitForFunction(()=>!window.captionTest.state.busy && window.captionTest.state.mainPrompt==='A red cat sitting beside a blue mug.');
  assert.equal(await offer.count(),0);
  await page.evaluate(async()=>{window.captionTest.m.saveChats({immediate:true});await window.captionTest.state.chatSaveChain;});
  await page.reload();await page.waitForFunction(()=>window.studioReady);await connect();
  result=await chat();assert.equal(result.mainPrompt,main);assert.equal(result.finalPrompt,final);assert.equal(await offer.count(),0);
  assert.deepEqual(fixture.errors,[]);
  console.log('Image import, opt-in caption, persisted dismissal/prompts, atomic failure/stale protection, keyboard and narrow layouts passed.');
} finally {await fixture.close();}
