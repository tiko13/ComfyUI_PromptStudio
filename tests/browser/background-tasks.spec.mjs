import assert from 'node:assert/strict';
import { startFixture, attachVideo, videoEnabled } from './fixture.mjs';

const fixture = await startFixture();
let snapshot = {state:'populating', total:328, processed:42, errors:0,
  records:{found:40, not_found:2, unchecked:286}};
let unavailable = false;
let requests = 0;
try {
  await fixture.context.route('**/prompt-studio/model-metadata/library', route => {
    requests++;
    assert.equal(route.request().method(), 'GET', 'Monitoring must not initiate metadata lookups');
    return route.fulfill({status:unavailable ? 503 : 200, json:unavailable ? {error:'offline'} : snapshot});
  });
  const page = await fixture.newPage();
  const check = async prefix => {
    const monitor = page.locator(`#${prefix}-kobold-control`);
    const section = page.locator(`#${prefix}-background-tasks`);
    const color = () => monitor.evaluate(node => ({state:node.dataset.state,
      color:getComputedStyle(node.querySelector('[aria-hidden="true"]')).backgroundColor}));
    snapshot = {state:'populating', total:328, processed:42, errors:0,
      records:{found:40, not_found:2, unchecked:286}};
    await monitor.locator('summary').click();
    await page.waitForFunction(id => document.getElementById(id).textContent.includes('42 / 328'), `${prefix}-background-tasks`);
    const initial = await color();
    assert.equal(await section.locator('progress').getAttribute('value'), '42');
    assert.ok((await section.textContent()).includes('40 matched · 2 unmatched · 286 unchecked'));
    snapshot = {...snapshot, state:'deferred', processed:43, errors:1,
      error:'Civitai is unavailable or rate limited. Saved records are kept; population will resume after a cooldown.'};
    await page.waitForFunction(id => document.getElementById(id).textContent.includes('Waiting to retry · 43 / 328'), `${prefix}-background-tasks`);
    assert.deepEqual(await color(), initial, 'Background work and retry errors must not change the health dot');
    await section.screenshot({path:`test-results/${prefix}-background-tasks.png`});
    // Reopening immediately refreshes instead of waiting for the next poll.
    const reopen = async () => {
      await monitor.locator('summary').click();
      await monitor.locator('summary').click();
    };
    snapshot = {...snapshot, state:'complete', processed:328, errors:0, error:''};
    await reopen();
    await page.waitForFunction(id => document.getElementById(id).textContent.includes('Scan complete · 328 / 328'), `${prefix}-background-tasks`);
    assert.equal(await section.locator('progress').isVisible(), false);
    snapshot = {...snapshot, state:'failed', error:'The library could not be indexed.'};
    await reopen();
    await page.waitForFunction(id => document.getElementById(id).textContent.includes('Scan failed'), `${prefix}-background-tasks`);
    assert.deepEqual(await color(), initial);
    unavailable = true;
    await reopen();
    await page.waitForFunction(id => document.getElementById(id).textContent.includes('status unavailable'), `${prefix}-background-tasks`);
    assert.ok((await section.textContent()).includes('Last known: Database:'));
    assert.deepEqual(await color(), initial, 'Monitor transport failures must not affect health');
    unavailable = false;
    await monitor.locator('summary').click();
    const closedRequests = requests;
    await page.waitForTimeout(5500);
    assert.equal(requests, closedRequests, 'Closed monitors should not poll the library');
  };
  await check('promptstudio');
  if (videoEnabled) { await attachVideo(page); await check('psvstudio'); }
  assert.deepEqual(fixture.errors, []);
  console.log(`Background tasks passed (${videoEnabled ? 'Image + Video' : 'Image'}): progress, auto refresh, retry/failure, closed polling, unchanged health color.`);
} finally { await fixture.close(); }
