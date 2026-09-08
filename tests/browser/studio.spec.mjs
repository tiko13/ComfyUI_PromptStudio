import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {startFixture,attachVideo,root} from './fixture.mjs';
const fixture=await startFixture();
const {context,origin,errors,requests}=fixture;
try {
 const page=await fixture.newPage();
 await page.locator('#promptstudio-new-chat').click();
 await page.locator('#promptstudio-new-chat').click();
 const emptyCount = await page.evaluate(async () => {
  const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
  return state.chats.filter(c => !c.messages.length && !c.currentPrompt).length;
 });
 assert.equal(emptyCount, 1, 'Repeated New chat must retain one empty session');
 await page.locator('#promptstudio-toggle-studio-settings').focus();
 await page.keyboard.press('Enter');
 await page.waitForFunction(() => !document.querySelector('#promptstudio-studio-settings').hidden);
 await page.locator('#promptstudio-open-backend-settings').click();
 await page.waitForFunction(() => document.querySelector('#promptstudio-backend-settings-dialog').getAttribute('aria-modal') === 'true');
 for (let index = 0; index < 35; index++) {
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.querySelector('#promptstudio-backend-settings-dialog').contains(document.activeElement)), true, 'Focus must remain in modal backend settings');
 }
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#promptstudio-backend-settings-dialog').isHidden(), true);
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#promptstudio-studio-settings').isHidden(), true);
 assert.equal(await page.evaluate(() => document.activeElement.id), 'promptstudio-toggle-studio-settings');
 assert.deepEqual(errors, [], 'Application must initialize without uncaught errors');
 await mkdir(resolve(root, 'test-results/browser'), {recursive:true});
 await page.screenshot({path: resolve(root, 'test-results/browser/image-desktop.png')});
 await page.setViewportSize({width:390, height:844});
 await page.screenshot({path: resolve(root, 'test-results/browser/image-narrow.png')});
 await page.setViewportSize({width:1440, height:1000});
 await attachVideo(page);
 await page.screenshot({path: resolve(root, 'test-results/browser/video-desktop.png')});
 await page.locator('#psvstudio-new-project').click();
 await page.locator('#psvstudio-project-title').fill('Browser fixture A');
 await page.waitForFunction(() => document.querySelector('#psvstudio-save-state').textContent === 'Saved');
 assert.equal(fixture.projects.projects[0].name, 'Browser fixture A');
 await page.reload();
 await page.waitForFunction(() => window.studioReady || window.bootError);
 assert.equal(await page.evaluate(() => window.bootError), undefined);
 assert.equal(await page.locator('#psvstudio-project-title').inputValue(), 'Browser fixture A', 'Saved Video project survives reload');
 await attachVideo(page);
 const second = await context.newPage();
 second.on('pageerror', e => errors.push(e.message));
 await second.goto(origin);
 await second.waitForFunction(() => window.studioReady || window.bootError);
 assert.equal(await second.evaluate(() => window.bootError), undefined);
 await attachVideo(second);
 await page.locator('#psvstudio-project-title').fill('Server version');
 await page.waitForFunction(() => document.querySelector('#psvstudio-save-state').textContent === 'Saved');
 await second.locator('#psvstudio-project-title').fill('Local version');
 await second.getByRole('button', {name:'Review conflicts', exact:true}).waitFor();
 assert.equal(fixture.projects.projects[0].name, 'Server version', 'Conflicting save must not overwrite server');
 await second.getByRole('button', {name:'Review conflicts', exact:true}).click();
 await second.getByRole('dialog', {name:/Conflicting edits/}).waitFor();
 await second.screenshot({path:resolve(root, 'test-results/browser/video-save-conflict.png')});
 await second.getByRole('button', {name:'Keep my version', exact:true}).click();
 await second.waitForFunction(() => document.querySelector('#psvstudio-save-state').textContent === 'Saved');
 assert.equal(fixture.projects.projects[0].name, 'Local version', 'Explicit conflict choice persists');
 assert.deepEqual(errors, [], 'Cross-studio actions must have no uncaught errors');
 console.log(JSON.stringify({passed: ['dual-studio initialization', 'one-empty-chat', 'keyboard modal focus/escape/return', 'reduced-motion render', 'Video save/reload', 'two-client conflict review and retry'], requests: requests.length}));

} finally {await fixture.close();}
