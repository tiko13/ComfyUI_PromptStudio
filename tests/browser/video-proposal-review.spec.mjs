import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {startFixture, attachVideo, root, videoEnabled} from './fixture.mjs';
if (!videoEnabled) process.exit(0);
const fixture = await startFixture();
try {
  await fixture.context.route('**/js/promptstudio_video_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: await response.text() + '\nwindow.reviewTest={state,activeProject,renderAll,openDirector,directorSession,ensureDirectorVariants,syncDirectorVariant,persistDirectorSessions,persistProjects,renderDirectorDialog,applyDirectorJobResult,selectDirectorResponse};'});
  });
  let failure = true, delay = null, previewCalls = 0;
  await fixture.context.route('**/director/preview', async route => {
    previewCalls++;
    const {document, proposal} = route.request().postDataJSON();
    if (failure) return route.fulfill({status: 503, json: {error: 'Temporary preview failure'}});
    if (delay) { const wait = delay; delay = null; await wait; }
    if (document.shots[0].notes === 'stale') return route.fulfill({status: 409, json: {error: 'Document changed'}});
    // Fixed server-result fixture: deliberately includes full details missing from operation summaries.
    const after = structuredClone(document);
    after.shots[0].camera = {...after.shots[0].camera, speed: 'slow'};
    after.shots.push({id: 'new-private-uuid', start: 2.5, transition: 'the camera cuts to',
      composition: 'Tracking medium shot', subjects: 'Woman in a blue suit', environment: 'Same office beside the desk',
      lighting: 'Soft daylight', camera: {type: 'Tracking Shot', speed: 'slow', amplitude: 'small', target: 'Woman'},
      steps: [{type: 'action', text: 'She stands.'}, {type: 'dialogue', text: 'Keep <Subject 1> & “these words”.', speaker: 'Woman', speaker_id: 'S1', language: 'English'}, {type: 'action', text: 'She walks forward.'}],
      sounds: ['Chair scrape', 'Footsteps'], visible_text: ['<img src=x onerror=alert(1)>'], notes: ''});
    return route.fulfill({json: {valid: true, document: after, proposal}});
  });
  const page = await fixture.newPage(); await attachVideo(page);
  await page.locator('#psvstudio-new-project').click();
  await page.evaluate(() => {
    const t = window.reviewTest, p = t.activeProject();
    p.document.shots[0].id = 'original-private-uuid'; p.document.shots[0].environment = 'Original office';
    p.document.shots[0].steps = [{type: 'action', text: 'She sits.'}];
    t.state.selectedShotId = p.document.shots[0].id;
    const session = t.directorSession(p.id, 'project');
    session.messages = [{id: 'user', role: 'user', text: 'She stands and walks.'}];
    t.applyDirectorJobResult(session, {kind: 'send'}, {message: 'Review the sequence.', proposal: {
      summary: 'Two-shot proposal', operations: [{op: 'update_shot', shot_id: 'original-private-uuid', fields: {camera: {speed: 'slow'}}},
        {op: 'add_shot', shot: {id: 'new-private-uuid', start: 2.5, steps: [{type: 'action', text: 'She stands.'}]}}]}});
    t.openDirector('project');
  });
  const dialog = page.getByRole('dialog', {name: 'Video director · Entire video'});
  await dialog.getByText('Temporary preview failure', {exact: true}).waitFor();
  assert.equal(await dialog.getByRole('button', {name: 'Apply proposal', exact: true}).isDisabled(), true);
  failure = false;
  await dialog.getByRole('button', {name: 'Retry review', exact: true}).click();
  await dialog.getByRole('heading', {name: 'Shot 2', exact: true}).waitFor();
  assert.equal(previewCalls, 2);
  const text = await dialog.locator('.psvstudio-proposal-review').innerText();
  assert.match(text, /Shot count: 1 → 2/); assert.match(text, /Cut added at 2.5 s/);
  for (const part of ['Same office beside the desk', 'Soft daylight', 'Tracking Shot', 'She stands.', 'She walks forward.', 'Keep <Subject 1> & “these words”.', 'Chair scrape', 'Footsteps']) assert.ok(text.includes(part), part);
  assert.doesNotMatch(text, /private-uuid|"type":|Add shot at/);
  assert.equal(await dialog.locator('.psvstudio-proposal-review img').count(), 0);
  const unchanged = dialog.getByText(/Unchanged details/).first();
  await unchanged.focus(); await page.keyboard.press('Enter');
  await dialog.getByText('Original office', {exact: true}).waitFor();
  const previous = dialog.getByText('Previous camera', {exact: true});
  await previous.click(); assert.ok(await previous.evaluate(node => node.parentElement.open));
  await page.screenshot({path: resolve(root, 'test-results/browser/video-proposal-review.png')});
  await dialog.locator('.psvstudio-review-shot').filter({has: page.getByRole('heading', {name: 'Shot 2', exact: true})}).screenshot({path: resolve(root, 'test-results/browser/video-proposal-review-added-shot.png')});
  await page.setViewportSize({width: 390, height: 844});
  assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), true);
  assert.equal(await dialog.locator('.psvstudio-proposal-review').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.screenshot({path: resolve(root, 'test-results/browser/video-proposal-review-narrow.png')});

  // A saved snapshot must retain its original numbering across reload and later timeline edits.
  const snapshot = await page.evaluate(() => JSON.stringify(window.reviewTest.directorSession().messages.at(-1).proposal_review));
  await page.evaluate(async () => {const t = window.reviewTest; t.persistDirectorSessions(); await t.persistProjects({immediate: true});});
  await page.reload(); await page.waitForFunction(() => window.studioReady); await attachVideo(page);
  await page.evaluate(() => window.reviewTest.openDirector('project'));
  await dialog.getByRole('heading', {name: 'Shot 2', exact: true}).waitFor();
  assert.equal(previewCalls, 2, 'Reload uses the saved snapshot without reinterpreting it');
  assert.equal(await page.evaluate(() => JSON.stringify(window.reviewTest.directorSession().messages.at(-1).proposal_review)), snapshot);

  // Regeneration variants keep separate review snapshots, including after navigation.
  await page.evaluate(() => {
    const t = window.reviewTest, session = t.directorSession(), message = session.messages.at(-1);
    const proposal = structuredClone(message.proposal); proposal.summary = 'Alternative proposal';
    t.applyDirectorJobResult(session, {kind: 'regenerate', message_id: message.id}, {message: 'Alternative answer.', proposal});
    t.renderDirectorDialog();
  });
  await dialog.getByText('Alternative proposal', {exact: true}).waitFor();
  await dialog.getByRole('button', {name: 'Apply proposal', exact: true}).waitFor();
  await page.waitForFunction(() => !!window.reviewTest.directorSession().messages.at(-1).proposal_review);
  await dialog.getByRole('button', {name: 'Show previous answer'}).click();
  await dialog.getByText('Two-shot proposal', {exact: true}).waitFor();
  assert.equal(await page.evaluate(() => JSON.stringify(window.reviewTest.directorSession().messages.at(-1).proposal_review)), snapshot);

  // Apply validates again; an edit during that request must not be overwritten.
  let release; delay = new Promise(resolve => {release = resolve;});
  const applying = previewCalls;
  await dialog.getByRole('button', {name: 'Apply proposal', exact: true}).click();
  await page.waitForFunction(() => window.reviewTest.state.directorBusy);
  while (previewCalls === applying) await new Promise(resolve => setTimeout(resolve, 10));
  await page.evaluate(() => {window.reviewTest.activeProject().document.shots[0].notes = 'Concurrent edit';});
  release();
  await dialog.getByText(/changed while applying/).waitFor();
  assert.equal(await page.evaluate(() => window.reviewTest.activeProject().document.shots[0].notes), 'Concurrent edit');
  assert.equal(await page.evaluate(() => window.reviewTest.activeProject().document.shots.length), 1);
  await page.evaluate(() => {window.reviewTest.activeProject().document.shots[0].notes = '';});
  // Saving another review can replace message objects while Apply is in flight.
  delay = new Promise(resolve => {release = resolve;});
  await dialog.getByRole('button', {name: 'Apply proposal', exact: true}).click();
  await page.waitForFunction(() => window.reviewTest.state.directorBusy);
  await page.evaluate(() => window.reviewTest.persistDirectorSessions());
  release();
  await dialog.waitFor({state: 'hidden'});
  assert.equal(await page.evaluate(() => window.reviewTest.activeProject().document.shots.length), 2);
  await page.evaluate(() => window.reviewTest.openDirector('project'));
  await dialog.getByText('Applied', {exact: true}).waitFor();
  assert.equal(await page.evaluate(() => JSON.stringify(window.reviewTest.directorSession().messages.at(-1).proposal_review)), snapshot);

  // Existing stale proposals fail closed and can be discarded without changing the video.
  await page.evaluate(() => {
    const t = window.reviewTest, session = t.directorSession();
    session.messages = [{id: 'stale', role: 'assistant', text: 'Older response', proposal: {summary: 'Stale proposal', operations: []}}];
    t.activeProject().document.shots[0].notes = 'stale'; t.renderDirectorDialog();
  });
  await dialog.getByText(/belongs to an earlier document/).waitFor();
  assert.equal(await dialog.getByRole('button', {name: 'Apply proposal', exact: true}).isDisabled(), true);
  await dialog.getByRole('button', {name: 'Discard', exact: true}).click();
  await dialog.getByText('Discarded', {exact: true}).waitFor();
  assert.equal(await page.evaluate(() => window.reviewTest.activeProject().document.shots[0].notes), 'stale');

  // A result received after a newer edit reviews the frozen request document, in shot scope too.
  await page.evaluate(() => {
    const t = window.reviewTest, p = t.activeProject();
    t.state.directorDialog.close();
    const before = structuredClone(p.document); before.shots = [before.shots[0]]; before.shots[0].notes = '';
    before.shots[0].environment = 'Frozen request office';
    const session = t.directorSession(p.id, 'shot');
    session.messages = [{id: 'late-user', role: 'user', text: 'Refine the selected shot.'}];
    t.applyDirectorJobResult(session, {kind: 'send', project_id: p.id, request: {document: before}}, {
      message: 'Late result', proposal: {summary: 'Frozen request review', operations: []}});
    p.document.shots[0].environment = 'Newer project office';
    t.openDirector('shot');
  });
  const shotDialog = page.getByRole('dialog', {name: 'Shot director · Shot 1'});
  await shotDialog.getByRole('heading', {name: 'Shot 2', exact: true}).waitFor();
  await shotDialog.getByText(/Unchanged details/).first().click();
  await shotDialog.getByText('Frozen request office', {exact: true}).waitFor();
  assert.equal(await page.evaluate(() => window.reviewTest.activeProject().document.shots[0].environment), 'Newer project office');
  assert.equal(await page.evaluate(() => window.reviewTest.directorSession().messages.at(-1).proposal_review_base), null, 'Full baseline released after review');
  await shotDialog.getByRole('button', {name: 'Apply proposal', exact: true}).click();
  await shotDialog.getByText('Proposal not applied: Document changed', {exact: true}).waitFor();
  assert.deepEqual(fixture.errors, []);
  console.log('Proposal review: full cards, safe text, mouse/keyboard, narrow layout, retry, reload, variants, concurrent edit/save guards, apply, stale discard and frozen background/shot-scope reviews passed.');
} finally { await fixture.close(); }
