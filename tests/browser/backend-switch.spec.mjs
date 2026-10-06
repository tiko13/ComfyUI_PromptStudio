import assert from "node:assert/strict";
import {startFixture, videoEnabled} from "./fixture.mjs";

const fixture = await startFixture();
try {
  if (videoEnabled) await fixture.context.route("**/js/promptstudio_video_studio.js", async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: await response.text() + "\nexport {directorSettings};"});
  });
  await fixture.context.addInitScript(() => {
    localStorage.setItem("promptstudio.promptStudio.settings.v1", JSON.stringify({
      llm_provider: "llamacpp", llamacpp_url: "http://localhost:8080", keep_models_loaded: true,
    }));
    localStorage.setItem("promptstudio.promptStudio.advancedLlmAcknowledged.v1", "acknowledged");
  });
  let pending, fail = false, missingRouteStatus = 0;
  const requests = [];
  await fixture.context.route("**/prompt-studio/llm/switch", async route => {
    requests.push(route.request().postDataJSON());
    await new Promise(resolve => { pending = resolve; });
    if (missingRouteStatus) {
      await route.fulfill({status: missingRouteStatus, contentType: "text/plain", body: "Method Not Allowed"});
      return;
    }
    await route.fulfill({status: fail ? 500 : 200, json: fail ? {error: "Unload failed"} : {stopped: true}});
  });
  const page = await fixture.newPage();
  async function snapshot() {
    return page.evaluate(async video => {
      const select = document.querySelector("#promptstudio-llm-provider");
      return {selected: select.value, disabled: select.disabled,
        saved: JSON.parse(localStorage.getItem("promptstudio.promptStudio.settings.v1")).llm_provider,
        video: video ? (await import("/extensions/PromptStudio_Video/js/promptstudio_video_studio.js")).directorSettings().llm_provider : null};
    }, videoEnabled);
  }
  async function choose(provider) {
    pending = null;
    await page.evaluate(provider => {
      const select = document.querySelector("#promptstudio-llm-provider");
      select.value = provider;
      select.dispatchEvent(new Event("change", {bubbles: true}));
    }, provider);
    await page.waitForFunction(() => document.querySelector("#promptstudio-llm-provider").disabled);
    for (let attempt = 0; !pending && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(pending);
  }
  await choose("ollama");
  assert.deepEqual(await snapshot(), {selected: "llamacpp", disabled: true, saved: "llamacpp", video: videoEnabled ? "llamacpp" : null});
  assert.equal(requests[0].previous.llm_provider, "llamacpp");
  assert.equal(requests[0].previous.keep_models_loaded, true);
  pending();
  await page.waitForFunction(() => document.querySelector("#promptstudio-llm-provider").value === "ollama");
  assert.deepEqual(await snapshot(), {selected: "ollama", disabled: false, saved: "ollama", video: videoEnabled ? "ollama" : null});
  fail = true;
  await choose("koboldcpp");
  pending();
  await page.waitForFunction(() => !document.querySelector("#promptstudio-llm-provider").disabled);
  assert.deepEqual(await snapshot(), {selected: "ollama", disabled: false, saved: "ollama", video: videoEnabled ? "ollama" : null});
  assert.ok(await page.getByText("Could not switch backend: Unload failed", {exact: true}).count());
  fail = false;
  await choose("llamacpp");
  assert.equal(requests.at(-1).previous.llm_provider, "ollama");
  pending();
  await page.waitForFunction(() => document.querySelector("#promptstudio-llm-provider").value === "llamacpp");
  assert.equal((await snapshot()).saved, "llamacpp");
  for (const status of [404, 405]) {
    missingRouteStatus = status;
    await choose("ollama");
    pending();
    await page.waitForFunction(() => !document.querySelector("#promptstudio-llm-provider").disabled);
    assert.deepEqual(await snapshot(), {selected: "llamacpp", disabled: false, saved: "llamacpp", video: videoEnabled ? "llamacpp" : null});
    assert.ok(await page.getByText("Could not switch backend: ComfyUI has not loaded backend switching yet. Use Restart ComfyUI in the status monitor, then try again.", {exact: true}).count());
  }
  missingRouteStatus = 0;
  const count = requests.length;
  page.once("dialog", dialog => dialog.dismiss());
  await page.evaluate(() => {
    localStorage.removeItem("promptstudio.promptStudio.advancedLlmAcknowledged.v1");
    const select = document.querySelector("#promptstudio-llm-provider");
    select.value = "koboldcpp";
    select.dispatchEvent(new Event("change", {bubbles: true}));
  });
  assert.equal((await snapshot()).selected, "llamacpp");
  assert.equal((await snapshot()).saved, "llamacpp");
  assert.equal(requests.length, count);
  assert.deepEqual(fixture.errors, []);
  console.log("Backend switching: cleanup ordering, error recovery, Ollama and shared Video settings passed.");
} finally {
  await fixture.close();
}
