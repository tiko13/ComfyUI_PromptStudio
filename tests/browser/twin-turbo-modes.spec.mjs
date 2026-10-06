import assert from 'node:assert/strict';
import {startFixture, videoEnabled} from './fixture.mjs';

const modes = ['Spoon', 'Einstein', 'XHigh', 'Medium', 'Low',
  'Instruct Spoon', 'Instruct Einstein', 'Instruct XHigh', 'Instruct Medium', 'Instruct Low', 'Disabled'];
const profile = {thinking_mode:'XHigh', thinking_modes:modes.slice(0,5), instruct_modes:[...modes.slice(0,5),'Disabled'], temperature:0.7,
  thinking_temperature:1.0, presence_penalty:1.5, thinking_presence_penalty:0};
const fixture = await startFixture();
try {
  await fixture.context.route('**/promptstudio/prompt-studio/llamacpp/config-profiles', route =>
    route.fulfill({json:{profiles:['twin.json'], selected_profile:'twin.json', llm_profile:profile}}));
  await fixture.context.route('**/extensions/ComfyUI_PromptStudio/js/prompt_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response, body:await response.text() +
      '\nwindow.twinModeTest={loadLlamacppConfigProfiles,llmProfileGenerationSettings,selectedLlamacppGenerationSettings,saveSettings,openLlmProfileEditor,closeLlmProfileEditor};'});
  });
  if (videoEnabled) await fixture.context.route('**/extensions/PromptStudio_Video/js/promptstudio_video_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response, body:await response.text() + '\nwindow.twinVideoSettings=directorSettings;'});
  });
  const page = await fixture.newPage();
  await page.evaluate(async () => {
    document.querySelector('#promptstudio-llm-provider').value='llamacpp';
    await window.twinModeTest.loadLlamacppConfigProfiles({preferred:'twin.json'});
  });
  assert.deepEqual(await page.locator('#promptstudio-thinking option').evaluateAll(options => options.map(o => o.value)), modes);
  for (const mode of modes) {
    await page.locator('#promptstudio-thinking').selectOption(mode);
    const actual = await page.evaluate(() => ({
      image:window.twinModeTest.llmProfileGenerationSettings(),
      persisted:window.twinModeTest.selectedLlamacppGenerationSettings(),
      video:window.twinVideoSettings?.(),
    }));
    const thinking = !mode.startsWith('Instruct ') && mode !== 'Disabled';
    assert.equal(actual.image.thinking_mode, mode);
    assert.equal(actual.image.temperature, thinking ? 1 : 0.7);
    assert.equal(actual.persisted.thinking_mode, mode);
    assert.deepEqual(actual.persisted.thinking_modes, profile.thinking_modes);
    assert.deepEqual(actual.persisted.instruct_modes, profile.instruct_modes);
    if (videoEnabled) {
      assert.equal(actual.video.thinking_mode, mode);
      assert.equal(actual.video.temperature, thinking ? 1 : 0.7);
    }
  }
  await page.locator('#promptstudio-thinking').selectOption('Instruct Spoon');
  await page.evaluate(async () => {
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    await state.chatSaveChain;
  });
  await page.reload();
  await page.waitForFunction(() => window.studioReady || window.bootError);
  assert.equal(await page.locator('#promptstudio-thinking').inputValue(), 'Instruct Spoon');
  if (videoEnabled) assert.equal(await page.evaluate(() => window.twinVideoSettings().thinking_mode), 'Instruct Spoon');
  await page.evaluate(() => {
    window.__promptstudioPromptStudioHost.setStandaloneVisibility(true);
    document.querySelector('#promptstudio-image-mount').hidden = false;
    document.querySelector('#promptstudio-video-mount').hidden = true;
  });
  await page.locator('#promptstudio-toggle-studio-settings').click();
  // The browser profile editor serves other providers; llama.cpp uses its
  // native config builder (whose separated load/save path is checked separately).
  await page.evaluate(async () => {
    document.querySelector('#promptstudio-llm-provider').value = 'koboldcpp';
    window.twinModeTest.saveSettings();
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    await state.chatSaveChain;
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({width,height:900});
    await page.evaluate(() => window.twinModeTest.openLlmProfileEditor(null, {create:true}));
    const editor = page.locator('#promptstudio-llm-profile-editor');
    assert.equal(await editor.getByText('Available thinking modes', {exact:true}).count(), 1);
    assert.equal(await editor.getByText('Available instruct modes', {exact:true}).count(), 1);
    assert.equal(await editor.getByText('Check the model card for supported modes. Unsupported modes may fail or produce unpredictable results.', {exact:true}).count(), 1);
    assert.equal(await editor.locator('input[name="thinking_modes"]').count(), modes.length + 2);
    const bounds = await editor.evaluate(el => ({width:el.getBoundingClientRect().width, scroll:el.scrollWidth, client:el.clientWidth}));
    assert.ok(bounds.width > 0 && bounds.width <= width && bounds.scroll <= bounds.client + 1,
      JSON.stringify(await editor.evaluate(el => {
        const parents=[]; for (let p=el;p;p=p.parentElement) parents.push({id:p.id,hidden:p.hidden,display:getComputedStyle(p).display,width:p.getBoundingClientRect().width});
        return parents;
      })));
    await page.evaluate(() => window.twinModeTest.closeLlmProfileEditor());
  }
  await page.evaluate(() => window.twinModeTest.openLlmProfileEditor(null, {create:true}));
  const form = page.locator('#promptstudio-llm-profile-editor form');
  await form.locator('[name="name"]').fill('Separate mode definitions');
  await form.locator('[name="thinking_modes"]').evaluateAll((inputs, modes) => {
    inputs.forEach(input => { input.checked = modes.includes(input.value); });
  }, modes);
  await form.evaluate(el => el.requestSubmit());
  const saved = await page.evaluate(async () => {
    const {loadLlmProfiles} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/settings/llm-profile-store.js');
    return loadLlmProfiles().find(profile => profile.name === 'Separate mode definitions');
  });
  assert.deepEqual(new Set(saved.thinking_modes), new Set(profile.thinking_modes));
  assert.deepEqual(new Set(saved.instruct_modes), new Set(profile.instruct_modes));
  // A reasoning-only profile removes unsupported Off and replaces stale selections.
  profile.thinking_modes = ['High', 'Medium', 'Low'];
  profile.instruct_modes = [];
  profile.thinking_mode = 'High';
  await page.evaluate(async () => {
    document.querySelector('#promptstudio-llm-provider').value = 'llamacpp';
    document.querySelector('#promptstudio-thinking').value = 'Disabled';
    await window.twinModeTest.loadLlamacppConfigProfiles({preferred:'twin.json'});
  });
  assert.equal(await page.locator('#promptstudio-thinking option[value="Disabled"]').count(), 0);
  assert.equal(await page.locator('#promptstudio-thinking').inputValue(), 'High');
  await page.evaluate(async () => {
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    await state.chatSaveChain;
  });
  await page.reload();
  await page.waitForFunction(() => window.studioReady || window.bootError);
  assert.equal(await page.locator('#promptstudio-thinking option[value="Disabled"]').count(), 0);
  assert.equal(await page.locator('#promptstudio-thinking').inputValue(), 'High');
  assert.equal(await page.evaluate(() => window.twinModeTest.llmProfileGenerationSettings().thinking_mode), 'High');
  if (videoEnabled) assert.equal(await page.evaluate(() => window.twinVideoSettings().thinking_mode), 'High');
  assert.deepEqual(fixture.errors, []);
  console.log(`Twin Turbo selector, sampling and persistence passed${videoEnabled ? ' including Video Studio' : ''}.`);
} finally {
  await fixture.close();
}
