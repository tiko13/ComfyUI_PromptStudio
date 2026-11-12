import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';
import {mossCatalog, mossProfile} from '../moss-fixture.mjs';

const fixture = await startFixture();
const profile = await mossProfile(mossCatalog.find(p => p.id === 'moss_sft_controlled'));
try {
  const page = await fixture.newPage();
  await page.setViewportSize({width: 3440, height: 1440});
  await page.evaluate(async profile => {
    const {openSpatialEditor} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/spatial-editor.js');
    openSpatialEditor({profile, defaults: {}, value: {elements: Array.from({length: 64}, (_, i) => ({
      id: `area-${i}`, type: 'object', x: .05 + (i % 8) * .1, y: .05 + Math.floor(i / 8) * .1,
      width: .08, height: .08, description: `Area ${i}: ` + 'detailed subject description '.repeat(250),
    }))}, save: value => {window.performanceSaved = value;}, upload: async () => {}, imageUrl: () => ''});
  }, profile);
  const dialog = page.getByRole('dialog', {name: 'Layout and control maps', exact: true});
  const canvas = dialog.locator('.ps-spatial-canvas'), viewport = dialog.locator('.ps-spatial-viewport');
  await canvas.evaluate(async () => {await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);});
  await page.evaluate(() => {
    const canvas = document.querySelector('.ps-spatial-canvas'), inspector = document.querySelector('.ps-spatial-inspector');
    window.spatialPerf = {originalBox: canvas.querySelector('.selected'), originalText: inspector.querySelector('textarea'), scans: 0, writes: 0};
    const query = canvas.querySelectorAll;
    canvas.querySelectorAll = function(selector) {if (selector === '.ps-spatial-box') window.spatialPerf.scans++; return query.call(this, selector);};
    window.spatialObserver = new MutationObserver(records => {window.spatialPerf.writes += records.filter(r => r.type === 'attributes' && r.target.classList.contains('ps-spatial-box') && r.attributeName === 'style').length;});
    window.spatialObserver.observe(canvas, {subtree: true, attributes: true});
  });
  const selected = dialog.locator('.ps-spatial-box[data-id="area-0"]');
  let box = await selected.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  const startIdentity = await page.evaluate(() => ({box: window.spatialPerf.originalBox.isConnected, input: window.spatialPerf.originalText.isConnected}));
  const burst = await viewport.evaluate(async (viewport, {x, y}) => {
    const start = performance.now(); window.spatialPerf.scans = 0; window.spatialPerf.writes = 0;
    for (let i = 1; i <= 240; i++) viewport.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, pointerId: 1, buttons: 1, clientX: x + i / 4, clientY: y + i / 8}));
    const handlerMs = performance.now() - start;
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    return {handlerMs, scans: window.spatialPerf.scans, writes: window.spatialPerf.writes};
  }, {x: box.x + box.width / 2, y: box.y + box.height / 2});
  await page.mouse.up();
  const endIdentity = await page.evaluate(() => ({box: window.spatialPerf.originalBox.isConnected, input: window.spatialPerf.originalText.isConnected}));
  console.log('Spatial drag performance:', JSON.stringify({startIdentity, endIdentity, burst}));
  assert.deepEqual(startIdentity, {box: true, input: true}, 'Starting a drag retains the selected box and inspector');
  assert.deepEqual(endIdentity, {box: true, input: true}, 'Finishing a drag retains the selected box and inspector');
  assert.equal(burst.scans, 0, 'Pointer movement must not scan every box');
  assert.ok(burst.writes <= 4, 'A burst of pointer events paints at most once per animation frame');
  await dialog.getByRole('button', {name: 'Undo', exact: true}).click();
  assert.equal(await dialog.getByLabel('x (%)', {exact: true}).inputValue(), '5', 'The burst is one undo step');
  const handle = await selected.locator('[data-edge=se]').boundingBox();
  await selected.evaluate(box => {window.resizeBox = box; window.resizeInput = document.querySelector('.ps-spatial-inspector textarea');});
  const sx = handle.x + handle.width / 2, sy = handle.y + handle.height / 2;
  await page.mouse.move(sx, sy); await page.mouse.down();
  const resizeBurst = await viewport.evaluate(async (viewport, {x, y}) => {
    window.spatialPerf.scans = 0; window.spatialPerf.writes = 0;
    const start = performance.now();
    for (let i = 1; i <= 240; i++) viewport.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, pointerId: 1, buttons: 1, clientX: x + i / 3, clientY: y + i / 4}));
    const handlerMs = performance.now() - start;
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    return {handlerMs, scans: window.spatialPerf.scans, writes: window.spatialPerf.writes};
  }, {x: sx, y: sy});
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.resizeBox.isConnected && window.resizeInput.isConnected), true, 'Resize preserves canvas and inspector nodes');
  assert.equal(resizeBurst.scans, 0); assert.ok(resizeBurst.writes <= 4);
  assert.ok(Number(await dialog.getByLabel('width (%)', {exact: true}).inputValue()) > 8);
  console.log('Spatial resize performance:', JSON.stringify(resizeBurst));
  await dialog.getByRole('button', {name: 'Undo', exact: true}).click();
  assert.equal(await dialog.getByLabel('width (%)', {exact: true}).inputValue(), '8');
  // Pointerup can precede the scheduled paint. It must still commit the last
  // event, and Escape before paint must discard it with no late frame writes.
  box = await selected.boundingBox();
  for (const abort of [false, true]) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    const result = await viewport.evaluate(async (viewport, {x, y, abort}) => {
      viewport.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, pointerId: 1, buttons: 1, clientX: x + 40, clientY: y + 20}));
      if (abort) document.querySelector('.ps-spatial-canvas').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
      else viewport.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, pointerId: 1, buttons: 0, clientX: x + 40, clientY: y + 20}));
      const immediate = document.querySelector('[aria-label="x (%)"]').value;
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      return {immediate, later: document.querySelector('[aria-label="x (%)"]').value};
    }, {x: box.x + box.width / 2, y: box.y + box.height / 2, abort});
    await page.mouse.up();
    assert.equal(result.immediate, result.later, 'No delayed frame changes committed/cancelled geometry');
    if (abort) assert.equal(result.immediate, '5');
    else {assert.ok(Number(result.immediate) > 5); await dialog.getByRole('button', {name: 'Undo', exact: true}).click();}
  }
  await canvas.focus();
  await selected.evaluate(box => {window.nudgeBox = box;});
  await page.keyboard.press('ArrowRight');
  assert.equal(await selected.evaluate(box => box === window.nudgeBox), true, 'Keyboard movement also preserves canvas nodes');
  await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
  assert.deepEqual(fixture.errors, []);
} finally {await fixture.close();}
