import { api } from "/scripts/api.js";
import { installDialogFocus } from "./dialog-focus.js";

const endpoint = "/promptstudio/prompt-studio/model-metadata";
const pending = new Map();
const recent = new Map();
const revisions = new Map();
const keyFor = file => JSON.stringify([file.category, file.name]);
const sites = ["civitai.com", "civitai.green", "civitai.red"];

function stylesheet(doc) {
  if (doc.querySelector("link[data-model-metadata]")) return;
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("../../../css/model-metadata.css", import.meta.url).href;
  link.dataset.modelMetadata = "true";
  doc.head.append(link);
}

async function request(file, { lookup = false, local = false, refresh = false, site = "auto" } = {}) {
  const key = keyFor(file);
  if (!lookup && !local && recent.get(key)?.until > Date.now()) return recent.get(key).data;
  const requestKey = JSON.stringify([key, lookup, local, refresh, site]);
  if (!pending.has(requestKey)) {
    const work = (async () => {
      const revision = revisions.get(key);
      const response = await api.fetchApi(lookup || local ? endpoint : `${endpoint}?${new URLSearchParams(file)}`, lookup || local ? {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...file, refresh, site, ...(local ? { local_only: true } : {}) }),
      } : undefined);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Model details could not be loaded. A ComfyUI restart may be needed after updating Studio.");
      if (revisions.get(key) === revision) recent.set(key, { data, until: Date.now() + 60000 });
      return data;
    })().finally(() => pending.delete(requestKey));
    pending.set(requestKey, work);
  }
  return pending.get(requestKey);
}

async function saveTriggerWords(file, words) {
  const key = keyFor(file);
  revisions.set(key, (revisions.get(key) || 0) + 1);
  const response = await api.fetchApi(endpoint, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...file, trigger_words: words }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Trigger words could not be saved. Your edits are still here; try again.");
  recent.set(key, { data, until: Date.now() + 60000 });
  return data;
}

function paintButtons(doc, file, data) {
  for (const button of doc.querySelectorAll("button[data-metadata-file]")) {
    if (button.dataset.metadataFile !== keyFor(file)) continue;
    const update = data?.update_status === "available";
    button.dataset.updateAvailable = String(update);
    button.textContent = update ? "↑" : "ⓘ";
    button.title = `${update ? "New version available — " : ""}Details for ${file.name}${data?.stale ? " (cached; check failed)" : ""}`;
    button.setAttribute("aria-label", button.title);
  }
}

export async function loadLoraTriggerWords(name) {
  const file = { category: "loras", name };
  let data = await request(file);
  if (!data.trigger_words_edited && !data.missing_file) {
    try { data = await request(file, { local: true }); }
    catch (error) {
      if (!Array.isArray(data.trigger_words)) throw error;
      return [...data.trigger_words];
    }
  }
  const localTriggers = data.local_metadata?.status === "found" && Array.isArray(data.local_metadata.trigger_words)
    || data.trigger_words_source === "Legacy tag frequency";
  if (!data.trigger_words_edited && !localTriggers && (data.status === "unchecked" || data.refresh_due) && !data.missing_file) {
    data = await request(file, { lookup: true, site: data.site || "auto" });
  }
  return [...new Set((Array.isArray(data.trigger_words) ? data.trigger_words : [])
    .filter(word => typeof word === "string").map(word => word.trim()).filter(Boolean))];
}

export function createModelDetailsButton({ category = "loras", name, document: doc = document }) {
  stylesheet(doc);
  const file = { category, name };
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "promptstudio-model-info";
  button.dataset.metadataFile = keyFor(file);
  button.textContent = "ⓘ";
  button.title = `Details for ${name}`;
  button.setAttribute("aria-label", button.title);
  // Studio can adopt this button into its standalone/popout document after
  // creation. Resolve the visible document at use time, not from the module.
  button.addEventListener("click", () => openModelDetails(button.ownerDocument, file));
  // Populate visible selections automatically; the server also indexes the full
  // installed library at startup. Its durable cache coalesces both paths.
  request(file).then(async data => {
    if (!button.isConnected) return;
    paintButtons(button.ownerDocument, file, data);
    if (file.category === "loras" && !data.missing_file) {
      data = await request(file, { local: true });
      paintButtons(button.ownerDocument, file, data);
    }
    if (data.refresh_due && !data.missing_file) {
      const updated = await request(file, { lookup: true, site: data.site || "auto" });
      paintButtons(button.ownerDocument, file, updated);
    }
  }).catch(() => { /* The popup provides actionable errors when opened. */ });
  return button;
}

export function openModelDetails(doc, file) {
  if (doc.querySelector(".promptstudio-model-metadata[open]")) return;
  stylesheet(doc);
  const make = (tag, text = "", className = "") => {
    const element = doc.createElement(tag);
    element.textContent = text;
    element.className = className;
    return element;
  };
  const dialog = make("dialog", "", "promptstudio-model-metadata");
  dialog.setAttribute("aria-label", file.category === "loras" ? "LoRA details" : "Model details");
  installDialogFocus(dialog);
  const header = make("header");
  const title = make("h2", file.category === "loras" ? "LoRA details" : "Model details");
  const close = make("button", "Close");
  close.type = "button";
  close.onclick = () => dialog.close();
  header.append(title, close);
  const status = make("p", "Loading saved details…", "promptstudio-metadata-status");
  status.setAttribute("role", "status");
  const content = make("div", "", "promptstudio-metadata-content");
  const actions = make("div", "", "promptstudio-metadata-actions");
  const siteLabel = make("label", "Civitai site ");
  const site = make("select");
  site.setAttribute("aria-label", "Civitai site");
  for (const host of ["auto", ...sites]) {
    const option = make("option", host === "auto" ? "Automatic (.com + .red)" : host);
    option.value = host;
    site.append(option);
  }
  siteLabel.append(site);
  const refresh = make("button", "Check again");
  refresh.type = "button";
  actions.append(siteLabel, refresh);
  dialog.append(header, make("p", file.name, "promptstudio-metadata-filename"), actions, status, content,
    make("small", "Embedded LoRA metadata is read locally. Civitai checks send only the SHA-256 hash; files and prompts stay local. Trigger words are copied only when you choose. Recommended strength is a suggestion; your strength stays unchanged."));
  const field = (label, value) => {
    if (value === undefined || value === null || value === "") return;
    const row = make("div", "", "promptstudio-metadata-field");
    row.append(make("strong", label), make("span", String(value)));
    content.append(row);
  };
  const link = (label, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !sites.includes(parsed.hostname) || parsed.username || parsed.password) return;
      const anchor = make("a", label);
      anchor.href = parsed.href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      content.append(anchor);
    } catch { /* Never turn untrusted metadata into an arbitrary link. */ }
  };
  let editing = false;
  let displayed = null;
  function renderTriggers(data) {
    const triggers = make("section", "", "promptstudio-metadata-triggers");
    triggers.append(make("h3", "Trigger words"));
    if (data.trigger_words_source) triggers.append(make("small", `Source: ${data.trigger_words_source}`));
    const words = Array.isArray(data.trigger_words) ? data.trigger_words : [];
    if (!words.length) triggers.append(make("p", data.trigger_words_edited ? "No trigger words in your local list." : "No saved trigger words. Check the author's notes or add your own."));
    for (const word of words) {
      const copy = make("button", word);
      copy.type = "button";
      copy.title = "Copy trigger word";
      copy.onclick = async () => {
        try {
          await doc.defaultView.navigator.clipboard.writeText(word);
          status.textContent = "Trigger word copied.";
        } catch { status.textContent = "Clipboard unavailable. Select the trigger text and copy it manually."; }
      };
      triggers.append(copy);
    }
    if (file.category === "loras") {
      const edit = make("button", "Edit trigger words");
      edit.type = "button";
      edit.disabled = Boolean(data.missing_file);
      edit.onclick = () => {
        if (editing) return;
        editing = true;
        refresh.disabled = site.disabled = true;
        const editor = make("dialog", "", "promptstudio-model-metadata promptstudio-trigger-settings");
        editor.setAttribute("aria-label", "Edit trigger words");
        installDialogFocus(editor);
        let saving = false;
        const editorHeader = make("header");
        const editorClose = make("button", "Close"); editorClose.type = "button";
        editorClose.onclick = () => editor.close();
        editorHeader.append(make("h2", "Edit trigger words"), editorClose);
        const form = make("form", "", "promptstudio-trigger-editor");
        const rows = make("div", "", "promptstudio-trigger-rows");
        const addRow = (word = "") => {
          const row = make("div", "", "promptstudio-trigger-row");
          const input = make("input");
          input.type = "text"; input.value = word; input.maxLength = 1024;
          input.setAttribute("aria-label", "Trigger word");
          const remove = make("button", "Delete"); remove.type = "button";
          remove.setAttribute("aria-label", `Delete trigger ${word || "word"}`);
          remove.onclick = () => { row.remove(); (rows.querySelector("input") || add).focus(); };
          row.append(input, remove); rows.append(row);
          return input;
        };
        const add = make("button", "Add trigger word"); add.type = "button";
        add.onclick = () => {
          const empty = [...rows.querySelectorAll("input")].find(input => !input.value.trim());
          (empty || addRow()).focus();
        };
        const save = make("button", "Save trigger words"); save.type = "submit";
        const cancel = make("button", "Cancel"); cancel.type = "button";
        const feedback = make("p"); feedback.setAttribute("role", "status");
        const buttons = make("div", "", "promptstudio-metadata-actions promptstudio-trigger-footer"); buttons.append(cancel, save);
        editor.addEventListener("close", () => {
          editor.remove();
          editing = false; refresh.disabled = site.disabled = busy;
          render(displayed);
          if (editor.returnValue === "saved") status.textContent = "Trigger words saved locally.";
          content.querySelector(".promptstudio-trigger-edit")?.focus();
        }, { once: true });
        editor.addEventListener("cancel", event => { if (saving) event.preventDefault(); });
        cancel.onclick = () => editor.close();
        form.onsubmit = async event => {
          event.preventDefault();
          const values = [...rows.querySelectorAll("input")].map(input => input.value.trim()).filter(Boolean);
          if (values.length > 128) {
            feedback.textContent = "Use up to 128 trigger words."; return;
          }
          saving = true;
          editorClose.disabled = true;
          for (const control of form.elements) control.disabled = true;
          feedback.textContent = "Saving trigger words…";
          try {
            displayed = await saveTriggerWords(file, values);
            editor.close("saved");
          } catch (error) {
            saving = false;
            editorClose.disabled = false;
            feedback.textContent = error.message;
            for (const control of form.elements) control.disabled = false;
          }
        };
        words.forEach(addRow);
        form.append(rows, add, feedback, buttons);
        editor.append(editorHeader, make("p", file.name, "promptstudio-metadata-filename"),
          make("p", "Edit each trigger below, delete unwanted entries, or add a new one."), form,
          make("small", "Saved locally for this LoRA. Civitai refreshes keep your edited list."));
        doc.body.append(editor);
        editor.showModal();
        (rows.querySelector("input") || add).focus();
      };
      edit.className = "promptstudio-trigger-edit";
      const editRow = make("div"); editRow.append(edit); triggers.append(editRow);
      if (data.trigger_words_edited) triggers.append(make("small", "Locally edited · kept when Civitai refreshes."));
    }
    content.append(triggers);
  }
  function render(data) {
    displayed = data;
    if (editing) return;
    content.replaceChildren();
    field("File size", `${(Number(data.size_bytes || 0) / 1024 ** 2).toFixed(1)} MiB`);
    field("SHA-256", data.sha256);
    const local = data.local_metadata;
    if (local?.status === "found" || local?.legacy) {
      content.append(make("h3", local.status === "found" ? "Embedded LoRA Studio metadata" : "Embedded training metadata"));
      if (local.status === "found" && local.name) title.textContent = local.name;
      field("Local name", local.name || local.legacy?.ss_output_name);
      field("Author", local.author);
      field("License", local.license);
      field("Recommended strength", local.recommended_strength);
      field("Studio version", local.studio_version);
      field("Base model", local.training?.model?.base_model || local.legacy?.ss_base_model_version);
      field("Checkpoint step", local.legacy?.training_info?.step);
      field("Checkpoint epoch", local.legacy?.training_info?.epoch);
      if (local.description) content.append(make("p", local.description, "promptstudio-metadata-description"));
      if (local.training) {
        const training = make("details");
        training.append(make("summary", "Training settings"),
          make("p", "Steps are planned; checkpoint progress is listed separately. Resolution values are pixel-area targets. Sample dimensions are defaults. Learning rate is the initial value."));
        training.append(make("pre", JSON.stringify(local.training, null, 2), "promptstudio-metadata-description"));
        content.append(training);
      }
    }
    if (local?.warning) content.append(make("p", local.warning));
    if (data.status === "found") {
      if (!local?.name) title.textContent = data.name;
      content.append(make("h3", "Civitai details"));
      field("Author", data.creator);
      field("Type", data.type);
      field("Installed version", data.version?.name);
      field("Base model", data.version?.base_model);
      field("Source", data.source_host);
      renderTriggers(data);
      const update = make("p", data.update_status === "available"
        ? `New version available: ${data.latest_version.name} (${data.latest_version.base_model}).`
        : data.update_status === "current" ? "No newer published version for this base model was found."
          : "Newer versions could not be determined from the available metadata.", "promptstudio-metadata-update");
      update.dataset.available = String(data.update_status === "available");
      content.append(update);
      link("Open installed version on Civitai", data.version?.url);
      if (data.latest_version) link("View newer version on Civitai", data.latest_version.url);
      for (const [heading, text] of [["Version notes", data.version_description], ["About this model", data.description]]) {
        if (!text) continue;
        const section = make("section");
        section.append(make("h3", heading), make("p", text, "promptstudio-metadata-description"));
        content.append(section);
      }
    }
    if (data.status !== "found" && file.category === "loras") renderTriggers(data);
    if (data.checked_at) field("Last checked", new Date(data.checked_at * 1000).toLocaleString());
    status.textContent = data.error ? `${data.status === "found" ? "Showing cached details. " : ""}${data.error}`
      : data.warning || (data.status === "not_found" ? "No accessible Civitai match was found for this exact file. It may be unpublished, restricted, or modified. You can try another Civitai site."
        : data.status === "found" ? "Matched by file hash. Newer versions must share the published base-model label; check the author's compatibility notes before installing."
          : local?.status === "found" ? "Loaded from the local LoRA file. No Civitai listing is required. Check again also checks Civitai."
            : "Details have not been fetched yet.");
  }
  let busy = false;
  async function load(force = false) {
    if (busy) return;
    busy = true;
    refresh.disabled = site.disabled = true;
    status.textContent = displayed?.status === "found" || displayed?.trigger_words_edited
      ? "Showing saved details. Refreshing in the background…"
      : "Checking for metadata in the background… You can edit local trigger words now.";
    const revision = revisions.get(keyFor(file));
    try {
      let data;
      if (file.category === "loras") {
        data = await request(file, { local: true });
        if (dialog.isConnected && revisions.get(keyFor(file)) === revision) render(data);
      }
      if (force || !data || data.refresh_due || (data.status === "unchecked" && data.local_metadata?.status !== "found")) {
        data = await request(file, { lookup: true, refresh: force, site: site.value });
      }
      paintButtons(doc, file, data);
      if (dialog.isConnected && revisions.get(keyFor(file)) === revision) render(data);
    } catch (error) {
      if (dialog.isConnected) status.textContent = `${displayed ? "Saved details remain available. " : ""}${error.message}`;
    } finally {
      busy = false;
      refresh.disabled = site.disabled = editing;
    }
  }
  refresh.onclick = () => load(true);
  site.onchange = () => load(true);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  doc.body.append(dialog);
  dialog.showModal();
  close.focus();
  // Render an already loaded snapshot synchronously, even if its short UI
  // cache has expired. The disk read and any remote refresh run separately.
  const saved = recent.get(keyFor(file))?.data;
  if (saved) { site.value = saved.site || "auto"; render(saved); }
  request(file).then(data => {
    if (!dialog.isConnected) return;
    site.value = data.site || "auto";
    render(data);
    if (!data.missing_file && (file.category === "loras" || data.status === "unchecked" || data.refresh_due)) load();
  }).catch(() => { if (dialog.isConnected) load(); });
  return dialog;
}
