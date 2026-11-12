import assert from 'node:assert/strict';
import {startFixture, videoEnabled} from './fixture.mjs';

const fixture = await startFixture();
try {
  await fixture.context.route(`${fixture.origin}/`, async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('await window.__promptstudioPromptStudioHost.attach(window);', '');
    await route.fulfill({response, body});
  });
  const host = await fixture.newPage();
  const popupEvent = host.waitForEvent('popup');
  await host.locator('#promptstudio-prompt-studio-launcher').evaluate(button => button.click());
  const popup = await popupEvent;
  popup.on('pageerror', error => fixture.errors.push(error.message));
  await popup.waitForSelector('#promptstudio-prompt-studio:visible');
  assert.equal(new URL(popup.url()).pathname, '/PromptStudio');
  await popup.reload();
  await popup.waitForSelector('#promptstudio-prompt-studio:visible');
  assert.equal(new URL(popup.url()).pathname, '/PromptStudio');
  if (videoEnabled) {
    await popup.goto(`${fixture.origin}/extensions/PromptStudio_Video/prompt_studio_video.html`);
    await popup.waitForFunction(() => document.body.dataset.studioMode === 'video');
    assert.equal(new URL(popup.url()).pathname, '/PromptStudio');
    assert.equal(new URL(popup.url()).searchParams.get('mode'), 'video');
    await popup.reload();
    await popup.waitForFunction(() => document.body.dataset.studioMode === 'video');
  }
  assert.deepEqual(fixture.errors, []);
  console.log('Short URL launcher, reload and legacy Video navigation passed.');
} finally {
  await fixture.close();
}
