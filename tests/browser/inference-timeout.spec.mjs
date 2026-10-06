import assert from "node:assert/strict";
import { startFixture } from "./fixture.mjs";

const fixture = await startFixture();
try {
  // Emulate ComfyUI's default fetch deadline on the synchronous inference URLs.
  await fixture.context.route("**/scripts/api.js", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace("fetchApi: (url, options) => fetch(url, options)", `fetchApi: async (url, options = {}) => {
      if (!/\\/(revise|route-turn|discuss|caption-image|qwen-edit-prompt|ground-edit-reference)$/.test(url)) return fetch(url, options);
      const controller = new AbortController();
      const timer = options.timeoutMs === null ? null : setTimeout(() => controller.abort(new Error('Fetch timeout')), 50);
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      try { return await fetch(url, {...options, signal}); }
      finally { clearTimeout(timer); }
    }`);
    await route.fulfill({ response, body });
  });
  await fixture.context.route("**/js/prompt_studio.js", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() +
      "\nwindow.timeoutTest={requestPromptRevision,requestStudioTurnRoute,requestStudioDiscussion,requestImageCaption,activeChat,beginOrContinueStudioDiscussion,api};" });
  });
  let failed = false;
  await fixture.context.route(/\/prompt-studio\/(revise|route-turn|discuss|caption-image|qwen-edit-prompt|ground-edit-reference)$/, async route => {
    await new Promise(resolve => setTimeout(resolve, 150));
    await route.fulfill({ status: failed ? 504 : 200, json: failed ? {error: "Provider inactivity timeout"} : {
      prompt: "Finished", route: "create", message: "Answered", grounding: {
        observations: "A mug", resolved_instruction: "Move the mug", edit_instruction: "Move the mug",
        uncertainty: "", needs_clarification: false,
      },
    } });
  });
  const page = await fixture.newPage();
  assert.equal(await page.evaluate(async () => {
    try { await window.timeoutTest.api.fetchApi('/promptstudio/prompt-studio/revise', {method:'POST'}); }
    catch (error) { return error.message; }
  }), "Fetch timeout", "the fixture must reproduce the host's default timeout");
  const results = await page.evaluate(async () => {
    const t = window.timeoutTest;
    const chat = t.activeChat();
    const image = { filename: "test.png", subfolder: "", type: "input" };
    const discussion = t.beginOrContinueStudioDiscussion(chat);
    const {requestQwenEdit} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/generation/qwen-references.js');
    const {requestReferenceGrounding} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/generation/reference-grounding.js');
    return [await t.requestPromptRevision({}, "Test"),
      (await t.requestStudioTurnRoute(chat, "Create a mug", null)).route,
      (await t.requestStudioDiscussion(chat, discussion)).message,
      await t.requestImageCaption(image),
      await requestQwenEdit(t.api.fetchApi, {}),
      (await requestReferenceGrounding(t.api.fetchApi, {source_image:image,reference_image:image})).observations];
  });
  assert.deepEqual(results, ["Finished", "create", "Answered", "Finished", "Finished", "A mug"]);
  failed = true;
  assert.equal(await page.evaluate(async () => {
    try { await window.timeoutTest.requestPromptRevision({}, "Test"); }
    catch (error) { return error.message; }
  }), "Provider inactivity timeout");
  assert.equal(await page.evaluate(async () => {
    const controller = new AbortController();
    const pending = window.timeoutTest.requestPromptRevision({}, "Test", null, controller.signal);
    setTimeout(() => controller.abort(), 20);
    try { await pending; } catch (error) { return error.name; }
  }), "AbortError");
  assert.deepEqual(fixture.errors, []);
  console.log("Long synchronous inference, backend timeout errors, and cancellation passed.");
} finally { await fixture.close(); }
