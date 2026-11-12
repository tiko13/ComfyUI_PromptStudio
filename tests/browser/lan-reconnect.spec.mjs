import assert from 'node:assert/strict';
import {startFixture, attachVideo, videoEnabled} from './fixture.mjs';

const fixture = await startFixture();
try {
  for (const video of videoEnabled ? [false, true] : [false]) {
    const page = await fixture.newPage();
    if (video) await attachVideo(page);
    await page.clock.install();
    const banner = page.locator(video ? '#psvstudio-api-connection' : '#promptstudio-api-connection');
    const input = page.locator(video ? '#psvstudio-main-description' : '#promptstudio-main-prompt');
    if (!video) await input.fill('Keep my draft through LAN reauthentication');
    let health = 'offline';
    await page.route('**/promptstudio/prompt-studio/runtime-health', route => {
      if (health === 'offline') return route.abort('connectionrefused');
      return route.fulfill({status: 401, json: {error: health}});
    });
    const event = name => page.evaluate(async name => {
      const {api} = await import('/scripts/api.js');
      api.dispatchEvent(new Event(name));
    }, name);
    await event('reconnecting');
    await banner.waitFor({state: 'visible'});
    assert.equal(await banner.locator('a').count(), 0, 'Offline is not an expired login');
    health = 'Another authentication provider';
    await page.clock.runFor(3100);
    assert.equal(await banner.locator('a').count(), 0, 'Do not redirect unrelated 401 responses');
    health = 'Prompt Studio LAN authentication required';
    await page.clock.runFor(3100);
    const signIn = banner.getByRole('link', {name: 'Sign in', exact: true});
    await signIn.waitFor();
    assert.equal(await banner.locator('strong').textContent(), 'LAN sign-in expired');
    assert.equal(await signIn.getAttribute('target'), '_blank');
    const href = new URL(await signIn.getAttribute('href'), fixture.origin);
    assert.equal(href.pathname, '/promptstudio/lan/login');
    assert.equal(href.searchParams.get('next'), '/');
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await banner.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.route('**/promptstudio/lan/login?*', route => route.fulfill({contentType: 'text/html', body: '<h1>Sign in</h1>'}));
    const popupReady = page.waitForEvent('popup');
    await page.getByRole('dialog', {name: 'Privacy guard', exact: true}).getByRole('link', {name: 'Sign in', exact: true}).click();
    const popup = await popupReady;
    await popup.close();
    assert.equal(page.url(), fixture.origin + '/', 'Keep the original tab and drafts');
    await event('reconnected');
    await banner.waitFor({state: 'hidden'});
    assert.equal(await banner.locator('a').count(), 0);
    if (!video) {
      assert.equal(await input.inputValue(), 'Keep my draft through LAN reauthentication');
      assert.equal(await input.isEnabled(), true);
    }
    // A subsequent ordinary disconnect must not retain the expired-login message.
    health = 'offline';
    await event('reconnecting');
    assert.equal(await banner.locator('strong').textContent(), 'ComfyUI disconnected');
    await event('reconnected');
    await page.close();
  }
  assert.deepEqual(fixture.errors, []);
  console.log('LAN expiry, offline retries, sign-in action, draft preservation and reconnection passed.');
} finally {
  await fixture.close();
}
