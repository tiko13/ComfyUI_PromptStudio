import { normalizeImageReference } from "../chat/image-reference.js";
import { supportsEditReference } from "../generation/edit-reference.js";
import { referenceInputDescriptors, workflowReferenceValues } from "../generation/reference-inputs.js";
import { qwenReferenceAdapter, normalizeQwenReferences, REFERENCE_ROLES } from "../generation/qwen-references.js";
import { installDialogFocus } from "./dialog-focus.js";

export function createEditReferenceController({panel, tile: suppliedTile, activeChat, findChat, selectedProfile,
  upload, imageUrl, changed, refresh, report, clearChatDropState = () => {}}) {
  const tile = suppliedTile || panel.querySelector("#promptstudio-edit-reference");
  const picker = tile.querySelector("input"), choose = tile.querySelector(".promptstudio-edit-reference-choose");
  const remove = tile.querySelector(".promptstudio-edit-reference-remove"), image = tile.querySelector("img"), caption = tile.querySelector("small");
  let doc = panel.ownerDocument;
  function ensureStyle() { if (!doc.querySelector('link[data-reference-inputs]')) {
    const style = doc.createElement("link"); style.rel = "stylesheet";
    style.href = new URL("../../../css/reference-inputs.css", import.meta.url).href;
    style.dataset.referenceInputs = "true"; doc.head.append(style);
  } }
  ensureStyle();
  const pending = new Map();
  let pickerTarget = null, dialog = null, dialogContext = "";
  const el = (tag, text, className) => { const item = doc.createElement(tag); if (text) item.textContent = text; if (className) item.className = className; return item; };
  const context = () => JSON.stringify([activeChat()?.id, selectedProfile()?.id]);
  const loading = id => [...pending.values()].some(job => job.chatId === id);
  const target = (slot = null, qwen = false) => ({chatId: activeChat()?.id, profile: selectedProfile(), slot, qwen});
  const jobKey = destination => JSON.stringify([destination.chatId, destination.profile.id, destination.qwen ? "qwen" : destination.slot]);
  function values(chat, profile) {
    const result = workflowReferenceValues(chat, profile);
    if (supportsEditReference(profile)) result[referenceInputDescriptors(profile.snapshot)[0].id] = normalizeImageReference(chat?.editReferenceImage);
    return result;
  }
  function storeInput(chat, profile, id, value) {
    chat.workflowReferences ||= {};
    chat.workflowReferences[profile.id] = {...chat.workflowReferences[profile.id], [id]: value};
    if (supportsEditReference(profile)) chat.editReferenceImage = value;
  }
  function render() {
    if (doc !== panel.ownerDocument) { dialog?.close(); doc = panel.ownerDocument; ensureStyle(); }
    const chat = activeChat(), profile = selectedProfile();
    const descriptors = referenceInputDescriptors(profile?.snapshot), qwen = qwenReferenceAdapter(profile);
    const popup = Boolean(qwen || descriptors.length > 1);
    const references = [...(qwen ? normalizeQwenReferences(chat?.qwenEditReferences).map(entry => entry.image) : []), ...Object.values(values(chat, profile)).filter(Boolean)];
    const reference = references[0], busy = loading(chat?.id);
    tile.hidden = !qwen && !descriptors.length;
    tile.dataset.filled = String(Boolean(reference)); tile.setAttribute("aria-busy", String(busy));
    choose.disabled = busy && !popup;
    choose.setAttribute("aria-label", popup ? "References" : reference ? "Replace edit reference image" : "Upload edit reference image (optional)");
    choose.title = popup ? "Edit references and workflow image inputs" : (descriptors[0]?.label || "Reference") + " — upload or drop an image";
    caption.textContent = busy ? "Uploading…" : popup ? "References (" + references.length + ")" : reference ? "Replace" : descriptors[0]?.label || "Optional";
    remove.hidden = popup || (!reference && !busy); image.hidden = !reference;
    if (reference) { if (image.getAttribute("src") !== imageUrl(reference)) image.src = imageUrl(reference); image.alt = reference.filename; }
    else { image.removeAttribute("src"); image.alt = ""; }
    if (dialog && dialogContext !== context()) dialog.close();
  }
  function notify(chat) { changed(chat); render(); refresh(); }
  async function attach(files, destination = null) {
    if (!destination) {
      const profile = selectedProfile(), descriptors = referenceInputDescriptors(profile?.snapshot);
      if (qwenReferenceAdapter(profile)) destination = target(null, true);
      else if (descriptors.length === 1) destination = target(descriptors[0].id);
      else { openDialog(); return; }
    }
    if (!destination.chatId || !destination.profile) return;
    const list = [...(files || [])]; if (!list.length) return;
    if ((!destination.qwen || destination.slot) && list.length !== 1) return report("Choose one image for this reference input.", "warning");
    if (list.some(file => !file.type.startsWith("image/") || !file.size || file.size > 20 * 1024 * 1024)) return report("Choose images smaller than 20 MB each.", "warning");
    const owner = findChat(destination.chatId); if (!owner) return;
    const key = jobKey(destination);
    if (pending.has(key)) return;
    if (destination.qwen && !destination.slot && normalizeQwenReferences(owner.qwenEditReferences).length + list.length > 9) return report("Qwen accepts nine additional references plus the edited image.", "warning");
    const job = {chatId: destination.chatId}; pending.set(key, job); render(); refresh(); if (dialog?.open) renderDialog();
    try {
      const uploaded = [];
      for (const file of list) uploaded.push(normalizeImageReference(await upload(file)));
      if (uploaded.some(value => !value)) throw new Error("Image upload returned an invalid reference.");
      const current = findChat(destination.chatId);
      if (!current || pending.get(key) !== job) return;
      if (destination.qwen) {
        const entries = normalizeQwenReferences(current.qwenEditReferences);
        if (destination.slot) {
          const entry = entries.find(item => item.id === destination.slot);
          if (!entry) return; // Removed during the upload; never resurrect it.
          entry.image = uploaded[0]; current.qwenEditReferences = entries;
        } else {
          if (entries.length + uploaded.length > 9) throw new Error("Qwen accepts at most nine additional references.");
          current.qwenEditReferences = [...entries, ...uploaded.map(image => ({id: crypto.randomUUID(), image, role: "custom", instruction: ""}))];
        }
      } else storeInput(current, destination.profile, destination.slot, uploaded[0]);
      notify(current);
    } catch (error) { report(error.message || String(error), "error"); }
    finally { if (pending.get(key) === job) pending.delete(key); render(); refresh(); if (dialog?.open) renderDialog(); }
  }
  function selectFiles(destination) { pickerTarget = destination; picker.multiple = destination.qwen && !destination.slot; picker.click(); }
  function renderDialog() {
    if (!dialog?.open) return;
    const chat = activeChat(), profile = selectedProfile(), body = dialog.querySelector(".ps-reference-body");
    const focusLabel = body.contains(doc.activeElement) ? doc.activeElement.getAttribute("aria-label") : null;
    body.replaceChildren();
    function row(label, reference, destination, inputLabel) {
      const item = el("div", "", "ps-reference-row"), preview = el("img"), fields = el("div", "", "ps-reference-fields");
      const imageTile = el("button", "", "ps-reference-image"), heading = el("div", "", "ps-reference-heading");
      imageTile.type = "button"; imageTile.setAttribute("aria-label", inputLabel);
      imageTile.title = "Click to choose, drop an image, or focus here and press Ctrl+V";
      imageTile.disabled = loading(chat.id);
      preview.alt = label; preview.hidden = !reference; if (reference) preview.src = imageUrl(reference);
      imageTile.append(preview, el("span", reference ? "Replace · Drop / Ctrl+V" : "Drop image\nor Ctrl+V", "ps-reference-image-hint"));
      imageTile.dataset.filled = String(Boolean(reference));
      imageTile.addEventListener("click", () => selectFiles(destination));
      for (const name of ["dragenter", "dragover", "dragleave", "drop"]) imageTile.addEventListener(name, event => {
        event.preventDefault(); event.stopPropagation(); imageTile.dataset.dragActive = String(name === "dragenter" || name === "dragover");
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        if (name === "drop") attach(event.dataTransfer?.files, destination);
      });
      item.addEventListener("paste", event => {if (event.clipboardData?.files.length) {event.preventDefault(); event.stopPropagation(); attach(event.clipboardData.files, destination);}});
      heading.append(el("strong", label)); fields.append(heading); item.append(imageTile, fields); body.append(item); return {item, fields, heading};
    }
    if (qwenReferenceAdapter(profile)) {
      const entries = normalizeQwenReferences(chat.qwenEditReferences);
      body.append(el("h3", "Edit references · " + entries.length + "/9"));
      entries.forEach((entry, index) => {
        const {fields, heading} = row("Reference " + (index + 1), entry.image, target(entry.id, true), "Replace reference " + (index + 1));
        const role = el("select"); role.setAttribute("aria-label", "Role for reference " + (index + 1));
        for (const [value, label] of Object.entries(REFERENCE_ROLES)) { const option = el("option", label); option.value = value; role.append(option); }
        role.value = entry.role;
        const instruction = el("textarea"); instruction.rows = 2; instruction.maxLength = 4000;
        const updateInstructionHint = () => { instruction.placeholder = role.value === "custom"
          ? "Describe what to use from this reference"
          : "Optional: refine what to use, for example only the jacket"; };
        updateInstructionHint();
        instruction.setAttribute("aria-label", "Instruction for reference " + (index + 1)); instruction.value = entry.instruction;
        const change = () => { const saved = chat.qwenEditReferences?.find(item => item.id === entry.id); if (saved) {saved.role = role.value; saved.instruction = instruction.value; notify(chat);} };
        role.addEventListener("change", () => { updateInstructionHint(); change(); }); instruction.addEventListener("input", change);
        const clear = el("button", "×", "ps-reference-remove"); clear.type = "button"; clear.setAttribute("aria-label", "Remove reference " + (index + 1));
        clear.addEventListener("click", () => {chat.qwenEditReferences = chat.qwenEditReferences.filter(item => item.id !== entry.id); notify(chat); renderDialog();});
        heading.append(role, clear); fields.append(instruction);
      });
      const add = el("button", loading(chat.id) ? "Uploading…" : "+ Add references · Drop / Ctrl+V", "ps-reference-add"); add.type = "button"; add.disabled = entries.length >= 9 || loading(chat.id);
      add.setAttribute("aria-label", "Add reference images");
      add.addEventListener("click", () => selectFiles(target(null, true))); body.append(add);
    }
    const descriptors = referenceInputDescriptors(profile?.snapshot);
    if (descriptors.length) {
      body.append(el("h3", "Workflow inputs"));
      const saved = values(chat, profile);
      for (const descriptor of descriptors) {
        const {fields, heading} = row(descriptor.label, saved[descriptor.id], target(descriptor.id), "Choose image for " + descriptor.label);
        const clear = el("button", "×", "ps-reference-remove"); clear.type = "button"; clear.disabled = !saved[descriptor.id] || loading(chat.id); clear.setAttribute("aria-label", "Clear " + descriptor.label);
        clear.addEventListener("click", () => {storeInput(chat, profile, descriptor.id, null); notify(chat); renderDialog();}); heading.append(clear);
        fields.append(el("span", saved[descriptor.id]?.filename || "Choose an image for this workflow input.", "ps-reference-filename"));
      }
    }
    if (focusLabel) [...body.querySelectorAll("[aria-label]")].find(control => control.getAttribute("aria-label") === focusLabel)?.focus({preventScroll: true});
  }
  function openDialog() {
    if (dialog?.open) return;
    dialogContext = context(); dialog = el("dialog", "", "ps-reference-dialog"); dialog.setAttribute("aria-label", "References");
    const header = el("header"), close = el("button", "Done"); close.type = "button";
    header.append(el("h2", "References"), close); dialog.append(header, el("div", "", "ps-reference-body"));
    doc.body.append(dialog); installDialogFocus(dialog); const current = dialog;
    close.addEventListener("click", () => current.close());
    current.addEventListener("close", () => {current.remove(); if (dialog === current) dialog = null;});
    current.addEventListener("dragover", event => { if (qwenReferenceAdapter(selectedProfile())) event.preventDefault(); });
    current.addEventListener("drop", event => {
      if (qwenReferenceAdapter(selectedProfile())) {event.preventDefault(); event.stopPropagation(); attach(event.dataTransfer?.files, target(null, true));}
    });
    current.addEventListener("paste", event => {
      if (qwenReferenceAdapter(selectedProfile()) && event.clipboardData?.files.length) {event.preventDefault(); event.stopPropagation(); attach(event.clipboardData.files, target(null, true));}
    });
    current.showModal(); renderDialog();
  }
  choose.addEventListener("click", () => {const profile = selectedProfile(), descriptors = referenceInputDescriptors(profile?.snapshot); if (qwenReferenceAdapter(profile) || descriptors.length > 1) openDialog(); else if (descriptors.length) selectFiles(target(descriptors[0].id));});
  picker.addEventListener("change", () => {attach(picker.files, pickerTarget); picker.value = "";});
  remove.addEventListener("click", () => {
    const chat = activeChat(), profile = selectedProfile(), slot = referenceInputDescriptors(profile?.snapshot)[0]?.id;
    if (!chat || !slot) return; pending.delete(jobKey(target(slot))); storeInput(chat, profile, slot, null); notify(chat); choose.focus();
  });
  for (const eventName of ["dragenter", "dragover", "dragleave", "drop"]) tile.addEventListener(eventName, event => {
    event.preventDefault(); event.stopPropagation(); clearChatDropState(); tile.dataset.dragActive = String(eventName === "dragenter" || eventName === "dragover");
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"; if (eventName === "drop") attach(event.dataTransfer?.files);
  });
  tile.addEventListener("paste", event => {if (event.clipboardData?.files.length) {event.preventDefault(); event.stopPropagation(); attach(event.clipboardData.files);}});
  return {render, uploading: loading, attach, close: () => dialog?.close()};
}
