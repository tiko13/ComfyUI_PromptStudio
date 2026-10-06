import assert from 'node:assert/strict';
import { startFixture, attachVideo, videoEnabled } from './fixture.mjs';

const fixture = await startFixture();
const policy = {recent: 3, daily_days: 7, weekly_weeks: 4, budget_bytes: 268435456};
const actions = [];
let fail = false;
try {
  await fixture.context.route(/\/(?:chats|projects)\/storage(?:\?|$)/, async route => {
    const url = new URL(route.request().url());
    if (fail) return route.fulfill({status: 409, json: {error: 'History changed. Refresh recovery before restoring.'}});
    if (route.request().method() === 'POST') {
      actions.push({endpoint: url.pathname, ...route.request().postDataJSON()});
      return route.fulfill({json: {ok: true, revision: 8}});
    }
    if (url.searchParams.has('checkpoint')) return route.fulfill({json: {revision: 6, records: [{id: 'saved', summary: {title: 'Saved session', messageCount: 23}}]}});
    return route.fulfill({json: {revision: 7, current_bytes: 3000000, recovery_bytes: 5000000, other_bytes: 123,
      policy, checkpoints: [{revision: 6, saved_at: 1791198000}]}});
  });
  const page = await fixture.newPage();
  await page.locator('#promptstudio-toggle-studio-settings').click();
  await page.locator('#promptstudio-history-storage').click();
  const dialog = page.getByRole('dialog', {name: 'History storage', exact: true});
  await dialog.getByText(/Current history: 2.86 MiB/).waitFor();
  await dialog.getByRole('button', {name: 'Optimize now'}).click();
  await dialog.getByRole('button', {name: 'Refresh', exact: true}).waitFor();
  assert.equal(actions[0].action, 'optimize');
  await dialog.getByLabel('Recovery checkpoint').selectOption('6');
  await dialog.getByLabel('Session to restore').selectOption('saved');
  assert.equal(await dialog.getByRole('button', {name: 'Restore selected session'}).isEnabled(), false);
  await dialog.getByRole('checkbox').check();
  fail = true;
  await dialog.getByRole('button', {name: 'Restore selected session'}).click();
  await dialog.getByRole('status').filter({hasText: 'History changed'}).waitFor();
  assert.equal(await dialog.isVisible(), true);
  fail = false;
  await dialog.getByRole('button', {name: 'Refresh', exact: true}).click();
  await dialog.getByLabel('Recovery checkpoint').selectOption('6');
  await dialog.getByLabel('Session to restore').selectOption('saved');
  await page.setViewportSize({width: 390, height: 844});
  const box = await dialog.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 391, JSON.stringify(box));
  await dialog.getByRole('button', {name: 'Close', exact: true}).focus();
  await page.keyboard.press('Tab');
  assert.equal(await dialog.getByRole('button', {name: 'Optimize now'}).evaluate(el => el === el.ownerDocument.activeElement), true);
  await page.keyboard.press('Escape');
  await dialog.waitFor({state: 'detached'});
  assert.equal(await page.locator('#promptstudio-history-storage').evaluate(el => el === el.ownerDocument.activeElement), true);
  await page.setViewportSize({width: 1440, height: 1000});
  await page.locator('#promptstudio-history-storage').click();
  await dialog.getByLabel('Recovery checkpoint').selectOption('6');
  await dialog.getByLabel('Session to restore').selectOption('saved');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', {name: 'Restore selected session'}).click();
  await dialog.waitFor({state: 'detached'});
  assert.equal(actions.at(-1).record_id, 'saved');
  assert.equal(actions.at(-1).revision, 7);
  if (videoEnabled) {
    await attachVideo(page);
    await page.locator('#psvstudio-history-storage').click();
    await dialog.getByText(/Current history:/).waitFor();
    await dialog.getByRole('button', {name: 'Optimize now'}).click();
    await page.waitForTimeout(100);
    assert.equal(actions.at(-1).endpoint, '/promptstudio-video/projects/storage');
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(fixture.errors, []);
  console.log('History storage: Image/Video controls, conflict handling, explicit restore, keyboard and narrow layout passed.');
} finally { await fixture.close(); }
