import { api } from "/scripts/api.js";

const endpoint = "/promptstudio/prompt-studio/model-profiles";
const controllers = new WeakMap();

export function mountModelProfileSettings(container, onChanged) {
  if (controllers.has(container)) {
    controllers.get(container).refresh();
    return;
  }
  const doc = container.ownerDocument;
  const section = doc.createElement("section");
  section.className = "promptstudio-model-profile-settings promptstudio-studio-settings-card";
  section.setAttribute("aria-label", "Model profiles");
  section.innerHTML = `
    <header class="promptstudio-studio-settings-card-header"><div><strong>Model profiles</strong><span>Image prompt format and model guidance</span></div></header>
    <div class="promptstudio-model-profile-body">
      <p>Personal profiles and overrides save in config/user/model_profiles.json. Bundled defaults stay unchanged.</p>
      <label>Profile<select data-profile-select aria-label="Model profile to edit"></select></label>
      <p data-profile-source></p>
      <div class="promptstudio-model-profile-actions"><button type="button" data-profile-new>New profile</button><button type="button" data-profile-duplicate>Duplicate</button><button type="button" data-profile-reload>Reload profiles</button></div>
      <details data-profile-editor><summary>Edit profile</summary>
        <form data-profile-form>
          <label>Name<input data-profile-field="name" required></label>
          <label>Prompt format<select data-profile-field="style"><option value="natural_language">Natural language</option><option value="comma_tags">Comma-separated tags</option></select></label>
          <label>Default response tokens<input data-profile-field="default_max_response_tokens" type="number" min="1" max="8192" step="1" required></label>
          <label>Instruction<textarea data-profile-field="instruction" rows="4"></textarea></label>
          <label>Examples (one per line)<textarea data-profile-field="example_prompts" rows="4"></textarea></label>
          <label>Notes<textarea data-profile-field="notes" rows="3"></textarea></label>
          <label>Exact final prompt prefix<textarea data-profile-field="final_prompt_prefix" rows="2"></textarea></label>
          <label>Exact final prompt suffix<textarea data-profile-field="final_prompt_suffix" rows="2"></textarea></label>
          <div class="promptstudio-model-profile-actions"><button type="submit">Save profile</button><button type="button" data-profile-delete hidden>Delete profile</button></div>
        </form>
      </details>
      <p data-profile-status role="status" aria-live="polite"></p>
    </div>`;
  container.replaceChildren(section);
  const find = selector => section.querySelector(selector);
  const select = find("[data-profile-select]");
  const status = find("[data-profile-status]");
  const editor = find("[data-profile-editor]");
  const form = find("[data-profile-form]");
  let catalog = null, current = null, dirty = false, busy = false;
  const field = key => find(`[data-profile-field="${key}"]`);
  const confirmDiscard = () => !dirty || doc.defaultView.confirm("Discard unsaved model profile changes?");
  function edit(entry) {
    current = entry;
    for (const input of form.querySelectorAll("[data-profile-field]")) {
      const value = entry.profile[input.dataset.profileField] ?? "";
      input.value = Array.isArray(value) ? value.join("\n") : String(value);
    }
    field("name").readOnly = ["bundled", "override"].includes(entry.source);
    const remove = find("[data-profile-delete]");
    remove.hidden = !["additional", "override"].includes(entry.source);
    remove.textContent = entry.source === "override" ? "Restore bundled default" : "Delete profile";
    find("[data-profile-source]").textContent = {
      bundled: "Bundled default · saving creates a local override. Duplicate to use a new name.",
      override: "Local override · restore to use the bundled default again.",
      additional: "Local profile", new: "New local profile · save to make it available in Generation controls.",
    }[entry.source];
    dirty = false;
  }
  function accept(data, selected = select.value) {
    catalog = data;
    select.replaceChildren(...data.profiles.map(entry => {
      const option = doc.createElement("option");
      option.value = entry.profile.name;
      option.textContent = `${entry.profile.name} · ${entry.source === "bundled" ? "bundled" : entry.source === "override" ? "local override" : "local"}`;
      return option;
    }));
    const entry = data.profiles.find(item => item.profile.name === selected) || data.profiles[0];
    if (entry) { select.value = entry.profile.name; edit(entry); }
    onChanged(data);
  }
  async function request(payload) {
    const response = await api.fetchApi(endpoint, payload ? {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    } : { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Model profiles could not be loaded.");
    if (!Array.isArray(data.profiles) || !data.revision || !data.template) throw new Error("Model profiles are unavailable. Restart ComfyUI after updating, then reload profiles.");
    return data;
  }
  async function run(operation) {
    if (busy) return;
    busy = true;
    section.setAttribute("aria-busy", "true");
    section.querySelectorAll("button, input, textarea, select").forEach(input => { input.disabled = true; });
    try { await operation(); }
    catch (error) { status.textContent = error.message || String(error); }
    finally {
      busy = false;
      section.removeAttribute("aria-busy");
      section.querySelectorAll("button, input, textarea, select").forEach(input => { input.disabled = !catalog && !input.matches("[data-profile-reload]"); });
    }
  }
  const refresh = () => {
    if (!dirty) return run(async () => { accept(await request()); status.textContent = ""; });
  };
  controllers.set(container, { refresh });
  form.addEventListener("input", () => { dirty = true; });
  form.addEventListener("change", () => { dirty = true; });
  select.addEventListener("change", () => {
    if (!confirmDiscard()) { select.value = current.source === "new" ? "" : current.profile.name; return; }
    edit(catalog.profiles.find(entry => entry.profile.name === select.value));
    status.textContent = "";
  });
  function create(duplicate) {
    if (!catalog || !confirmDiscard()) return;
    const profile = structuredClone(duplicate ? current.profile : catalog.template);
    const base = duplicate ? `${profile.name} copy` : "New model profile";
    let name = base, number = 2;
    const names = catalog.profiles.map(entry => entry.profile.name.toLowerCase());
    while (names.includes(name.toLowerCase())) name = `${base} ${number++}`;
    profile.name = name;
    edit({ profile, source: "new" }); select.value = ""; dirty = true;
    editor.open = true; status.textContent = ""; field("name").focus();
  }
  find("[data-profile-new]").addEventListener("click", () => create(false));
  find("[data-profile-duplicate]").addEventListener("click", () => create(true));
  find("[data-profile-reload]").addEventListener("click", () => {
    if (confirmDiscard()) { dirty = false; refresh(); }
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!catalog || !current || !form.reportValidity()) return;
    const profile = structuredClone(current.profile);
    for (const input of form.querySelectorAll("[data-profile-field]")) profile[input.dataset.profileField] = input.value;
    profile.name = profile.name.trim();
    profile.default_max_response_tokens = Number(profile.default_max_response_tokens);
    profile.example_prompts = profile.example_prompts.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    delete profile.example_prompt;
    run(async () => {
      const data = await request({ action: "save", revision: catalog.revision,
        original_name: current.source === "new" ? "" : current.profile.name, profile });
      accept(data, profile.name);
      status.textContent = "Profile saved. Available in Generation controls immediately; refresh the ComfyUI canvas to update node dropdowns.";
    });
  });
  find("[data-profile-delete]").addEventListener("click", () => {
    const restoring = current.source === "override";
    if (!doc.defaultView.confirm(restoring ? "Remove this local override and restore the bundled default?" : "Delete this local profile? Saved chats and workflows may still refer to it.")) return;
    run(async () => {
      accept(await request({ action: "delete", revision: catalog.revision, original_name: current.profile.name }));
      status.textContent = restoring ? "Bundled default restored." : "Local profile deleted.";
    });
  });
  refresh();
}
