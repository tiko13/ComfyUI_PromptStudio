import assert from 'node:assert/strict';
import {startFixture, videoEnabled} from './fixture.mjs';

const fixture = await startFixture();
try {
  const calls = [];
  let failCore = false;
  await fixture.context.route('**/prompt-studio/update-comfyui', async route => {
    calls.push('core');
    await new Promise(resolve => setTimeout(resolve, 150));
    await route.fulfill({status: failCore ? 500 : 200, json: failCore
      ? {error: 'Package update failed'}
      : {success: true, steps: [{id: 'comfyui-core', success: true, updated: true}]}});
  });
  await fixture.context.route('**/manager/queue/**', async route => {
    const url = new URL(route.request().url());
    calls.push(`${route.request().method()} ${url.pathname}`);
    await new Promise(resolve => setTimeout(resolve, 150));
    // Exercise both missing v2 routes and older GET-only Manager endpoints.
    const status = url.pathname.startsWith('/v2/') ? 404
      : route.request().method() === 'POST' ? 405 : 200;
    await route.fulfill({status, json: {}});
  });
  const page = await fixture.newPage();
  page.on('dialog', dialog => dialog.accept());
  await page.evaluate(async () => {
    const {api} = await import('/scripts/api.js');
    const original = api.fetchApi.bind(api);
    // Match ComfyUI's timeoutMs contract, with a shorter default for the test.
    api.fetchApi = async (url, options = {}) => {
      const update = url.includes('update-comfyui') || url.includes('/manager/queue/');
      if (!update) return original(url, options);
      const {timeoutMs = 40, ...init} = options;
      const controller = new AbortController();
      const timer = timeoutMs === null ? null : setTimeout(() => {
        controller.abort(new DOMException('Fetch timeout', 'TimeoutError'));
      }, timeoutMs);
      try { return await original(url, {...init, signal: controller.signal}); }
      finally { if (timer !== null) clearTimeout(timer); }
    };
  });
  await page.locator('#promptstudio-kobold-control > summary').click();
  await page.locator('#promptstudio-comfy-update').click();
  await page.waitForFunction(() => document.querySelector('#promptstudio-comfy-status-detail')
    ?.textContent.includes('Manager Update All started'));
  assert.deepEqual(calls, [
    'core', 'POST /v2/manager/queue/update_all', 'POST /manager/queue/update_all',
    'GET /manager/queue/update_all', 'POST /v2/manager/queue/start',
    'POST /manager/queue/start', 'GET /manager/queue/start',
  ]);
  assert.equal(await page.locator('#promptstudio-comfy-update').isDisabled(), true);
  await page.evaluate(async () => {
    const {api} = await import('/scripts/api.js');
    api.dispatchEvent(new CustomEvent('cm-queue-status', {detail: {status: 'all-done'}}));
  });
  await page.waitForFunction(() => !document.querySelector('#promptstudio-comfy-update').disabled);
  assert.match(await page.locator('#promptstudio-comfy-status-detail').textContent(), /Restart required/);

  calls.length = 0;
  failCore = true;
  await page.locator('#promptstudio-comfy-update').click();
  await page.waitForFunction(() => document.querySelector('#promptstudio-comfy-status-detail')
    ?.textContent.includes('Package update failed'));
  assert.deepEqual(calls, ['core']);
  assert.equal(await page.locator('#promptstudio-comfy-update').isDisabled(), false);
  assert.deepEqual(fixture.errors, []);
  console.log(`ComfyUI update delayed responses, Manager fallbacks and errors passed (Video=${videoEnabled})`);
} finally {
  await fixture.close();
}
