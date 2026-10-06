import assert from 'node:assert/strict';
import { startFixture, attachVideo, videoEnabled, config } from './fixture.mjs';
const fixture = await startFixture();
const moduleUrl = '/extensions/ComfyUI_PromptStudio/js/prompt-studio/chat/draft-outbox.js';
const reload = async page => { await page.reload(); await page.waitForFunction(() => window.studioReady || window.bootError); assert.equal(await page.evaluate(() => window.bootError), undefined); };
const save = page => page.evaluate(async () => {
  const { state } = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
  await new Promise(resolve => setTimeout(resolve, 250)); await state.chatSaveChain;
});
const seed = (page, product, draft) => page.evaluate(async ({ moduleUrl, product, draft }) => {
  const { createDraftOutbox, draftTabKey } = await import(moduleUrl);
  const box = createDraftOutbox(); await box.put(draftTabKey(product), draft); await box.close();
}, { moduleUrl, product, draft });
try {
  const page = await fixture.newPage();
  await page.locator('#promptstudio-main-prompt').fill('Original scene'); await save(page);
  const baseline = structuredClone(fixture.chats.chats[0]);
  const draft = structuredClone(baseline); draft.mainPrompt = 'Recovered main'; draft.finalPrompt = 'Dismiss this final';
  draft.messages.push({ id: 'missing-message', role: 'user', text: 'Recovered conversation', createdAt: 1, updatedAt: 1 });
  await seed(page, 'image', { mutation: 10, revision: fixture.chats.revision, activeChatId: baseline.id, baseChats: [baseline], chats: [draft], composerText: 'Recovered unsent text' });
  fixture.chats = { ...fixture.chats, revision: fixture.chats.revision + 1, chats: [{ ...baseline, finalPrompt: 'Newer server final' }, { ...baseline, id: 'other', mainPrompt: 'Unrelated session' }] };
  await reload(page); await save(page);
  const notice = page.locator('[data-draft-review]'); await notice.waitFor();
  assert.equal(await notice.getByRole('button', { name: /Export/ }).count(), 0);
  assert.notEqual(await page.locator('#promptstudio-revision').inputValue(), 'Recovered unsent text');
  await notice.getByRole('button', { name: 'View draft', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review unsaved draft' });
  const row = text => dialog.locator('[data-draft-difference]').filter({ has: page.getByRole('heading', { name: new RegExp(text) }) });
  await row('Main prompt$').waitFor();
  // Keyboard focus remains within the modal, including on a narrow viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole('button', { name: 'Close', exact: true }).focus(); await page.keyboard.press('Tab');
  assert.equal(await dialog.evaluate(node => node.contains(node.ownerDocument.activeElement)), true);
  assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
  if (process.env.DRAFT_REVIEW_SCREENSHOT) {
    await dialog.getByRole('button', { name: 'Refresh differences', exact: true }).focus();
    await dialog.evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: process.env.DRAFT_REVIEW_SCREENSHOT });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await row('Final prompt$').getByRole('button', { name: 'Dismiss', exact: true }).click();
  await row('Final prompt$').waitFor({ state: 'detached' });
  // An external edit invalidates the reviewed field; no stale overwrite is allowed.
  fixture.chats.chats[0].mainPrompt = 'Changed during review'; fixture.chats.revision++;
  await row('Main prompt$').getByRole('button', { name: 'Apply', exact: true }).click();
  try { await dialog.getByText(/This item changed since/).waitFor({ timeout: 5000 }); }
  catch (error) { console.log(await dialog.innerText(), fixture.chats.chats[0].mainPrompt); throw error; }
  assert.equal(fixture.chats.chats[0].mainPrompt, 'Changed during review');
  await dialog.getByRole('button', { name: 'Refresh differences', exact: true }).click();
  await row('Main prompt$').getByRole('button', { name: 'Apply', exact: true }).click();
  await row('Main prompt$').waitFor({ state: 'detached' });
  assert.equal(fixture.chats.chats[0].mainPrompt, 'Recovered main');
  assert.equal(fixture.chats.chats[0].finalPrompt, 'Newer server final');
  assert.equal(fixture.chats.chats.find(chat => chat.id === 'other').mainPrompt, 'Unrelated session');
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  assert.equal(await notice.getByRole('button', { name: 'View draft', exact: true }).evaluate(node => node === node.ownerDocument.activeElement), true);
  // Normal autosaves cannot overwrite the unresolved recovery archive.
  await page.locator('#promptstudio-main-prompt').fill('New live edit'); await save(page); await reload(page);
  await notice.getByRole('button', { name: 'View draft', exact: true }).click();
  await row('Unsent message$').waitFor();
  assert.equal(await row('Main prompt$').count(), 0);
  assert.equal(await row('Final prompt$').count(), 0);
  await row('Messages').getByRole('button', { name: 'Apply', exact: true }).click();
  await row('Messages').waitFor({ state: 'detached' });
  assert.equal(fixture.chats.chats.find(chat => chat.id === baseline.id).messages.some(message => message.id === 'missing-message'), true);
  await row('Unsent message$').getByRole('button', { name: 'Apply', exact: true }).click();
  await dialog.getByText('No remaining differences. You can dismiss this draft.').waitFor();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await page.locator('#promptstudio-revision').inputValue(), 'Recovered unsent text');
  assert.equal(await notice.count(), 0);
  assert.equal(fixture.requests.some(request => request.path === '/prompt'), false);

  // A legacy deletion-only draft still gets a review, and a failed write stays unresolved.
  await seed(page, 'image', { mutation: 20, revision: 0, activeChatId: baseline.id, chats: [], deletedMessageIds: { [baseline.id]: ['missing-message'] } });
  await reload(page); await save(page);
  await notice.getByRole('button', { name: 'View draft', exact: true }).click();
  await row('Delete message$').waitFor();
  const brokenWrite = route => route.request().method() === 'PUT' ? route.fulfill({ status: 200, json: {} }) : route.continue();
  await page.route('**/promptstudio/prompt-studio/chats', brokenWrite);
  await row('Delete message$').getByRole('button', { name: 'Apply', exact: true }).click();
  await dialog.getByRole('status').filter({ hasText: /invalid|revision/i }).waitFor();
  assert.equal(await row('Delete message$').count(), 1);
  await page.unroute('**/promptstudio/prompt-studio/chats', brokenWrite);
  await row('Delete message$').getByRole('button', { name: 'Apply', exact: true }).click();
  await row('Delete message$').waitFor({ state: 'detached' });
  assert.equal(fixture.chats.chats.find(chat => chat.id === baseline.id).messages.some(message => message.id === 'missing-message'), false);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  const dismissedChat = { ...fixture.chats.chats.find(chat => chat.id === baseline.id), mainPrompt: 'Discard this draft' };
  await seed(page, 'image', { mutation: 21, revision: 0, chats: [dismissedChat] });
  await reload(page); await save(page);
  await notice.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await notice.waitFor({ state: 'detached' });
  await reload(page);
  assert.equal(await notice.count(), 0, 'Whole-draft dismissal survives reload');
  assert.notEqual(fixture.chats.chats.find(chat => chat.id === baseline.id).mainPrompt, 'Discard this draft');

  if (videoEnabled) {
    const base = { id: 'project', name: 'Original project', brief: 'Original brief', document: config.default_document, generations: [], created_at: 1, updated_at: 1 };
    fixture.projects = { revision: 20, active_project_id: base.id, projects: [{ ...base, brief: 'Newer server brief' }] };
    await seed(page, 'video', { mutation: 4, revision: 19, active_project_id: base.id, base: [base], projects: [{ ...base, name: 'Recovered project', brief: 'Draft brief' }] });
    await reload(page); await attachVideo(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const videoNotice = page.locator('.psvstudio-sidebar [data-draft-review]');
    await videoNotice.getByRole('button', { name: 'View draft', exact: true }).click();
    await row('name$').getByRole('button', { name: 'Apply', exact: true }).click();
    await row('name$').waitFor({ state: 'detached' });
    assert.equal(fixture.projects.projects[0].name, 'Recovered project');
    assert.equal(fixture.projects.projects[0].brief, 'Newer server brief');
    await row('brief$').getByRole('button', { name: 'Dismiss', exact: true }).click();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(await videoNotice.count(), 0);
    await reload(page); await attachVideo(page);
    assert.equal(await videoNotice.count(), 0);
  }
  assert.deepEqual(fixture.errors, []);
  console.log('Draft review: selective apply/dismiss, stale protection, durable decisions, composer, keyboard/narrow layout and Video passed.', { videoEnabled });
} finally { await fixture.close(); }
