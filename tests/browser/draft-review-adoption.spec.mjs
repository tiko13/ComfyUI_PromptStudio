import assert from 'node:assert/strict';
import { startFixture, attachVideo, videoEnabled, config } from './fixture.mjs';

const fixture = await startFixture();
const outboxModule = '/extensions/ComfyUI_PromptStudio/js/prompt-studio/chat/draft-outbox.js';
try {
  for (const product of videoEnabled ? ['image', 'video'] : ['image']) {
    if (product === 'video') fixture.projects = { revision: 1, active_project_id: 'video-draft', projects: [
      { id: 'video-draft', name: 'Saved video', document: config.default_document, generations: [], created_at: 1, updated_at: 1 },
    ] };
    const host = await fixture.newPage();
    if (product === 'video') await attachVideo(host);
    await host.evaluate(async () => {
      const { state } = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
      await new Promise(resolve => setTimeout(resolve, 250)); await state.chatSaveChain;
    });
    const base = structuredClone(product === 'image' ? fixture.chats.chats : fixture.projects.projects);
    await host.evaluate(async ({ product, base, outboxModule }) => {
      const { createDraftOutbox, draftTabKey } = await import(outboxModule);
      const outbox = createDraftOutbox();
      const draft = product === 'image' ? { chats: base, baseChats: structuredClone(base) } : { projects: base, base: structuredClone(base) };
      await outbox.put(`${draftTabKey(product)}:review:test-empty`, { ...draft, draftSavedAt: 1 });
      if (product === 'image') draft.chats[0].mainPrompt = 'Reviewed in visible window';
      else draft.projects[0].name = 'Reviewed in visible window';
      await outbox.put(`${draftTabKey(product)}:review:test-change`, { ...draft, draftSavedAt: 2 });
      await outbox.close();
    }, { product, base, outboxModule });
    await host.reload(); await host.waitForFunction(() => window.studioReady);
    if (product === 'video') await attachVideo(host);

    const opening = host.waitForEvent('popup');
    await host.evaluate(product => window.open(`/extensions/ComfyUI_PromptStudio/prompt_studio.html?mode=${product}`), product);
    const popup = await opening;
    popup.on('pageerror', error => fixture.errors.push(error.message));
    const emptyNotice = popup.locator('[data-draft-review$=":test-empty"]');
    await emptyNotice.getByRole('button', { name: 'View draft', exact: true }).click();
    const dialog = popup.getByRole('dialog', { name: 'Review unsaved draft' });
    await dialog.getByText(/No unapplied draft changes/).waitFor();
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await host.locator('dialog.promptstudio-draft-review[open]').count(), 0, 'Review belongs to the adopted visible document');
    assert.equal(await emptyNotice.count(), 1, 'Viewing identical content does not dismiss it');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await popup.reload();
    await emptyNotice.getByRole('button', { name: 'View draft', exact: true }).click();
    await dialog.getByText(/No unapplied draft changes/).waitFor();
    assert.equal(await host.evaluate(async ({ product, outboxModule }) => {
      const { createDraftOutbox, draftTabKey } = await import(outboxModule);
      const box = createDraftOutbox(); const saved = await box.get(`${draftTabKey(product)}:review:test-empty`); await box.close(); return Boolean(saved);
    }, { product, outboxModule }), true, 'Opening and closing preserve the durable draft');
    await dialog.getByRole('button', { name: 'Dismiss draft', exact: true }).click();
    await emptyNotice.waitFor({ state: 'detached' });

    const changeNotice = popup.locator('[data-draft-review$=":test-change"]');
    await changeNotice.getByRole('button', { name: 'View draft', exact: true }).click();
    await dialog.getByText('Reviewed in visible window', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await changeNotice.waitFor({ state: 'detached' });
    assert.equal(product === 'image' ? fixture.chats.chats[0].mainPrompt : fixture.projects.projects[0].name, 'Reviewed in visible window');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await popup.close(); await host.close();
  }

  // Match the private iframe fallback: build the notice in a hidden host, then adopt it.
  const page = await fixture.newPage();
  await page.evaluate(async () => {
    const { showDraftReviews } = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/chat/draft-review.js');
    const frame = document.createElement('iframe'); frame.hidden = true; document.body.append(frame);
    const container = frame.contentDocument.createElement('section'); frame.contentDocument.body.append(container);
    const archive = { key: 'test:review:iframe', saved_at: 1 };
    window.reviewRemoved = false;
    await showDraftReviews({ container, key: 'test', outbox: { list: async () => [archive], remove: async () => { window.reviewRemoved = true; } }, differences: async () => [], apply: async () => {} });
    document.body.append(container);
  });
  await page.locator('[data-draft-review="test:review:iframe"]').getByRole('button', { name: 'View draft' }).click();
  await page.getByRole('dialog', { name: 'Review unsaved draft' }).getByText(/No unapplied draft changes/).waitFor();
  assert.equal(await page.evaluate(() => window.reviewRemoved), false);
  assert.deepEqual(fixture.errors, []);
  console.log('Draft review opens in adopted Image/Video windows and hidden-iframe fallback; empty reviews survive close/reload until explicitly dismissed.');
} finally { await fixture.close(); }
