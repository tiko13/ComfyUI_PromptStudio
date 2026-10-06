import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {startFixture, config, root} from './fixture.mjs';

config.styles = ['None', ...Array.from({length: 70}, (_, i) => `Style ${i + 1}`)];
config.framings = ['None', ...Array.from({length: 70}, (_, i) => `Framing ${i + 1}`)];
const fixture = await startFixture();
try {
  const page = await fixture.newPage();
  for (const id of ['promptstudio-style', 'promptstudio-framing']) {
    const select = page.locator(`#${id}`);
    await select.evaluate(el => {
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS') parent.open = true;
      }
    });
    await select.scrollIntoViewIfNeeded();
    await select.click();
    assert.equal(await select.evaluate(el => el.matches(':open')), true);
    assert.equal(await select.evaluate(el => getComputedStyle(el, '::picker(select)').appearance), 'base-select');
    const firstOption = select.locator('option').first();
    const initial = await firstOption.boundingBox();
    const pickerHeight = await select.evaluate(el => parseFloat(getComputedStyle(el, '::picker(select)').height));
    assert.ok(pickerHeight <= 480);
    const x = initial.x + initial.width / 2;
    const bottom = initial.y + pickerHeight - 2;
    // Re-enter the bottom edge repeatedly, with no wheel or mouse button input.
    for (let i = 0; i < 8; i++) {
      await page.mouse.move(x, bottom + 8);
      await page.mouse.move(x, bottom - 3);
    }
    assert.equal((await firstOption.boundingBox()).y, initial.y, 'hover must not scroll the preset list');
    await page.mouse.move(x, initial.y + 50);
    await page.mouse.wheel(0, 220);
    await page.waitForFunction(({id, y}) => document.getElementById(id).options[0].getBoundingClientRect().y < y, {id, y: initial.y});
    const scrolled = (await firstOption.boundingBox()).y;
    for (let i = 0; i < 8; i++) {
      await page.mouse.move(x, bottom + 8);
      await page.mouse.move(x, bottom - 3);
    }
    assert.equal((await firstOption.boundingBox()).y, scrolled, 'hover must preserve deliberate scroll position');
    await page.keyboard.press('Escape');
    assert.equal(await select.inputValue(), 'None');
    assert.equal(await select.evaluate(el => el.matches(':open')), false);
    await select.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    assert.equal(await select.inputValue(), id.endsWith('style') ? 'Style 70' : 'Framing 70');
    await select.click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Escape');
    assert.equal(await select.inputValue(), id.endsWith('style') ? 'Style 70' : 'Framing 70', 'Escape cancels keyboard navigation');
  }
  await mkdir(resolve(root, 'test-results/browser'), {recursive: true});
  for (const width of [1440, 390]) {
    await page.setViewportSize({width, height: 844});
    // The mobile Controls drawer must be open for the sidebar controls.
    if (width === 390) {
      const toggle = page.locator('#promptstudio-toggle-settings');
      if (await toggle.isVisible()) await toggle.click();
    }
    const select = page.locator('#promptstudio-style');
    await select.scrollIntoViewIfNeeded();
    await select.click();
    const option = await select.locator('option').last().boundingBox();
    assert.ok(option.x >= 0 && option.x + option.width <= width, 'preset list fits the viewport');
    await page.screenshot({path: resolve(root, `test-results/browser/preset-dropdown-${width}.png`)});
    await select.locator('option').last().click();
    assert.equal(await select.evaluate(el => el.matches(':open')), false);
  }
  assert.deepEqual(fixture.errors, []);
  console.log('Style and Framing: stable hover edges, wheel scrolling, keyboard selection and Escape passed.');
} finally { await fixture.close(); }
