import assert from 'node:assert/strict';
import {join} from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import {startFixture} from './fixture.mjs';
import {mossCatalog, mossProfile} from '../moss-fixture.mjs';

const fixture = await startFixture();
const profile = await mossProfile(mossCatalog.find(p => p.id === 'moss_sft_controlled'));
try {
  const page = await fixture.newPage();
  await page.setViewportSize({width: 3440, height: 1440});
  await page.evaluate(async profile => {
    const {openSpatialEditor} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/spatial-editor.js');
    openSpatialEditor({profile, value: {elements: ['Background', 'Middle', 'Foreground'].map((description, index) => ({
      id: `layer-${index}`, type: 'object', description, x: .1, y: .1, width: .7, height: .7,
    }))}, defaults: {}, save: value => {window.overlapSaved = value;}, upload: async () => {}, imageUrl: () => ''});
  }, profile);
  const dialog = page.getByRole('dialog', {name: 'Layout and control maps', exact: true});
  const studio = page.locator('#promptstudio-prompt-studio');
  const canvas = dialog.locator('.ps-spatial-canvas');
  const button = name => dialog.getByRole('button', {name, exact: true});
  async function assertInset() {
    await page.waitForFunction(() => {
      const d = document.querySelector('.ps-spatial-editor').getBoundingClientRect(), s = document.querySelector('#promptstudio-prompt-studio').getBoundingClientRect();
      return Math.abs(d.width - (s.width - 48)) < 1 && Math.abs((d.x + d.width / 2) - (s.x + s.width / 2)) < 1;
    });
    const d = await dialog.boundingBox(), s = await studio.boundingBox();
    assert.ok(d.x >= s.x + 23 && d.y >= s.y + 23 && d.x + d.width <= s.x + s.width - 23 && d.y + d.height <= s.y + s.height - 23, 'Editor is inset within the main Studio window');
  }
  await assertInset();
  assert.ok((await dialog.boundingBox()).width < 2240, 'Ultrawide display does not stretch the editor across the monitor');
  await page.setViewportSize({width: 5120, height: 1440}); await assertInset();
  await button('Maximize').click(); assert.equal(Math.round((await dialog.boundingBox()).width), 5120);
  await button('Restore size').click(); await assertInset();
  // The embedded panel is narrower and aligned to the right, not the screen center.
  await page.evaluate(() => document.body.classList.remove('promptstudio-popout-body')); await assertInset();
  await page.evaluate(() => document.body.classList.add('promptstudio-popout-body')); await assertInset();
  await page.setViewportSize({width: 3440, height: 1440}); await assertInset();
  const rect = await canvas.boundingBox();
  const point = {x: rect.x + rect.width * .45, y: rect.y + rect.height * .45};
  await page.mouse.click(point.x, point.y, {button: 'right'});
  const menu = dialog.getByRole('menu', {name: 'Segments under pointer'});
  assert.deepEqual(await menu.getByRole('menuitemradio').allTextContents(), ['object: Foreground', 'object: Middle', 'object: Background']);
  const audit = await new AxeBuilder({page}).include('.ps-spatial-editor').analyze();
  assert.deepEqual(audit.violations.map(v => ({id: v.id, help: v.help})), []);
  if (process.env.SPATIAL_SCREENSHOTS) await page.screenshot({path: join(process.env.SPATIAL_SCREENSHOTS, 'spatial-ultrawide-overlap.png')});
  await menu.getByRole('menuitemradio', {name: 'object: Middle', exact: true}).click();
  assert.equal(await dialog.getByLabel('Description', {exact: true}).inputValue(), 'Middle');
  assert.equal(await button('Undo').isDisabled(), true, 'Choosing a covered segment is not an edit');
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x + 24, point.y + 16); await page.mouse.up();
  assert.equal(await dialog.locator('.ps-spatial-box.selected').getAttribute('data-id'), 'layer-1', 'Dragging retains the chosen lower layer');
  assert.ok(Number(await dialog.getByLabel('x (%)', {exact: true}).inputValue()) > 10);
  await button('Undo').click();
  assert.equal(await dialog.getByLabel('x (%)', {exact: true}).inputValue(), '10');
  await page.keyboard.down('Alt'); await page.mouse.click(point.x, point.y); await page.keyboard.up('Alt');
  assert.equal(await dialog.getByLabel('Description', {exact: true}).inputValue(), 'Background');
  await page.keyboard.down('Alt'); await page.mouse.click(point.x, point.y); await page.keyboard.up('Alt');
  assert.equal(await dialog.getByLabel('Description', {exact: true}).inputValue(), 'Foreground', 'Alt-click wraps through all layers');
  await page.mouse.click(point.x, point.y, {button: 'right'}); await page.keyboard.press('Escape');
  assert.equal(await menu.count(), 0); assert.equal(await dialog.count(), 1, 'Escape dismisses the picker, not the editor');
  await page.mouse.click(point.x, point.y, {button: 'right'});
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  assert.equal(await dialog.getByLabel('Description', {exact: true}).inputValue(), 'Background', 'Overlap chooser is keyboard accessible');
  await canvas.focus(); await page.keyboard.press('Delete');
  assert.equal(await dialog.locator('.ps-spatial-box[data-id="layer-0"]').count(), 0, 'Delete affects the selected covered segment');
  await page.keyboard.press('Control+z');
  await button('Apply changes').click();
  assert.deepEqual(await page.evaluate(() => window.overlapSaved.elements.map(e => e.id)), ['layer-0', 'layer-1', 'layer-2'], 'Picking layers never changes their generation order');
  assert.deepEqual(fixture.errors, []);
  console.log('Spatial ultrawide bounds, embedded panel alignment, overlap picker, lower-layer drag/delete, Alt cycling, keyboard and accessibility passed.');
} finally {await fixture.close();}
