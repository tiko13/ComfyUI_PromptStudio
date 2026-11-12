import assert from 'node:assert/strict';
import {startFixture, attachVideo, videoEnabled} from './fixture.mjs';
if (!videoEnabled) process.exit(0);

// Native media clock, without an external encoder or a long recording delay.
const samples = 48000 * 8, wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
const fixture = await startFixture();
try {
  await fixture.context.route('**/js/promptstudio_video_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: await response.text() + '\nwindow.rangeTest={state,activeProject,renderAll};'});
  });
  await fixture.context.route('**/view?**', route => route.fulfill({contentType:'audio/wav', body:wav}));
  const page = await fixture.newPage();
  await attachVideo(page);
  await page.locator('#psvstudio-new-project').click();
  // Opening a default project must not save its five-second end as an explicit Out.
  await page.evaluate(() => {
    const {activeProject, renderAll} = rangeTest, project = activeProject();
    project.document.duration_seconds = 8;
    project.generations = [{id:'long-take', status:'complete', effective_duration:8,
      document:structuredClone(project.document), outputs:[{filename:'long.wav', type:'output'}]}];
    renderAll();
  });
  await page.waitForFunction(() => document.querySelector('#psvstudio-preview video')?.readyState >= 2);
  const player = page.locator('#psvstudio-preview video');
  assert.equal(await player.getAttribute('data-timeline-preview'), 'true');
  // A blob provides a fully seekable source without implementing HTTP byte ranges.
  await player.evaluate(async media => { media.src = URL.createObjectURL(await (await fetch(media.src)).blob()); });
  await page.waitForFunction(() => document.querySelector('#psvstudio-preview video')?.readyState >= 2);
  await player.evaluate(media => { media.muted = true; media.currentTime = 5.5; });
  await page.waitForFunction(() => !document.querySelector('#psvstudio-preview video').seeking);
  await player.evaluate(media => media.play());
  await page.waitForFunction(() => {
    const media = document.querySelector('#psvstudio-preview video');
    return media.currentTime > 6 && !media.paused;
  }, null, {timeout:5000});
  await player.evaluate(media => media.pause());

  const toolbar = page.locator('#psvstudio-timing-toolbar');
  await page.evaluate(() => rangeTest.state.timelineTransport.seek(6.5));
  await toolbar.getByRole('button', {name:'Set Out', exact:true}).click();
  await page.evaluate(() => rangeTest.renderAll());
  assert.equal(await page.evaluate(() => rangeTest.state.timelineRange.out), 6.5);
  await player.evaluate(media => { media.currentTime = 6; });
  await page.waitForFunction(() => !document.querySelector('#psvstudio-preview video').seeking);
  await player.evaluate(media => media.play());
  await page.waitForFunction(() => {
    const media = document.querySelector('#psvstudio-preview video');
    return media.paused && media.currentTime >= 6.5 && media.currentTime < 7;
  });

  await toolbar.getByRole('button', {name:'Clear range', exact:true}).click();
  await page.evaluate(() => rangeTest.renderAll());
  await player.evaluate(media => { media.currentTime = 7; });
  await page.waitForFunction(() => !document.querySelector('#psvstudio-preview video').seeking);
  await player.evaluate(media => media.play());
  await page.waitForFunction(() => document.querySelector('#psvstudio-preview video').ended);
  assert.equal(await player.evaluate(media => media.currentTime), 8);
  assert.deepEqual(fixture.errors, []);
  console.log('Longer takes play past the initial five-second range; explicit Out survives rerender and Clear range restores full playback.');
} finally { await fixture.close(); }
