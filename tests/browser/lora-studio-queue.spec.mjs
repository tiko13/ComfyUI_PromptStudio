import assert from 'node:assert/strict';
import { startFixture, attachVideo, videoEnabled } from './fixture.mjs';

const fixture = await startFixture();
let status = { reserved: false, active: false };
try {
  await fixture.context.route('**/promptstudio/lora-studio/generation', route => route.fulfill({ json: status }));
  const page = await fixture.newPage();
  await page.locator('#promptstudio-new-chat').click();
  const idleLabel = await page.locator('#promptstudio-send').textContent();
  status = { reserved: true, active: true };
  await page.waitForFunction(() => document.querySelector('#promptstudio-kobold-status-label').textContent === 'Generating in LoRA studio');
  await page.waitForFunction(() => document.querySelector('#promptstudio-send').textContent.startsWith('Queue'));
  assert.equal(await page.locator('#promptstudio-kobold-control').getAttribute('data-state'), 'busy');
  assert.equal(await page.locator('#promptstudio-reroll').textContent(), 'Queue reroll');
  if (videoEnabled) {
    await attachVideo(page);
    await page.locator('#psvstudio-new-project').click();
    await page.waitForFunction(() => document.querySelector('#psvstudio-kobold-status-label').textContent === 'Generating in LoRA studio');
    assert.equal(await page.locator('#psvstudio-generate').textContent(), 'Queue generation');
    assert.equal(await page.locator('#psvstudio-kobold-control').getAttribute('data-state'), 'busy');
  }
  // Empty intervals between images retain the reservation; only its release resets UI.
  status = { reserved: true, active: false };
  await page.waitForFunction(() => document.querySelector('#promptstudio-kobold-status-label').textContent === 'LoRA studio waiting for current work');
  assert.ok((await page.locator('#promptstudio-send').textContent()).startsWith('Queue'));
  status = { reserved: false, active: false };
  await page.waitForFunction(label => document.querySelector('#promptstudio-send').textContent === label, idleLabel);
  assert.equal(await page.locator('#promptstudio-reroll').textContent(), 'Reroll');
  if (videoEnabled) await page.waitForFunction(() => document.querySelector('#psvstudio-generate').textContent === 'Generate');
  assert.deepEqual(fixture.errors, []);
  console.log(`LoRA comparison status and queue labels passed (${videoEnabled ? 'Image + Video' : 'Image'}).`);
} finally {
  await fixture.close();
}
