import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startFixture, attachVideo, videoEnabled, config, root } from './fixture.mjs';

const fixture = await startFixture();
const moduleUrl = '/extensions/ComfyUI_PromptStudio/js/prompt-studio/chat/draft-outbox.js';
try {
  const page = await fixture.newPage();
  await page.evaluate(async url => {
    const { createDraftOutbox, showDraftStorageFailure } = await import(url);
    const frame = document.createElement('iframe'); frame.hidden = true; document.body.append(frame);
    const container = frame.contentDocument.createElement('section'); container.id = 'failure-test';
    frame.contentDocument.body.append(container);
    window.failedRecord = { mutation: 1, composerText: 'Inspect my unsent message', attachment: 'x'.repeat(33 * 1024 * 1024), tail: 'Complete export' };
    const box = createDraftOutbox({ database: 'oversized-failure-test' });
    try { await box.put('test', window.failedRecord); throw new Error('Expected size rejection'); }
    catch (error) {
      if (!error.message.includes('recovery-copy limit')) throw error;
      window.failureMessage = error.message;
      showDraftStorageFailure(container, window.failedRecord, error.message);
    }
    document.body.append(container); // Adopt from the hidden host before opening.
  }, moduleUrl);
  const notice = page.locator('#failure-test [data-draft-failure]');
  assert.match(await notice.innerText(), /Prompt Studio.*32 MiB/);
  const view = notice.getByRole('button', { name: 'View draft', exact: true });
  await view.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Unsaved draft', exact: true });
  await dialog.waitFor();
  await dialog.locator('summary').filter({ hasText: 'Unsent message' }).click();
  assert.equal(await dialog.locator('pre').innerText(), 'Inspect my unsent message');
  await dialog.locator('summary').filter({ hasText: 'attachment' }).click();
  await dialog.getByRole('button', { name: 'Next text' }).click();
  assert.match(await dialog.innerText(), /Characters 8001–16000/);
  assert.ok((await dialog.innerText()).length < 20000, 'Large values render in bounded pages');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.screenshot({ path: resolve(root, 'test-results/browser/draft-storage-failure-narrow.png') });
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export unsaved draft' }).click();
  const exported = JSON.parse(await readFile(await (await downloading).path(), 'utf8'));
  assert.equal(exported.draft.attachment.length, 33 * 1024 * 1024);
  assert.equal(exported.draft.tail, 'Complete export');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await view.evaluate(el => el === el.ownerDocument.activeElement), true);
  await notice.getByRole('button', { name: 'Dismiss warning' }).click();
  await page.evaluate(async url => {
    const { showDraftStorageFailure, clearDraftStorageFailure } = await import(url);
    const container = document.querySelector('#failure-test');
    showDraftStorageFailure(container, { ...window.failedRecord, mutation: 2 }, window.failureMessage);
    if (container.querySelector('[data-draft-failure]')) throw new Error('Dismissed warning reappeared');
    clearDraftStorageFailure(container, { mutation: 1 });
    showDraftStorageFailure(container, { ...window.failedRecord, mutation: 2 }, window.failureMessage);
    if (container.querySelector('[data-draft-failure]')) throw new Error('Stale success reset dismissal');
    clearDraftStorageFailure(container, { mutation: 2 });
    showDraftStorageFailure(container, { composerText: 'New failure', mutation: 3 }, window.failureMessage);
    showDraftStorageFailure(container, { composerText: 'Latest failed copy', mutation: 4 }, window.failureMessage);
  }, moduleUrl);
  await view.click();
  await dialog.locator('summary').filter({ hasText: 'Unsent message' }).click();
  assert.equal(await dialog.locator('pre').innerText(), 'Latest failed copy');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.close();

  // Lower only the fixture cap so real Image/Video save lifecycles can exercise it cheaply.
  await fixture.context.route('**/js/prompt-studio/chat/draft-outbox.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('32 * 1024 * 1024', '64 * 1024') });
  });
  await fixture.context.route('**/js/prompt-studio/chat/store-controller.js', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const body = source.replace(/(?=^  return \{\r?\n    async flushChatStore\()/m, '  window.draftTest = { persistChats };\n');
    assert.notEqual(body, source);
    await route.fulfill({ response, body });
  });
  await fixture.context.route('**/js/promptstudio_video_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()) + '\nwindow.videoDraftTest = { state, persistProjects };\n' });
  });
  for (const product of videoEnabled ? ['image', 'video'] : ['image']) {
    if (product === 'video') fixture.projects = { revision: 1, active_project_id: 'storage-test', projects: [
      { id: 'storage-test', name: 'Saved project', document: config.default_document, generations: [], created_at: 1, updated_at: 1 },
    ] };
    const live = await fixture.newPage();
    if (product === 'video') await attachVideo(live);
    const save = async content => live.evaluate(async ({ product, content }) => {
      if (product === 'image') {
        const { state } = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
        await state.chatSaveChain;
        state.chats.find(chat => chat.id === state.activeChatId).mainPrompt = content;
        state.chatMutationVersion++;
        await window.draftTest.persistChats().catch(() => {});
      } else {
        const { state, persistProjects } = window.videoDraftTest;
        await state.projectSaveChain.catch(() => {});
        state.projects.find(project => project.id === state.activeProjectId).name = content;
        state.projectMutation++;
        await persistProjects();
      }
    }, { product, content });
    await save('a'.repeat(40000));
    const endpoint = product === 'image' ? '**/promptstudio/prompt-studio/chats' : '**/promptstudio-video/projects';
    let broken = true;
    await live.route(endpoint, route => broken && route.request().method() === 'PUT'
      ? route.fulfill({ status: 503, json: { error: 'Test save failure' } }) : route.continue());
    await save('b'.repeat(40000));
    const failure = live.locator(product === 'image' ? '.promptstudio-chat-sidebar [data-draft-failure]' : '.psvstudio-sidebar [data-draft-failure]');
    await failure.waitFor();
    await failure.getByRole('button', { name: 'View draft', exact: true }).click();
    await live.getByRole('dialog', { name: 'Unsaved draft', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
    if (product === 'image') await live.locator('#promptstudio-revision').fill('Still unsent after saving');
    broken = false;
    await save('c'.repeat(40000));
    await failure.waitFor({ state: 'detached' });
    assert.equal(product === 'image' ? fixture.chats.chats.find(c => c.mainPrompt.startsWith('ccc'))?.mainPrompt.length
      : fixture.projects.projects.find(p => p.name.startsWith('ccc'))?.name.length, 40000);
    if (product === 'image') {
      const remaining = await live.evaluate(async url => {
        const { createDraftOutbox, draftTabKey } = await import(url);
        const box = createDraftOutbox();
        try { return await box.get(draftTabKey('image')); } finally { await box.close(); }
      }, moduleUrl);
      assert.equal(remaining.composerText, 'Still unsent after saving');
      assert.deepEqual(remaining.chats, [], 'Saved chat snapshots no longer inflate the recovery copy');
    }
    await live.close();
  }
  assert.deepEqual(fixture.errors, []);
  assert.equal(fixture.requests.some(request => request.path === '/prompt'), false);
  console.log('Oversized drafts: bounded preview, complete export, dismissal, adoption, keyboard, narrow layout and Image/Video save recovery passed.');
} finally { await fixture.close(); }
