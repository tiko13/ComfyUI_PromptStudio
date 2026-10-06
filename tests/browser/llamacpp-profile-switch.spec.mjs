import assert from "node:assert/strict";
import { startFixture, videoEnabled } from "./fixture.mjs";

const fixture = await startFixture();
try {
  const key = "promptstudio.promptStudio.settings.v1";
  await fixture.context.addInitScript(key => {
    localStorage.setItem(key, JSON.stringify({ llm_provider: "llamacpp", llamacpp_model: "old.gguf",
      llamacpp_config_profile: "old.json", llamacpp_executable: "llama-server" }));
    localStorage.setItem("promptstudio.promptStudio.advancedLlmAcknowledged.v1", "acknowledged");
  }, key);
  await fixture.context.route("**/js/prompt_studio.js", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() +
      "\nwindow.switchTest={refreshLlmStatus,controlLlamacppServer,loadLlamacppModels,collectRevisionPayload,llmConnectionPayload,state,readSharedHealth};" });
  });
  if (videoEnabled) await fixture.context.route("**/js/promptstudio_video_studio.js", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() + "\nwindow.videoSwitchSettings=directorSettings;" });
  });
  let activeProfile = "old.json", model = "old.gguf", busy = true, fail = false, external = false;
  const restarts = [];
  let holdStatus = false, releaseStatus;
  let holdModels = false, releaseModels;
  await fixture.context.route("**/prompt-studio/llamacpp/config-profiles", route => route.fulfill({ json: {
    profiles: ["old.json", "middle.json", "new.json"], selected_profile: route.request().postDataJSON().llamacpp_config_profile,
    llm_profile: {},
  } }));
  await fixture.context.route("**/prompt-studio/llamacpp-models", async route => {
    const models = [model];
    if (holdModels) { holdModels = false; await new Promise(resolve => { releaseModels = resolve; }); }
    await route.fulfill({ json: { models } });
  });
  await fixture.context.route("**/prompt-studio/llm/status", async route => {
    const data = { provider: "llamacpp", reachable: true, busy, model, model_installed: true, vision: true,
      server_process: { managed: !external, running: true, config_profile: activeProfile, model, config_changed: false } };
    if (holdStatus) { holdStatus = false; await new Promise(resolve => { releaseStatus = resolve; }); }
    await route.fulfill({ json: data });
  });
  await fixture.context.route("**/prompt-studio/llamacpp/server/restart", route => {
    const data = route.request().postDataJSON();
    restarts.push(data);
    if (fail) return route.fulfill({ status: 500, json: { error: "Invalid profile" } });
    activeProfile = data.llamacpp_config_profile;
    model = activeProfile.replace(".json", ".gguf");
    return route.fulfill({ json: { model, config_profile: activeProfile, managed: true, running: true } });
  });
  const page = await fixture.newPage();
  const poll = () => page.evaluate(async () => { const t = window.switchTest; t.readSharedHealth.invalidate(); await t.refreshLlmStatus(); });
  const change = name => page.evaluate(name => {
    const select = document.querySelector("#promptstudio-llamacpp-config-profile");
    select.value = name; select.dispatchEvent(new Event("change", { bubbles: true }));
  }, name);
  const settled = () => page.waitForFunction(() => !window.switchTest.state.llamacppProcessBusy
    && !document.querySelector("#promptstudio-llamacpp-config-profile").disabled);
  const assertRequestModel = async expected => {
    const models = await page.evaluate(() => ({
      connection: window.switchTest.llmConnectionPayload().llamacpp_model,
      revision: window.switchTest.collectRevisionPayload("Test", "render", "", "").llamacpp_model,
      saved: JSON.parse(localStorage.getItem("promptstudio.promptStudio.settings.v1")).llamacpp_model,
    }));
    assert.deepEqual(models, { connection: expected, revision: expected, saved: expected });
    if (videoEnabled) assert.equal(await page.evaluate(() => window.videoSwitchSettings().llamacpp_model), expected);
  };
  await settled();
  await change("middle.json"); await settled(); await poll();
  await change("new.json"); await settled(); await poll();
  assert.equal(restarts.length, 0, "busy server must not restart");
  assert.equal(await page.evaluate(() => window.switchTest.state.llamacppPendingProfile), "new.json");
  busy = false;
  await poll(); await settled();
  assert.equal(restarts.length, 1);
  assert.equal(restarts[0].llamacpp_config_profile, "new.json");
  assert.equal(restarts[0].when_idle, true);
  assert.equal(await page.locator("#promptstudio-llamacpp-model").inputValue(), "new.gguf");
  await assertRequestModel("new.gguf");

  // A successful restart must supersede in-flight model discovery and status.
  holdStatus = true; holdModels = true;
  await page.evaluate(() => {
    window.switchTest.readSharedHealth.invalidate();
    window.staleStatus = window.switchTest.refreshLlmStatus();
    window.staleModels = window.switchTest.loadLlamacppModels();
  });
  for (let i = 0; (!releaseStatus || !releaseModels) && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(releaseStatus && releaseModels);
  await page.evaluate(async () => {
    document.querySelector("#promptstudio-llamacpp-config-profile").value = "middle.json";
    await window.switchTest.controlLlamacppServer("restart");
  });
  releaseStatus(); releaseModels();
  await page.evaluate(() => Promise.all([window.staleStatus, window.staleModels]));
  assert.equal(await page.locator("#promptstudio-llamacpp-model").inputValue(), "middle.gguf");
  await assertRequestModel("middle.gguf");

  // Recover persisted stale selections on an already-restarted managed server.
  await page.evaluate(() => {
    const select = document.querySelector("#promptstudio-llamacpp-model");
    select.replaceChildren(new Option("old.gguf", "old.gguf"));
  });
  await poll();
  assert.equal(await page.locator("#promptstudio-llamacpp-model").inputValue(), "middle.gguf");
  assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).llamacpp_model, key), "middle.gguf");
  await assertRequestModel("middle.gguf");

  fail = true;
  await change("new.json"); await settled(); await poll(); await settled();
  assert.equal(await page.locator("#promptstudio-llamacpp-model").inputValue(), "middle.gguf");
  const count = restarts.length;
  await poll(); await settled();
  assert.equal(restarts.length, count, "failed auto-restart must not retry forever");
  fail = false; external = true;
  await change("old.json"); await settled(); await poll();
  assert.equal(restarts.length, count, "external server must stay untouched");
  assert.deepEqual(fixture.errors, []);
  console.log(`Profile switch idle restart, latest selection, stale response rejection, recovery and Video sharing passed (Video=${videoEnabled}).`);
} finally { await fixture.close(); }
