import assert from 'node:assert/strict';
import {startFixture, videoEnabled} from './fixture.mjs';

const fixture = await startFixture();
try {
  let status = {installed: false, loaded: false, state: 'missing'};
  await fixture.context.route('**/promptstudio-video/capabilities', route => route.fulfill({status: 503, json: {error: 'starting'}}));
  await fixture.context.route('**/promptstudio/prompt-studio/video-status', route => status
    ? route.fulfill({json: status}) : route.abort());
  const host = await fixture.newPage();
  await host.evaluate(() => {
    window.savedVideoHost = window.__promptstudioVideoStudioHost;
    delete window.__promptstudioVideoStudioHost;
  });
  const popup = host.waitForEvent('popup');
  await host.evaluate(() => window.open('/extensions/ComfyUI_PromptStudio/prompt_studio.html'));
  const page = await popup;
  await page.waitForSelector('[data-promptstudio-studio-mode="video"]:visible');
  await page.locator('[data-promptstudio-studio-mode="video"]:visible').first().click();
  const title = page.locator('#promptstudio-video-install-title');
  const install = page.locator('#promptstudio-video-install');
  await page.waitForFunction(() => document.querySelector('#promptstudio-video-install-dialog').open);
  assert.match(await title.textContent(), /not installed/);
  assert.equal(await install.isVisible(), true);

  // An already open dialog updates on the automatic poll, including failures.
  status = null;
  await page.waitForFunction(() => document.querySelector('#promptstudio-video-install-title').textContent.includes('temporarily unavailable'), null, {timeout: 12000});
  assert.equal(await install.isVisible(), false);
  status = {installed: true, loaded: false, state: 'not_loaded'};
  await page.evaluate(() => window.__promptstudioUnifiedStudio.refreshVideoAvailability());
  assert.match(await title.textContent(), /installed but not loaded/);
  assert.equal(await install.isVisible(), false);
  assert.equal(fixture.requests.some(r => r.path === '/customnode/install/git_url'), false);

  if (videoEnabled) {
    // A late frontend host recovers even while the capability endpoint fails.
    await host.evaluate(() => { window.__promptstudioVideoStudioHost = window.savedVideoHost; });
    await page.evaluate(() => window.__promptstudioUnifiedStudio.refreshVideoAvailability());
    await page.waitForFunction(() => document.body.dataset.studioMode === 'video');
    assert.equal(await page.locator('#promptstudio-video-install-dialog').isVisible(), false);
    await page.setViewportSize({width: 390, height: 844});
    const image = page.locator('[data-promptstudio-studio-mode="image"]:visible').first();
    await image.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.body.dataset.studioMode === 'image');
  }
  assert.deepEqual(fixture.errors, []);
  console.log('Video discovery: confirmed absence, outages, dialog recovery and late host attachment passed.');
} finally { await fixture.close(); }
