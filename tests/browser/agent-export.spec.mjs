import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';

const fixture = await startFixture();
const prompt = 'A red ceramic teapot on a wooden table.';
try {
  await fixture.context.route('**/extensions/ComfyUI_PromptStudio/js/prompt_studio.js', async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: await response.text()
      + '\nwindow.agentExportActions={promotePromptAgentIteration,exportPromptAgentIterationToNewSession};'});
  });
  const page = await fixture.newPage();
  const sourceId = await page.evaluate(async prompt => {
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    const {normalizeConsultAgent} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/consult/model.js');
    const chat = state.chats.find(item => item.id === state.activeChatId);
    chat.consultAgent = normalizeConsultAgent({
      id: 'export-agent', goal: 'Generate images and improve the teapot until it scores 90.',
      feedback: [{text: 'Try another approach and compare the results.'}],
      iterations: [{id: 'selected', index: 1, status: 'complete', candidate: {prompt},
        generation: {mainPrompt: 'Legacy agent instructions', finalPrompt: prompt,
          executionPrompt: prompt, generationState: 'complete',
          images: [{filename: 'candidate.png', type: 'output', subfolder: ''}]}},
        {id: 'later', index: 2, status: 'complete', candidate: {prompt: 'A different candidate.'}}],
    });
    return chat.id;
  }, prompt);

  const assertExport = async () => {
    assert.equal(await page.locator('#promptstudio-main-prompt').inputValue(), prompt);
    const chat = await page.evaluate(async () => {
      const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
      return structuredClone(state.chats.find(item => item.id === state.activeChatId));
    });
    assert.equal(chat.mainPrompt, prompt);
    assert.equal(chat.finalPrompt, prompt);
    assert.equal(chat.renderedMainPrompt, prompt);
    assert.equal(chat.mainPromptDirty, false);
    assert.equal(chat.versions[chat.versionIndex].mainPrompt, prompt);
    assert.equal(chat.versions[chat.versionIndex].finalPrompt, prompt);
    const message = chat.messages.find(item => item.label === 'Exported Prompt Agent iteration 1');
    assert.equal(message.mainPrompt, prompt);
    assert.equal(message.canonicalPrompt, prompt);
    assert.equal(message.executionPrompt, prompt);
    return chat;
  };
  await page.evaluate(() => window.agentExportActions.promotePromptAgentIteration('selected'));
  assert.equal((await assertExport()).id, sourceId);
  await page.evaluate(() => window.agentExportActions.exportPromptAgentIterationToNewSession('selected'));
  const newChat = await assertExport();
  assert.notEqual(newChat.id, sourceId);
  assert.equal(newChat.consultAgent, null);
  await page.evaluate(async () => {
    const {state} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
    for (let attempt = 0; attempt < 100; attempt++) {
      await state.chatSaveChain;
      if (!state.chatSaveTimer && !state.chatSaveInFlight) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Export did not finish saving');
  });
  for (const id of [sourceId, newChat.id]) {
    assert.equal(fixture.chats.chats.find(item => item.id === id).mainPrompt, prompt);
  }
  await page.reload();
  await page.waitForFunction(() => window.studioReady || window.bootError);
  await assertExport();
  assert.deepEqual(fixture.errors, []);
  console.log('Both Prompt Agent exports use the selected prompt in Main, history, image metadata and persisted reload.');
} finally {
  await fixture.close();
}
