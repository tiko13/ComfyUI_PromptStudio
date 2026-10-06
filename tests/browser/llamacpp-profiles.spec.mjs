import assert from "node:assert/strict";
import { startFixture, videoEnabled } from "./fixture.mjs";

const fixture = await startFixture();
try {
  const key = "promptstudio.promptStudio.settings.v1";
  await fixture.context.addInitScript(key => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
      llm_provider: "llamacpp", llamacpp_config_profile: "selected.json", llamacpp_executable: "llama-server",
    }));
    localStorage.setItem("promptstudio.promptStudio.advancedLlmAcknowledged.v1", "acknowledged");
  }, key);
  if (videoEnabled) await fixture.context.route("**/js/promptstudio_video_studio.js", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() + "\nexport {directorSettings};" });
  });
  const longName = "long-profile-".repeat(12) + ".json";
  const present = { path: "/models/" + "long-model-name-".repeat(12) + ".gguf", present: true };
  let profiles = [
    { name: "selected.json", model: present, mmproj: { path: "/models/deleted.gguf", present: false } },
    { name: longName, model: present, mmproj: { path: "", present: null } },
    { name: "broken.json", error: "Invalid JSON" },
  ];
  let startup = { enabled: true, llamacpp_config_profile: "selected.json" };
  let failDelete = false;
  let failInspect = false;
  let deletes = 0;
  await fixture.context.route("**/prompt-studio/llamacpp/autostart", route => route.fulfill({ json: startup }));
  await fixture.context.route("**/prompt-studio/llamacpp/config-profiles", async route => {
    const data = route.request().postDataJSON();
    if (data.action === "inspect") return route.fulfill(failInspect
      ? { status: 500, json: { error: "Folder unavailable" } } : { json: { profiles } });
    if (data.action === "delete") {
      deletes++;
      if (failDelete) return route.fulfill({ status: 500, json: { error: "File locked" } });
      profiles = profiles.filter(item => item.name !== data.llamacpp_config_profile);
      if (startup.llamacpp_config_profile === data.llamacpp_config_profile) startup = { enabled: false };
      return route.fulfill({ json: { deleted: data.llamacpp_config_profile, autostart: startup } });
    }
    await route.fulfill({ json: { profiles: profiles.map(item => item.name),
      selected_profile: data.llamacpp_config_profile || profiles[0]?.name, llm_profile: {} } });
  });
  const page = await fixture.newPage();
  const manage = page.locator("#promptstudio-manage-llamacpp-configs");
  const dialog = page.getByRole("dialog", { name: "Manage Llama.cpp profiles" });
  const row = name => dialog.getByRole("region", { name, exact: true });
  async function open() {
    await page.locator("#promptstudio-toggle-studio-settings").click();
    await page.locator("#promptstudio-open-backend-settings").click();
    await page.waitForFunction(() => !document.querySelector("#promptstudio-llamacpp-autostart").disabled
      && !document.querySelector("#promptstudio-llamacpp-config-profile").disabled);
    await manage.click();
    await dialog.getByRole("button", { name: "Done", exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector(".promptstudio-profile-manager button").disabled);
  }
  await open();
  assert.match(await row("selected.json").innerText(), /✓ Model: Present/);
  assert.match(await row("selected.json").innerText(), /✕ MMProj: Missing/);
  assert.match(await row(longName).innerText(), /MMProj: Not configured/);
  assert.match(await row("broken.json").innerText(), /Unavailable/);
  if (process.env.PROFILE_MANAGER_SCREENSHOT) await page.screenshot({ path: process.env.PROFILE_MANAGER_SCREENSHOT });
  await row("selected.json").getByRole("button", { name: "Delete selected.json", exact: true }).click();
  await row("selected.json").getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(deletes, 0);
  failDelete = true;
  await row("selected.json").getByRole("button", { name: "Delete selected.json", exact: true }).click();
  await row("selected.json").getByRole("button", { name: "Delete profile", exact: true }).click();
  await dialog.getByRole("status").filter({ hasText: "File locked" }).waitFor();
  assert.equal(await row("selected.json").count(), 1);
  failDelete = false;
  await row("selected.json").getByRole("button", { name: "Delete profile", exact: true }).click();
  await dialog.getByRole("status").filter({ hasText: "Deleted selected.json" }).waitFor();
  assert.equal(await row("selected.json").count(), 0);
  const settings = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
  assert.equal(settings.llamacpp_config_profile, longName);
  assert.equal(settings.llamacpp_autostart, false);
  if (videoEnabled) {
    const video = await page.evaluate(async () => (await import("/extensions/PromptStudio_Video/js/promptstudio_video_studio.js")).directorSettings());
    assert.equal(video.llamacpp_config_profile, longName);
    assert.equal(video.llamacpp_autostart, false);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
  const box = await dialog.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390);
  await dialog.getByRole("button", { name: "Refresh", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await dialog.evaluate(node => node.contains(node.ownerDocument.activeElement)), true);
  failInspect = true;
  await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
  await dialog.getByRole("status").filter({ hasText: "Folder unavailable" }).waitFor();
  assert.equal(await row(longName).count(), 1);
  failInspect = false;
  profiles[0].model.present = false;
  await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
  await row(longName).getByText("✕ Model: Missing", { exact: false }).waitFor();
  for (const name of [longName, "broken.json"]) {
    await row(name).getByRole("button", { name: `Delete ${name}`, exact: true }).click();
    await row(name).getByRole("button", { name: "Delete profile", exact: true }).click();
    await dialog.getByRole("status").filter({ hasText: `Deleted ${name}` }).waitFor();
  }
  assert.match(await dialog.innerText(), /No JSON profiles found/);
  assert.equal(await page.locator("#promptstudio-llamacpp-config-profile").inputValue(), "");
  await page.keyboard.press("Escape");
  assert.equal(await dialog.count(), 0);
  assert.equal(await manage.evaluate(node => node === node.ownerDocument.activeElement), true);
  await page.reload();
  await page.waitForFunction(() => window.studioReady);
  assert.equal((await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key)).llamacpp_config_profile, "");
  assert.deepEqual(fixture.errors, []);
  console.log(`Profile manager deletion, status, persistence, keyboard and narrow layout passed (Video=${videoEnabled}).`);
} finally {
  await fixture.close();
}
