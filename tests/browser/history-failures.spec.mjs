import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import {startFixture, attachVideo, videoEnabled, root} from './fixture.mjs';

const failures = [];
async function scenario(name, run) {
  const fixture = await startFixture();
  try {
    await fixture.context.route('**/js/prompt-studio/chat/store-controller.js', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const hook = '  window.uxStore = {refreshChatsFromServer, persistChats, saveChats, loadChats};\n';
      const instrumented = source.replace(/(?=^  return \{\r?\n    async flushChatStore\()/m, hook);
      assert.notEqual(instrumented, source, 'Persistence test hook must attach to the controller');
      await route.fulfill({response, body: instrumented});
    });
    await run(fixture);
    assert.deepEqual(fixture.errors, []);
    console.log(`PASS ${name}`);
  } catch (error) { failures.push(`${name}: ${error.stack}`); }
  finally { await fixture.close(); }
}
async function saved(page) {
  await page.evaluate(async () => {
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    for (let attempt = 0; attempt < 100; attempt++) {
      await state.chatSaveChain;
      if (!state.chatSaveTimer && !state.chatSaveInFlight) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Chat save did not settle');
  });
}

for (const body of ['<html>Proxy unavailable</html>', JSON.stringify({revision: 8})]) {
  await scenario('Invalid initial history is blocked and can be retried', async fixture => {
    let broken = true;
    await fixture.context.route('**/promptstudio/prompt-studio/chats?*', route => broken
      ? route.fulfill({status: 200, body, contentType: 'application/json'}) : route.continue());
    const page = await fixture.newPage();
    assert.equal(await page.evaluate(async () => {
      const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
      return state.chatPersistenceBlocked;
    }), true);
    assert.equal(fixture.requests.some(r => r.path.endsWith('/chats') && r.method === 'PUT'), false);
    await page.locator('#promptstudio-main-prompt').fill('Written before history recovered');
    await page.getByRole('button', {name: 'Retry loading history', exact: true}).click();
    assert.equal(await page.locator('#promptstudio-main-prompt').inputValue(), 'Written before history recovered');
    broken = false;
    await page.getByRole('button', {name: 'Retry loading history', exact: true}).click();
    await page.waitForFunction(() => !document.querySelector('[data-chat-load-failure]'));
    assert.equal(await page.locator('#promptstudio-main-prompt').inputValue(), 'Written before history recovered');
    await saved(page);
    assert.ok(fixture.chats.chats.some(c => c.mainPrompt === 'Written before history recovered'));
    await page.locator('#promptstudio-main-prompt').fill('Recovered session');
    await saved(page);
    assert.ok(fixture.chats.chats.some(c => c.mainPrompt === 'Recovered session'));
  });
}

await scenario('Failed save survives background synchronization and explicit retry', async fixture => {
  const page = await fixture.newPage();
  await page.locator('#promptstudio-main-prompt').fill('Saved scene');
  await saved(page);
  let broken = true;
  await fixture.context.route('**/promptstudio/prompt-studio/chats', route => broken
    ? route.fulfill({status: 503, json: {error: 'Synthetic save failure'}}) : route.continue());
  await page.locator('#promptstudio-main-prompt').fill('Unsaved local scene');
  await saved(page);
  fixture.chats = {...fixture.chats, revision: fixture.chats.revision + 1,
    chats: fixture.chats.chats.map(c => ({...c, mainPrompt: 'Other browser scene', updatedAt: Date.now() + 10000}))};
  await page.evaluate(() => window.uxStore.refreshChatsFromServer({force: true}));
  assert.equal(await page.locator('#promptstudio-main-prompt').inputValue(), 'Unsaved local scene');
  assert.equal(await page.evaluate(async () => {
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    return state.chats.find(chat => chat.id === state.activeChatId).mainPrompt;
  }), 'Unsaved local scene');
  const notice = page.locator('[data-chat-save-failure]');
  await notice.getByRole('button', {name: 'Export unsaved draft', exact: true}).waitFor();
  await page.setViewportSize({width: 390, height: 844});
  await page.locator('#promptstudio-mobile-toggle-chats').click();
  assert.equal(await notice.isVisible(), true);
  assert.equal(await notice.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  const scan = await new AxeBuilder({page}).include('[data-chat-save-failure]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  assert.deepEqual(scan.violations.map(v => v.id), []);
  await page.screenshot({path: resolve(root, 'test-results/browser/history-recovery-narrow.png')});
  await page.setViewportSize({width: 1440, height: 1000});
  await page.evaluate(async () => {
    const {api} = await import('/scripts/api.js'); api.dispatchEvent(new Event('reconnecting'));
  });
  assert.equal(await notice.getByRole('button', {name: 'Export unsaved draft', exact: true}).isEnabled(), true);
  const downloadEvent = page.waitForEvent('download');
  await notice.getByRole('button', {name: 'Export unsaved draft', exact: true}).click();
  assert.match((await downloadEvent).suggestedFilename(), /promptstudio-draft.*\.json/);
  await page.evaluate(async () => {
    const {api} = await import('/scripts/api.js'); api.dispatchEvent(new Event('reconnected'));
  });
  broken = false;
  await notice.getByRole('button', {name: 'Retry save', exact: true}).click();
  await page.waitForFunction(() => !document.querySelector('[data-chat-save-failure]'));
  assert.ok(fixture.chats.chats.some(c => c.mainPrompt === 'Unsaved local scene'));
});

await scenario('Invalid save acknowledgement retains Image and Video drafts', async fixture => {
  const page = await fixture.newPage();
  await saved(page);
  await fixture.context.route('**/promptstudio/prompt-studio/chats', route => route.fulfill({status: 200, json: {}}));
  await page.locator('#promptstudio-main-prompt').fill('Draft needing an acknowledgement');
  await saved(page);
  await page.locator('[data-chat-save-failure]').waitFor();
  const draft = await page.evaluate(async () => {
    const {createDraftOutbox, draftTabKey} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/chat/draft-outbox.js');
    const outbox = createDraftOutbox();
    try { return await outbox.get(draftTabKey('image')); } finally { await outbox.close(); }
  });
  assert.ok(draft.chats.some(c => c.mainPrompt === 'Draft needing an acknowledgement'));
  if (videoEnabled) {
    await attachVideo(page);
    await fixture.context.route('**/promptstudio-video/projects', route => route.request().method() === 'PUT'
      ? route.fulfill({status: 200, json: {}}) : route.continue());
    await page.locator('#psvstudio-new-project').click();
    await page.getByRole('button', {name: 'Retry save', exact: true}).waitFor();
    assert.match(await page.locator('#psvstudio-save-state').innerText(), /Save failed/);
  }
});
assert.deepEqual(failures, [], failures.join('\n\n'));
