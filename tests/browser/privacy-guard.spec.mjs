import assert from 'node:assert/strict';
import {startFixture, attachVideo, videoEnabled} from './fixture.mjs';

for (const hasTouch of [false, true]) {
  const fixture = await startFixture({contextOptions: {hasTouch}});
  try {
    for (const video of videoEnabled ? [false, true] : [false]) {
      const page = await fixture.newPage();
      if (video) {
        await attachVideo(page);
        if (await page.locator('#psvstudio-mobile-projects').isVisible()) await page.locator('#psvstudio-mobile-projects').click();
        await page.locator('#psvstudio-new-project').click();
        if (await page.locator('#psvstudio-close-projects').isVisible()) await page.locator('#psvstudio-close-projects').click();
      }
      const input = page.locator(video ? '#psvstudio-project-title' : '#promptstudio-main-prompt');
      await input.fill('Private draft retained across disconnect');
      // Native modal previews are above every ordinary z-index overlay.
      await page.evaluate(() => {
        const preview = document.createElement('dialog');
        preview.id = 'private-preview';
        preview.textContent = 'Private preview';
        document.body.append(preview);
        preview.showModal();
      });
      const event = name => page.evaluate(async name => {
        const {api} = await import('/scripts/api.js');
        api.dispatchEvent(new Event(name));
      }, name);
      await page.setViewportSize({width: 390, height: 844});
      await event('reconnecting');
      const guard = page.getByRole('dialog', {name: 'Privacy guard', exact: true});
      await guard.waitFor();
      assert.match(await guard.textContent(), /is frozen until the API connection returns/);
      for (const size of [{width:390,height:844}, {width:820,height:1180}, {width:1366,height:1024}]) {
        await page.setViewportSize(size);
        assert.deepEqual(await guard.boundingBox(), {x:0,y:0,...size});
        assert.equal(await guard.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(12, 13, 18)');
        assert.equal(await guard.evaluate(el => getComputedStyle(el).opacity), '1');
        assert.equal(await guard.evaluate(el => [[1,1],[innerWidth-1,innerHeight-1],[innerWidth/2,innerHeight/2]]
          .every(([x,y]) => el.contains(document.elementFromPoint(x,y)))), true);
      }
      await page.keyboard.press('Escape');
      assert.equal(await guard.isVisible(), true, 'Escape cannot reveal private content');
      await page.mouse.click(1, 1);
      assert.equal(await guard.isVisible(), true, 'Tapping the cover cannot dismiss it');
      await page.setViewportSize({width:1600,height:1000});
      if (hasTouch) await guard.waitFor();
      else await guard.waitFor({state:'hidden'});
      await page.setViewportSize({width:390,height:844});
      await guard.waitFor();
      await event('reconnected');
      await guard.waitFor({state:'hidden'});
      assert.equal(await input.inputValue(), 'Private draft retained across disconnect');
      assert.equal(await input.isEnabled(), true);
      assert.equal(await page.locator('#private-preview').evaluate(el => el.open), true);
      await page.close();
    }
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
}
console.log('Privacy guard covers phone/tablet viewports and modal previews, resists dismissal, and restores drafts in both studios.');
