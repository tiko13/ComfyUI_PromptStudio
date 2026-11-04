import assert from 'node:assert/strict';
import {startFixture, videoEnabled} from './fixture.mjs';

const fixture = await startFixture();
try {
  for (const mode of ['image', 'video']) {
    const page = await fixture.context.newPage();
    await page.clock.install();
    let health = {};
    let servicesReady = false;
    let videoReady = false;
    let shellRequests = 0;
    let hostRequests = 0;
    let navigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    await page.route('**/*', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/runtime-health')) return route.fulfill({json: health});
      if (path.endsWith('/prompt_studio_shell.js')) shellRequests++;
      if (path === '/') hostRequests++;
      if (path === '/promptstudio/prompt-studio/config' && !servicesReady) {
        return route.fulfill({status: 503, json: {error: 'Starting'}});
      }
      if (path === '/promptstudio-video/config' && !videoReady) {
        return route.fulfill({json: {}}); // HTTP 200 alone is insufficient.
      }
      return route.continue();
    });
    const url = `${fixture.origin}/extensions/ComfyUI_PromptStudio/prompt_studio.html?mode=${mode}`;
    const initialHealth = page.waitForResponse('**/runtime-health');
    await page.goto(url);
    await initialHealth;
    async function assertWaiting() {
      assert.equal(shellRequests, 0, 'Do not execute the shell before readiness');
      assert.equal(hostRequests, 0, 'Do not launch the workflow host before readiness');
      assert.equal(navigations, 1, 'Do not reload before readiness');
      assert.equal(await page.locator('#promptstudio-standalone-host').getAttribute('src'), null);
      assert.equal(await page.locator('#promptstudio-startup').getAttribute('data-state'), 'connecting');
    }
    await assertWaiting();
    // Even with all browser assets available, an unknown/dead worker must not
    // start the shell's 30-second failure timer. Advance time, not real sleeps.
    health = {prompt_worker_alive: false};
    const slowHealth = page.waitForResponse('**/runtime-health');
    await page.clock.fastForward(35000);
    await slowHealth;
    await assertWaiting();

    health = {prompt_worker_alive: true};
    const configAttempt = page.waitForResponse('**/prompt-studio/config');
    await page.clock.fastForward(5000);
    await configAttempt;
    await page.waitForFunction(() => document.getElementById('promptstudio-standalone-status')?.textContent.includes('finish starting'));
    await assertWaiting();

    servicesReady = true;
    if (mode === 'video' && videoEnabled) {
      const videoAttempt = page.waitForResponse('**/promptstudio-video/config');
      await page.clock.fastForward(5000);
      await videoAttempt;
      await assertWaiting();
    }
    videoReady = true;
    // Recovery must complete automatically, without a click or a manual reload.
    await page.clock.resume();
    await page.waitForFunction(() => !document.getElementById('promptstudio-startup'), null, {timeout: 20000});
    assert.equal(navigations, 2, 'Reload once after all required services recover');
    assert.equal(shellRequests, 1);
    assert.equal(hostRequests, 1);
    if (mode === 'video' && videoEnabled) {
      await page.waitForFunction(() => document.body.dataset.studioMode === 'video');
    } else {
      assert.ok(await page.locator('#promptstudio-prompt-studio').isVisible());
    }
    await page.close();
  }
  console.log('Image/Video wait for explicit worker and service readiness before starting the shell or host.');
} finally {
  await fixture.close();
}
