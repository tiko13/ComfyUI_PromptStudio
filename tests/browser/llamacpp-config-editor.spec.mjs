import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startFixture, videoEnabled } from "./fixture.mjs";

const fixture = await startFixture();
try {
  const template = JSON.parse(await readFile(new URL("../../llamacpp_server.example.json", import.meta.url), "utf8"));
  template.model = "/models/original.gguf";
  template.model_gguf = "/models/ignored-alias.gguf";
  template.custom = { keep: "unknown setting" };
  template.llm_profile.custom_sampler = true;
  template.llm_profile.thinking_modes = ["XHigh", "Medium", "Low"];
  template.llm_profile.instruct_modes = [];
  let documents = { "original.json": structuredClone(template) };
  let revision = 1;
  let failLoad = false;
  let failSave = false;
  let saved = [];
  const key = "promptstudio.promptStudio.settings.v1";
  await fixture.context.addInitScript(key => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ llm_provider: "llamacpp", llamacpp_config_profile: "original.json" }));
  }, key);
  if (videoEnabled) await fixture.context.route("**/js/promptstudio_video_studio.js", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() + "\nexport {directorSettings};" });
  });
  await fixture.context.route("**/llamacpp/config-profiles", route => {
    const name = route.request().postDataJSON().llamacpp_config_profile || "original.json";
    return route.fulfill({ json: { profiles: Object.keys(documents), selected_profile: name, llm_profile: documents[name]?.llm_profile } });
  });
  await fixture.context.route("**/llamacpp/config-builder", route => {
    const data = route.request().postDataJSON();
    if (data.action === "save") {
      if (failSave) return route.fulfill({ status: 409, json: { error: "Profile changed since opening" } });
      documents[data.llamacpp_config_profile] = data.config;
      saved.push(data);
      return route.fulfill({ json: { saved: true, config_profile: data.llamacpp_config_profile, revision: String(++revision), llm_profile: data.config.llm_profile } });
    }
    if (failLoad) return route.fulfill({ status: 400, json: { error: "Unreadable profile" } });
    return route.fulfill({ json: { native_editor: true, can_browse: true,
      config: data.action === "new" ? { llm_profile: template.llm_profile } : documents[data.llamacpp_config_profile],
      revision: data.action === "new" ? null : String(revision) } });
  });
  await fixture.context.route("**/llamacpp/pick-file", route => {
    assert.equal(route.request().postDataJSON().kind, "model");
    return route.fulfill({ json: { path: "/models/browsed.gguf" } });
  });
  const page = await fixture.newPage();
  await page.locator("#promptstudio-toggle-studio-settings").click();
  await page.locator("#promptstudio-open-backend-settings").click();
  await page.waitForFunction(() => !document.querySelector("#promptstudio-llamacpp-config-profile").disabled);
  const editor = page.getByRole("dialog", { name: "Llama.cpp config builder", exact: true });
  const edit = page.locator("#promptstudio-build-llamacpp-config");
  const field = name => editor.locator(`[name="${name}"]`);
  await edit.click();
  await field("model_gguf").waitFor();
  assert.equal(await field("model_gguf").inputValue(), "/models/original.gguf");
  assert.equal(await field("instruct_modes").inputValue(), "");
  assert.equal(await field("thinking_mode").locator('option[value="Disabled"]').count(), 0);
  await field("model_gguf").fill("/models/unsaved.gguf");
  await page.keyboard.press("Escape");
  assert.equal(await editor.count(), 0);
  assert.equal(saved.length, 0);
  assert.equal(await edit.evaluate(node => node === node.ownerDocument.activeElement), true);
  await edit.click();
  await field("model_gguf").waitFor();
  assert.equal(await field("model_gguf").inputValue(), "/models/original.gguf");
  await editor.getByRole("button", { name: "Browse Model GGUF" }).click();
  await page.waitForFunction(() => document.querySelector('[name="model_gguf"]').value === "/models/browsed.gguf");
  await field("instruct_modes").fill("Low, Spoon");
  await field("thinking_mode").selectOption("Instruct Spoon");
  await editor.getByText("Thinking sampler", { exact: true }).click();
  await field("thinking_temperature").fill("1.15");
  await field("port").fill("0");
  await editor.getByText("Model and server", { exact: true }).click();
  await editor.getByRole("button", { name: "Save config", exact: true }).click();
  assert.equal(saved.length, 0);
  assert.equal(await field("port").isVisible(), true);
  await field("port").fill("8080");
  failSave = true;
  await editor.getByRole("button", { name: "Save config", exact: true }).click();
  await editor.getByRole("status").filter({ hasText: "Profile changed" }).waitFor();
  assert.equal(await field("thinking_temperature").inputValue(), "1.15");
  failSave = false;
  await editor.getByRole("button", { name: "Save config", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  assert.equal(saved[0].config.model_gguf, "/models/browsed.gguf");
  assert.equal(Object.hasOwn(saved[0].config, "model"), false);
  assert.deepEqual(saved[0].config.custom, template.custom);
  assert.equal(saved[0].config.llm_profile.custom_sampler, true);
  assert.equal(saved[0].config.llm_profile.thinking_mode, "Instruct Spoon");
  assert.equal(saved[0].config.llm_profile.thinking_temperature, 1.15);
  assert.equal(saved[0].revision, "1");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator("#promptstudio-new-llamacpp-config").click();
    await field("model_gguf").waitFor();
    assert.equal(await field("profile_name").inputValue(), "");
    assert.equal(await field("profile_name").evaluate(node => node === node.ownerDocument.activeElement), true);
    await page.keyboard.press("Shift+Tab");
    assert.equal(await editor.evaluate(node => node.contains(node.ownerDocument.activeElement)), true);
    assert.equal(await editor.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    const box = await editor.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width);
    if (width === 1440 && process.env.CONFIG_EDITOR_SCREENSHOT) await page.screenshot({ path: process.env.CONFIG_EDITOR_SCREENSHOT });
    await field("profile_name").fill("new-model");
    await field("model_gguf").fill("/models/new.gguf");
    if (width === 1440) { await editor.getByRole("button", { name: "Cancel", exact: true }).click(); continue; }
    await editor.getByRole("button", { name: "Save config", exact: true }).click();
    await editor.waitFor({ state: "detached" });
  }
  assert.equal(saved[1].llamacpp_config_profile, "new-model.json");
  assert.equal(saved[1].revision, null);
  assert.equal(await page.locator("#promptstudio-llamacpp-config-profile").inputValue(), "new-model.json");
  if (videoEnabled) {
    const video = await page.evaluate(async () => (await import("/extensions/PromptStudio_Video/js/promptstudio_video_studio.js")).directorSettings());
    assert.equal(video.llamacpp_config_profile, "new-model.json");
  }
  failLoad = true;
  await edit.click();
  await editor.getByRole("status").filter({ hasText: "Unreadable profile" }).waitFor();
  assert.equal(await editor.getByRole("button", { name: "Save config", exact: true }).isDisabled(), true);
  await page.keyboard.press("Escape");
  failLoad = false;
  await page.reload(); await page.waitForFunction(() => window.studioReady);
  assert.equal((await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key)).llamacpp_config_profile, "new-model.json");
  assert.deepEqual(fixture.errors, []);
  console.log(`Native config editor create/edit/cancel/conflict/browse/layout/persistence passed (Video=${videoEnabled}).`);
} finally { await fixture.close(); }
