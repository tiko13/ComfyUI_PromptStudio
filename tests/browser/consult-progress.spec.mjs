import assert from "node:assert/strict";
import {startFixture} from "./fixture.mjs";

const fixture = await startFixture();
try {
  await fixture.context.route("**/js/prompt_studio.js", async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: await response.text() + "\nexport {renderConsultHistory,setConsultJobProgress};"});
  });
  const page = await fixture.newPage();
  await page.locator("#promptstudio-toggle-consult").click();
  for (const width of [1280, 390]) {
    await page.setViewportSize({width, height: 900});
    await page.evaluate(async () => {
      const m = await import("/extensions/ComfyUI_PromptStudio/js/prompt_studio.js");
      const {state} = await import("/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js");
      const chat = state.chats.find(c => c.id === state.activeChatId);
      chat.consultPendingJob = {job_id: "layout-test", progress: "Processing..."};
      m.renderConsultHistory();
      window.consultTest = {m, state, chat};
    });
    for (const count of [235, 12345]) {
      await page.evaluate(count => {
        const {m, chat} = window.consultTest;
        m.setConsultJobProgress(chat.id, count === 235 ? "Processing..." : "Waiting for the local model to finish processing the request...", count);
      }, count);
      const bubble = page.locator(".promptstudio-consult-message-pending");
      const tokens = bubble.locator("[data-consult-token-count]");
      assert.equal(await tokens.textContent(), await page.evaluate(count => `${count.toLocaleString()} tokens`, count));
      const boxes = await Promise.all([bubble, bubble.locator("[data-consult-pending]"), bubble.locator("button"), tokens].map(locator => locator.boundingBox()));
      const [outer, ...children] = boxes;
      for (const child of children) {
        assert.ok(child.x >= outer.x && child.y >= outer.y);
        assert.ok(child.x + child.width <= outer.x + outer.width + 1);
        assert.ok(child.y + child.height <= outer.y + outer.height + 1);
      }
      for (let i = 0; i < children.length; i++) for (let j = i + 1; j < children.length; j++) {
        const a = children[i], b = children[j];
        assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, "Progress text, Cancel and tokens must not overlap");
      }
    }
    const cancel = page.locator(".promptstudio-consult-message-pending button");
    if (width === 1280) {
      await cancel.focus();
      await page.keyboard.press("Enter");
    } else await cancel.click();
    await page.waitForFunction(() => !document.querySelector(".promptstudio-consult-message-pending"));
  }
  assert.deepEqual(fixture.errors, []);
  console.log("PASS consultation progress layout, live token updates and keyboard/mouse cancellation at desktop/mobile widths");
} finally { await fixture.close(); }
