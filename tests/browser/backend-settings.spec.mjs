import assert from "node:assert/strict";
import {startFixture, videoEnabled} from "./fixture.mjs";

const fixture = await startFixture();
const key = "promptstudio.promptStudio.settings.v1";
const connection = {
  kobold_url: "http://localhost:5009",
  ollama_url: "http://localhost:11439", ollama_model: "saved-ollama",
  llamacpp_url: "http://localhost:8089", llamacpp_model: "saved-llama",
  llamacpp_executable: "llama-server", llamacpp_config_profile: "saved.json",
  llamacpp_autostart: true,
};
try {
  if (videoEnabled) await fixture.context.route("**/js/promptstudio_video_studio.js", async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: await response.text() + "\nexport {directorSettings};"});
  });
  await fixture.context.addInitScript(({key, connection}) => {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, JSON.stringify({
      ...connection, keep_models_loaded: true, llm_provider: "llamacpp", llm_profile: "ollama-profile", thinking_mode: "Instruct Spoon",
      llamacpp_generation_settings: {thinking_mode: "Instruct Spoon", thinking_modes: ["Spoon"], instruct_modes: ["Spoon"], temperature: 0.37},
    }));
    localStorage.setItem("promptstudio.promptStudio.advancedLlmAcknowledged.v1", "acknowledged");
    localStorage.setItem("promptstudio.promptStudio.llmProfiles.v1", JSON.stringify({version: 1, profiles: [
      {id: "ollama-profile", name: "Ollama settings", thinking_mode: "Low", thinking_modes: ["Low", "High"], temperature: 0.41},
      {id: "kobold-profile", name: "Kobold settings", thinking_mode: "High", thinking_modes: ["Low", "High"], temperature: 0.83},
    ]}));
  }, {key, connection});
  let discovery = "normal";
  let heldOllama;
  await fixture.context.route("**/prompt-studio/llamacpp/autostart", route => route.fulfill({json: {enabled: true}}));
  await fixture.context.route("**/prompt-studio/llm/switch", route => route.fulfill({json: {stopped: true}}));
  for (const provider of ["ollama", "llamacpp"]) {
    await fixture.context.route(`**/prompt-studio/${provider}-models`, async route => {
      if (provider === "ollama" && heldOllama) {
        const hold = heldOllama;
        heldOllama = null;
        await new Promise(resolve => { hold.release = resolve; });
        await route.fulfill({json: {models: ["stale-model"]}});
        return;
      }
      await route.fulfill(discovery === "fail" ? {status: 503, json: {error: "Offline"}}
        : {json: discovery === "malformed" ? {} : {models: discovery === "missing" ? [] : ["other-model", provider === "ollama" ? "saved-ollama" : "saved-llama"]}});
    });
  }
  await fixture.context.route("**/prompt-studio/llamacpp/config-profiles", route => route.fulfill(
    discovery === "fail" ? {status: 503, json: {error: "Config folder offline"}}
      : {json: discovery === "malformed" ? {} : {
        profiles: discovery === "missing" ? ["other.json"] : ["other.json", "saved.json"],
        selected_profile: discovery === "missing" ? "other.json" : "saved.json",
        llm_profile: {thinking_mode: "Spoon", thinking_modes: ["Spoon"], instruct_modes: ["Spoon"], temperature: 0.37},
      }},
  ));
  const page = await fixture.newPage();
  const saved = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
  async function change(id, value) {
    await page.evaluate(({id, value}) => {
      const control = document.getElementById(id);
      if (control.type === "checkbox") control.checked = value;
      else control.value = value;
      control.dispatchEvent(new Event("change", {bubbles: true}));
    }, {id, value});
  }
  async function settled() {
    await page.waitForFunction(() => ["llm-provider", "llamacpp-config-profile", "refresh-ollama-models", "refresh-llamacpp-models"]
      .every(id => !document.getElementById(`promptstudio-${id}`).disabled));
  }
  async function choose(provider) {
    await change("promptstudio-llm-provider", provider);
    await page.waitForFunction(provider => document.getElementById("promptstudio-llm-provider").value === provider, provider);
    await settled();
  }
  async function verifyConnection() {
    const settings = await saved();
    for (const [name, value] of Object.entries(connection)) assert.equal(settings[name], value, name);
    const controls = await page.evaluate(names => Object.fromEntries(names.map(name => {
      const control = document.getElementById(`promptstudio-${name.replaceAll("_", "-")}`);
      return [name, control.type === "checkbox" ? control.checked : control.value];
    })), Object.keys(connection));
    assert.deepEqual(controls, connection);
    assert.equal(settings.llamacpp_generation_settings.thinking_mode, "Instruct Spoon");
    if (videoEnabled) {
      const video = await page.evaluate(async () => (await import("/extensions/PromptStudio_Video/js/promptstudio_video_studio.js")).directorSettings());
      for (const [name, value] of Object.entries(connection)) assert.equal(video[name], value, `Video ${name}`);
      assert.equal(video.llm_provider, settings.llm_provider);
      assert.equal(video.thinking_mode, settings.thinking_mode);
      assert.equal(video.keep_models_loaded, settings.keep_models_loaded);
    }
  }
  await settled();
  await change("promptstudio-thinking", "Instruct Spoon");
  await verifyConnection();
  await choose("ollama");
  await change("promptstudio-llm-profile", "ollama-profile");
  await change("promptstudio-thinking", "High");
  await change("promptstudio-keep-models-loaded", false);
  await choose("koboldcpp");
  await change("promptstudio-llm-profile", "kobold-profile");
  await change("promptstudio-thinking", "Low");
  await change("promptstudio-keep-models-loaded", true);
  for (discovery of ["normal", "missing", "fail", "malformed"]) {
    for (const [provider, profile, mode] of [
      ["llamacpp", null, "Instruct Spoon"], ["ollama", "ollama-profile", "High"], ["koboldcpp", "kobold-profile", "Low"],
    ]) {
      await choose(provider);
      await verifyConnection();
      assert.equal((await saved()).thinking_mode, mode, `${discovery}: ${provider} thinking`);
      assert.equal((await saved()).keep_models_loaded, provider !== "ollama");
      if (profile) assert.equal((await saved()).llm_profile, profile);
      await page.reload();
      await page.waitForFunction(() => window.studioReady);
      await settled();
      await verifyConnection();
      assert.equal((await saved()).llm_provider, provider);
      assert.equal((await saved()).thinking_mode, mode, `${discovery}: ${provider} thinking after reload`);
      assert.equal((await saved()).keep_models_loaded, provider !== "ollama");
    }
  }
  // An old endpoint response cannot overwrite a newer endpoint's selected model.
  discovery = "normal";
  await choose("ollama");
  const hold = {};
  heldOllama = hold;
  await change("promptstudio-ollama-url", "http://localhost:11440");
  for (let i = 0; !hold.release && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(hold.release);
  await change("promptstudio-ollama-url", connection.ollama_url);
  await settled();
  const oldResponse = page.waitForResponse(response => response.url().endsWith("/ollama-models") && response.request().postDataJSON().ollama_url.endsWith(":11440"));
  hold.release();
  await oldResponse;
  await verifyConnection();
  // A model picked during discovery wins over the choice captured at request time.
  const selectionHold = {};
  heldOllama = selectionHold;
  await change("promptstudio-ollama-url", connection.ollama_url);
  for (let i = 0; !selectionHold.release && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(selectionHold.release);
  await change("promptstudio-ollama-model", "other-model");
  selectionHold.release();
  await settled();
  assert.equal((await saved()).ollama_model, "other-model");
  assert.deepEqual(fixture.errors, []);
  console.log("Backend settings: provider profiles/modes, connection persistence, reload, failed/empty discovery, stale responses and Video sharing passed.");
} finally {
  await fixture.close();
}
