import assert from "node:assert/strict";
import {startFixture, videoEnabled} from "./fixture.mjs";

const fixture = await startFixture();
try {
  const key = "promptstudio.promptStudio.settings.v1";
  await fixture.context.addInitScript(key => {
    localStorage.setItem(key, JSON.stringify({llm_provider: "llamacpp", keep_models_loaded: true,
      llamacpp_executable: "llama-server", llamacpp_config_profile: "test.json"}));
    localStorage.setItem("promptstudio.promptStudio.advancedLlmAcknowledged.v1", "acknowledged");
  }, key);
  let stored = {enabled: true, llamacpp_executable: "llama-server", llamacpp_config_profile: "test.json"};
  const saves = [];
  let holdNext = false;
  let release;
  let fail = false;
  await fixture.context.route("**/prompt-studio/llamacpp/autostart", async route => {
    if (route.request().method() === "POST") {
      const data = route.request().postDataJSON();
      saves.push(data);
      if (holdNext) {
        holdNext = false;
        await new Promise(resolve => {release = resolve;});
      }
      if (fail) return route.fulfill({status: 500, json: {error: "Save unavailable"}});
      stored = data;
    }
    await route.fulfill({json: stored});
  });
  await fixture.context.route("**/prompt-studio/llm/switch", route => route.fulfill({json: {stopped: true}}));
  const page = await fixture.newPage();
  const settled = () => page.waitForFunction(() => !document.querySelector("#promptstudio-llamacpp-autostart").disabled);
  async function change(id, value) {
    await page.evaluate(({id, value}) => {
      const input = document.getElementById(id);
      if (input.type === "checkbox") input.checked = value;
      else input.value = value;
      input.dispatchEvent(new Event("change", {bubbles: true}));
    }, {id: `promptstudio-${id}`, value});
  }
  // Existing installations migrate the browser preference without toggling it.
  await settled();
  assert.equal(stored.keep_models_loaded, true);
  holdNext = true;
  await change("keep-models-loaded", false);
  await page.waitForFunction(() => document.querySelector("#promptstudio-llamacpp-autostart").disabled);
  await change("keep-models-loaded", true);
  assert.equal(typeof release, "function");
  release();
  await settled();
  assert.equal(stored.keep_models_loaded, true, "latest toggle must survive an in-flight save");
  assert.deepEqual(saves.slice(-2).map(item => item.keep_models_loaded), [false, true]);
  await change("llm-provider", "ollama");
  await page.waitForFunction(() => document.querySelector("#promptstudio-llm-provider").value === "ollama"
    && !document.querySelector("#promptstudio-llm-provider").disabled);
  await change("keep-models-loaded", false);
  const count = saves.length;
  await change("llamacpp-config-profile", "test.json");
  await settled();
  assert.equal(saves.length, count + 1);
  assert.equal(stored.keep_models_loaded, true, "Ollama's memory setting must not change Llama startup");
  fail = true;
  await change("llamacpp-config-profile", "test.json");
  await settled();
  assert.equal(saves.length, count + 2, "failed saves must not retry indefinitely");
  assert.deepEqual(fixture.errors, []);
  console.log(`Llama startup preference migration, toggles, provider isolation and failure passed (Video=${videoEnabled}).`);
} finally {
  await fixture.close();
}
