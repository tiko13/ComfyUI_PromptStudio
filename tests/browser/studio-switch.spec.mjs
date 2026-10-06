import assert from 'node:assert/strict';
import {startFixture, videoEnabled} from './fixture.mjs';

if (!videoEnabled) {
  console.log('Studio shell integration requires STUDIO_TEST_VIDEO=1');
} else {
  const fixture = await startFixture();
  try {
    await fixture.context.route('**/promptstudio-video/capabilities', route => route.fulfill({
      json: {features: ['unified_studio_shell'], studio_instances: []},
    }));
    const host = await fixture.newPage();
    // Reconnect through the broadcast bridge without an opener reference.
    // Keep the fixture host alive across navigation of the standalone page.
    await host.evaluate(() => {
      const bridge = new BroadcastChannel('promptstudio.promptStudio.standalone.v1');
      bridge.onmessage = async ({data}) => {
        if (data.type !== 'connect') return;
        const attached = await window.__promptstudioPromptStudioHost.attach(window.testPopup);
        bridge.postMessage({type: attached ? 'connected' : 'failed', requestId: data.requestId});
      };
    });
    const popupPromise = host.waitForEvent('popup');
    await host.evaluate(() => { window.testPopup = window.open('about:blank'); });
    let page = await popupPromise;
    page.on('pageerror', error => fixture.errors.push(error.message));
    await page.evaluate(() => { window.opener = null; });
    await page.goto(`${fixture.origin}/extensions/ComfyUI_PromptStudio/prompt_studio.html`);

    async function switchTo(mode, keyboard = false) {
      const button = page.locator(`[data-promptstudio-studio-mode="${mode}"]:visible`).first();
      if (keyboard) { await button.focus(); await page.keyboard.press('Enter'); }
      else await button.click();
      await page.waitForFunction(mode => document.body.dataset.studioMode === mode, mode, {timeout: 5000});
      assert.equal(await page.locator('#promptstudio-video-install-dialog').isVisible(), false);
      assert.equal(await page.locator('#promptstudio-image-mount').isVisible(), mode === 'image');
      assert.equal(await page.locator('#promptstudio-video-mount .psvstudio-app').isVisible(), mode === 'video');
    }

    for (let refresh = 0; refresh < 2; refresh++) {
      if (refresh) await page.reload();
      await page.waitForSelector('[data-promptstudio-studio-mode="video"][data-available="true"]:visible');
      await switchTo('video');
      await switchTo('image');
      await page.setViewportSize({width: 390, height: 844});
      await switchTo('video', true);
      await switchTo('image', true);
      await page.setViewportSize({width: 1440, height: 1000});
    }
    await page.close();
    await host.close();

    // Normal opener attachment and the private iframe fallback must also
    // reconnect with the actual companion host after a browser refresh.
    const directHost = await fixture.newPage();
    const directPopup = directHost.waitForEvent('popup');
    await directHost.evaluate(() => window.open('/extensions/ComfyUI_PromptStudio/prompt_studio.html?mode=video'));
    page = await directPopup;
    page.on('pageerror', error => fixture.errors.push(error.message));
    for (let refresh = 0; refresh < 2; refresh++) {
      if (refresh) await page.reload();
      await page.waitForFunction(() => document.body.dataset.studioMode === 'video');
      await switchTo('image');
      await page.evaluate(() => window.__promptstudioUnifiedStudio.refreshVideoAvailability());
      assert.equal(await page.evaluate(() => document.body.dataset.studioMode), 'image', 'Capability refresh respects the latest selection');
      await switchTo('video');
    }
    await page.close();
    await directHost.close();
    page = await fixture.context.newPage();
    page.on('pageerror', error => fixture.errors.push(error.message));
    await page.goto(`${fixture.origin}/extensions/ComfyUI_PromptStudio/prompt_studio.html`);
    for (let refresh = 0; refresh < 2; refresh++) {
      if (refresh) await page.reload();
      await page.waitForSelector('[data-promptstudio-studio-mode="video"][data-available="true"]:visible');
      await switchTo('video');
      await switchTo('image');
    }
    assert.deepEqual(fixture.errors, []);
    console.log('Studio shell broadcast, opener and iframe switching/refresh passed, including desktop/mobile keyboard controls.');
  } finally { await fixture.close(); }
}
