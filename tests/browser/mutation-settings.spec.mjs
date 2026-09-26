import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import {startFixture, root} from './fixture.mjs';
import {MUTATION_CONFIG_CATEGORIES} from '../../web/js/prompt-studio/core/constants.js';

const fixture = await startFixture();
let config = {revision: '1', ...Object.fromEntries(Object.keys(MUTATION_CONFIG_CATEGORIES).map(key => [key, []]))};
let failSave = false;
try {
  await fixture.context.route('**/mutation-config*', async route => {
    if (route.request().method() === 'PUT') {
      if (failSave) return route.fulfill({status: 503, json: {error: 'Save temporarily unavailable'}});
      const {category, items} = route.request().postDataJSON();
      config = {...config, [category]: items, revision: String(Number(config.revision) + 1)};
    }
    await route.fulfill({json: config});
  });
  const page = await fixture.newPage();
  await page.locator('#promptstudio-toggle-studio-settings').focus();
  await page.keyboard.press('Enter');
  const settings = page.locator('#promptstudio-studio-settings');
  const manager = page.locator('#promptstudio-mutation-manager');
  const editor = page.locator('#promptstudio-mutation-editor');
  assert.equal(await page.locator('section[aria-labelledby="promptstudio-general-settings-title"] #promptstudio-run-setup').count(), 1);
  const focusInside = async (locator, presses = 12) => {
    for (let i = 0; i < presses; i++) {
      await page.keyboard.press(i % 2 ? 'Tab' : 'Shift+Tab');
      assert.equal(await locator.evaluate(el => el.contains(document.activeElement)), true);
    }
  };
  for (const [category, metadata] of Object.entries(MUTATION_CONFIG_CATEGORIES)) {
    const launcher = page.locator(`[data-mutation-category="${category}"]`);
    await launcher.click();
    assert.equal(await manager.evaluate(el => el.matches(':modal')), true);
    assert.equal(await manager.getAttribute('aria-labelledby'), 'promptstudio-mutation-manager-title');
    assert.equal(await page.locator('#promptstudio-mutation-manager-title').textContent(), metadata.title);
    const scrollTop = await settings.evaluate(el => el.scrollTop);
    await focusInside(manager);
    await manager.getByRole('button', {name: `Add ${metadata.itemLabel}`, exact: true}).click();
    await page.locator('#promptstudio-mutation-editor-name').fill(`Test ${category}`);
    if (metadata.textField) await page.locator('#promptstudio-mutation-editor-text').fill('Preserve this guidance.');
    await focusInside(editor);
    await editor.getByRole('button', {name: 'Save', exact: true}).click();
    await editor.waitFor({state: 'hidden'});
    assert.equal(config[category].length, 1);
    await manager.getByRole('button', {name: 'Edit', exact: true}).click();
    await page.locator('#promptstudio-mutation-editor-name').fill('Unsaved draft');
    await page.keyboard.press('Escape');
    assert.equal(await editor.isHidden(), true);
    assert.equal(await manager.isVisible(), true, 'Escape must close only the editor');
    await page.locator('#promptstudio-mutation-search').fill('no matching entry');
    assert.equal(await manager.locator('.promptstudio-mutation-row').count(), 0);
    await page.locator('#promptstudio-mutation-search').fill('');
    await manager.getByRole('button', {name: 'Close', exact: true}).click();
    assert.equal(await settings.isVisible(), true);
    assert.equal(await launcher.evaluate(el => el === document.activeElement), true);
    assert.equal(await settings.evaluate(el => el.scrollTop), scrollTop);
  }
  await page.locator('[data-mutation-category="known_references"]').click();
  await manager.getByRole('button', {name: 'Edit', exact: true}).click();
  failSave = true;
  await page.locator('#promptstudio-mutation-editor-name').fill('Keep my draft');
  await editor.getByRole('button', {name: 'Save', exact: true}).click();
  await page.getByText('Save temporarily unavailable', {exact: true}).waitFor();
  assert.equal(await page.locator('#promptstudio-mutation-editor-name').inputValue(), 'Keep my draft');
  failSave = false;
  await editor.getByRole('button', {name: 'Save', exact: true}).click();
  await editor.waitFor({state: 'hidden'});
  await mkdir(resolve(root, 'test-results/browser'), {recursive: true});
  for (const viewport of [{width: 1440, height: 1000}, {width: 390, height: 844}]) {
    await page.setViewportSize(viewport);
    const bounds = await manager.evaluate(el => ({width: el.scrollWidth, client: el.clientWidth,
      left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right,
      top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom}));
    assert.ok(bounds.width <= bounds.client && bounds.left >= 0 && bounds.right <= viewport.width);
    assert.ok(bounds.top >= 0 && bounds.bottom <= viewport.height);
    const accessibility = await new AxeBuilder({page}).include('#promptstudio-mutation-manager').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(accessibility.violations.map(v => ({id: v.id, targets: v.nodes.map(n => n.target)})), []);
    await page.screenshot({path: resolve(root, `test-results/browser/mutation-${viewport.width}.png`)});
  }
  await page.keyboard.press('Escape');
  assert.equal(await manager.isHidden(), true);
  assert.equal(await settings.isVisible(), true);
  assert.deepEqual(fixture.errors, []);
  console.log('Five mutation pop-ups: native modal, focus, CRUD save, search, failure retry, nested Escape, return to Settings, accessibility and responsive layout passed.');
} finally { await fixture.close(); }
