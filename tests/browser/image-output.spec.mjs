import assert from 'node:assert/strict';
import {startFixture, attachVideo, videoEnabled, config} from './fixture.mjs';

Object.assign(config,{aspect_presets:[{width:1344,height:768,label:'Landscape'}],modes:['auto','t2va']});
const fixture = await startFixture();
if (videoEnabled) fixture.projects={revision:1,projects:[{id:'output-project',name:'Output test',brief:'',workflow_id:'',document:structuredClone(config.default_document),generations:[],created_at:1,updated_at:1}],active_project_id:'output-project'};
try {
  await fixture.context.route('**/js/prompt_studio.js', async route => {
    const response=await route.fetch(); await route.fulfill({response, body:await response.text()+'\nexport {refreshWorkflowControls,restoreChatState,captureGenerationQueueSettings,queueGeneration};'});
  });
  await fixture.context.route('**/scripts/api.js', async route => {
    const response=await route.fetch(); await route.fulfill({response, body:await response.text()+'\napi.queuePrompt=async(_,snapshot)=>{window.queuedSnapshots||=[];window.queuedSnapshots.push(structuredClone(snapshot));return {prompt_id:"output-"+window.queuedSnapshots.length};};'});
  });
  const page=await fixture.newPage();
  const open = () => page.locator('#promptstudio-toggle-studio-settings').click();
  await open();
  const output=page.locator('#promptstudio-studio-settings .promptstudio-image-output-settings');
  const field = key => output.locator(`[data-output="${key}"]`);
  assert.equal(await field('format').inputValue(),'webp');
  assert.ok(await field('quality').isVisible());
  assert.ok(await field('png_compression').isHidden());
  await field('quality').fill('93'); await field('quality').dispatchEvent('change');
  await field('mode').selectOption('lossless');
  assert.ok(await field('quality').isHidden());
  assert.ok(await field('lossless_effort').isVisible());
  await field('format').selectOption('png');
  assert.ok(await field('mode').isHidden());
  await field('png_compression').fill('0'); await field('png_compression').dispatchEvent('change');
  await field('png_optimize').check();
  assert.ok(await field('png_compression').isDisabled());
  await page.reload(); await page.waitForFunction(()=>window.studioReady); await open();
  assert.equal(await field('format').inputValue(),'png');
  assert.equal(await field('png_compression').inputValue(),'0');
  await field('format').selectOption('webp'); await field('mode').selectOption('lossy');
  assert.equal(await field('quality').inputValue(),'93');
  await page.evaluate(async()=>{
    const m=await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const chat=state.chats.find(c=>c.id===state.activeChatId);
    Object.assign(chat,{initialized:true,mainPrompt:'A test scene.',finalPrompt:'A test scene.',currentPrompt:'A test scene.'});
    const make=force=>({id:force?'forced':'normal',name:force?'Transparent example':'Ordinary example',kind:'create',promptNodeId:'p',resultNodeIds:['save'],loraNodes:[],modelNodes:[],snapshot:{workflow:{nodes:[{id:'save',type:'Save_as_webp_cond',widgets_values:['example','lossless',80,'yes','png',4,false,6,force]}],links:[]},output:{p:{class_type:'KCPP_PromptSlot',inputs:{prompt:''}},save:{class_type:'Save_as_webp_cond',inputs:{images:['decoder',0],filename_prefix:'example',mode:'lossless',compression:80,save:'yes',format:'png',force}}}}});
    state.workflowProfiles=[make(true),make(false)]; state.workflowBusy=true; state.apiConnected=true;
    chat.createWorkflowId='forced';m.refreshWorkflowControls();m.restoreChatState(chat);window.outputTest={m,state,chat};
  });
  const notice=output.locator('[data-output-workflow-notice]');
  assert.match(await notice.textContent(),/Transparent example.*forces PNG/);
  if (process.env.OUTPUT_SETTINGS_SCREENSHOT) await output.screenshot({path:process.env.OUTPUT_SETTINGS_SCREENSHOT});
  for (const width of [1440,768,390]) {
    await page.setViewportSize({width,height:1000});
    await page.locator('#promptstudio-studio-settings').evaluate(node=>{node.scrollTop=0;});
    assert.ok(await page.locator('#promptstudio-studio-settings').evaluate(node=>node.scrollWidth<=node.clientWidth+1), `Settings overflow at ${width}px`);
    if(process.env.OUTPUT_SETTINGS_SCREENSHOT) await page.screenshot({path:process.env.OUTPUT_SETTINGS_SCREENSHOT.replace('.png',`-${width}.png`)});
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('#promptstudio-close-studio-settings').click();
  await page.evaluate(async()=>{const {m,chat}=window.outputTest; await m.queueGeneration({...m.captureGenerationQueueSettings('create'),mainPrompt:chat.mainPrompt,finalPrompt:chat.finalPrompt,executionPrompt:chat.finalPrompt,independent:true});});
  let snapshot=await page.evaluate(()=>window.queuedSnapshots?.at(-1));assert.ok(snapshot);
  assert.equal(snapshot.output.save.inputs.format,'png');assert.equal(snapshot.output.save.inputs.force,true);
  await open();
  // Fixture pins workflow discovery while exercising selection notifications.
  await page.evaluate(()=>{const select=document.querySelector('#promptstudio-create-workflow');select.value='normal';select.dispatchEvent(new Event('change',{bubbles:true}));});
  assert.ok(await notice.isHidden());
  await field('format').selectOption('png');await page.locator('#promptstudio-close-studio-settings').click();
  await page.evaluate(async()=>{const {m,chat}=window.outputTest; await m.queueGeneration({...m.captureGenerationQueueSettings('create'),mainPrompt:chat.mainPrompt,finalPrompt:chat.finalPrompt,executionPrompt:chat.finalPrompt,independent:true});});
  snapshot=await page.evaluate(()=>window.queuedSnapshots.at(-1));
  assert.equal(snapshot.output.save.inputs.png_compression,0);assert.equal(snapshot.output.save.inputs.png_optimize,true);
  await page.evaluate(async saved=>{
    const {saveImageOutputSettings}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/settings/image-output.js');
    saveImageOutputSettings({format:'webp',quality:93});
    const {m,chat}=window.outputTest;
    window.outputReplay=m.queueGeneration({...m.captureGenerationQueueSettings('create'),mainPrompt:chat.mainPrompt,finalPrompt:chat.finalPrompt,executionPrompt:chat.finalPrompt,generationSnapshot:saved,independent:true});
  },snapshot);
  await page.getByRole('button',{name:'Replay saved inputs',exact:true}).click();
  await page.evaluate(async()=>{await window.outputReplay;const {saveImageOutputSettings}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/settings/image-output.js');saveImageOutputSettings({format:'png',quality:93});});
  const replay=await page.evaluate(()=>window.queuedSnapshots.at(-1));
  assert.equal(replay.output.save.inputs.format,'png');assert.equal(replay.output.save.inputs.png_optimize,true);
  if(videoEnabled) {
    await attachVideo(page);
    await page.getByRole('button',{name:'Global settings',exact:true}).click();
    assert.deepEqual(fixture.errors,[]);
    const video=page.locator('.psvstudio-global-settings-dialog .promptstudio-image-output-settings');
    assert.equal(await video.locator('[data-output="format"]').inputValue(),'png');
    await video.locator('[data-output="format"]').selectOption('webp');
    assert.equal(await video.locator('[data-output="quality"]').inputValue(),'93');
  }
  assert.deepEqual(fixture.errors,[]);
  console.log('Image output settings: conditional controls, persistence, forced workflow notice, queued PNG and shared Video settings passed.');
} finally {await fixture.close();}
