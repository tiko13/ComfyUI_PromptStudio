import assert from 'node:assert/strict';
import {startFixture, videoEnabled} from './fixture.mjs';

const fixture = await startFixture();
try {
  for (const mode of ['image', 'video']) {
    const page = await fixture.context.newPage();
    let offline = true;
    let workerReady = false;
    let navigations = 0;
    let releaseHost;
    const hostReady = new Promise(resolve => { releaseHost = resolve; });
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    await page.route('**/*', async route => {
      const path = new URL(route.request().url()).pathname;
      // Reproduce session restore: only the HTML survived, no CSS, JS or images.
      if (path.endsWith('/prompt_studio.html')) return route.continue();
      if (offline) return route.abort('connectionrefused');
      if (path.endsWith('/runtime-health')) return route.fulfill({json: {prompt_worker_alive: workerReady}});
      if (path === '/') await hostReady;
      return route.continue();
    });
    await page.goto(`${fixture.origin}/extensions/ComfyUI_PromptStudio/prompt_studio.html?mode=${mode}`);
    await page.waitForSelector('#promptstudio-startup[data-state="offline"]');
    assert.equal(await page.locator('.promptstudio-startup-spinner').isVisible(), false);
    assert.equal(await page.locator('#promptstudio-startup strong').textContent(), mode === 'video' ? 'Prompt Studio Video' : 'Prompt Studio');
    for (const viewport of [{width: 1440, height: 900}, {width: 827, height: 623}, {width: 390, height: 844}]) {
      await page.setViewportSize(viewport);
      const geometry = await page.evaluate(() => {
        const card = document.getElementById('promptstudio-startup');
        const first = card.querySelector('svg').getBoundingClientRect();
        const last = card.querySelector('small').getBoundingClientRect();
        const frame = document.getElementById('promptstudio-standalone-host');
        return {
          centerX: first.x + first.width / 2,
          centerY: (first.top + last.bottom) / 2,
          logoWidth: first.width,
          frameOpacity: getComputedStyle(frame).opacity,
          frameWidth: frame.getBoundingClientRect().width,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert.ok(Math.abs(geometry.centerX - viewport.width / 2) < 2, 'Logo centered horizontally');
      assert.ok(Math.abs(geometry.centerY - viewport.height / 2) < 2, 'Content centered vertically');
      assert.equal(geometry.logoWidth, 72);
      assert.equal(geometry.frameOpacity, '0');
      assert.equal(geometry.frameWidth, 1);
      assert.equal(geometry.overflow, false);
    }
    // Retry while offline must keep the restored document, not navigate to an error page.
    await page.getByRole('button', {name: 'Try again'}).click();
    assert.equal(navigations, 1);
    if (process.env.STARTUP_SCREENSHOT && mode === 'image') {
      await page.setViewportSize({width: 827, height: 623});
      await page.screenshot({path: process.env.STARTUP_SCREENSHOT});
    }
    offline = false;
    await page.getByRole('button', {name: 'Try again'}).click();
    await page.waitForSelector('#promptstudio-startup[data-state="connecting"]');
    async function assertConnecting() {
      assert.ok(await page.locator('.promptstudio-startup-spinner').isVisible());
      for (const selector of ['p', 'button', 'small']) {
        assert.equal(await page.locator(`#promptstudio-startup ${selector}`).isVisible(), false);
      }
      const centered = await page.evaluate(() => {
        const first = document.querySelector('#promptstudio-startup svg').getBoundingClientRect();
        const spinner = document.querySelector('.promptstudio-startup-spinner');
        const last = spinner.getBoundingClientRect();
        const bottom = last.y + last.height / 2 + spinner.offsetHeight / 2;
        return Math.abs((first.top + bottom) / 2 - innerHeight / 2) < 2
          && Math.abs(last.x + last.width / 2 - innerWidth / 2) < 2;
      });
      assert.ok(centered, 'Connecting content remains centered');
    }
    await assertConnecting();
    assert.equal(navigations, 1, 'Wait for the prompt worker before reloading');
    workerReady = true;
    await page.waitForEvent('framenavigated', {predicate: frame => frame === page.mainFrame()});
    await page.waitForSelector('#promptstudio-startup[data-state="connecting"]');
    await assertConnecting();
    await page.emulateMedia({reducedMotion: 'reduce'});
    assert.equal(await page.locator('.promptstudio-startup-spinner').evaluate(el => getComputedStyle(el).animationName), 'none');
    releaseHost();
    await page.waitForFunction(() => !document.getElementById('promptstudio-startup'), null, {timeout: 20000});
    assert.equal(navigations, 2, 'Automatically reload once when ComfyUI returns');
    if (mode === 'video' && videoEnabled) {
      await page.waitForFunction(() => document.body.dataset.studioMode === 'video');
      assert.ok(await page.locator('#promptstudio-video-mount .psvstudio-app').isVisible());
    } else {
      assert.ok(await page.locator('#promptstudio-prompt-studio').isVisible());
    }
    await page.close();
  }
  console.log('Restored Image/Video startup stays centered without assets and reconnects automatically.');
} finally {
  await fixture.close();
}
