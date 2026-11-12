import assert from "node:assert/strict";
import {startFixture} from "./fixture.mjs";
const fixture = await startFixture();
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
try {
  await fixture.context.route("**/js/prompt_studio.js", async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: await response.text() + "\nexport {updateComposeMode,refreshWorkflowControls,restoreChatState,handleStudioTurn,queueBackgroundReroll,queueGeneration,captureGenerationQueueSettings};"});
  });
  await fixture.context.route("**/scripts/api.js", async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: await response.text() + '\napi.queuePrompt=async(_,snapshot)=>{window.queuedSnapshots||=[];window.queuedSnapshots.push(structuredClone(snapshot));return {prompt_id:"semantic-"+window.queuedSnapshots.length};};'});
  });
  let uploads = 0, calls = [], edits = [], clarify = false, fail = false, routeMode = "mutate_now", release = null, delayed = false;
  await fixture.context.route("**/promptstudio/prompt-studio/import-image", route => route.fulfill({json: {image: {filename: `donor-${++uploads}.png`, type: "input", subfolder: "", width: 64, height: 64}}}));
  await fixture.context.route("**/promptstudio/prompt-studio/image?*", route => route.fulfill({contentType: "image/png", body: png}));
  await fixture.context.route("**/view?*", route => route.fulfill({contentType: "image/png", body: png}));
  await fixture.context.route("**/promptstudio/prompt-studio/vision-capability", route => route.fulfill({json: {available: true}}));
  await fixture.context.route("**/promptstudio/references/triage", route => route.fulfill({json: {decision: "deep"}}));
  await fixture.context.route("**/promptstudio/prompt-studio/route-turn", route => route.fulfill({json: {route: routeMode, confidence: 1, help_domain: "none", resolved_instruction: route.request().postDataJSON().user_text}}));
  await fixture.context.route("**/promptstudio/prompt-studio/semantic-reference", async route => {
    calls.push(route.request().postDataJSON());
    if (delayed) await new Promise(resolve => {release = resolve;});
    await route.fulfill(fail ? {status: 500, json: {error: "Model unavailable"}} : {json: clarify
      ? {status: "clarify", role: "", instruction: "", message: "Which woman should wear the dress?"}
      : {status: "assigned", role: "clothing", instruction: "Replace only the left woman's dress with the attached reference dress. Preserve both identities and the scene.", message: ""}});
  });
  await fixture.context.route("**/promptstudio/prompt-studio/qwen-edit-prompt", route => {
    const payload = route.request().postDataJSON(); edits.push(payload);
    return route.fulfill({json: {prompt: payload.references.length
      ? "Replace the woman's dress in <image1> with the dress in <image2>. Preserve everything else."
      : "Brighten the image. Preserve the clothing."}});
  });
  const page = await fixture.newPage();
  await page.evaluate(async () => {
    const m = await import("/extensions/ComfyUI_PromptStudio/js/prompt_studio.js");
    const {state} = await import("/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js");
    window.test = {m, state};
    const chat = state.chats.find(c => c.id === state.activeChatId);
    Object.assign(chat, {initialized: true, mainPrompt: "Two women outdoors.", finalPrompt: "Two women outdoors, daylight.",
      selectedSource: {filename: "source.png", subfolder: "", type: "output", width: 64, height: 64}, qwenEditReferences: []});
    const profile = {id: "qwen", path: "qwen", name: "[PS] Qwen edit", kind: "edit", promptNodeId: "p", imageNodeId: "base", resultNodeIds: ["save"], loraNodes: [], modelNodes: [], snapshot: {workflow: {nodes: [], links: []}, output: {
      p: {class_type: "KCPP_PromptSlot", inputs: {prompt: ""}}, base: {class_type: "KCPP_ChatImageInput", inputs: {image_ref: ""}},
      encoder: {class_type: "TextEncodeQwenImage21", inputs: {prompt: ["p", 0], "images.image_1": ["base", 0]}},
      save: {class_type: "SaveImage", inputs: {images: ["encoder", 0]}},
    }}};
    state.workflowProfiles = [profile]; state.apiConnected = true; state.workflowBusy = true;
    m.refreshWorkflowControls(); m.restoreChatState(chat);
    document.querySelector("#promptstudio-use-llm-amplification").checked = true;
    document.querySelector("#promptstudio-auto-generate").checked = false;
    document.querySelector('input[name="promptstudio-generation-action"][value="edit"]').checked = true;
    document.querySelector("#promptstudio-edit-workflow").value = "qwen"; m.updateComposeMode();
  });
  const chat = () => page.evaluate(() => window.test.state.chats.find(c => c.id === window.test.state.activeChatId));
  async function paste(count = 1) {
    await page.locator("#promptstudio-revision").evaluate((input, {base64, count}) => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const data = new DataTransfer();
      for (let i = 0; i < count; i++) data.items.add(new File([bytes], `dress-${i}.png`, {type: "image/png"}));
      input.dispatchEvent(new ClipboardEvent("paste", {bubbles: true, cancelable: true, clipboardData: data}));
    }, {base64: png.toString("base64"), count});
    if (count === 1) await page.waitForFunction(() => window.test.state.studioPreparations.size === 0 && window.test.state.mainPastedImage);
  }
  async function send(text) {
    await page.locator("#promptstudio-revision").fill(text);
    await page.evaluate(() => window.test.m.handleStudioTurn());
  }
  await paste(2);
  assert.equal(uploads, 0);
  await paste();
  clarify = true;
  await send("Make her wear this dress");
  assert.equal((await chat()).qwenEditReferences.length, 0);
  assert.equal((await chat()).referenceClarification.semanticAttachment.filename, "donor-1.png");
  assert.equal(edits.length, 0);
  clarify = false;
  await send("The woman on the left");
  assert.match(calls.at(-1).user_text, /Make her wear this dress/);
  assert.match(calls.at(-1).user_text, /woman on the left/);
  assert.equal(edits.at(-1).references[0].role, "clothing");
  assert.equal(edits.at(-1).source_image.filename, "source.png");
  assert.equal((await chat()).pendingGeneration.qwenReferences[0].image.filename, "donor-1.png");
  assert.equal((await chat()).qwenEditReferences[0].semanticTurn, true);
  assert.equal(await page.locator("#promptstudio-pasted-image").isVisible(), false);
  const requestCount = calls.length;
  await page.evaluate(() => window.test.m.queueBackgroundReroll("edit"));
  assert.equal(calls.length, requestCount, "Rerolls reuse the resolved reference");
  const snapshot = await page.evaluate(() => window.queuedSnapshots.at(-1));
  assert.equal(JSON.parse(snapshot.output.ps_qwen_reference_2.inputs.image_ref).filename, "donor-1.png");
  assert.deepEqual(snapshot.output.encoder.inputs["images.image_2"], ["ps_qwen_reference_2", 0]);
  await send("Brighten the image");
  assert.equal(edits.at(-1).references.length, 0, "Old chat clothing must not leak into the next edit");
  assert.equal((await chat()).qwenEditReferences.length, 0);
  await paste(); fail = true;
  await send("Use this dress");
  assert.equal((await chat()).qwenEditReferences.length, 0);
  assert.equal(await page.locator("#promptstudio-pasted-image").isVisible(), true);
  fail = false;
  await send("Use this dress");
  assert.equal((await chat()).qwenEditReferences.length, 1, "Retry creates one reference");
  await page.getByRole("button", {name: "References", exact: true}).click();
  const dialog = page.getByRole("dialog", {name: "References", exact: true});
  await dialog.getByRole("button", {name: "Keep for future edits"}).click();
  await dialog.getByRole("button", {name: "Done"}).click();
  assert.equal((await chat()).qwenEditReferences[0].semanticTurn, undefined);
  await send("Brighten the image");
  assert.equal(edits.at(-1).references.length, 1, "Pinned references persist");
  await paste(); delayed = true;
  const pending = send("Use this new dress");
  await page.waitForFunction(() => document.querySelector("#promptstudio-revision").value === "");
  while (!release) await new Promise(resolve => setTimeout(resolve, 10));
  await page.evaluate(() => {window.test.state.chats.find(c => c.id === window.test.state.activeChatId).selectedSource.filename = "changed.png";});
  release(); await pending;
  assert.equal((await chat()).qwenEditReferences.length, 1, "A stale operation cannot commit its reference");
  assert.equal(await page.locator("#promptstudio-pasted-image").isVisible(), true);
  delayed = false;
  await page.evaluate(() => {
    const {m, state} = window.test;
    const chat = state.chats.find(c => c.id === state.activeChatId);
    chat.qwenEditReferences = [];
    const profile = structuredClone(state.workflowProfiles[0]);
    profile.id = "full"; profile.path = "full";
    profile.snapshot.output.collection = {class_type: "PS_ReferenceCollection", inputs: {maximum: 2, minimum: 0, roles: "clothing,style,custom"}};
    profile.snapshot.output.contract = {class_type: "PS_ReferencePrompt", inputs: {prompt: ["p", 0], references: ["collection", 0], prompt_mode: "full_prompt", source_token: "canvas", reference_token: "photo_{index}", first_reference_index: 2}};
    profile.snapshot.output.encoder = {class_type: "CustomConsumer", inputs: {prompt: ["contract", 0], references: ["collection", 0], source: ["base", 0]}};
    state.workflowProfiles.push(profile); m.refreshWorkflowControls();
    document.querySelector("#promptstudio-edit-workflow").value = "full"; m.updateComposeMode();
  });
  await fixture.context.route("**/promptstudio/prompt-studio/revise", route => route.fulfill({json: {prompt: "Two women outdoors. The woman on the left wears the red reference dress."}}));
  await send("Make the woman on the left wear this dress");
  assert.equal((await chat()).qwenEditReferences[0].role, "clothing", "Full-prompt workflows also receive semantic assignments");
  const prepared = (await chat()).pendingGeneration;
  await page.evaluate(pending => window.test.m.queueGeneration({...window.test.m.captureGenerationQueueSettings("edit"), action: "edit",
    executionPrompt: pending.executionPrompt, finalPrompt: pending.canonicalPrompt, independent: true}), prepared);
  const full = await page.evaluate(() => window.queuedSnapshots.at(-1));
  assert.equal(JSON.parse(full.output.collection.inputs.references_json)[0].role, "clothing");
  assert.match(full.output.p.inputs.prompt, /photo_2/);
  await paste();
  clarify = true;
  await send("Make her wear this dress");
  assert.ok((await chat()).referenceClarification?.semanticAttachment);
  await page.getByRole("button", {name: "Remove pasted reference", exact: true}).click();
  assert.equal((await chat()).referenceClarification, null, "Removing an attachment also cancels its pending clarification");
  assert.equal(await page.locator("#promptstudio-pasted-image").isVisible(), false);
  assert.deepEqual(fixture.errors, []);
  console.log("Semantic editing: paste, clarification, reference wiring, reroll, scope, retry, pinning and stale source verified.");
} finally {await fixture.close();}
