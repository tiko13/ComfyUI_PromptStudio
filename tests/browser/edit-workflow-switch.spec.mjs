import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';

const fixture = await startFixture();
try {
  await fixture.context.route('**/js/prompt_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: await response.text() + '\nexport {refreshWorkflowControls,restoreChatState};'});
  });
  const page = await fixture.newPage();
  await page.evaluate(async () => {
    const m = await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const chat = state.chats.find(c => c.id === state.activeChatId);
    Object.assign(chat, {initialized: true, editWorkflowId: 'qwen', editPromptMode: 'edit_instruction',
      selectedSource: {filename: 'base.png', type: 'output', subfolder: ''},
      qwenEditReferences: [{id: 'ref', role: 'clothing', instruction: '',
        image: {filename: 'jacket.png', type: 'input', subfolder: ''}}]});
    const qwen = {id: 'qwen', name: 'Qwen edit', kind: 'edit', promptNodeId: 'p', imageNodeId: 'base',
      resultNodeIds: ['save'], snapshot: {workflow: {nodes: [], links: []}, output: {
        p: {class_type: 'KCPP_PromptSlot', inputs: {prompt: ''}},
        base: {class_type: 'KCPP_ChatImageInput', inputs: {image_ref: ''}},
        encoder: {class_type: 'TextEncodeQwenImage21', inputs: {prompt: ['p', 0], 'images.image_1': ['base', 0]}},
        save: {class_type: 'SaveImage', inputs: {images: ['encoder', 0]}},
      }}};
    const plain = structuredClone(qwen);
    plain.id = 'plain'; plain.name = 'Plain edit';
    delete plain.snapshot.output.encoder;
    plain.snapshot.output.save.inputs.images = ['base', 0];
    const single = structuredClone(plain);
    single.id = 'single'; single.name = 'Single reference edit';
    single.snapshot.output.ref = {class_type: 'KCPP_ChatImageReference', inputs: {image_ref: ''}};
    single.snapshot.output.save.inputs.reference = ['ref', 0];
    state.workflowProfiles = [qwen, plain, single];
    state.apiConnected = true;
    m.restoreChatState(chat); m.refreshWorkflowControls();
  });
  await page.locator('label').filter({has: page.locator('input[name="promptstudio-generation-action"][value="edit"]')}).click();
  const input = page.locator('#promptstudio-revision');
  const modes = page.locator('#promptstudio-edit-prompt-action');
  const tile = page.locator('#promptstudio-edit-reference');
  await input.fill('Keep this unsent edit.');
  const switchWorkflow = async id => {
    await page.locator('#promptstudio-toggle-studio-settings').click();
    await page.locator('#promptstudio-edit-workflow').selectOption(id);
    await page.locator('#promptstudio-close-studio-settings').click();
  };
  for (const width of [1440, 390]) {
    await page.setViewportSize({width, height: 1000});
    await switchWorkflow('plain');
    assert.equal(await modes.isVisible(), true, 'Prompt modes appear immediately after leaving Qwen');
    assert.equal(await tile.isVisible(), false, 'A workflow without references immediately hides the tile');
    assert.doesNotMatch(await input.getAttribute('placeholder'), /reference edit/);
    await modes.getByText('Full prompt', {exact: true}).click();
    await switchWorkflow('qwen');
    assert.equal(await modes.isVisible(), false, 'Qwen immediately hides Full prompt/Edit instruction');
    assert.equal(await tile.isVisible(), true);
    assert.match(await tile.locator('small').textContent(), /References \(1\)/, 'Saved references return immediately');
    assert.match(await input.getAttribute('placeholder'), /Optional.*reference edit/);
    assert.match(await page.locator('#promptstudio-compose-hint').textContent(), /Reference roles/);
    await switchWorkflow('single');
    assert.equal(await modes.isVisible(), true);
    assert.equal(await tile.isVisible(), true);
    assert.equal(await tile.locator('button[aria-label="Upload edit reference image (optional)"]').count(), 1,
      'The Qwen reference dialog changes to the single-image picker immediately');
    assert.equal(await modes.locator('input[value="full_prompt"]').isChecked(), true, 'Switching preserves the chosen prompt mode');
    assert.equal(await input.inputValue(), 'Keep this unsent edit.', 'Switching preserves the draft');
  }
  await page.locator('#promptstudio-toggle-studio-settings').click();
  const selector = page.locator('#promptstudio-edit-workflow');
  await selector.focus();
  await selector.press('Home');
  await selector.press('Enter');
  await page.locator('#promptstudio-close-studio-settings').click();
  assert.equal(await selector.inputValue(), 'qwen');
  assert.equal(await modes.isVisible(), false, 'Keyboard selection also refreshes the composer');
  assert.match(await input.getAttribute('placeholder'), /Optional.*reference edit/);
  await page.locator('#promptstudio-use-llm-amplification').uncheck();
  await input.fill('Keep this direct edit.');
  await switchWorkflow('plain');
  assert.equal(await tile.isVisible(), false);
  assert.match(await input.getAttribute('placeholder'), /Describe the image to generate/);
  await switchWorkflow('qwen');
  assert.equal(await tile.isVisible(), true);
  assert.match(await input.getAttribute('placeholder'), /Optional.*reference edit/);
  assert.equal(await input.inputValue(), 'Keep this direct edit.');
  assert.deepEqual(fixture.errors, []);
  console.log('Edit workflow switching immediately refreshes input guidance, prompt modes and references at desktop/mobile widths.');
} finally { await fixture.close(); }
