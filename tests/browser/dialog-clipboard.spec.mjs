import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import {startFixture, attachVideo, root} from './fixture.mjs';
const fixture = await startFixture();
try {
  await fixture.context.route('**/js/promptstudio_video_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: await response.text() + '\nwindow.uxVideo = {showCompiledPrompt, showEditableProjectPrompt, activeProject};'});
  });
  const page = await fixture.newPage();
  await attachVideo(page);
  await page.locator('#psvstudio-new-project').click();
  for (const editable of [false, true]) {
    for (const mode of ['unavailable', 'denied', 'success']) {
      await page.evaluate(({editable, mode}) => {
        Object.defineProperty(navigator, 'clipboard', {configurable: true, value: mode === 'unavailable' ? undefined : {
          async writeText(text) {
            if (mode === 'denied') throw new DOMException('Denied', 'NotAllowedError');
            window.copiedText = text;
          }
        }});
        if (editable) window.uxVideo.showEditableProjectPrompt(window.uxVideo.activeProject(), {prompt: 'Preserved prompt text', settingsPrompt: 'Preserved prompt text'});
        else window.uxVideo.showCompiledPrompt('Preserved prompt text');
      }, {editable, mode});
      const dialog = page.getByRole('dialog', {name: editable ? 'Editable MiniMax prompt' : 'Compiled MiniMax prompt'});
      const editor = dialog.getByRole('textbox', {name: editable ? 'Generation prompt' : 'Compiled MiniMax prompt text'});
      await dialog.getByRole('button', {name: 'Copy', exact: true}).click();
      await page.waitForFunction(() => [...document.querySelectorAll('dialog[open] [role=status]')]
        .some(el => /copied|Clipboard access/.test(el.textContent)));
      assert.equal(await editor.inputValue(), 'Preserved prompt text');
      if (mode === 'success') assert.equal(await page.evaluate(() => window.copiedText), 'Preserved prompt text');
      else assert.equal(await editor.evaluate(el => el.selectionEnd - el.selectionStart), 'Preserved prompt text'.length);
      const result = await new AxeBuilder({page}).include('dialog[open]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      assert.deepEqual(result.violations.map(v => ({id: v.id, nodes: v.nodes.map(n => n.target)})), []);
      await page.setViewportSize({width: 390, height: 844});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({path: resolve(root, 'test-results/browser/prompt-copy-' + (editable ? 'editable' : 'compiled') + '.png')});
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('dialog[open]').count(), 0);
    }
  }
  assert.deepEqual(fixture.errors, []);
  console.log('Both prompt dialogs: labelled editors, denied/unavailable/successful clipboard, selection fallback, accessibility, narrow layout and Escape passed.');
} finally { await fixture.close(); }
