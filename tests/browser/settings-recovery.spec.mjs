import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';

const fixture = await startFixture();
try {
  fixture.chats = {revision:1, activeChatId:'saved', chats:[{
    id:'saved', initialized:true, mainPrompt:'Saved scene', finalPrompt:'Saved scene',
    messages:[], studioSettings:{style_modifier:'Saved style', secondary_instructions:'Keep exact',
      additional_input_selections:{'workflow\u0000steps':{value:37,schemaFingerprint:'saved-schema'}}},
  }]};
  await fixture.context.addInitScript(() => {
    window.settingsRecoveryGate = new Promise(resolve => { window.releaseSettingsRecovery = resolve; });
  });
  await fixture.context.route('**/chat/store-controller.js', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = "const draft = await draftOutbox.get(draftTabKey('image'));";
    assert.ok(source.includes(marker));
    await route.fulfill({response, body:source.replace(marker,
      'window.settingsRecoveryPending = true; await window.settingsRecoveryGate; ' + marker)});
  });
  await fixture.context.route('**/js/prompt_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response, body:await response.text() + '\nexport {syncActiveChatSettings};'});
  });
  const page = await fixture.context.newPage();
  page.on('pageerror', error => fixture.errors.push(error.message));
  await page.goto(fixture.origin, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => window.settingsRecoveryPending);
  const before = await page.evaluate(async () => {
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const {syncActiveChatSettings} = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    // Async provider discovery can request a save before recovered controls exist.
    syncActiveChatSettings();
    return structuredClone(state.chats.find(chat => chat.id === 'saved').studioSettings);
  });
  assert.equal(before.style_modifier, 'Saved style');
  assert.equal(before.additional_input_selections['workflow\u0000steps'].value, 37);
  await page.evaluate(() => window.releaseSettingsRecovery());
  await page.waitForFunction(() => window.studioReady || window.bootError);
  assert.equal(await page.evaluate(() => window.bootError), undefined);
  assert.equal(await page.locator('#promptstudio-secondary-instructions').inputValue(), 'Keep exact');
  await page.locator('#promptstudio-style-modifier').fill('Edited style');
  const after = await page.evaluate(async () => {
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const {syncActiveChatSettings} = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    syncActiveChatSettings();
    await state.chatSaveChain;
    return state.chats.find(chat => chat.id === 'saved').studioSettings.style_modifier;
  });
  assert.equal(after, 'Edited style');
  assert.deepEqual(fixture.errors, []);
  console.log('Settings recovery preserves saved controls during delayed draft reads and saves later edits.');
} finally { await fixture.close(); }
