import assert from 'node:assert/strict';
import {startFixture, videoEnabled} from './fixture.mjs';
if (!videoEnabled) process.exit(0);

// Small generated PCM fixture exercises native browser media seeking and decoding.
const samples = 48000 * 3, wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i / 48000 * 440 * Math.PI * 2) * 16000), 44 + i * 2);
const fixture = await startFixture();
try {
  const page = await fixture.newPage();
  await page.route('**/timeline-tone.wav', route => route.fulfill({contentType:'audio/wav', body:wav}));
  await page.evaluate(async encoded => {
    const {mountTransport, drawWaveform} = await import('/extensions/PromptStudio_Video/js/timeline-media.js');
    const host = document.createElement('section'); host.id = 'transport-test'; document.body.append(host);
    const media = document.createElement('video'); media.muted = true; media.preload = 'metadata'; host.append(media);
    window.mediaTest = {host, media, positions:[], range:null};
    const transport = mountTransport(host, {duration:1, position:.25, offset:1, media, unit:'frames', label:'Fixture',
      onPosition:time => mediaTest.positions.push(time), onRange:range => { mediaTest.range = range; }});
    mediaTest.transport = transport;
    media.src = URL.createObjectURL(new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], {type:'audio/wav'}));
    const canvas = document.createElement('canvas'); canvas.style.width = '300px'; host.append(canvas);
    await drawWaveform(canvas, '/timeline-tone.wav', .5, 1.5, 3);
    mediaTest.waveform = [...canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data].some(value => value > 0);
  }, wav.toString('base64'));
  await page.waitForFunction(() => Math.abs(mediaTest.media.currentTime - 1.25) < .001);
  const host = page.locator('#transport-test');
  await host.getByRole('button',{name:'+1 frame',exact:true}).click();
  await page.waitForFunction(() => Math.abs(mediaTest.media.currentTime - (1.25 + 1/24)) < .001);
  await host.getByRole('button',{name:'Set In',exact:true}).click();
  const input = host.getByRole('textbox',{name:'Fixture playhead'});
  await input.fill('12'); await input.press('Tab');
  await host.getByRole('button',{name:'Set Out',exact:true}).click();
  await host.getByRole('button',{name:'Loop range',exact:true}).click();
  await host.getByRole('button',{name:'Play',exact:true}).click();
  await page.waitForFunction(() => mediaTest.positions.some((value, index, values) => index > 0 && values[index - 1] > .45 && value < .32));
  await host.getByRole('button',{name:'Pause',exact:true}).click();
  assert.equal(await page.evaluate(() => mediaTest.waveform), true);
  assert.deepEqual(await page.evaluate(() => mediaTest.range), {in:7/24, out:.5, loop:true});
  await page.evaluate(() => { mediaTest.media.currentTime = .1; });
  await page.waitForFunction(() => !mediaTest.media.seeking && Math.abs(mediaTest.media.currentTime - 1) < .001);
  await page.evaluate(() => { mediaTest.transport.dispose(); mediaTest.positions.length = 0; mediaTest.media.currentTime = 2; });
  await page.waitForFunction(() => !mediaTest.media.seeking);
  assert.equal(await page.evaluate(() => mediaTest.positions.length), 0);
  assert.deepEqual(fixture.errors, []);
  console.log('Native media offset/seek, frame stepping, range looping, waveform decoding and transport disposal passed.');
} finally { await fixture.close(); }
