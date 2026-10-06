import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {startFixture,attachVideo,config,videoEnabled} from './fixture.mjs';

const fixture = await startFixture();
const kinds = ['create','edit','upscale'];
const selection = suffix => Object.fromEntries(kinds.map(kind => [`${kind}WorkflowId`,`${kind}-${suffix}`]));
const defaults = {createWorkflowId:'create-b',editWorkflowId:'edit-a',upscaleWorkflowId:'upscale-b'};
let profiles = ['a','b'].flatMap(suffix => kinds.map(kind => ({
  id:`${kind}-${suffix}`,name:`${kind} workflow ${suffix}`,kind,promptNodeId:'1',imageNodeId:'2',upscaleNodeId:'3',
  snapshot:{workflow:{nodes:[],links:[]},output:{}},
})));
try {
  fixture.chats = {revision:1,activeChatId:'source',chats:[
    {id:'source',initialized:true,mainPrompt:'A scene',finalPrompt:'A scene',...selection('a')},
    {id:'empty',...selection('a')},
  ]};
  await fixture.context.route('**/prompt-studio/workflows', route => route.fulfill({json:{templates:profiles,revision:1}}));
  await fixture.context.route('**/userdata?*', route => route.fulfill({status:503,json:{error:'Use cached workflows'}}));
  await fixture.context.route('**/js/prompt_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nexport {createChat,activateChat,saveChats,deleteChat};'});
  });
  const page = await fixture.newPage();
  const values = () => page.evaluate(() => Object.fromEntries(['create','edit','upscale'].map(kind =>
    [`${kind}WorkflowId`,document.querySelector(`#promptstudio-${kind}-workflow`).value])));
  const invoke = (name,arg) => page.evaluate(async ({name,arg}) => {
    const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    await m[name](arg);
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    m.saveChats({immediate:true}); await state.chatSaveChain;
    return state.activeChatId;
  },{name,arg});
  await page.locator('#promptstudio-toggle-studio-settings').click();
  for (const kind of kinds) {
    await page.locator(`#promptstudio-${kind}-workflow`).selectOption(defaults[`${kind}WorkflowId`]);
    const button = page.locator(`#promptstudio-default-${kind}-workflow`);
    assert.equal(await button.textContent(),'Make default workflow');
    if (kind === 'edit') { await button.focus(); await page.keyboard.press('Enter'); }
    else await button.click();
    assert.equal(await button.isDisabled(),true);
    assert.match(await page.locator(`#promptstudio-${kind}-workflow option:checked`).textContent(),/ · Default$/);
  }
  await mkdir('test-results/browser',{recursive:true});
  await page.locator('.promptstudio-workflow-routing-fields').screenshot({path:'test-results/browser/workflow-defaults-desktop.png'});
  const boxes = await page.locator('.promptstudio-workflow-routing-row').evaluateAll(rows => rows.map(row => {
    const r = row.getBoundingClientRect(), s = row.querySelector('select').getBoundingClientRect(), b = row.querySelector('button').getBoundingClientRect();
    return {top:r.top,bottom:r.bottom,selectRight:s.right,buttonLeft:b.left};
  }));
  assert.ok(boxes[0].bottom <= boxes[1].top && boxes[1].bottom <= boxes[2].top,'One workflow per row');
  assert.ok(boxes.every(box => box.selectRight <= box.buttonLeft),'Buttons sit beside their selectors');
  await page.setViewportSize({width:390,height:844});
  await page.locator('.promptstudio-workflow-routing-fields').screenshot({path:'test-results/browser/workflow-defaults-mobile.png'});
  assert.equal(await page.locator('.promptstudio-workflow-routing-fields').evaluate(root => root.scrollWidth <= root.clientWidth),true,'Rows fit narrow settings');
  for (const kind of kinds) await page.locator(`#promptstudio-${kind}-workflow`).selectOption(`${kind}-a`);
  assert.equal(await page.locator('#promptstudio-default-create-workflow').isEnabled(),true);
  assert.match(await page.locator('#promptstudio-create-workflow option[value="create-b"]').textContent(),/Default/);
  await page.locator('#promptstudio-close-studio-settings').click();
  await invoke('saveChats',{immediate:true});
  await page.reload(); await page.waitForFunction(() => window.studioReady);
  assert.deepEqual(await values(),selection('a'),'Reload preserves existing chat selections separately from defaults');
  assert.match(await page.locator('#promptstudio-create-workflow option[value="create-b"]').textContent(),/Default/);
  assert.equal(await invoke('createChat'),'empty');
  assert.deepEqual(await values(),defaults,'Reused empty chat uses each operation default');
  await invoke('activateChat','source');
  assert.deepEqual(await values(),selection('a'),'Existing chat keeps choices after default-based new chat creation');
  // Make the reusable chat nonempty, so New must allocate a fresh record.
  await page.evaluate(async () => {
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    state.chats.find(chat => chat.id === 'empty').initialized = true;
  });
  const freshId = await invoke('createChat');
  assert.notEqual(freshId,'empty');
  assert.deepEqual(await values(),defaults,'Fresh chat also uses defaults');
  page.on('dialog',dialog => dialog.accept());
  await page.evaluate(async () => {
    const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    for (const id of state.chats.map(chat => chat.id)) m.deleteChat(id);
    m.saveChats({immediate:true}); await state.chatSaveChain;
  });
  assert.deepEqual(await values(),defaults,'Replacement after deleting all chats uses defaults');
  profiles = profiles.filter(profile => profile.id.endsWith('-a'));
  fixture.chats = {revision:fixture.chats.revision+1,activeChatId:null,chats:[]};
  const firstPage = await fixture.newPage();
  assert.equal(await firstPage.locator('#promptstudio-create-workflow').inputValue(),'create-b','First chat uses default even if unavailable');
  assert.match(await firstPage.locator('#promptstudio-create-workflow option:checked').textContent(),/unavailable · Default/);
  assert.equal(await firstPage.locator('#promptstudio-default-create-workflow').isDisabled(),true);

  if (videoEnabled) {
    fixture.projects = {revision:1,active_project_id:'video-source',projects:[{
      id:'video-source',name:'Source',workflow_id:'video-a',document:structuredClone(config.default_document),generations:[],created_at:1,updated_at:1,
    }]};
    await fixture.context.route('**/promptstudio-video/workflows',route => route.fulfill({json:{revision:1,templates:[
      {id:'video-a',name:'Video A',snapshot:{workflow:{nodes:[]},output:{}}},
      {id:'video-b',name:'Video B',snapshot:{workflow:{nodes:[]},output:{}}},
    ]}}));
    await fixture.context.route('**/js/promptstudio_video_studio.js',async route => {
      const response = await route.fetch();
      await route.fulfill({response,body:await response.text()+'\nexport {state,persistProjects};'});
    });
    const videoPage = await fixture.newPage(); await attachVideo(videoPage);
    await videoPage.locator('#psvstudio-workflow').selectOption('video-b');
    await videoPage.locator('#psvstudio-default-workflow').click();
    assert.match(await videoPage.locator('#psvstudio-workflow option:checked').textContent(),/Default/);
    await videoPage.locator('#psvstudio-workflow').selectOption('video-a');
    await videoPage.evaluate(async () => {
      const m = await import('/extensions/PromptStudio_Video/js/promptstudio_video_studio.js');
      await m.persistProjects({immediate:true});
    });
    await videoPage.reload(); await videoPage.waitForFunction(() => window.studioReady); await attachVideo(videoPage);
    assert.equal(await videoPage.locator('#psvstudio-workflow').inputValue(),'video-a');
    await videoPage.locator('#psvstudio-new-project').click();
    assert.equal(await videoPage.locator('#psvstudio-workflow').inputValue(),'video-b','New Video project uses its own default');
    for (const width of [1440,390]) {
      await videoPage.setViewportSize({width,height:844});
      const fits = await videoPage.locator('.psvstudio-workflow-choice').evaluate(root => {
        const r = root.getBoundingClientRect(), s = root.querySelector('select').getBoundingClientRect(), b = root.querySelector('button').getBoundingClientRect();
        return r.left >= 0 && r.right <= window.innerWidth && s.right <= b.left && b.right <= r.right + 1;
      });
      assert.equal(fits,true,`Video workflow and default button fit at ${width}px`);
      await videoPage.locator('.psvstudio-workflow-choice').screenshot({path:`test-results/browser/video-workflow-defaults-${width}.png`});
    }
    assert.equal(await videoPage.evaluate(async () => {
      const {state} = await import('/extensions/PromptStudio_Video/js/promptstudio_video_studio.js');
      return state.projects.find(project => project.id === 'video-source').workflow_id;
    }),'video-a');
    assert.deepEqual(await videoPage.evaluate(async () => {
      const {newChatWorkflowSelections} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/settings/workflow-defaults.js');
      return newChatWorkflowSelections();
    }),defaults,'Video defaults do not overwrite Image defaults');
  }
  assert.deepEqual(fixture.errors,[]);
  console.log('Workflow defaults: independent persisted defaults, per-chat choices, all new-chat paths, unavailable defaults, row layout, keyboard, narrow UI'+(videoEnabled ? ', and Video passed.' : ' passed.'));
} finally { await fixture.close(); }
