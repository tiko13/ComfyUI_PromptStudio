import assert from 'node:assert/strict';
import {startFixture,attachVideo,config,videoEnabled} from './fixture.mjs';

const fixture = await startFixture();
const selections = suffix => Object.fromEntries(['create','edit','upscale'].map(kind => [`${kind}WorkflowId`, `${kind}-${suffix}`]));
const profiles = ['a','b'].flatMap(suffix => ['create','edit','upscale'].map(kind => ({
  id:`${kind}-${suffix}`, name:`${kind} ${suffix}`, kind,
  promptNodeId:'1', imageNodeId:'2', upscaleNodeId:'3',
  snapshot:{workflow:{nodes:[],links:[]},output:{}},
})));
try {
  fixture.chats = {revision:1,activeChatId:'saved',chats:[
    {id:'saved',mainPrompt:'Saved prompt',finalPrompt:'Saved prompt',initialized:true,...selections('b')},
    {id:'empty',...selections('a')},
  ]};
  await fixture.context.route('**/prompt-studio/workflows', route => route.fulfill({json:{templates:profiles,revision:1}}));
  await fixture.context.route('**/userdata?*', route => route.fulfill({status:503,json:{error:'Use cached workflows'}}));
  await fixture.context.route('**/js/prompt_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response,body:await response.text()+
      '\nexport {syncActiveChat,restoreChatState,activateChat,createChat,refreshWorkflowControls,refreshWorkflowTemplates,saveChats,deleteChat};'});
  });
  const page = await fixture.newPage();
  const selected = () => page.evaluate(() => Object.fromEntries(['create','edit','upscale'].map(kind =>
    [`${kind}WorkflowId`,document.querySelector(`#promptstudio-${kind}-workflow`).value])));
  const flush = () => page.evaluate(async () => {
    const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    m.saveChats({immediate:true}); await state.chatSaveChain;
  });
  assert.deepEqual(await selected(),selections('b'),'Startup restores all saved choices');
  await page.evaluate(async () => {
    const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    m.createChat();
  });
  assert.deepEqual(await selected(),selections('b'),'New chat reusing an empty chat inherits current workflow choices');
  await flush();
  await page.reload(); await page.waitForFunction(() => window.studioReady);
  assert.deepEqual(await selected(),selections('b'),'Choices survive reload');
  // A saved chat can be restored while controls still show the previous chat.
  await page.evaluate(async () => {
    const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const chat = state.chats.find(chat => chat.id === state.activeChatId);
    for (const kind of ['create','edit','upscale']) chat[`${kind}WorkflowId`] = `${kind}-a`;
    m.restoreChatState(chat);
    m.syncActiveChat();
    m.refreshWorkflowControls();
  });
  assert.deepEqual(await selected(),selections('a'),'Restoring chat state restores workflow controls before another save');
  await page.evaluate(async () => {
    const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    for (const kind of ['create','edit','upscale']) document.querySelector(`#promptstudio-${kind}-workflow`).replaceChildren();
    m.syncActiveChat();
    m.refreshWorkflowControls();
  });
  assert.deepEqual(await selected(),selections('a'),'Empty controls cannot clear remembered workflow choices');
  await page.locator('#promptstudio-toggle-studio-settings').click();
  for (const kind of ['create','edit','upscale']) {
    await page.locator(`#promptstudio-${kind}-workflow`).selectOption(`${kind}-b`);
  }
  await page.locator('#promptstudio-close-studio-settings').click();
  await flush();
  assert.deepEqual(Object.fromEntries(Object.keys(selections('b')).map(key =>
    [key,fixture.chats.chats.find(chat => chat.id === fixture.chats.activeChatId)[key]])),selections('b'),
  'All three explicit choices reach durable storage');
  await page.reload(); await page.waitForFunction(() => window.studioReady);
  assert.deepEqual(await selected(),selections('b'));
  await page.evaluate(async () => {
    const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    state.workflowProfiles = state.workflowProfiles.filter(profile => profile.id.endsWith('-a'));
    m.refreshWorkflowControls(); m.syncActiveChat();
  });
  assert.deepEqual(await selected(),selections('b'),'A missing workflow is not replaced by the first available option');
  assert.match(await page.locator('#promptstudio-upscale-workflow option:checked').textContent(),/unavailable/);
  await page.evaluate(async () => {
    const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    m.activateChat('saved');
  });
  assert.deepEqual(await selected(),selections('b'),'Switching chats restores their saved choices');
  await page.locator('#promptstudio-toggle-studio-settings').click();
  for (const kind of ['create','edit','upscale']) {
    await page.locator(`#promptstudio-${kind}-workflow`).selectOption(`${kind}-a`);
  }
  await page.locator('#promptstudio-close-studio-settings').click();
  await page.evaluate(async () => {
    const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    m.activateChat('empty');
  });
  assert.deepEqual(await selected(),selections('b'),'Each chat keeps its own choices');
  await page.evaluate(async () => {
    const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    m.activateChat('saved');
  });
  assert.deepEqual(await selected(),selections('a'),'A different saved selection is restored on returning to its chat');
  await page.evaluate(async () => {
    const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    m.activateChat('empty');
  });
  // Delete the two fixture chats through the real deletion path.
  page.on('dialog',dialog => dialog.accept());
  await page.evaluate(async () => {
    const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    for (const id of state.chats.map(chat => chat.id)) m.deleteChat(id);
  });
  assert.deepEqual(await selected(),selections('b'),'Deleting the last chat keeps workflow choices in its replacement');
  await flush();
  if (videoEnabled) {
    fixture.projects = {revision:1,active_project_id:'video-saved',projects:[{
      id:'video-saved',name:'Saved video',workflow_id:'video-b',
      document:structuredClone(config.default_document),generations:[],created_at:1,updated_at:1,
    }]};
    await fixture.context.route('**/js/promptstudio_video_studio.js', async route => {
      const response = await route.fetch();
      await route.fulfill({response,body:await response.text()+
        '\nexport {state,refreshWorkflows,renderHeader,newProject,persistProjects};'});
    });
    await fixture.context.route('**/promptstudio-video/workflows', route => route.fulfill({json:{templates:[
      {id:'video-a',name:'Video A',snapshot:{workflow:{nodes:[]},output:{}}},
      {id:'video-b',name:'Video B',snapshot:{workflow:{nodes:[]},output:{}}},
    ],revision:1}}));
    const videoPage = await fixture.newPage(); await attachVideo(videoPage);
    assert.equal(await videoPage.locator('#psvstudio-workflow').inputValue(),'video-b');
    await fixture.context.route('**/userdata?*', route => route.fulfill({json:[]}));
    await videoPage.evaluate(async () => {
      const m = await import('/extensions/PromptStudio_Video/js/promptstudio_video_studio.js');
      await m.refreshWorkflows();
      m.state.workflows = [{id:'video-a',name:'Video A'}]; m.renderHeader();
    });
    assert.equal(await videoPage.locator('#psvstudio-workflow').inputValue(),'video-b',
      'Video retains missing workflow when discovery returns empty and other choices appear');
    assert.match(await videoPage.locator('#psvstudio-workflow option:checked').textContent(),/unavailable/);
    await videoPage.evaluate(async () => {
      const m = await import('/extensions/PromptStudio_Video/js/promptstudio_video_studio.js');
      m.newProject(); await m.persistProjects({immediate:true});
    });
    assert.equal(await videoPage.locator('#psvstudio-workflow').inputValue(),'video-b','New Video projects inherit selections');
    await videoPage.waitForFunction(() => document.querySelector('#psvstudio-save-state')?.textContent === 'Saved');
    await videoPage.reload(); await videoPage.waitForFunction(() => window.studioReady); await attachVideo(videoPage);
    assert.equal(await videoPage.locator('#psvstudio-workflow').inputValue(),'video-b','Video selection survives reload and empty discovery');
    assert.deepEqual(await selected(),selections('b'),'Video operations preserve Image workflow choices');
  }
  assert.deepEqual(fixture.errors,[]);
  console.log('Workflow selections survive explicit changes, new chats, deletion, restoration, missing workflows and reload'+(videoEnabled ? ', including Video integration.' : '.'));
} finally { await fixture.close(); }
