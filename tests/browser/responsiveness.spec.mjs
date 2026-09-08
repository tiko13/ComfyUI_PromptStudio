import assert from 'node:assert/strict';
import {startFixture, attachVideo, videoEnabled} from './fixture.mjs';

const fixture = await startFixture();
try {
  await fixture.context.route('**/js/prompt_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: await response.text() + '\nexport {handleStudioTurn};'});
  });
  await fixture.context.route('**/js/promptstudio_video_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: await response.text() + '\nexport {state};'});
  });
  const page = await fixture.newPage();
  // Count expensive work in the actual bubbling input handlers. Timing alone
  // would pass on a fast machine even if every key copied all history again.
  const typing = await page.evaluate(async () => {
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    await state.chatSaveChain;
    const input = document.querySelector('#promptstudio-revision');
    const chat = state.chats.find(chat => chat.id === state.activeChatId);
    const history = structuredClone(chat);
    history.id = 'large-history';
    history.initialized = true;
    history.messages = Array.from({length:300}, (_, i) => ({id:`old-${i}`,role:'user',text:'History',images:[],createdAt:i+1,generationSnapshot:{output:{data:'x'.repeat(20000)}}}));
    state.chats.push(history);
    state.chatMutationVersion++;
    const stringify = JSON.stringify;
    let scans = 0;
    JSON.stringify = function(value, ...args) {
      if (value === history || value?.chats?.includes(history)) scans++;
      return stringify(value, ...args);
    };
    const started = performance.now();
    try {
      for (const character of 'A lighthouse beside the sea') {
        input.value += character;
        input.dispatchEvent(new Event('input', {bubbles:true}));
      }
      return {scans, milliseconds:performance.now()-started, text:input.value};
    } finally { JSON.stringify = stringify; state.chats.pop(); state.chatMutationVersion++; }
  });
  assert.equal(typing.scans, 0, 'Typing must not serialize historical workflows');
  assert.equal(await page.evaluate(async text => {
    const {createDraftOutbox,draftTabKey} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/chat/draft-outbox.js');
    const outbox = createDraftOutbox();
    let saved;
    for (let attempt = 0; attempt < 60; attempt++) {
      saved = await outbox.get(draftTabKey('image'));
      if (saved?.composerText === text) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await outbox.close();
    return saved?.composerText === text;
  }, typing.text), true, 'Composer draft must reach durable storage');
  await page.reload();
  await page.waitForFunction(() => window.studioReady);
  assert.equal(await page.locator('#promptstudio-revision').inputValue(), typing.text, 'Batched composer draft survives reload');

  let releaseRoute;
  let routeReply = {route:'clarify',confidence:1};
  await page.route('**/promptstudio/prompt-studio/route-turn', async route => {
    await new Promise(resolve => { releaseRoute = resolve; });
    await route.fulfill({json:routeReply});
  });
  await page.route('**/promptstudio/prompt-studio/discuss', route => route.fulfill({json:{message:'Synthetic advice'}}));
  for (const routeName of ['clarify','discuss','mutate_now','cancel_pending','commit_pending']) {
    routeReply = {route:routeName,confidence:1,resolved_instruction:'A lighthouse'};
    const text = `Request for ${routeName}`;
    await page.locator('#promptstudio-revision').fill(text);
    await page.locator('#promptstudio-send').click();
    assert.equal(await page.locator('#promptstudio-history').getByText(text, {exact:true}).count(), 1, 'Message is visible while the router is still blocked');
    assert.equal(await page.locator('#promptstudio-revision').inputValue(), '');
    assert.equal(await page.locator('#promptstudio-send').isDisabled(), true);
    // The user can draft the next turn while this request is being classified.
    await page.locator('#promptstudio-revision').fill('Next unsent draft');
    releaseRoute();
    await page.waitForFunction(() => !document.querySelector('#promptstudio-send').disabled);
    assert.equal(await page.locator('#promptstudio-history').getByText(text, {exact:true}).count(), 1, `${routeName} must reuse the receipt`);
    assert.equal(await page.locator('#promptstudio-revision').inputValue(), 'Next unsent draft');
  }
  await page.unroute('**/promptstudio/prompt-studio/route-turn');
  await page.route('**/promptstudio/prompt-studio/route-turn', route => route.fulfill({status:503,json:{error:'Synthetic router unavailable'}}));
  await page.locator('#promptstudio-revision').fill('Retry this request');
  await page.locator('#promptstudio-send').click();
  await page.waitForFunction(() => !document.querySelector('#promptstudio-send').disabled);
  assert.equal(await page.locator('#promptstudio-revision').inputValue(), 'Retry this request');

  if (videoEnabled) {
    await attachVideo(page);
    await page.locator('#psvstudio-new-project').click();
    const videoTyping = await page.evaluate(async () => {
      const {state} = await import('/extensions/PromptStudio_Video/js/promptstudio_video_studio.js');
      const title = document.querySelector('#psvstudio-project-title');
      const stringify = JSON.stringify;
      let snapshots = 0;
      JSON.stringify = function(value, ...args) {
        if (value?.projects || value === state.projects) snapshots++;
        return stringify(value, ...args);
      };
      try {
        for (const character of 'Responsive video title') {
          title.value += character;
          title.dispatchEvent(new Event('input', {bubbles:true}));
        }
        return {snapshots, title:title.value};
      } finally { JSON.stringify = stringify; }
    });
    assert.equal(videoTyping.snapshots, 0, 'Video input must not copy/serialize the project archive');
    await page.waitForFunction(() => document.querySelector('#psvstudio-save-state').textContent === 'Saved');
    assert.equal(fixture.projects.projects[0].name, videoTyping.title);
  }
  assert.deepEqual(fixture.errors, []);
  console.log(JSON.stringify({typing, passed:['composer draft reload','immediate receipt for five routes','no duplicate messages','next draft preserved','routing failure retry',...(videoEnabled ? ['Video batched save'] : [])]}));
} finally {await fixture.close();}
