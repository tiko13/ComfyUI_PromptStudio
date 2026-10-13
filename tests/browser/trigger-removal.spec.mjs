import assert from 'node:assert/strict';
import { startFixture } from './fixture.mjs';

const fixture = await startFixture();
try {
  await fixture.context.route('**/js/prompt_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() + '\nexport {refreshWorkflowControls};' });
  });
  const words = { 'Style/one.safetensors': ['solo', 'shared'], 'Style/two.safetensors': ['shared', 'other'] };
  await fixture.context.route('**/prompt-studio/loras?*', route => route.fulfill({ json: {
    loras: Object.keys(words).map(name => ({ name, label: name })),
  } }));
  await fixture.context.route('**/prompt-studio/model-metadata**', route => {
    const req = route.request();
    const name = req.method() === 'POST' ? req.postDataJSON().name : new URL(req.url()).searchParams.get('name');
    return route.fulfill({json:{status:'found',trigger_words:words[name] || [],refresh_due:false}});
  });
  const page = await fixture.newPage();
  await page.evaluate(async () => {
    const { state } = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const { refreshWorkflowControls } = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    state.workflowProfiles = [{ id: 'triggers', name: 'Trigger fixture', kind: 'create', promptNodeId: 'p',
      loraNodes: [{ id: 'a', loraType: 'Style' }, { id: 'b', loraType: 'Style' }], modelNodes: [],
      snapshot: { workflow: { nodes: [], links: [] }, output: { p: { class_type: 'KCPP_PromptSlot', inputs: { prompt: '' } } } } }];
    state.workflowBusy = true;
    state.chats.find(chat => chat.id === state.activeChatId).createWorkflowId = 'triggers';
    window.triggerState = state;
    window.selectLoras = (first, second) => {
      state.loraSelections = Object.fromEntries([['a', first], ['b', second]].map(([id, names]) =>
        [`triggers\u0000${id}`, names.map(name => ({ name, strength: 1 }))]));
      refreshWorkflowControls();
      document.querySelector('#promptstudio-lora-details').open = true;
      document.querySelector('#promptstudio-secondary-details').open = true;
    };
    window.selectLoras(['Style/one.safetensors'], ['Style/two.safetensors']);
  });
  const editor = page.getByRole('textbox', { name: 'Unmodified part', exact: true });
  await editor.fill('  solo , , shared, \n other , keep this  , solo, ');
  await page.getByRole('button', { name: 'Remove Style/one.safetensors', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#promptstudio-secondary-instructions').value === 'shared, other, keep this');
  assert.equal(await page.evaluate(() => window.triggerState.chats.find(c => c.id === window.triggerState.activeChatId).studioSettings.secondary_instructions), 'shared, other, keep this');
  await page.getByRole('button', { name: 'Remove Style/two.safetensors', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#promptstudio-secondary-instructions').value === 'keep this');

  // The same file in two loaders still needs its triggers until the last removal.
  await page.evaluate(() => window.selectLoras(['Style/one.safetensors'], ['Style/one.safetensors']));
  await editor.fill('solo, shared');
  await page.getByRole('button', { name: 'Remove Style/one.safetensors', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('.promptstudio-lora-remove').length === 1);
  assert.equal(await editor.inputValue(), 'solo, shared');
  await page.getByRole('button', { name: 'Remove Style/one.safetensors', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#promptstudio-secondary-instructions').value === '');
  assert.equal(await page.evaluate(() => window.triggerState.chats.find(c => c.id === window.triggerState.activeChatId).studioSettings.secondary_instructions), '');
  assert.deepEqual(fixture.errors, []);
  console.log('LoRA removal: cross-loader shared triggers, cleanup, last removal and persistence passed.');
} finally { await fixture.close(); }
