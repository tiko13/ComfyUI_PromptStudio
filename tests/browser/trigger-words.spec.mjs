import assert from 'node:assert/strict';
import { startFixture } from './fixture.mjs';

const fixture = await startFixture();
const words = {
  'Style/single.safetensors': ['solo'],
  'Style/multiple.safetensors': ['first trigger', 'second trigger'],
  'Character/other.safetensors': ['character'],
  'Style/empty.safetensors': [],
  'Style/slow.safetensors': ['too late'],
};
let releaseSlow;
try {
  await fixture.context.route('**/js/prompt_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() + '\nexport {refreshWorkflowControls};' });
  });
  await fixture.context.route('**/prompt-studio/loras?*', route => route.fulfill({ json: {
    loras: Object.keys(words).map(name => ({ name, label: name })),
  } }));
  await fixture.context.route('**/prompt-studio/model-metadata**', async route => {
    const request = route.request();
    const data = request.method() === 'POST' ? request.postDataJSON() : Object.fromEntries(new URL(request.url()).searchParams);
    if (data.name === 'Style/slow.safetensors') await new Promise(resolve => { releaseSlow = resolve; });
    await route.fulfill({ json: { status: 'found', trigger_words: words[data.name] || [], refresh_due: false } });
  });
  const page = await fixture.newPage();
  await page.evaluate(async () => {
    const { state } = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const { refreshWorkflowControls } = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    state.workflowProfiles = [{ id: 'triggers', name: 'Trigger fixture', kind: 'create', promptNodeId: 'p',
      loraNodes: [{ id: 'l', loraType: 'Style' }], modelNodes: [],
      snapshot: { workflow: { nodes: [], links: [] }, output: { p: { class_type: 'KCPP_PromptSlot', inputs: { prompt: '' } } } } }];
    state.workflowBusy = true;
    state.chats.find(chat => chat.id === state.activeChatId).createWorkflowId = 'triggers';
    refreshWorkflowControls();
    window.triggerState = state;
    window.selectTriggers = names => { state.loraSelections = { ['triggers\u0000l']: names.map(name => ({ name, strength: 1 })) }; };
  });
  const button = page.getByRole('button', { name: 'Add trigger words', exact: true });
  const editor = page.getByRole('textbox', { name: 'Unmodified part', exact: true });
  const menu = page.locator('.promptstudio-trigger-menu');
  const select = names => page.evaluate(names => window.selectTriggers(names), names);
  await select(['Style/single.safetensors']);
  await editor.fill('Existing text');
  await button.click();
  await page.waitForFunction(() => document.querySelector('#promptstudio-secondary-instructions').value === 'Existing text, solo');
  assert.ok(await menu.isHidden());
  assert.equal(await page.evaluate(() => window.triggerState.chats.find(c => c.id === window.triggerState.activeChatId).studioSettings.secondary_instructions), 'Existing text, solo');

  await select(['Style/multiple.safetensors', 'Character/other.safetensors']);
  await button.click();
  await menu.getByRole('button', { name: 'first trigger', exact: true }).click();
  assert.ok(await menu.isVisible());
  await menu.getByRole('button', { name: 'second trigger', exact: true }).click();
  await menu.getByRole('button', { name: 'character', exact: true }).click();
  assert.equal(await editor.inputValue(), 'Existing text, solo, first trigger, second trigger, character');
  assert.deepEqual(await menu.locator('h4').allTextContents(), ['Style/multiple.safetensors', 'Character/other.safetensors']);
  assert.ok(await menu.isVisible());
  await editor.click();
  assert.ok(await menu.isHidden());

  await select(['Style/multiple.safetensors']);
  await editor.fill('Existing text,  ');
  await button.click();
  await menu.getByRole('button', { name: 'first trigger', exact: true }).click();
  assert.equal(await editor.inputValue(), 'Existing text, first trigger');
  await page.keyboard.press('Escape');
  assert.ok(await menu.isHidden());
  await button.click();
  await menu.getByRole('button', { name: 'first trigger', exact: true }).waitFor();
  await button.click();
  assert.ok(await menu.isHidden(), 'Clicking Add trigger words again closes its dropdown');
  await select(['Style/single.safetensors', 'Character/other.safetensors']);
  await button.click();
  await menu.getByRole('button', { name: 'solo', exact: true }).waitFor();
  assert.ok(await menu.isVisible(), 'Two LoRAs with one trigger each need a dropdown');
  await page.keyboard.press('Escape');

  for (const [names, message] of [[[], 'Select a LoRA first.'], [['Style/empty.safetensors'], 'No trigger words available for this LoRA.']]) {
    await select(names);
    await button.click();
    await menu.getByText(message, { exact: true }).waitFor();
    assert.equal(await editor.inputValue(), 'Existing text, first trigger');
    await page.keyboard.press('Escape');
  }

  await select(['Style/slow.safetensors']);
  await button.click();
  await menu.getByText('Loading trigger words…').waitFor();
  // Changing context while a request is in flight must never insert old triggers.
  await select(['Style/single.safetensors']);
  await page.waitForFunction(() => document.querySelector('#promptstudio-add-trigger-words').getAttribute('aria-busy') === 'true');
  while (!releaseSlow) await new Promise(resolve => setTimeout(resolve, 10));
  releaseSlow();
  await menu.waitFor({ state: 'hidden' });
  assert.equal(await editor.inputValue(), 'Existing text, first trigger');

  await select(['Style/multiple.safetensors']);
  await page.setViewportSize({ width: 390, height: 844 });
  // Open the same responsive sidebar via its actual control.
  const controls = page.locator('#promptstudio-mobile-toggle-inspector');
  if (!(await button.isVisible()) && await controls.count()) await controls.click();
  await button.click();
  await menu.getByRole('button', { name: 'first trigger', exact: true }).waitFor();
  const bounds = await menu.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.equal(await menu.evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await menu.screenshot({ path: 'test-results/trigger-words-mobile.png' });
  await page.locator('#promptstudio-secondary-details').screenshot({ path: 'test-results/trigger-words-field.png' });
  await page.keyboard.press('Escape');

  // Controls are created before the standalone host adopts them into its document.
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.id = 'trigger-popout';
    Object.assign(frame.style, { position: 'fixed', inset: '0', width: '380px', height: '700px', zIndex: 100000 });
    document.body.append(frame);
    const doc = frame.contentDocument;
    const root = doc.createElement('div'); root.id = 'promptstudio-prompt-studio';
    doc.body.append(root);
    root.append(doc.adoptNode(document.querySelector('#promptstudio-secondary-details')));
    const css = doc.createElement('link'); css.rel = 'stylesheet'; css.href = '/extensions/ComfyUI_PromptStudio/css/prompt_studio.css';
    doc.head.append(css);
    window.selectTriggers(['Style/single.safetensors']);
  });
  const popout = page.frameLocator('#trigger-popout');
  await popout.getByRole('button', { name: 'Add trigger words', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#trigger-popout').contentDocument.querySelector('textarea').value.endsWith(', solo'));
  assert.deepEqual(fixture.errors, []);
  console.log('Trigger words: direct insert, grouped repeated selection, persistence, dismissal, empty metadata, context race and mobile passed.');
} finally { releaseSlow?.(); await fixture.close(); }
