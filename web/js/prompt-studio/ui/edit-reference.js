import { normalizeImageReference } from "../chat/image-reference.js";
import { supportsEditReference } from "../generation/edit-reference.js";
import { referenceInputDescriptors, workflowReferenceValues } from "../generation/reference-inputs.js";
import { qwenReferenceAdapter, normalizeQwenReferences, REFERENCE_ROLES } from "../generation/qwen-references.js";
import { structureAdapter, isStructureReference } from "../generation/structure-guide.js";
import { structureControls } from "./structure-controls.js";
import { referenceTargeting } from "./reference-targeting.js";
import { maskAdapter } from "../generation/reference-targeting.js";
import { installDialogFocus } from "./dialog-focus.js";
import { referenceImageEditor } from "./reference-image-editor.js";

export function createEditReferenceController({panel, tile: suppliedTile, activeChat, findChat, selectedProfile,
  upload, imageUrl, changed, refresh, report, fetchApi = (...args) => fetch(...args), sourceImage = () => null, analysisSettings = null, guideDimensions = () => ({}), clearChatDropState = () => {}}) {
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
  const prepareTile = doc.createElement("button"); prepareTile.type = "button"; prepareTile.textContent = "Crop / mask…";
  prepareTile.className = "ps-reference-prepare-open"; prepareTile.setAttribute("aria-label", "Crop or mask reference image"); prepareTile.hidden = true;
  prepareTile.addEventListener("click", () => openDialog()); tile.append(prepareTile);
  const pending = new Map();
  let pickerTarget = null, dialog = null, dialogContext = "", expanded = null, previewAbort = null;
  const managed = profile => Boolean(qwenReferenceAdapter(profile) || structureAdapter(profile));
  const referenceLimit = profile => qwenReferenceAdapter(profile)?.limit ?? 9;
  const limitMessage = profile => `This workflow accepts up to ${referenceLimit(profile)} references${profile?.kind === "edit" ? " in addition to the edited image" : ""}.`;
  const el = (tag, text, className) => { const item = doc.createElement(tag); if (text) item.textContent = text; if (className) item.className = className; return item; };
  const context = () => {const source=sourceImage();return JSON.stringify([activeChat()?.id, selectedProfile()?.id,source?.filename,source?.subfolder,source?.type]);};
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
    const descriptors = referenceInputDescriptors(profile?.snapshot), qwen = managed(profile) || normalizeQwenReferences(chat?.qwenEditReferences).some(isStructureReference);
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
    prepareTile.hidden = popup || !reference; prepareTile.disabled = busy;
    if (reference) { if (image.getAttribute("src") !== imageUrl(reference)) image.src = imageUrl(reference); image.alt = reference.filename; }
    else { image.removeAttribute("src"); image.alt = ""; }
    if (dialog && dialogContext !== context()) dialog.close();
  }
  function notify(chat) { changed(chat); render(); refresh(); }
  async function attach(files, destination = null, expected = null) {
    if (!destination) {
      const profile = selectedProfile(), descriptors = referenceInputDescriptors(profile?.snapshot);
      if (managed(profile)) destination = target(null, true);
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
    if (destination.qwen && !destination.slot && normalizeQwenReferences(owner.qwenEditReferences).length + list.length > referenceLimit(destination.profile)) return report(limitMessage(destination.profile), "warning");
    const job = {chatId: destination.chatId}; pending.set(key, job); render(); refresh(); if (dialog?.open) renderDialog();
    try {
      const uploaded = [];
      for (const file of list) uploaded.push(normalizeImageReference(await upload(file)));
      if (uploaded.some(value => !value)) throw new Error("Image upload returned an invalid reference.");
      const current = findChat(destination.chatId);
      if (!current || pending.get(key) !== job) return;
      if (expected) {
        const latest = destination.qwen ? normalizeQwenReferences(current.qwenEditReferences).find(e => e.id === destination.slot)?.image : values(current, destination.profile)[destination.slot];
        if (JSON.stringify(latest) !== JSON.stringify(expected)) return;
      }
      if (destination.qwen) {
        const entries = normalizeQwenReferences(current.qwenEditReferences);
        if (destination.slot) {
          const entry = entries.find(item => item.id === destination.slot);
          if (!entry) return; // Removed during the upload; never resurrect it.
          entry.image = uploaded[0];
          if (expected) entry.targeting = entry.targeting?.target ? {...entry.targeting, reference: null} : null;
          else {entry.targeting = null; entry.editMask = null;}
          current.qwenEditReferences = entries;
        } else {
          if (entries.length + uploaded.length > referenceLimit(destination.profile)) throw new Error(limitMessage(destination.profile));
          current.qwenEditReferences = [...entries, ...uploaded.map(image => ({id: crypto.randomUUID(), image, role: "custom", instruction: "", ...(!qwenReferenceAdapter(destination.profile) && !entries.some(isStructureReference) && image === uploaded[0] ? {use: "structure"} : {})}))];
        }
      } else storeInput(current, destination.profile, destination.slot, uploaded[0]);
      if (destination.qwen) expanded = current.qwenEditReferences.at(-1)?.id;
      notify(current);
    } catch (error) { report(error.message || String(error), "error"); }
    finally { if (pending.get(key) === job) pending.delete(key); render(); refresh(); if (dialog?.open) renderDialog(); }
  }
  function selectFiles(destination) { pickerTarget = destination; picker.multiple = destination.qwen && !destination.slot; picker.click(); }
  function renderDialog() {
    if (!dialog?.open) return;
    const chat = activeChat(), profile = selectedProfile(), body = dialog.querySelector(".ps-reference-body");
    const focusLabel = body.contains(doc.activeElement) ? doc.activeElement.getAttribute("aria-label") : null;
    const openOptions = new Set([...body.querySelectorAll("details[open][data-guide-options]")].map(node => node.dataset.guideOptions));
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
      heading.append(el("strong", label)); fields.append(heading); item.append(imageTile, fields); body.append(item);
      if (reference) {
        const editor = referenceImageEditor({doc, image: reference, imageUrl, label,
          valid: () => dialog?.open && dialogContext === context() && !loading(chat.id),
          apply: file => attach([file], destination, reference)});
        // Managed references put this inside their collapsed detail below.
        if (!destination.qwen) fields.append(editor);
        return {item, fields, heading, editor};
      }
      return {item, fields, heading};
    }
    if (managed(profile) || normalizeQwenReferences(chat.qwenEditReferences).some(isStructureReference)) {
      const entries = normalizeQwenReferences(chat.qwenEditReferences);
      body.append(el("h3", "References · " + entries.length + "/" + referenceLimit(profile)));
      if (managed(profile) && entries.length > referenceLimit(profile)) body.append(el("small", limitMessage(profile) + " Remove a reference before generating."));
      entries.forEach((entry, index) => {
        const {item, fields, heading, editor} = row("Reference " + (index + 1), entry.image, target(entry.id, true), "Replace reference " + (index + 1));
        item.classList.add("ps-reference-compact");
        const detail = el("div", "", "ps-reference-detail"); detail.hidden = expanded !== entry.id;
        const toggle = el("button", "Reference " + (index + 1), "ps-reference-toggle"); toggle.type = "button";
        toggle.setAttribute("aria-expanded", String(!detail.hidden)); toggle.setAttribute("aria-label", "Expand reference " + (index + 1));
        toggle.addEventListener("click", () => {expanded = expanded === entry.id ? null : entry.id; renderDialog();});
        const summary = el("small", isStructureReference(entry) ? "Structure guide (ControlNet)" + (entry.use === "both" ? " + " + REFERENCE_ROLES[entry.role] : "") : REFERENCE_ROLES[entry.role] + (entry.instruction ? " · " + entry.instruction : ""));
        summary.className = "ps-reference-summary";
        heading.replaceChildren(toggle);
        fields.append(summary); item.append(detail);
        const save = (patch, redraw = false) => {
          const saved = chat.qwenEditReferences?.find(e => e.id === entry.id);
          if (saved) {Object.assign(saved, patch); Object.assign(entry, patch); notify(chat); if (redraw) renderDialog();}
        };
        detail.append(structureControls({doc, entry, index, profile, entries, save, fetchApi, imageUrl, report,
          dimensions: guideDimensions, signal: previewAbort?.signal}));
        if (entry.use !== "structure") {
          const role = el("select"); role.setAttribute("aria-label", "Role for reference " + (index + 1));
          for (const [value, label] of Object.entries(REFERENCE_ROLES)) {const option = el("option", label); option.value = value; role.append(option);}
          role.value = entry.role;
          role.addEventListener("change", () => save({role: role.value}, true));
          detail.append(role);
          if (!qwenReferenceAdapter(profile)) {role.disabled = true; detail.append(el("small", "Reference instructions are inactive here. Select a compatible Qwen 2.1 Create or Edit workflow to use them."));}
        }
        const instruction = el("textarea"); instruction.rows = 1; instruction.maxLength = 4000;
        instruction.setAttribute("aria-label", "Instruction for reference " + (index + 1)); instruction.value = entry.instruction;
        instruction.placeholder = entry.use === "structure" ? "Optional: apply this pose to the person on the left" : entry.role === "custom" ? "Describe what to use from this reference" : "Optional: take the left person's jacket for the dark-haired person in the source";
        instruction.addEventListener("input", () => save({instruction: instruction.value}));
        const sourceAtOpen = sourceImage();
        detail.append(editor, instruction, referenceTargeting({doc, entry, index, sourceImage: sourceAtOpen, imageUrl, save, fetchApi,
          analysisSettings, maskSupported: Boolean(maskAdapter(profile)), validContext: () => JSON.stringify(sourceAtOpen) === JSON.stringify(sourceImage()),
          signal: previewAbort?.signal,
          structure: isStructureReference(entry), edit: profile?.kind === "edit"}));
        const clear = el("button", "×", "ps-reference-remove"); clear.type = "button"; clear.setAttribute("aria-label", "Remove reference " + (index + 1));
        clear.addEventListener("click", () => {chat.qwenEditReferences = chat.qwenEditReferences.filter(e => e.id !== entry.id); notify(chat); renderDialog();}); heading.append(clear);
      });
      if (managed(profile)) {
        const add = el("button", loading(chat.id) ? "Uploading…" : "+ Add references · Drop / Ctrl+V", "ps-reference-add"); add.type = "button"; add.disabled = entries.length >= referenceLimit(profile) || loading(chat.id);
        add.setAttribute("aria-label", "Add reference images"); add.addEventListener("click", () => selectFiles(target(null, true))); body.append(add);
        if (profile.kind === "edit" && sourceImage() && !entries.some(isStructureReference) && entries.length < referenceLimit(profile)) {
          const reuse = el("button", "Use edit source as structure guide", "ps-reference-add"); reuse.type = "button";
          reuse.addEventListener("click", () => {const entry = {id: crypto.randomUUID(), image: normalizeImageReference(sourceImage()), use: "structure", role: "custom", instruction: ""};
            chat.qwenEditReferences = [...entries, entry]; expanded = entry.id; notify(chat); renderDialog();}); body.append(reuse);
        }
      }
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
    for (const details of body.querySelectorAll("details[data-guide-options]")) details.open = openOptions.has(details.dataset.guideOptions);
    if (focusLabel) [...body.querySelectorAll("[aria-label]")].find(control => control.getAttribute("aria-label") === focusLabel)?.focus({preventScroll: true});
  }
  function openDialog() {
    if (dialog?.open) return;
    dialogContext = context(); previewAbort = new AbortController(); expanded = normalizeQwenReferences(activeChat()?.qwenEditReferences)[0]?.id || null; dialog = el("dialog", "", "ps-reference-dialog"); dialog.setAttribute("aria-label", "References");
    const header = el("header"), close = el("button", "Done"); close.type = "button";
    header.append(el("h2", "References"), close); dialog.append(header, el("div", "", "ps-reference-body"));
    doc.body.append(dialog); installDialogFocus(dialog); const current = dialog;
    close.addEventListener("click", () => current.close());
    current.addEventListener("close", () => {previewAbort?.abort(); current.remove(); if (dialog === current) dialog = null;});
    current.addEventListener("dragover", event => { if (managed(selectedProfile())) event.preventDefault(); });
    current.addEventListener("drop", event => {
      if (managed(selectedProfile())) {event.preventDefault(); event.stopPropagation(); attach(event.dataTransfer?.files, target(null, true));}
    });
    current.addEventListener("paste", event => {
      if (managed(selectedProfile()) && event.clipboardData?.files.length) {event.preventDefault(); event.stopPropagation(); attach(event.clipboardData.files, target(null, true));}
    });
    current.showModal(); renderDialog();
  }
  choose.addEventListener("click", () => {const profile = selectedProfile(), descriptors = referenceInputDescriptors(profile?.snapshot); if (managed(profile) || normalizeQwenReferences(activeChat()?.qwenEditReferences).some(isStructureReference) || descriptors.length > 1) openDialog(); else if (descriptors.length) selectFiles(target(descriptors[0].id));});
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
