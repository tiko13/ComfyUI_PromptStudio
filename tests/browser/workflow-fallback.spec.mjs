import assert from 'node:assert/strict';
import {startFixture,attachVideo,config,videoEnabled} from './fixture.mjs';

const fixture = await startFixture();
const kinds = ['create','edit','upscale'];
const defaults = Object.fromEntries([...kinds,'video'].map(kind => [kind,`${kind}-b`]));
const profiles = ['a','b'].flatMap(suffix => kinds.map(kind => ({
  id:`${kind}-${suffix}`,name:`${kind} ${suffix}`,kind,
  promptNodeId:'1',imageNodeId:'2',upscaleNodeId:'3',
  snapshot:{workflow:{nodes:[],links:[]},output:{}},
})));
try {
  fixture.chats = {revision:1,activeChatId:'saved',chats:[{
    id:'saved',initialized:true,mainPrompt:'Saved prompt',finalPrompt:'Saved prompt',
  }]};
  await fixture.context.addInitScript(defaults => {
    localStorage.setItem('promptstudio.workflowDefaults.v1',JSON.stringify(defaults));
  },defaults);
  await fixture.context.route('**/prompt-studio/workflows',route => route.fulfill({json:{templates:profiles,revision:1}}));
  await fixture.context.route('**/userdata?*',route => route.fulfill({status:503,json:{error:'Use cached workflows'}}));
  await fixture.context.route('**/js/prompt_studio.js',async route => {
    const response = await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nexport {refreshWorkflowControls,flushChatStore,syncActiveChat};'});
  });
  const page = await fixture.newPage();
  const assertSelections = async suffix => {
    for (const kind of kinds) assert.equal(await page.locator(`#promptstudio-${kind}-workflow`).inputValue(),`${kind}-${suffix}`);
  };
  await assertSelections('b');
  await page.evaluate(async () => {
    const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    m.syncActiveChat(); await m.flushChatStore();
  });
  await page.reload(); await page.waitForFunction(() => window.studioReady);
  await assertSelections('b');
  const choose = async (suffix,{removeDefaults=false,removeProfiles=false}={}) => page.evaluate(async ({suffix,removeDefaults,removeProfiles}) => {
    const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    await m.flushChatStore();
    const chat = state.chats.find(chat => chat.id === state.activeChatId);
    for (const kind of ['create','edit','upscale']) chat[`${kind}WorkflowId`] = suffix ? `${kind}-${suffix}` : '';
    if (removeDefaults) localStorage.removeItem('promptstudio.workflowDefaults.v1');
    if (removeProfiles) state.workflowProfiles = state.workflowProfiles.filter(profile => profile.id.endsWith('-a'));
    m.refreshWorkflowControls();
  },{suffix,removeDefaults,removeProfiles});
  await choose('a'); await assertSelections('a');
  await choose('removed'); await assertSelections('removed');
  await choose('',{removeProfiles:true}); await assertSelections('b');
  for (const kind of kinds) assert.match(await page.locator(`#promptstudio-${kind}-workflow option:checked`).textContent(),/unavailable.*Default/);
  await choose('',{removeDefaults:true}); await assertSelections('a');

  if (videoEnabled) {
    fixture.projects = {revision:1,active_project_id:'video-source',projects:[{
      id:'video-source',name:'Source',workflow_id:'video-a',document:structuredClone(config.default_document),
      generations:[],created_at:1,updated_at:1,
    }]};
    await fixture.context.route('**/promptstudio-video/workflows',route => route.fulfill({json:{revision:1,templates:[
      {id:'video-a',name:'Video A',snapshot:{workflow:{nodes:[]},output:{}}},
      {id:'video-b',name:'Video B',snapshot:{workflow:{nodes:[]},output:{}}},
    ]}}));
    await fixture.context.route('**/js/promptstudio_video_studio.js',async route => {
      const response = await route.fetch();
      await route.fulfill({response,body:await response.text()+'\nexport {state,resetProject,refreshWorkflows,persistProjects};'});
    });
    const videoPage = await fixture.newPage(); await attachVideo(videoPage);
    const select = videoPage.locator('#psvstudio-workflow');
    assert.equal(await select.inputValue(),'video-a','Existing Video choice takes priority over default');
    videoPage.on('dialog',dialog => dialog.accept());
    await videoPage.evaluate(async () => {
      const m = await import('/extensions/PromptStudio_Video/js/promptstudio_video_studio.js');
      m.resetProject(); await m.persistProjects({immediate:true});
    });
    assert.equal(await select.inputValue(),'video-b','Reset uses the configured default, not the first workflow');
    await fixture.context.route('**/userdata?*',route => route.fulfill({json:[]}));
    await videoPage.evaluate(async () => {
      const m = await import('/extensions/PromptStudio_Video/js/promptstudio_video_studio.js');
      m.state.projects.find(project => project.id === m.state.activeProjectId).workflow_id = '';
      await m.refreshWorkflows({announce:false});
    });
    assert.equal(await select.inputValue(),'video-b','Refresh restores the configured default for an empty selection');
    assert.match(await select.locator('option:checked').textContent(),/unavailable.*Default/);
  }
  assert.deepEqual(fixture.errors,[]);
  console.log('Workflow fallbacks: per-kind defaults, saved choices, reload, unavailable defaults, no-default fallback and Video reset/refresh passed.');
} finally { await fixture.close(); }
