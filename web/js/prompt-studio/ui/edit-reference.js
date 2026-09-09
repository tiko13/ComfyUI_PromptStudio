import { normalizeImageReference } from "../chat/image-reference.js";
import { supportsEditReference } from "../generation/edit-reference.js";

export function createEditReferenceController({ panel, activeChat, findChat, selectedAction, selectedProfile,
  upload, imageUrl, changed, refresh, report, clearChatDropState }) {
  const tile = panel.querySelector("#promptstudio-edit-reference");
  const picker = tile.querySelector("input");
  const choose = tile.querySelector(".promptstudio-edit-reference-choose");
  const remove = tile.querySelector(".promptstudio-edit-reference-remove");
  const image = tile.querySelector("img");
  const caption = tile.querySelector("small");
  const pending = new Map();
  let pickerChat = null;
  function visible() { return selectedAction() === "edit" && supportsEditReference(selectedProfile()); }
  function render() {
    const chat = activeChat();
    tile.hidden = !visible();
    const reference = normalizeImageReference(chat?.editReferenceImage);
    const loading = pending.has(chat?.id);
    tile.dataset.filled = String(Boolean(reference));
    tile.setAttribute("aria-busy", String(loading));
    choose.disabled = loading;
    choose.setAttribute("aria-label", reference ? "Replace edit reference image" : "Upload edit reference image (optional)");
    choose.title = reference ? `${reference.filename} — click to replace` : "Drop or upload an optional reference for the edit model";
    caption.textContent = loading ? "Uploading…" : reference ? "Replace" : "Optional";
    remove.hidden = !reference && !loading;
    image.hidden = !reference;
    if (reference) {
      const url = imageUrl(reference);
      if (image.getAttribute("src") !== url) image.src = url;
      image.alt = `Edit reference: ${reference.filename}`;
    } else { image.removeAttribute("src"); image.alt = ""; }
  }
  async function attach(files, chat = activeChat()) {
    if (!chat || !visible()) return;
    const list = [...(files || [])];
    if (list.length !== 1) return report("Choose one reference image.", "warning");
    const file = list[0];
    if (!file.type.startsWith("image/") || !file.size || file.size > 20 * 1024 * 1024) {
      return report("Choose an image smaller than 20 MB.", "warning");
    }
    const token = Symbol();
    pending.set(chat.id, token);
    render(); refresh();
    try {
      const reference = await upload(file);
      if (pending.get(chat.id) !== token) return;
      const owner = findChat(chat.id);
      if (!owner) return;
      owner.editReferenceImage = normalizeImageReference(reference);
      changed(owner);
    } catch (error) {
      if (activeChat()?.id === chat.id && pending.get(chat.id) === token) report(error.message || String(error), "error");
    } finally {
      if (pending.get(chat.id) === token) pending.delete(chat.id);
      render(); refresh();
    }
  }
  choose.addEventListener("click", () => { pickerChat = activeChat(); picker.click(); });
  picker.addEventListener("change", () => { attach(picker.files, pickerChat || activeChat()); picker.value = ""; });
  remove.addEventListener("click", () => {
    const chat = activeChat();
    if (!chat) return;
    pending.delete(chat.id);
    chat.editReferenceImage = null;
    changed(chat); render(); refresh(); choose.focus();
  });
  for (const eventName of ["dragenter", "dragover", "dragleave", "drop"]) tile.addEventListener(eventName, event => {
    event.preventDefault(); event.stopPropagation();
    clearChatDropState();
    tile.dataset.dragActive = String(eventName === "dragenter" || eventName === "dragover");
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    if (eventName === "drop") attach(event.dataTransfer?.files);
  });
  tile.addEventListener("paste", event => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) { event.preventDefault(); event.stopPropagation(); attach(files); }
  });
  return { render, uploading: chatId => pending.has(chatId), attach };
}
