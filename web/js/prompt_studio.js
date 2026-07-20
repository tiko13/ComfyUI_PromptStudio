import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const EXTENSION_NAME = "ComfyUI_LLLM.PromptStudio";
const SLOT_TYPE = "KCPP_PromptSlot";
const AMPLIFY_TYPE = "KCPP_PromptAmplify";
const STORAGE_KEY = "lllm.promptStudio.settings.v1";
const STANDALONE_CHANNEL = "lllm.promptStudio.standalone.v1";
const CONTROL_IDS = [
  "lllm-kobold-url",
  "lllm-profile",
  "lllm-style",
  "lllm-framing",
  "lllm-style-modifier",
  "lllm-framing-modifier",
  "lllm-thinking",
  "lllm-embellishment",
  "lllm-max-tokens",
  "lllm-temperature",
];

const state = {
  panel: null,
  launcher: null,
  popup: null,
  dockingPopup: false,
  standaloneChannel: null,
  config: null,
  selectedSlotId: null,
  currentPrompt: "",
  versions: [],
  versionIndex: -1,
  busy: false,
  generating: false,
  operationToken: 0,
  pollToken: 0,
  chats: [],
  activeChatId: null,
  chatSaveTimer: null,
  chatSaveChain: Promise.resolve(),
  lightboxTrigger: null,
};

function loadCss() {
  if (document.querySelector("link[data-lllm-prompt-studio]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("../css/prompt_studio.css", import.meta.url).href;
  link.dataset.lllmPromptStudio = "true";
  document.head.appendChild(link);
}

function getSettings() {
  const defaults = {
    kobold_url: "http://localhost:5001",
    model_profile: "General Natural Language",
    style_preset: "None",
    framing_preset: "None",
    style_modifier: "",
    framing_modifier: "",
    thinking_mode: "Disabled",
    embellishment_level: "Clean",
    max_response_tokens: 0,
    temperature: 0.7,
    secondary_instructions: "",
    use_llm_amplification: true,
    randomize_seed: true,
    auto_generate: true,
    image_scale: 100,
  };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
  } catch (_) {
    return defaults;
  }
}

function saveSettings() {
  if (!state.panel) return;
  const value = (id) => state.panel.querySelector(`#${id}`)?.value;
  const checked = (id) => Boolean(state.panel.querySelector(`#${id}`)?.checked);
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      kobold_url: value("lllm-kobold-url"),
      model_profile: value("lllm-profile"),
      style_preset: value("lllm-style"),
      framing_preset: value("lllm-framing"),
      style_modifier: value("lllm-style-modifier"),
      framing_modifier: value("lllm-framing-modifier"),
      thinking_mode: value("lllm-thinking"),
      embellishment_level: value("lllm-embellishment"),
      max_response_tokens: Number(value("lllm-max-tokens") || 0),
      temperature: Number(value("lllm-temperature") || 0.7),
      secondary_instructions: value("lllm-secondary-instructions"),
      use_llm_amplification: checked("lllm-use-llm-amplification"),
      randomize_seed: checked("lllm-randomize-seed"),
      auto_generate: checked("lllm-auto-generate"),
      image_scale: Number(value("lllm-image-scale") || 100),
    }),
  );
}

function applyImageScale(value) {
  if (!state.panel) return;
  const numeric = Number(value);
  const scale = Number.isFinite(numeric) ? Math.max(30, Math.min(100, Math.round(numeric / 5) * 5)) : 100;
  const input = state.panel.querySelector("#lllm-image-scale");
  const output = state.panel.querySelector("#lllm-image-scale-value");
  if (input) input.value = String(scale);
  if (output) output.textContent = `${scale}%`;
  state.panel.style.setProperty("--ps-image-scale", `${scale}%`);
}

function toggleStudioSettings(force) {
  const popover = state.panel?.querySelector("#lllm-studio-settings");
  const button = state.panel?.querySelector("#lllm-toggle-studio-settings");
  if (!popover || !button) return;
  const show = force ?? popover.hidden;
  popover.hidden = !show;
  button.setAttribute("aria-expanded", show ? "true" : "false");
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function activeChat() {
  return state.chats.find((chat) => chat.id === state.activeChatId) || null;
}

function normalizeChat(chat) {
  const currentPrompt = String(chat?.currentPrompt || "");
  const versions = Array.isArray(chat?.versions) && chat.versions.length
    ? chat.versions.map((value) => String(value))
    : [currentPrompt];
  const messages = Array.isArray(chat?.messages)
    ? chat.messages.map((message) => ({
        id: String(message?.id || makeId()),
        role: ["user", "assistant", "system"].includes(message?.role) ? message.role : "system",
        text: String(message?.text || ""),
        label: String(message?.label || ""),
        images: Array.isArray(message?.images) ? message.images : [],
        canonicalPrompt: String(message?.canonicalPrompt || ""),
        controlsFingerprint: String(message?.controlsFingerprint || ""),
        llmAmplified: Boolean(message?.llmAmplified),
        createdAt: Number(message?.createdAt || Date.now()),
      }))
    : [];
  const requestedIndex = Number(chat?.versionIndex ?? versions.length - 1);
  const versionIndex = Number.isFinite(requestedIndex)
    ? Math.max(0, Math.min(requestedIndex, versions.length - 1))
    : versions.length - 1;
  return {
    id: String(chat?.id || makeId()),
    createdAt: Number(chat?.createdAt || Date.now()),
    updatedAt: Number(chat?.updatedAt || Date.now()),
    slotId: chat?.slotId == null ? null : String(chat.slotId),
    initialized: chat?.initialized == null ? Boolean(currentPrompt) : Boolean(chat.initialized),
    currentPrompt,
    versions,
    versionIndex,
    controlsFingerprint: String(chat?.controlsFingerprint || ""),
    messages,
  };
}

function saveChats({ immediate = false } = {}) {
  if (state.chatSaveTimer) clearTimeout(state.chatSaveTimer);
  const persist = () => {
    state.chatSaveTimer = null;
    const snapshot = structuredClone({ activeChatId: state.activeChatId, chats: state.chats });
    state.chatSaveChain = state.chatSaveChain
      .catch(() => {})
      .then(async () => {
        const response = await api.fetchApi("/lllm/prompt-studio/chats", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(snapshot),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `Chat save failed (${response.status}).`);
        }
      })
      .catch((error) => setStatus(error.message || "Chat history could not be saved.", "warning"));
  };
  if (immediate) persist();
  else state.chatSaveTimer = setTimeout(persist, 150);
}

async function loadChats() {
  try {
    const response = await api.fetchApi("/lllm/prompt-studio/chats");
    const stored = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(stored.error || `Chat load failed (${response.status}).`);
    state.chats = Array.isArray(stored.chats) ? stored.chats.map(normalizeChat) : [];
    state.activeChatId = state.chats.some((chat) => chat.id === stored.activeChatId)
      ? stored.activeChatId
      : state.chats[0]?.id || null;
  } catch (error) {
    state.chats = [];
    state.activeChatId = null;
    setStatus(error.message || "Chat history could not be loaded.", "warning");
  }
  if (!state.chats.length) {
    const chat = normalizeChat({});
    state.chats.push(chat);
    state.activeChatId = chat.id;
    saveChats({ immediate: true });
  }
}

function syncActiveChat() {
  const chat = activeChat();
  if (!chat) return;
  chat.currentPrompt = state.currentPrompt;
  chat.versions = [...state.versions];
  chat.versionIndex = state.versionIndex;
  chat.initialized = Boolean(chat.initialized);
  chat.slotId = state.selectedSlotId == null ? null : String(state.selectedSlotId);
  chat.updatedAt = Date.now();
  saveChats();
  renderChatList();
}

function controlsFingerprint() {
  if (!state.panel) return "";
  return JSON.stringify(CONTROL_IDS.map((id) => state.panel.querySelector(`#${id}`)?.value ?? ""));
}

function useLlmAmplification() {
  return state.panel?.querySelector("#lllm-use-llm-amplification")?.checked !== false;
}

function controlsNeedApply() {
  const chat = activeChat();
  return Boolean(useLlmAmplification() && chat?.initialized && chat.controlsFingerprint !== controlsFingerprint());
}

function markControlsChanged() {
  saveSettings();
  if (!useLlmAmplification()) {
    setStatus("Direct prompt mode. KoboldCpp will not be used.", "ready");
  } else if (!activeChat()?.initialized) {
    setStatus("Describe an image to create the first prompt.", "ready");
  } else if (controlsNeedApply()) {
    setStatus("Generation controls changed. KoboldCpp will update the prompt before generation.", "warning");
  } else if (selectedSlot()) {
    setStatus(`Attached to ${slotLabel(selectedSlot())}`, "ready");
  }
}

function chatTitle(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderChatList() {
  const list = state.panel?.querySelector("#lllm-chat-list");
  if (!list) return;
  list.replaceChildren();
  const ordered = [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const chat of ordered) {
    const row = document.createElement("div");
    row.className = "lllm-chat-row";
    row.dataset.active = chat.id === state.activeChatId ? "true" : "false";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "lllm-chat-item";
    button.disabled = state.busy;
    const title = document.createElement("span");
    title.className = "lllm-chat-title";
    title.textContent = chatTitle(chat.createdAt);
    const date = document.createElement("span");
    date.className = "lllm-chat-date";
    date.textContent = `${chat.messages.length} message${chat.messages.length === 1 ? "" : "s"}`;
    button.append(title, date);
    button.addEventListener("click", () => activateChat(chat.id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "lllm-chat-delete";
    remove.dataset.disableBusy = "";
    remove.disabled = state.busy;
    remove.textContent = "Delete";
    remove.title = `Delete chat from ${chatTitle(chat.createdAt)}`;
    remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", () => deleteChat(chat.id));
    row.append(button, remove);
    list.appendChild(row);
  }
}

function scrollHistoryToEnd() {
  const history = state.panel?.querySelector("#lllm-history");
  if (!history) return;
  const scroll = () => {
    history.scrollTop = history.scrollHeight;
  };
  scroll();
  const view = history.ownerDocument.defaultView;
  view?.requestAnimationFrame(() => view.requestAnimationFrame(scroll));
  for (const image of history.querySelectorAll("img")) {
    if (!image.complete) image.addEventListener("load", scroll, { once: true });
  }
}

function renderChatHistory() {
  const history = state.panel?.querySelector("#lllm-history");
  if (!history) return;
  history.replaceChildren();
  for (const message of activeChat()?.messages || []) renderMessage(message);
  scrollHistoryToEnd();
  updateComposeMode();
}

function updateComposeMode() {
  if (!state.panel) return;
  const amplificationEnabled = useLlmAmplification();
  const creating = !activeChat()?.initialized;
  const heading = state.panel.querySelector("#lllm-compose-title");
  const hint = state.panel.querySelector("#lllm-compose-hint");
  const input = state.panel.querySelector("#lllm-revision");
  const send = state.panel.querySelector("#lllm-send");
  const editor = state.panel.querySelector("#lllm-current-prompt");
  if (!amplificationEnabled) {
    if (heading) heading.textContent = "Canonical prompt";
    if (hint) hint.textContent = "Edit directly; no LLM call";
    if (input) {
      input.placeholder = "Describe the image to generate…";
      input.value = state.currentPrompt;
    }
    if (send) send.textContent = "Generate";
    if (editor) editor.readOnly = false;
    return;
  }
  if (heading) heading.textContent = creating ? "Describe the image" : "Describe the next change";
  if (hint) hint.textContent = creating ? "KoboldCpp will create the initial prompt" : "Leave empty to reroll";
  if (input) input.placeholder = creating ? "A portrait of an astronaut in a greenhouse…" : "Make the background more varied…";
  if (send) send.textContent = creating ? "Create & Generate" : "Revise & Generate";
  if (editor) editor.readOnly = creating;
}

function updateAmplificationMode({ announce = true, persist = true } = {}) {
  const enabled = useLlmAmplification();
  state.panel.dataset.useLlmAmplification = enabled ? "true" : "false";
  if (enabled) state.panel.querySelector("#lllm-revision").value = "";
  updateComposeMode();
  if (persist) saveSettings();
  if (!announce) return;
  if (enabled) {
    markControlsChanged();
  } else {
    setStatus("Direct prompt mode. KoboldCpp will not be used.", "ready");
  }
}

function syncManualPrompt(value) {
  if (useLlmAmplification()) return;
  const chat = activeChat();
  if (chat) chat.initialized = Boolean(value.trim());
  if (selectedSlot()) {
    writePromptToSlot(value);
  } else {
    updatePromptEditor(value);
    syncActiveChat();
  }
}

function createChat() {
  if (state.busy) return;
  syncActiveChat();
  const chat = normalizeChat({
    slotId: state.selectedSlotId,
    initialized: false,
    currentPrompt: "",
    versions: [""],
    versionIndex: 0,
    controlsFingerprint: "",
    messages: [],
  });
  state.chats.push(chat);
  state.activeChatId = chat.id;
  saveChats();
  activateChat(chat.id);
}

function deleteChat(chatId) {
  if (state.busy) return;
  const index = state.chats.findIndex((chat) => chat.id === chatId);
  if (index < 0) return;
  const chat = state.chats[index];
  const view = state.panel?.ownerDocument.defaultView;
  if (!view?.confirm(`Delete the chat from ${chatTitle(chat.createdAt)}? This cannot be undone.`)) return;
  const wasActive = chat.id === state.activeChatId;
  state.chats.splice(index, 1);
  if (!state.chats.length) {
    const replacement = normalizeChat({ slotId: state.selectedSlotId });
    state.chats.push(replacement);
  }
  if (wasActive) {
    const replacement = [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    state.activeChatId = replacement.id;
    activateChat(replacement.id);
  } else {
    renderChatList();
  }
  saveChats({ immediate: true });
}

function activateChat(chatId) {
  if (state.busy && chatId !== state.activeChatId) return;
  const chat = state.chats.find((item) => item.id === chatId);
  if (!chat) return;
  state.activeChatId = chat.id;
  const available = slots();
  const rememberedSlot = available.find((node) => String(node.id) === String(chat.slotId));
  if (rememberedSlot) state.selectedSlotId = String(rememberedSlot.id);
  else if (!selectedSlot() && available.length) state.selectedSlotId = String(available[0].id);
  const slotSelect = state.panel?.querySelector("#lllm-slot-select");
  if (slotSelect && state.selectedSlotId != null) slotSelect.value = String(state.selectedSlotId);
  state.currentPrompt = chat.currentPrompt;
  state.versions = [...chat.versions];
  state.versionIndex = chat.versionIndex;
  renderChatHistory();
  renderChatList();
  const node = selectedSlot();
  if (node) {
    chat.slotId = String(state.selectedSlotId);
    writePromptToSlot(chat.currentPrompt, { sync: false });
    loadSecondaryInstructionsFromNode(node);
    if (!useLlmAmplification()) {
      setStatus("Direct prompt mode. KoboldCpp will not be used.", "ready");
    } else if (!chat.initialized) {
      setStatus("Describe an image to create the first prompt.", "ready");
    } else if (controlsNeedApply()) {
      setStatus("Generation controls differ from this prompt. KoboldCpp will update it before generation.", "warning");
    } else {
      setStatus(`Attached to ${slotLabel(node)}`, "ready");
    }
  } else {
    updatePromptEditor(chat.currentPrompt);
    setStatus("This chat's prompt node is not available in the current workflow.", "warning");
  }
  const undo = state.panel?.querySelector("#lllm-undo");
  if (undo) undo.disabled = state.versionIndex <= 0 || state.busy;
  state.panel?.classList.remove("lllm-chats-open");
  saveChats();
}

function slots() {
  return (app.graph?._nodes || []).filter((node) => node.type === SLOT_TYPE || node.type === AMPLIFY_TYPE);
}

function widget(node, name) {
  return node?.widgets?.find((item) => item.name === name);
}

function promptWidget(node) {
  return widget(node, node?.type === AMPLIFY_TYPE ? "text" : "prompt");
}

function secondaryInstructionsWidget(node) {
  return widget(node, "secondary_instructions");
}

function loadSecondaryInstructionsFromNode(node) {
  const editor = state.panel?.querySelector("#lllm-secondary-instructions");
  const input = secondaryInstructionsWidget(node);
  if (editor && input) editor.value = String(input.value || "");
}

function writeSecondaryInstructionsToNode(value) {
  const node = selectedSlot();
  const input = secondaryInstructionsWidget(node);
  if (!node || !input) return;
  input.value = value;
  input.callback?.(value, app.canvas, node, app.canvas?.graph_mouse, {});
  node.graph?.setDirtyCanvas?.(true, true);
}

function slotLabel(node) {
  const named = String(widget(node, "slot_name")?.value || "").trim();
  return `${named || node.title || "Prompt Slot"} · node ${node.id}`;
}

function selectedSlot() {
  return slots().find((node) => String(node.id) === String(state.selectedSlotId)) || null;
}

function setStatus(text, kind = "") {
  const el = state.panel?.querySelector("#lllm-status");
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind;
}

function setBusy(busy) {
  state.busy = busy;
  state.panel?.querySelectorAll("button[data-disable-busy]").forEach((button) => {
    button.disabled = busy;
  });
  state.panel?.querySelectorAll(".lllm-mode-control input, .lllm-settings input, .lllm-settings select, .lllm-settings textarea, .lllm-secondary-details textarea")
    .forEach((control) => {
      control.disabled = busy;
    });
  const undo = state.panel?.querySelector("#lllm-undo");
  if (undo) undo.disabled = busy || state.versionIndex <= 0;
  const newChat = state.panel?.querySelector("#lllm-new-chat");
  if (newChat) newChat.disabled = busy;
  state.panel?.querySelectorAll(".lllm-chat-item").forEach((button) => {
    button.disabled = busy;
  });
}

function closeImageLightbox() {
  const lightbox = state.panel?.querySelector("#lllm-lightbox");
  if (!lightbox || lightbox.hidden) return;
  lightbox.hidden = true;
  const image = lightbox.querySelector("#lllm-lightbox-image");
  if (image) image.removeAttribute("src");
  state.lightboxTrigger?.focus({ preventScroll: true });
  state.lightboxTrigger = null;
}

function openImageLightbox(url, alt, trigger) {
  const lightbox = state.panel?.querySelector("#lllm-lightbox");
  if (!lightbox) return;
  const image = lightbox.querySelector("#lllm-lightbox-image");
  const open = lightbox.querySelector("#lllm-lightbox-open");
  image.src = url;
  image.alt = alt;
  open.href = url;
  state.lightboxTrigger = trigger;
  lightbox.hidden = false;
  lightbox.focus({ preventScroll: true });
}

function renderImageGallery(message, images) {
  if (!message || !images?.length) return;
  message.classList.add("lllm-has-images");
  const gallery = document.createElement("div");
  gallery.className = "lllm-image-grid";
  for (const item of images) {
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "lllm-image-preview";
    const params = new URLSearchParams({
      filename: item.filename || "",
      subfolder: item.subfolder || "",
      type: item.type || "output",
    });
    const url = `/view?${params}`;
    const image = document.createElement("img");
    image.src = url;
    image.alt = item.filename || "Generated image";
    preview.title = `Preview ${image.alt}`;
    preview.setAttribute("aria-label", preview.title);
    preview.addEventListener("click", () => openImageLightbox(url, image.alt, preview));
    preview.appendChild(image);
    gallery.appendChild(preview);
  }
  message.appendChild(gallery);
}

function useStoredCanonicalPrompt(data, details) {
  if (state.busy) return setStatus("Wait for the current operation to finish.", "warning");
  const prompt = String(data.canonicalPrompt || "");
  if (!prompt.trim()) return;
  const previousVersion = state.versions[state.versionIndex];
  const chat = activeChat();
  if (chat) {
    chat.initialized = true;
    chat.controlsFingerprint = data.llmAmplified ? String(data.controlsFingerprint || "") : "";
  }
  if (selectedSlot()) writePromptToSlot(prompt);
  else updatePromptEditor(prompt);
  if (previousVersion !== prompt) pushVersion(prompt);
  else syncActiveChat();
  updateComposeMode();
  details.open = false;
  if (controlsNeedApply()) {
    setStatus("Prompt restored. KoboldCpp will apply the current controls before generation.", "warning");
  } else {
    setStatus("Prompt restored from this generation.", "ready");
  }
}

function renderPromptInfo(message, data) {
  if (!message || !data?.canonicalPrompt || !data.images?.length || message.querySelector(".lllm-prompt-info")) return;
  message.classList.add("lllm-has-prompt");
  const details = document.createElement("details");
  details.className = "lllm-prompt-info";
  const summary = document.createElement("summary");
  summary.textContent = "i";
  summary.title = "Show the canonical prompt used for this generation";
  summary.setAttribute("aria-label", summary.title);
  const panel = document.createElement("div");
  panel.className = "lllm-prompt-info-panel";
  const heading = document.createElement("strong");
  heading.textContent = "Canonical prompt used";
  const text = document.createElement("div");
  text.className = "lllm-prompt-info-text";
  text.textContent = data.canonicalPrompt;
  const usePrompt = document.createElement("button");
  usePrompt.type = "button";
  usePrompt.dataset.disableBusy = "";
  usePrompt.disabled = state.busy;
  usePrompt.textContent = "Use this prompt";
  usePrompt.addEventListener("click", () => useStoredCanonicalPrompt(data, details));
  panel.append(heading, text, usePrompt);
  details.append(summary, panel);
  message.appendChild(details);
}

function renderMessage(data) {
  const history = state.panel?.querySelector("#lllm-history");
  if (!history) return null;
  const message = document.createElement("div");
  message.className = `lllm-message lllm-${data.role}`;
  message.dataset.messageId = data.id;

  if (data.label) {
    const label = document.createElement("div");
    label.className = "lllm-message-label";
    label.textContent = data.label;
    message.appendChild(label);
  }

  const body = document.createElement("div");
  body.className = "lllm-message-text";
  body.textContent = data.text;
  message.appendChild(body);
  renderImageGallery(message, data.images);
  renderPromptInfo(message, data);

  history.appendChild(message);
  history.scrollTop = history.scrollHeight;
  return message;
}

function appendMessage(role, text, options = {}) {
  const data = {
    id: makeId(),
    role,
    text: String(text || ""),
    label: options.label || "",
    images: [],
    canonicalPrompt: String(options.canonicalPrompt || ""),
    controlsFingerprint: String(options.controlsFingerprint || ""),
    llmAmplified: Boolean(options.llmAmplified),
    createdAt: Date.now(),
  };
  const chat = activeChat();
  if (chat) {
    chat.messages.push(data);
    chat.updatedAt = Date.now();
    saveChats();
    renderChatList();
  }
  return renderMessage(data);
}

function appendImages(message, images) {
  if (!message || !images.length) return;
  renderImageGallery(message, images);
  const chat = activeChat();
  const stored = chat?.messages.find((item) => item.id === message.dataset.messageId);
  if (stored) {
    stored.images = images;
    renderPromptInfo(message, stored);
    chat.updatedAt = Date.now();
    saveChats();
    renderChatList();
  }
  const history = state.panel?.querySelector("#lllm-history");
  if (history) history.scrollTop = history.scrollHeight;
}

function updatePromptEditor(prompt) {
  state.currentPrompt = prompt;
  const editor = state.panel?.querySelector("#lllm-current-prompt");
  if (editor) editor.value = prompt;
}

function writePromptToSlot(prompt, { sync = true } = {}) {
  const node = selectedSlot();
  const input = promptWidget(node);
  if (!node || !input) throw new Error("The selected prompt node is no longer available.");
  input.value = prompt;
  input.callback?.(prompt, app.canvas, node, app.canvas?.graph_mouse, {});
  node.graph?.setDirtyCanvas?.(true, true);
  updatePromptEditor(prompt);
  if (sync) syncActiveChat();
}

function pushVersion(prompt) {
  state.versions = state.versions.slice(0, state.versionIndex + 1);
  state.versions.push(prompt);
  state.versionIndex = state.versions.length - 1;
  const undo = state.panel?.querySelector("#lllm-undo");
  if (undo) undo.disabled = state.versionIndex <= 0 || state.busy;
  syncActiveChat();
}

function attachSelectedSlot({ announce = true, useSlotPrompt = false } = {}) {
  const node = selectedSlot();
  if (!node) {
    updatePromptEditor(activeChat()?.currentPrompt || "");
    setStatus("Add a KoboldCpp Prompt Slot or Prompt Amplify node to this workflow.", "warning");
    return;
  }
  const chat = activeChat();
  loadSecondaryInstructionsFromNode(node);
  const slotPrompt = String(promptWidget(node)?.value || "");
  const prompt = chat?.initialized ? (useSlotPrompt ? slotPrompt : chat.currentPrompt) : "";
  if (chat?.initialized && (useSlotPrompt || !chat.versions?.length)) {
    state.versions = [prompt];
    state.versionIndex = 0;
  } else {
    state.versions = [...(chat?.versions || [""])];
    state.versionIndex = chat?.versionIndex || 0;
  }
  writePromptToSlot(prompt, { sync: false });
  syncActiveChat();
  if (!useLlmAmplification()) {
    setStatus("Direct prompt mode. KoboldCpp will not be used.", "ready");
  } else if (!chat?.initialized) {
    setStatus("Describe an image to create the first prompt.", "ready");
  } else if (controlsNeedApply()) {
    setStatus("Generation controls differ from this prompt. KoboldCpp will update it before generation.", "warning");
  } else {
    setStatus(`Attached to ${slotLabel(node)}`, "ready");
  }
  if (announce) appendMessage("system", `Attached to ${slotLabel(node)}.`);
}

function refreshSlots() {
  const select = state.panel?.querySelector("#lllm-slot-select");
  if (!select) return;
  const available = slots();
  const previous = String(activeChat()?.slotId ?? state.selectedSlotId ?? "");
  select.replaceChildren();
  for (const node of available) {
    const option = document.createElement("option");
    option.value = String(node.id);
    option.textContent = slotLabel(node);
    select.appendChild(option);
  }
  if (available.some((node) => String(node.id) === previous)) {
    select.value = previous;
  } else if (available.length) {
    select.value = String(available[0].id);
  }
  state.selectedSlotId = select.value || null;
  attachSelectedSlot({ announce: false });
  renderChatHistory();
  renderChatList();
}

function setOptions(selectId, values, selected) {
  const select = state.panel?.querySelector(`#${selectId}`);
  if (!select) return;
  select.replaceChildren();
  for (const value of values || []) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
}

async function loadConfig() {
  const response = await api.fetchApi("/lllm/prompt-studio/config");
  if (!response.ok) throw new Error(`Could not load Prompt Studio configuration (${response.status}).`);
  state.config = await response.json();
  const settings = getSettings();
  setOptions("lllm-profile", state.config.profiles, settings.model_profile);
  setOptions("lllm-style", state.config.styles, settings.style_preset);
  setOptions("lllm-framing", state.config.framings, settings.framing_preset);
  setOptions("lllm-thinking", state.config.thinking_modes, settings.thinking_mode);
  setOptions("lllm-embellishment", state.config.embellishment_levels, settings.embellishment_level);
}

function collectRevisionPayload(revision, mode = "revise") {
  const value = (id) => state.panel.querySelector(`#${id}`)?.value;
  return {
    current_prompt: state.currentPrompt,
    revision,
    mode,
    kobold_url: value("lllm-kobold-url"),
    model_profile: value("lllm-profile"),
    style_preset: value("lllm-style"),
    framing_preset: value("lllm-framing"),
    style_modifier: value("lllm-style-modifier"),
    framing_modifier: value("lllm-framing-modifier"),
    thinking_mode: value("lllm-thinking"),
    embellishment_level: value("lllm-embellishment"),
    max_response_tokens: Number(value("lllm-max-tokens") || 0),
    temperature: Number(value("lllm-temperature") || 0.7),
  };
}

function randomizeWorkflowSeeds() {
  for (const node of app.graph?._nodes || []) {
    for (const item of node.widgets || []) {
      if (!/^(seed|noise_seed)$/i.test(item.name || "")) continue;
      const next = Math.floor(Math.random() * 0x100000000);
      item.value = next;
      item.callback?.(next, app.canvas, node, app.canvas?.graph_mouse, {});
    }
  }
}

function historyImages(historyItem) {
  const images = [];
  for (const output of Object.values(historyItem?.outputs || {})) {
    if (Array.isArray(output?.images)) images.push(...output.images);
    if (Array.isArray(output?.gifs)) images.push(...output.gifs);
  }
  return images;
}

async function waitForResult(promptId, targetMessage, token) {
  const started = Date.now();
  while (token === state.pollToken && Date.now() - started < 10 * 60 * 1000) {
    const response = await api.fetchApi(`/history/${encodeURIComponent(promptId)}`);
    if (response.ok) {
      const history = await response.json();
      const item = history?.[promptId];
      if (item) {
        const images = historyImages(item);
        const completed = Boolean(item.status?.completed);
        if (images.length || completed) {
          appendImages(targetMessage, images);
          if (item.status?.status_str === "error") {
            setStatus("Generation failed. See the ComfyUI console for details.", "error");
          } else if (images.length) {
            setStatus(`Generated ${images.length} image${images.length === 1 ? "" : "s"}.`, "ready");
          } else {
            setStatus("Generation completed without an image output.", "warning");
          }
          setBusy(false);
          state.generating = false;
          return;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  if (token === state.pollToken) {
    setStatus("Stopped waiting for the generation result.", "warning");
    state.generating = false;
    setBusy(false);
  }
}

async function queueCurrentPrompt() {
  if (!selectedSlot()) throw new Error("Select a prompt node before generating.");
  writePromptToSlot(state.currentPrompt);
  const secondaryInstructions = state.panel.querySelector("#lllm-secondary-instructions")?.value || "";
  writeSecondaryInstructionsToNode(secondaryInstructions);
  if (state.panel.querySelector("#lllm-randomize-seed")?.checked) randomizeWorkflowSeeds();
  const snapshot = structuredClone(await app.graphToPrompt());
  const apiNode = snapshot.output?.[String(state.selectedSlotId)];
  if (!apiNode || ![SLOT_TYPE, AMPLIFY_TYPE].includes(apiNode.class_type)) {
    throw new Error("The selected prompt node was not included in the executable workflow.");
  }
  if (apiNode.class_type === AMPLIFY_TYPE) {
    apiNode.class_type = SLOT_TYPE;
    apiNode.inputs = {
      prompt: state.currentPrompt,
      slot_name: slotLabel(selectedSlot()),
      secondary_instructions: secondaryInstructions,
    };
  } else {
    apiNode.inputs.prompt = state.currentPrompt;
    apiNode.inputs.secondary_instructions = secondaryInstructions;
  }
  const queued = await api.queuePrompt(-1, snapshot);
  const promptId = queued?.prompt_id;
  if (!promptId) throw new Error("ComfyUI did not return a prompt ID.");
  const chat = activeChat();
  const resultMessage = appendMessage("assistant", `Queued generation ${promptId.slice(0, 8)}…`, {
    label: "ComfyUI",
    canonicalPrompt: state.currentPrompt,
    controlsFingerprint: chat?.controlsFingerprint || "",
    llmAmplified: useLlmAmplification(),
  });
  state.generating = true;
  setStatus("ComfyUI is generating…", "working");
  const token = ++state.pollToken;
  waitForResult(promptId, resultMessage, token).catch((error) => {
    if (token !== state.pollToken) return;
    setStatus(error.message || String(error), "error");
    state.generating = false;
    setBusy(false);
  });
}

async function generateDirectPrompt() {
  if (state.busy) return;
  if (!selectedSlot()) return setStatus("Add or select a Prompt Slot or Prompt Amplify node first.", "warning");
  const input = state.panel.querySelector("#lllm-revision");
  const prompt = input.value.trim();
  if (!prompt) return setStatus("Enter a prompt before generating.", "warning");
  const previousVersion = state.versions[state.versionIndex];
  const chat = activeChat();
  if (chat) chat.initialized = true;
  input.value = prompt;
  writePromptToSlot(prompt);
  if (previousVersion !== prompt) pushVersion(prompt);
  saveSettings();
  setBusy(true);
  setStatus("ComfyUI is generating the direct prompt…", "working");
  try {
    await queueCurrentPrompt();
  } catch (error) {
    setStatus(error.message || String(error), "error");
    setBusy(false);
  }
}

async function reviseAndMaybeGenerate({ controlsOnly = false, forceGenerate = false } = {}) {
  if (state.busy) return;
  if (!useLlmAmplification()) return generateDirectPrompt();
  const input = state.panel.querySelector("#lllm-revision");
  const revision = input.value.trim();
  const editedPrompt = state.panel.querySelector("#lllm-current-prompt").value.trim();
  const creating = !activeChat()?.initialized;
  if (!selectedSlot()) return setStatus("Add or select a Prompt Slot or Prompt Amplify node first.", "warning");
  if (creating && !revision) return setStatus("Describe an image to create the first prompt.", "warning");
  if (!creating && !editedPrompt) return setStatus("The current prompt is empty.", "warning");
  controlsOnly = !creating && (controlsOnly || (!revision && controlsNeedApply()));
  if (!revision && !controlsOnly) return reroll({ applyControls: false });

  if (!creating && editedPrompt !== state.currentPrompt) {
    writePromptToSlot(editedPrompt);
    pushVersion(editedPrompt);
  }
  if (revision && !controlsOnly) {
    appendMessage("user", revision);
    input.value = "";
  }
  saveSettings();
  const operationToken = ++state.operationToken;
  setBusy(true);
  setStatus(
    creating
      ? "KoboldCpp is creating the initial prompt…"
      : controlsOnly
        ? "KoboldCpp is applying the changed generation controls…"
        : "KoboldCpp is revising the prompt…",
    "working",
  );
  const requestedControlsFingerprint = controlsFingerprint();
  const effectiveRevision = controlsOnly
    ? "Rewrite the current prompt so it fully follows the active model profile, style preset or modifier, framing preset or modifier, and embellishment controls. Preserve the concrete subject matter and requested content unless an active control explicitly conflicts with it."
    : revision;

  try {
    const response = await api.fetchApi("/lllm/prompt-studio/revise", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectRevisionPayload(effectiveRevision, creating ? "create" : "revise")),
    });
    const data = await response.json().catch(() => ({}));
    if (operationToken !== state.operationToken) return;
    if (!response.ok) {
      const action = creating ? "Prompt creation" : "Revision";
      throw new Error(data.error || `${action} failed (${response.status}).`);
    }
    const prompt = String(data.prompt || "").trim();
    if (!prompt) throw new Error("KoboldCpp returned an empty prompt.");
    const chat = activeChat();
    if (creating) {
      writePromptToSlot(prompt, { sync: false });
      state.versions = [prompt];
      state.versionIndex = 0;
      if (chat) chat.initialized = true;
      syncActiveChat();
      updateComposeMode();
    } else {
      writePromptToSlot(prompt);
      pushVersion(prompt);
    }
    if (chat) {
      chat.controlsFingerprint = requestedControlsFingerprint;
      saveChats();
    }
    setStatus(creating ? "Initial prompt created." : "Prompt revised.", "ready");
    if (forceGenerate || state.panel.querySelector("#lllm-auto-generate")?.checked) {
      await queueCurrentPrompt();
    } else {
      setBusy(false);
    }
  } catch (error) {
    if (operationToken !== state.operationToken) return;
    appendMessage("system", error.message || String(error));
    setStatus(error.message || String(error), "error");
    setBusy(false);
  }
}

async function reroll({ applyControls = true } = {}) {
  if (state.busy) return;
  if (!useLlmAmplification()) return generateDirectPrompt();
  if (!activeChat()?.initialized) return setStatus("Create the first prompt before rerolling.", "warning");
  if (applyControls && controlsNeedApply()) {
    return reviseAndMaybeGenerate({ controlsOnly: true, forceGenerate: true });
  }
  const editedPrompt = state.panel.querySelector("#lllm-current-prompt").value.trim();
  if (!editedPrompt) return setStatus("The current prompt is empty.", "warning");
  if (editedPrompt !== state.currentPrompt) {
    writePromptToSlot(editedPrompt);
    pushVersion(editedPrompt);
  }
  saveSettings();
  setBusy(true);
  try {
    await queueCurrentPrompt();
  } catch (error) {
    setStatus(error.message || String(error), "error");
    setBusy(false);
  }
}

function undoPrompt() {
  if (state.busy || state.versionIndex <= 0) return;
  state.versionIndex -= 1;
  const prompt = state.versions[state.versionIndex];
  writePromptToSlot(prompt);
  updateComposeMode();
  appendMessage("system", `Restored prompt version ${state.versionIndex + 1}.`);
  state.panel.querySelector("#lllm-undo").disabled = state.versionIndex <= 0;
}

async function interrupt() {
  state.operationToken += 1;
  state.pollToken += 1;
  try {
    if (state.generating) {
      if (typeof api.interrupt === "function") await api.interrupt();
      else await api.fetchApi("/interrupt", { method: "POST" });
      setStatus("Generation interrupt requested.", "warning");
    } else {
      setStatus("Prompt revision cancelled.", "warning");
    }
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    state.generating = false;
    setBusy(false);
  }
}

function buildPanel() {
  const settings = getSettings();
  const panel = document.createElement("section");
  panel.id = "lllm-prompt-studio";
  panel.hidden = true;
  panel.innerHTML = `
    <aside class="lllm-chat-sidebar">
      <div class="lllm-chat-sidebar-header">
        <div><span>Prompt Studio</span><strong>Sessions</strong></div>
        <button id="lllm-new-chat" type="button">New chat</button>
      </div>
      <div id="lllm-chat-list" class="lllm-chat-list"></div>
    </aside>
    <main class="lllm-main">
      <div id="lllm-history" class="lllm-history"></div>
      <div class="lllm-compose">
        <div class="lllm-compose-heading"><strong id="lllm-compose-title">Describe the next change</strong><span id="lllm-compose-hint">Leave empty to reroll</span></div>
        <textarea id="lllm-revision" rows="3" placeholder="Make the background more varied…"></textarea>
        <div class="lllm-compose-footer">
          <div class="lllm-toggles">
            <label class="lllm-auto-generate-toggle"><input id="lllm-auto-generate" type="checkbox" ${settings.auto_generate ? "checked" : ""} /> Generate after revision</label>
            <label><input id="lllm-randomize-seed" type="checkbox" ${settings.randomize_seed ? "checked" : ""} /> New seed</label>
          </div>
          <div class="lllm-actions">
            <button id="lllm-toggle-inspector" class="lllm-inspector-button" type="button">Settings</button>
            <button id="lllm-undo" type="button" data-disable-busy disabled>Undo</button>
            <button id="lllm-stop" type="button">Stop</button>
            <button id="lllm-reroll" type="button" data-disable-busy>Reroll</button>
            <button id="lllm-send" class="lllm-primary" type="button" data-disable-busy>Revise & Generate</button>
          </div>
        </div>
      </div>
    </main>
    <aside class="lllm-inspector">
      <header class="lllm-header">
        <div class="lllm-brand">
          <span class="lllm-brand-mark">PS</span>
          <div><strong>Prompt Studio</strong><span>Iterative local generation</span></div>
        </div>
        <div class="lllm-header-actions">
          <button id="lllm-toggle-chats" class="lllm-chats-button" type="button" title="Show chats" aria-label="Show chats">Sessions</button>
          <button id="lllm-popout" type="button" title="Open Prompt Studio in its own tab" aria-label="Open Prompt Studio in its own tab">↗</button>
          <button id="lllm-toggle-studio-settings" type="button" title="Prompt Studio settings" aria-label="Prompt Studio settings" aria-expanded="false">⚙</button>
          <button id="lllm-close" type="button" title="Close Prompt Studio" aria-label="Close Prompt Studio">×</button>
        </div>
        <div id="lllm-studio-settings" class="lllm-studio-settings" hidden>
          <div class="lllm-studio-settings-heading"><strong>Settings</strong><span>Interface</span></div>
          <label class="lllm-image-scale-control">
            <span><strong>Image scale</strong><output id="lllm-image-scale-value" for="lllm-image-scale">100%</output></span>
            <input id="lllm-image-scale" type="range" min="30" max="100" step="5" value="${settings.image_scale}" />
            <small>Scale generated images in chat. Full-size preview is unchanged.</small>
          </label>
        </div>
      </header>
      <section class="lllm-toolbar">
        <label class="lllm-slot-control">
          <span>Workflow prompt</span>
          <div class="lllm-attach-row">
            <select id="lllm-slot-select" aria-label="Prompt node"></select>
            <button id="lllm-refresh-slots" type="button" title="Refresh prompt nodes">↻</button>
          </div>
        </label>
        <div id="lllm-status" class="lllm-status">Loading…</div>
      </section>
      <section class="lllm-mode-control">
        <label>
          <input id="lllm-use-llm-amplification" type="checkbox" ${settings.use_llm_amplification ? "checked" : ""} />
          <span><strong>Use LLM amplification</strong><small>Rewrite prompts through KoboldCpp</small></span>
        </label>
      </section>
      <section class="lllm-control-deck">
        <details class="lllm-current-details" open>
          <summary><span>Canonical prompt</span><small>Used for the next generation</small></summary>
          <textarea id="lllm-current-prompt" rows="8" placeholder="The selected prompt node's current text"></textarea>
        </details>
        <details class="lllm-settings" open>
          <summary><span>Generation controls</span><small>Model, style and LLM settings</small></summary>
          <div class="lllm-settings-grid">
            <label>Model profile<select id="lllm-profile"></select></label>
            <label>Style<select id="lllm-style"></select></label>
            <label>Framing<select id="lllm-framing"></select></label>
            <label>Embellishment<select id="lllm-embellishment"></select></label>
            <label>Thinking<select id="lllm-thinking"></select></label>
            <label>KoboldCpp URL<input id="lllm-kobold-url" /></label>
            <label>Style modifier<textarea id="lllm-style-modifier" rows="2"></textarea></label>
            <label>Framing modifier<textarea id="lllm-framing-modifier" rows="2"></textarea></label>
            <label>Max response tokens<input id="lllm-max-tokens" type="number" min="0" max="8192" /></label>
            <label>Temperature<input id="lllm-temperature" type="number" min="0" max="5" step="0.05" /></label>
          </div>
        </details>
        <details class="lllm-secondary-details" open>
          <summary><span>Secondary instructions</span><small>Optional pass-through output</small></summary>
          <textarea id="lllm-secondary-instructions" rows="3" placeholder="Returned unchanged from the secondary output"></textarea>
        </details>
      </section>
    </aside>
    <div id="lllm-lightbox" class="lllm-lightbox" role="dialog" aria-modal="true" aria-label="Image preview" tabindex="-1" hidden>
      <img id="lllm-lightbox-image" alt="" />
      <div class="lllm-lightbox-actions">
        <a id="lllm-lightbox-open" href="#" target="_blank" rel="noopener" title="Open image in new tab" aria-label="Open image in new tab">↗</a>
        <button id="lllm-lightbox-close" type="button" title="Close image preview" aria-label="Close image preview">×</button>
      </div>
    </div>`;
  document.body.appendChild(panel);
  state.panel = panel;

  panel.querySelector("#lllm-kobold-url").value = settings.kobold_url;
  panel.querySelector("#lllm-max-tokens").value = settings.max_response_tokens;
  panel.querySelector("#lllm-temperature").value = settings.temperature;
  panel.querySelector("#lllm-style-modifier").value = settings.style_modifier;
  panel.querySelector("#lllm-framing-modifier").value = settings.framing_modifier;
  panel.querySelector("#lllm-secondary-instructions").value = settings.secondary_instructions;
  applyImageScale(settings.image_scale);
  updateAmplificationMode({ announce: false, persist: false });
  panel.querySelector("#lllm-toggle-chats").addEventListener("click", () => {
    panel.classList.remove("lllm-inspector-open");
    panel.classList.toggle("lllm-chats-open");
  });
  panel.querySelector("#lllm-toggle-inspector").addEventListener("click", () => {
    panel.classList.remove("lllm-chats-open");
    panel.classList.toggle("lllm-inspector-open");
  });
  panel.querySelector("#lllm-toggle-studio-settings").addEventListener("click", () => toggleStudioSettings());
  panel.addEventListener("click", (event) => {
    const popover = panel.querySelector("#lllm-studio-settings");
    if (popover.hidden || popover.contains(event.target) || event.target === panel.querySelector("#lllm-toggle-studio-settings")) return;
    toggleStudioSettings(false);
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || panel.querySelector("#lllm-studio-settings").hidden) return;
    toggleStudioSettings(false);
    panel.querySelector("#lllm-toggle-studio-settings").focus();
  });
  panel.querySelector("#lllm-lightbox").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeImageLightbox();
  });
  panel.querySelector("#lllm-lightbox").addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeImageLightbox();
  });
  panel.querySelector("#lllm-lightbox-close").addEventListener("click", closeImageLightbox);
  panel.querySelector("#lllm-new-chat").addEventListener("click", createChat);
  panel.querySelector("#lllm-popout").addEventListener("click", togglePopout);
  panel.querySelector("#lllm-close").addEventListener("click", () => togglePanel(false));
  panel.querySelector("#lllm-refresh-slots").addEventListener("click", refreshSlots);
  panel.querySelector("#lllm-slot-select").addEventListener("change", (event) => {
    state.selectedSlotId = event.target.value || null;
    attachSelectedSlot({ useSlotPrompt: true });
  });
  panel.querySelector("#lllm-send").addEventListener("click", reviseAndMaybeGenerate);
  panel.querySelector("#lllm-reroll").addEventListener("click", reroll);
  panel.querySelector("#lllm-undo").addEventListener("click", undoPrompt);
  panel.querySelector("#lllm-stop").addEventListener("click", interrupt);
  panel.querySelector("#lllm-use-llm-amplification").addEventListener("change", () => updateAmplificationMode());
  panel.querySelector("#lllm-secondary-instructions").addEventListener("input", (event) => {
    writeSecondaryInstructionsToNode(event.target.value);
  });
  panel.querySelector("#lllm-secondary-instructions").addEventListener("change", saveSettings);
  panel.querySelector("#lllm-revision").addEventListener("input", (event) => {
    syncManualPrompt(event.target.value);
  });
  panel.querySelector("#lllm-revision").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      reviseAndMaybeGenerate();
    }
  });
  panel.querySelectorAll(".lllm-settings input, .lllm-settings select, .lllm-settings textarea")
    .forEach((element) => element.addEventListener("change", markControlsChanged));
  panel.querySelectorAll(".lllm-toggles input")
    .forEach((element) => element.addEventListener("change", saveSettings));
  panel.querySelector("#lllm-image-scale").addEventListener("input", (event) => applyImageScale(event.target.value));
  panel.querySelector("#lllm-image-scale").addEventListener("change", saveSettings);
}

function buildLauncher() {
  const button = document.createElement("button");
  button.id = "lllm-prompt-studio-launcher";
  button.type = "button";
  button.title = "Open Prompt Studio";
  button.textContent = "Prompt Studio";
  button.addEventListener("click", () => togglePanel());
  document.body.appendChild(button);
  state.launcher = button;
}

function updatePopoutButton() {
  const button = state.panel?.querySelector("#lllm-popout");
  if (!button) return;
  const popped = Boolean(state.popup && !state.popup.closed && state.panel.ownerDocument === state.popup.document);
  button.textContent = popped ? "↙" : "↗";
  button.title = popped ? "Return Prompt Studio to ComfyUI" : "Open Prompt Studio in its own tab";
  button.setAttribute("aria-label", button.title);
}

function dockPanel({ closePopup = true, keepOpen = true } = {}) {
  const popup = state.popup;
  if (state.panel.ownerDocument !== document) document.body.appendChild(state.panel);
  state.panel.hidden = !keepOpen;
  state.popup = null;
  updatePopoutButton();
  state.launcher.dataset.open = keepOpen ? "true" : "false";
  if (closePopup && popup && !popup.closed) {
    state.dockingPopup = true;
    popup.close();
    state.dockingPopup = false;
  }
}

async function attachStandalone(popup) {
  if (!popup || popup.closed) return false;
  try {
    if (popup.location.origin !== window.location.origin) return false;
  } catch (_) {
    return false;
  }
  const mount = popup.document.querySelector("#lllm-popout-mount");
  if (!mount) return false;
  if (state.popup && state.popup !== popup && !state.popup.closed) dockPanel();
  state.popup = popup;
  mount.replaceChildren(state.panel);
  state.panel.hidden = false;
  state.launcher.dataset.open = "true";
  updatePopoutButton();
  popup.addEventListener("beforeunload", () => {
    if (!state.dockingPopup && state.popup === popup) dockPanel({ closePopup: false, keepOpen: true });
  }, { once: true });
  await togglePanel(true);
  return true;
}

function setupStandaloneBridge() {
  globalThis.__lllmPromptStudioHost = { attach: attachStandalone };
  if (typeof BroadcastChannel !== "function") return;
  state.standaloneChannel?.close();
  const channel = new BroadcastChannel(STANDALONE_CHANNEL);
  state.standaloneChannel = channel;
  channel.addEventListener("message", async (event) => {
    const data = event.data;
    if (data?.type !== "connect" || !data.windowName || !data.requestId) return;
    const popup = window.open("", data.windowName);
    const connected = await attachStandalone(popup);
    channel.postMessage({ type: connected ? "connected" : "failed", requestId: data.requestId });
  });
}

function togglePopout() {
  if (state.popup && !state.popup.closed) {
    dockPanel();
    return;
  }

  const pageUrl = new URL("../prompt_studio.html", import.meta.url).href;
  const popup = window.open(pageUrl, "_blank");
  if (!popup) {
    setStatus("The browser blocked the Prompt Studio tab. Allow pop-ups for ComfyUI and try again.", "warning");
    return;
  }

  state.popup = popup;
  state.launcher.dataset.open = "true";
  const mountPanel = () => {
    if (popup.closed || state.popup !== popup) return;
    attachStandalone(popup).then((connected) => {
      if (connected) return;
      setStatus("Prompt Studio could not initialize its standalone page.", "error");
      dockPanel();
    });
  };
  const onStandaloneLoad = () => {
    if (!popup.location.pathname.endsWith("/prompt_studio.html")) return;
    popup.removeEventListener("load", onStandaloneLoad);
    mountPanel();
  };
  popup.addEventListener("load", onStandaloneLoad);
  if (popup.location.pathname.endsWith("/prompt_studio.html") && popup.document.readyState === "complete") {
    onStandaloneLoad();
  }
  popup.focus();
}

async function togglePanel(force) {
  const show = force ?? state.panel.hidden;
  if (!show) closeImageLightbox();
  if (!show && state.popup && !state.popup.closed) {
    saveSettings();
    dockPanel({ closePopup: true, keepOpen: false });
    return;
  }
  state.panel.hidden = !show;
  state.launcher.dataset.open = show ? "true" : "false";
  if (!show) return saveSettings();
  refreshSlots();
  try {
    if (!state.config) await loadConfig();
    refreshSlots();
  } catch (error) {
    setStatus(error.message || String(error), "error");
  }
}

app.registerExtension({
  name: EXTENSION_NAME,
  async setup() {
    loadCss();
    buildPanel();
    await loadChats();
    buildLauncher();
    refreshSlots();
    setupStandaloneBridge();
  },
});
