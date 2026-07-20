import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const EXTENSION_NAME = "ComfyUI_LLLM.PromptStudio";
const SLOT_TYPE = "KCPP_PromptSlot";
const AMPLIFY_TYPE = "KCPP_PromptAmplify";
const IMAGE_SOURCE_TYPE = "KCPP_ChatImageInput";
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
  popupCloseTimer: null,
  dockingPopup: false,
  returnToEmbedded: false,
  standaloneChannel: null,
  config: null,
  selectedSlotId: null,
  currentPrompt: "",
  versions: [],
  versionIndex: -1,
  busy: false,
  generating: false,
  queueing: false,
  operationToken: 0,
  pollToken: 0,
  chats: [],
  activeChatId: null,
  chatRevision: 0,
  chatStoreLoaded: false,
  chatPersistenceBlocked: false,
  workflowProfiles: [],
  managedWorkflowProfileId: null,
  workflowRevision: 0,
  workflowStoreLoaded: false,
  workflowSaveChain: Promise.resolve(),
  workflowBusy: false,
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
    auto_advance_source: true,
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
  try {
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
      auto_advance_source: checked("lllm-auto-advance-source"),
      image_scale: Number(value("lllm-image-scale") || 100),
      }),
    );
  } catch (error) {
    setStatus(error.message || "Prompt Studio settings could not be saved.", "warning");
  }
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
        executionPrompt: String(message?.executionPrompt || message?.canonicalPrompt || ""),
        generationAction: message?.generationAction === "edit" ? "edit" : "create",
        workflowProfileId: String(message?.workflowProfileId || ""),
        workflowName: String(message?.workflowName || ""),
        sourceImage: normalizeImageReference(message?.sourceImage),
        resultNodeIds: Array.isArray(message?.resultNodeIds) ? message.resultNodeIds.map(String) : [],
        resultFields: Array.isArray(message?.resultFields) && message.resultFields.length ? message.resultFields.map(String) : ["images", "gifs"],
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
    createWorkflowId: String(chat?.createWorkflowId || ""),
    editWorkflowId: String(chat?.editWorkflowId || ""),
    editPromptMode: ["edit_instruction", "full_prompt"].includes(chat?.editPromptMode) ? chat.editPromptMode : "",
    selectedSource: normalizeImageReference(chat?.selectedSource),
    lastGeneration: normalizeLastGeneration(chat?.lastGeneration),
    pendingGeneration: normalizePendingGeneration(chat?.pendingGeneration),
    messages,
  };
}

function normalizeImageReference(value) {
  if (!value || typeof value !== "object") return null;
  const filename = String(value.filename || "").trim();
  if (!filename) return null;
  return {
    filename,
    subfolder: String(value.subfolder || ""),
    type: ["input", "output", "temp"].includes(value.type) ? value.type : "output",
  };
}

function normalizeLastGeneration(value) {
  if (!value || typeof value !== "object") return null;
  return {
    action: value.action === "edit" ? "edit" : "create",
    canonicalPrompt: String(value.canonicalPrompt || ""),
    executionPrompt: String(value.executionPrompt || ""),
    workflowProfileId: String(value.workflowProfileId || ""),
    sourceImage: normalizeImageReference(value.sourceImage),
  };
}

function normalizePendingGeneration(value) {
  if (!value || typeof value !== "object") return null;
  return {
    action: value.action === "edit" ? "edit" : "create",
    canonicalPrompt: String(value.canonicalPrompt || ""),
    executionPrompt: String(value.executionPrompt || ""),
    workflowProfileId: String(value.workflowProfileId || ""),
  };
}

function saveChats({ immediate = false } = {}) {
  if (state.chatPersistenceBlocked || !state.chatStoreLoaded) return;
  if (state.chatSaveTimer) clearTimeout(state.chatSaveTimer);
  const persist = () => {
    state.chatSaveTimer = null;
    const snapshot = structuredClone({ activeChatId: state.activeChatId, chats: state.chats });
    state.chatSaveChain = state.chatSaveChain
      .catch(() => {})
      .then(async () => {
        if (state.chatPersistenceBlocked) return;
        const response = await api.fetchApi("/lllm/prompt-studio/chats", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...snapshot, revision: state.chatRevision }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (response.status === 409) state.chatPersistenceBlocked = true;
          throw new Error(data.error || `Chat save failed (${response.status}).`);
        }
        state.chatRevision = Number(data.revision || state.chatRevision);
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
    state.chatRevision = Number(stored.revision || 0);
    state.chatStoreLoaded = true;
    state.chatPersistenceBlocked = false;
    state.activeChatId = state.chats.some((chat) => chat.id === stored.activeChatId)
      ? stored.activeChatId
      : state.chats[0]?.id || null;
  } catch (error) {
    state.chats = [];
    state.activeChatId = null;
    state.chatStoreLoaded = false;
    state.chatPersistenceBlocked = true;
    setStatus(error.message || "Chat history could not be loaded.", "warning");
  }
  if (!state.chats.length) {
    const chat = normalizeChat({});
    state.chats.push(chat);
    state.activeChatId = chat.id;
    if (state.chatStoreLoaded) saveChats({ immediate: true });
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
  chat.createWorkflowId = state.panel?.querySelector("#lllm-create-workflow")?.value || "";
  chat.editWorkflowId = state.panel?.querySelector("#lllm-edit-workflow")?.value || "";
  chat.editPromptMode = selectedEditPromptMode();
  chat.updatedAt = Date.now();
  saveChats();
  renderChatList();
}

function normalizeWorkflowProfile(profile) {
  const snapshot = profile?.snapshot && typeof profile.snapshot === "object" ? profile.snapshot : null;
  return {
    id: String(profile?.id || makeId()),
    name: String(profile?.name || "Workflow").trim() || "Workflow",
    kind: profile?.kind === "edit" ? "edit" : "create",
    promptMode: profile?.promptMode === "edit_instruction" ? "edit_instruction" : "full_prompt",
    promptNodeId: String(profile?.promptNodeId || ""),
    imageNodeId: String(profile?.imageNodeId || ""),
    resultNodeIds: Array.isArray(profile?.resultNodeIds) ? profile.resultNodeIds.map(String) : [],
    resultFields: Array.isArray(profile?.resultFields) && profile.resultFields.length ? profile.resultFields.map(String) : ["images", "gifs"],
    snapshot,
    updatedAt: Number(profile?.updatedAt || Date.now()),
  };
}

async function loadWorkflowProfiles() {
  const response = await api.fetchApi("/lllm/prompt-studio/workflows");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Workflow profiles could not be loaded (${response.status}).`);
  state.workflowProfiles = Array.isArray(data.profiles) ? data.profiles.map(normalizeWorkflowProfile) : [];
  state.workflowRevision = Number(data.revision || 0);
  state.workflowStoreLoaded = true;
  refreshWorkflowControls();
}

async function saveWorkflowProfiles() {
  if (!state.workflowStoreLoaded) throw new Error("Workflow profiles were not loaded, so saving is disabled to protect the existing store.");
  const snapshot = structuredClone(state.workflowProfiles);
  const operation = state.workflowSaveChain
    .catch(() => {})
    .then(async () => {
      const response = await api.fetchApi("/lllm/prompt-studio/workflows", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, revision: state.workflowRevision, profiles: snapshot }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409) state.workflowStoreLoaded = false;
        throw new Error(data.error || `Workflow profiles could not be saved (${response.status}).`);
      }
      state.workflowRevision = Number(data.revision || state.workflowRevision);
    });
  state.workflowSaveChain = operation;
  return operation;
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
  const action = selectedAction();
  const autoGenerate = state.panel.querySelector("#lllm-auto-generate")?.checked !== false;
  const editPromptAction = state.panel.querySelector("#lllm-edit-prompt-action");
  if (editPromptAction) editPromptAction.hidden = action !== "edit";
  if (!amplificationEnabled) {
    if (heading) heading.textContent = "Canonical prompt";
    if (hint) hint.textContent = "Edit directly; no LLM call";
    if (input) {
      input.placeholder = "Describe the image to generate…";
      input.value = state.currentPrompt;
    }
    if (send) send.textContent = action === "edit" ? "Edit selected image" : "Create new image";
    if (editor) editor.readOnly = false;
    return;
  }
  if (heading) heading.textContent = creating ? "Describe the image" : "Describe the next change";
  if (hint) hint.textContent = creating ? "KoboldCpp will create the initial prompt" : "Leave empty to reroll";
  if (input) input.placeholder = creating ? "A portrait of an astronaut in a greenhouse…" : "Make the background more varied…";
  if (send) {
    if (!autoGenerate) send.textContent = creating ? "Create prompt" : "Revise prompt";
    else {
      send.textContent = action === "edit"
        ? (creating ? "Describe & edit selected" : "Revise & edit selected")
        : (creating ? "Create new image" : "Revise & create new");
    }
  }
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
  commitPromptEditorVersion();
  syncActiveChat();
  const chat = normalizeChat({
    slotId: state.selectedSlotId,
    initialized: false,
    currentPrompt: "",
    versions: [""],
    versionIndex: 0,
    controlsFingerprint: "",
    createWorkflowId: state.panel?.querySelector("#lllm-create-workflow")?.value || "",
    editWorkflowId: state.panel?.querySelector("#lllm-edit-workflow")?.value || "",
    editPromptMode: selectedEditPromptMode(),
    selectedSource: null,
    lastGeneration: null,
    pendingGeneration: null,
    messages: [],
  });
  state.chats.push(chat);
  state.activeChatId = chat.id;
  saveChats();
  activateChat(chat.id);
}

function deleteChat(chatId) {
  if (state.busy) return;
  if (chatId === state.activeChatId) commitPromptEditorVersion();
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
  if (chatId !== state.activeChatId) commitPromptEditorVersion();
  const chat = state.chats.find((item) => item.id === chatId);
  if (!chat) return;
  state.activeChatId = chat.id;
  const available = slots();
  const rememberedSlot = available.find((node) => String(node.id) === String(chat.slotId));
  if (rememberedSlot) state.selectedSlotId = String(rememberedSlot.id);
  else state.selectedSlotId = available.length ? String(available[0].id) : null;
  const slotSelect = state.panel?.querySelector("#lllm-slot-select");
  if (slotSelect && state.selectedSlotId != null) slotSelect.value = String(state.selectedSlotId);
  state.currentPrompt = chat.currentPrompt;
  state.versions = [...chat.versions];
  state.versionIndex = chat.versionIndex;
  refreshWorkflowControls();
  renderChatHistory();
  renderChatList();
  const node = selectedSlot();
  if (node) {
    chat.slotId = String(state.selectedSlotId);
    updatePromptEditor(chat.currentPrompt);
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

function nodeClassName(node) {
  return String(
    node?.comfyClass
    || node?.constructor?.nodeData?.name
    || node?.type
    || "",
  );
}

function slots() {
  return (app.graph?._nodes || []).filter((node) => [SLOT_TYPE, AMPLIFY_TYPE].includes(nodeClassName(node)));
}

function imageSources() {
  return (app.graph?._nodes || []).filter((node) => {
    const identifiers = [
      nodeClassName(node),
      String(node?.type || ""),
      String(node?.title || ""),
      String(node?.constructor?.nodeData?.display_name || ""),
    ];
    return identifiers.includes(IMAGE_SOURCE_TYPE)
      || identifiers.includes("Prompt Studio Image Source");
  });
}

function incompatibleImageLoaders() {
  const compatible = new Set(imageSources());
  return (app.graph?._nodes || []).filter((node) => {
    if (compatible.has(node)) return false;
    const identity = `${nodeClassName(node)} ${node?.type || ""} ${node?.title || ""}`;
    return /(?:load\s*image|image\s*loader)/i.test(identity);
  });
}

function widget(node, name) {
  return node?.widgets?.find((item) => item.name === name);
}

function promptWidget(node) {
  return widget(node, nodeClassName(node) === AMPLIFY_TYPE ? "text" : "prompt");
}

function secondaryInstructionsWidget(node) {
  return widget(node, "secondary_instructions");
}

function loadSecondaryInstructionsFromNode(node) {
  const editor = state.panel?.querySelector("#lllm-secondary-instructions");
  const profile = selectedWorkflowProfile(selectedAction());
  if (editor && profile) {
    editor.value = String(profile.snapshot?.output?.[profile.promptNodeId]?.inputs?.secondary_instructions || "");
    editor.disabled = true;
    editor.title = "Captured by the selected workflow profile. Update the profile from its canvas to change it.";
    return;
  }
  const input = secondaryInstructionsWidget(node);
  if (editor) {
    if (input) editor.value = String(input.value || "");
    editor.disabled = state.busy;
    editor.removeAttribute("title");
  }
}

function writeSecondaryInstructionsToNode(value) {
  if (selectedWorkflowProfile(selectedAction())) return;
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

function imageSourceLabel(node) {
  const named = String(widget(node, "source_name")?.value || "").trim();
  return `${named || node.title || "Edit Source"} · node ${node.id}`;
}

function outputNodeLabel(node) {
  return `${node.title || node.type || "Output"} · node ${node.id}`;
}

function outputCandidates() {
  return (app.graph?._nodes || []).filter((node) => {
    const data = node.constructor?.nodeData;
    return Boolean(data?.output_node || /(?:save|preview|output)/i.test(node.type || ""));
  });
}

function selectedAction() {
  return state.panel?.querySelector('input[name="lllm-generation-action"]:checked')?.value === "edit"
    ? "edit"
    : "create";
}

function selectedEditPromptMode() {
  return state.panel?.querySelector('input[name="lllm-edit-prompt-mode"]:checked')?.value === "edit_instruction"
    ? "edit_instruction"
    : "full_prompt";
}

function setEditPromptMode(mode, { persist = false } = {}) {
  const normalized = mode === "edit_instruction" ? "edit_instruction" : "full_prompt";
  const control = state.panel?.querySelector(`input[name="lllm-edit-prompt-mode"][value="${normalized}"]`);
  if (control) control.checked = true;
  if (persist) syncActiveChat();
}

function workflowProfileById(profileId) {
  return state.workflowProfiles.find((profile) => profile.id === String(profileId || "")) || null;
}

function selectedWorkflowProfileId(action = selectedAction()) {
  const selectId = action === "edit" ? "#lllm-edit-workflow" : "#lllm-create-workflow";
  return workflowProfileById(state.panel?.querySelector(selectId)?.value)?.id || "";
}

function selectedWorkflowProfile(action = selectedAction()) {
  return workflowProfileById(selectedWorkflowProfileId(action));
}

function announceWorkflowSelection(action) {
  syncActiveChat();
  const profile = selectedWorkflowProfile(action);
  loadSecondaryInstructionsFromNode(selectedSlot());
  setStatus(`${action === "edit" ? "Edit" : "Create"} will use ${profile ? `“${profile.name}”` : "the current canvas"}.`, "ready");
}

function fillWorkflowSelect(select, kind, remembered) {
  if (!select) return;
  select.replaceChildren();
  const current = document.createElement("option");
  current.value = "";
  current.textContent = "Current canvas";
  select.appendChild(current);
  for (const profile of state.workflowProfiles.filter((item) => item.kind === kind)) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    select.appendChild(option);
  }
  if ([...select.options].some((option) => option.value === remembered)) select.value = remembered;
}

function refreshWorkflowControls() {
  if (!state.panel) return;
  const chat = activeChat();
  fillWorkflowSelect(state.panel.querySelector("#lllm-create-workflow"), "create", chat?.createWorkflowId || "");
  fillWorkflowSelect(state.panel.querySelector("#lllm-edit-workflow"), "edit", chat?.editWorkflowId || "");
  const editWorkflow = workflowProfileById(chat?.editWorkflowId);
  setEditPromptMode(chat?.editPromptMode || editWorkflow?.promptMode || "full_prompt");
  refreshWorkflowManagerSelect();

  const sourceSelect = state.panel.querySelector("#lllm-current-image-source");
  if (sourceSelect) {
    const previous = sourceSelect.value;
    sourceSelect.replaceChildren();
    for (const node of imageSources()) {
      const option = document.createElement("option");
      option.value = String(node.id);
      option.textContent = imageSourceLabel(node);
      sourceSelect.appendChild(option);
    }
    if ([...sourceSelect.options].some((option) => option.value === previous)) sourceSelect.value = previous;
  }
  refreshRegistrationControls();
  loadSecondaryInstructionsFromNode(selectedSlot());
  updateComposeMode();
  if (!selectedSlot() && (selectedWorkflowProfile("create") || selectedWorkflowProfile("edit"))) {
    setStatus("Saved workflow profiles are ready; the current canvas prompt node is optional.", "ready");
  }
}

function refreshWorkflowManagerSelect() {
  const select = state.panel?.querySelector("#lllm-managed-workflow");
  if (!select) return;
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "New profile draft";
  select.appendChild(placeholder);
  for (const profile of state.workflowProfiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `${profile.name} · ${profile.kind === "edit" ? "Editing" : "Creation"}`;
    select.appendChild(option);
  }
  if (workflowProfileById(state.managedWorkflowProfileId)) {
    select.value = state.managedWorkflowProfileId;
  } else {
    state.managedWorkflowProfileId = null;
    select.value = "";
  }
  updateWorkflowManagerState();
}

function updateWorkflowManagerState() {
  const profile = workflowProfileById(state.managedWorkflowProfileId);
  const update = state.panel?.querySelector("#lllm-update-workflow");
  const remove = state.panel?.querySelector("#lllm-delete-workflow");
  const mode = state.panel?.querySelector("#lllm-workflow-manager-mode");
  const unavailable = state.busy || state.workflowBusy || !state.workflowStoreLoaded;
  if (update) {
    update.disabled = unavailable || !profile;
    update.textContent = profile ? `Update “${profile.name}”` : "Update selected";
  }
  if (remove) remove.disabled = unavailable || !profile;
  const saveNew = state.panel?.querySelector("#lllm-save-new-workflow");
  if (saveNew) saveNew.disabled = unavailable;
  if (mode) {
    mode.textContent = profile
      ? `Editing saved profile “${profile.name}”. Changes are not applied until you explicitly update it.`
      : "New profile draft. Saving creates a separate profile and never overwrites an existing one.";
    mode.dataset.existing = profile ? "true" : "false";
  }
}

function refreshRegistrationControls({ resetCanvasSelections = false } = {}) {
  if (!state.panel) return;
  const promptSelect = state.panel.querySelector("#lllm-register-prompt-node");
  const sourceSelect = state.panel.querySelector("#lllm-register-image-node");
  const resultSelect = state.panel.querySelector("#lllm-register-result-node");
  if (promptSelect) {
    const previous = resetCanvasSelections ? "" : promptSelect.value;
    promptSelect.replaceChildren();
    for (const node of slots()) {
      const option = document.createElement("option");
      option.value = String(node.id);
      option.textContent = slotLabel(node);
      promptSelect.appendChild(option);
    }
    if ([...promptSelect.options].some((option) => option.value === previous)) promptSelect.value = previous;
  }
  if (sourceSelect) {
    const previous = resetCanvasSelections ? "" : sourceSelect.value;
    sourceSelect.replaceChildren();
    for (const node of imageSources()) {
      const option = document.createElement("option");
      option.value = String(node.id);
      option.textContent = imageSourceLabel(node);
      sourceSelect.appendChild(option);
    }
    if ([...sourceSelect.options].some((option) => option.value === previous)) sourceSelect.value = previous;
  }
  if (resultSelect) {
    const previous = resetCanvasSelections ? "" : resultSelect.value;
    resultSelect.replaceChildren();
    const automatic = document.createElement("option");
    automatic.value = "";
    automatic.textContent = "Automatic · all image results";
    resultSelect.appendChild(automatic);
    for (const node of outputCandidates()) {
      const option = document.createElement("option");
      option.value = String(node.id);
      option.textContent = outputNodeLabel(node);
      resultSelect.appendChild(option);
    }
    if ([...resultSelect.options].some((option) => option.value === previous)) resultSelect.value = previous;
  }
  const kind = state.panel.querySelector("#lllm-register-kind")?.value || "create";
  state.panel.querySelector("#lllm-register-image-row")?.toggleAttribute("hidden", kind !== "edit");
  state.panel.querySelector("#lllm-register-prompt-mode-row")?.toggleAttribute("hidden", kind !== "edit");
  const canvasStatus = state.panel.querySelector("#lllm-profile-canvas-status");
  if (canvasStatus) canvasStatus.textContent = `Current canvas: ${profileCanvasSummary()}`;
}

function profileCanvasSummary() {
  const promptCount = slots().length;
  const imageCount = imageSources().length;
  const resultCount = outputCandidates().length;
  const ignoredLoaders = incompatibleImageLoaders();
  let summary = `${promptCount} prompt ${promptCount === 1 ? "node" : "nodes"}, ${imageCount} Prompt Studio image ${imageCount === 1 ? "input" : "inputs"}, ${resultCount} result ${resultCount === 1 ? "node" : "nodes"}`;
  if (!imageCount && ignoredLoaders.length) {
    const names = ignoredLoaders.slice(0, 3).map((node) => nodeClassName(node) || node.title || "Image loader").join(", ");
    summary += `; ignored incompatible ${names}`;
  }
  return summary;
}

function refreshProfileCanvasNodes() {
  refreshRegistrationControls({ resetCanvasSelections: true });
  const summary = profileCanvasSummary();
  const canvasStatus = state.panel?.querySelector("#lllm-profile-canvas-status");
  if (canvasStatus) canvasStatus.textContent = `Current canvas: ${summary}`;
  setStatus(`Refreshed profile fields from the current canvas: ${summary}.`, "ready");
}

function loadWorkflowProfileIntoManager(profileId) {
  const profile = workflowProfileById(profileId);
  if (!profile) return resetWorkflowManager();
  state.managedWorkflowProfileId = profile.id;
  state.panel.querySelector("#lllm-register-kind").value = profile.kind;
  state.panel.querySelector("#lllm-register-name").value = profile.name;
  state.panel.querySelector("#lllm-register-prompt-mode").value = profile.promptMode;
  state.panel.querySelector("#lllm-register-result-fields").value = profile.resultFields.join(",");
  refreshRegistrationControls();
  const promptSelect = state.panel.querySelector("#lllm-register-prompt-node");
  const imageSelect = state.panel.querySelector("#lllm-register-image-node");
  const resultSelect = state.panel.querySelector("#lllm-register-result-node");
  if (promptSelect && [...promptSelect.options].some((option) => option.value === profile.promptNodeId)) {
    promptSelect.value = profile.promptNodeId;
  }
  if (imageSelect && [...imageSelect.options].some((option) => option.value === profile.imageNodeId)) {
    imageSelect.value = profile.imageNodeId;
  }
  const resultNodeId = profile.resultNodeIds[0] || "";
  if (resultSelect && [...resultSelect.options].some((option) => option.value === resultNodeId)) {
    resultSelect.value = resultNodeId;
  }
  updateWorkflowManagerState();
}

function resetWorkflowManager() {
  if (!state.panel) return;
  state.managedWorkflowProfileId = null;
  const managerSelect = state.panel.querySelector("#lllm-managed-workflow");
  if (managerSelect) managerSelect.value = "";
  state.panel.querySelector("#lllm-register-name").value = "";
  state.panel.querySelector("#lllm-register-kind").value = selectedAction();
  state.panel.querySelector("#lllm-register-prompt-mode").value = "full_prompt";
  state.panel.querySelector("#lllm-register-result-fields").value = "images,gifs";
  refreshRegistrationControls();
  const resultSelect = state.panel.querySelector("#lllm-register-result-node");
  if (resultSelect) resultSelect.value = "";
  updateWorkflowManagerState();
  state.panel.querySelector("#lllm-register-name").focus();
}

async function captureWorkflowProfile({ existingProfileId = "", confirmUpdate = false } = {}) {
  if (state.busy || state.workflowBusy) return;
  if (!state.workflowStoreLoaded) {
    return setStatus("Workflow profiles could not be loaded. Reload Prompt Studio before saving.", "error");
  }
  const promptNodeId = state.panel.querySelector("#lllm-register-prompt-node")?.value || "";
  const node = slots().find((candidate) => String(candidate.id) === promptNodeId);
  if (!node) return setStatus("Refresh the current canvas and select its workflow prompt node before saving a profile.", "warning");
  const kind = state.panel.querySelector("#lllm-register-kind")?.value === "edit" ? "edit" : "create";
  const existing = workflowProfileById(existingProfileId);
  if (existingProfileId && !existing) return setStatus("Select a saved workflow profile to update.", "warning");
  const name = state.panel.querySelector("#lllm-register-name")?.value.trim() || existing?.name || "";
  const imageNodeId = state.panel.querySelector("#lllm-register-image-node")?.value || "";
  const resultNodeId = state.panel.querySelector("#lllm-register-result-node")?.value || "";
  const resultFields = String(state.panel.querySelector("#lllm-register-result-fields")?.value || "images,gifs")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const promptMode = state.panel.querySelector("#lllm-register-prompt-mode")?.value === "edit_instruction"
    ? "edit_instruction"
    : "full_prompt";
  if (!name) return setStatus("Enter a workflow profile name.", "warning");
  if (kind === "edit" && !imageNodeId) {
    return setStatus("Add and select a Prompt Studio Image Source node for an editing profile.", "warning");
  }
  const duplicate = state.workflowProfiles.find((profile) => (
    profile.id !== existing?.id
    && profile.kind === kind
    && profile.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0
  ));
  if (duplicate) {
    return setStatus(`A ${kind} profile named “${name}” already exists. Choose a different name or update that profile explicitly.`, "warning");
  }

  let previousProfiles = null;
  state.workflowBusy = true;
  updateWorkflowManagerState();
  try {
    const snapshot = structuredClone(await app.graphToPrompt());
    const promptApiNode = snapshot.output?.[String(node.id)];
    if (!promptApiNode || ![SLOT_TYPE, AMPLIFY_TYPE].includes(promptApiNode.class_type)) {
      throw new Error("The selected prompt node is not part of the executable workflow.");
    }
    if (kind === "edit" && snapshot.output?.[imageNodeId]?.class_type !== IMAGE_SOURCE_TYPE) {
      throw new Error("The selected image source node is not part of the executable workflow.");
    }
    if (resultNodeId && !snapshot.output?.[resultNodeId]) {
      throw new Error("The selected result node is not part of the executable workflow.");
    }
    if (existing && confirmUpdate) {
      const view = state.panel.ownerDocument.defaultView;
      const confirmed = view?.confirm(
        `Update “${existing.name}”?\n\nThis replaces its saved workflow snapshot with the current ComfyUI canvas.`,
      );
      if (!confirmed) return;
    }
    const profile = normalizeWorkflowProfile({
      id: existing?.id || makeId(),
      name,
      kind,
      promptMode,
      promptNodeId,
      imageNodeId: kind === "edit" ? imageNodeId : "",
      resultNodeIds: resultNodeId ? [resultNodeId] : [],
      resultFields,
      snapshot,
      updatedAt: Date.now(),
    });
    previousProfiles = state.workflowProfiles;
    if (existing) {
      state.workflowProfiles = state.workflowProfiles.map((item) => item.id === existing.id ? profile : item);
    } else {
      state.workflowProfiles = [...state.workflowProfiles, profile];
    }
    await saveWorkflowProfiles();
    if (existing && existing.kind !== profile.kind) {
      for (const chat of state.chats) {
        if (existing.kind === "create" && chat.createWorkflowId === profile.id) chat.createWorkflowId = "";
        if (existing.kind === "edit" && chat.editWorkflowId === profile.id) chat.editWorkflowId = "";
      }
      saveChats({ immediate: true });
    }
    state.managedWorkflowProfileId = profile.id;
    refreshWorkflowControls();
    loadWorkflowProfileIntoManager(profile.id);
    setStatus(`Saved ${kind} workflow “${profile.name}”.`, "ready");
  } catch (error) {
    if (previousProfiles) state.workflowProfiles = previousProfiles;
    refreshWorkflowControls();
    setStatus(error.message || String(error), "error");
  } finally {
    state.workflowBusy = false;
    updateWorkflowManagerState();
  }
}

function saveNewWorkflowProfile() {
  return captureWorkflowProfile();
}

function updateManagedWorkflowProfile() {
  return captureWorkflowProfile({
    existingProfileId: state.managedWorkflowProfileId || "",
    confirmUpdate: true,
  });
}

async function deleteSelectedWorkflowProfile() {
  if (state.busy || state.workflowBusy) return;
  if (!state.workflowStoreLoaded) return setStatus("Workflow profiles must be reloaded before deleting.", "error");
  const profile = workflowProfileById(state.managedWorkflowProfileId);
  if (!profile) return setStatus("Select a saved workflow profile to delete.", "warning");
  const view = state.panel.ownerDocument.defaultView;
  if (!view?.confirm(`Delete the workflow profile “${profile.name}”?`)) return;
  state.workflowBusy = true;
  updateWorkflowManagerState();
  const previousProfiles = state.workflowProfiles;
  const previousRoutes = state.chats.map((chat) => ({
    chat,
    createWorkflowId: chat.createWorkflowId,
    editWorkflowId: chat.editWorkflowId,
  }));
  state.workflowProfiles = state.workflowProfiles.filter((item) => item.id !== profile.id);
  for (const chat of state.chats) {
    if (chat.createWorkflowId === profile.id) chat.createWorkflowId = "";
    if (chat.editWorkflowId === profile.id) chat.editWorkflowId = "";
  }
  try {
    await saveWorkflowProfiles();
    state.managedWorkflowProfileId = null;
    refreshWorkflowControls();
    resetWorkflowManager();
    saveChats({ immediate: true });
    setStatus(`Deleted workflow profile “${profile.name}”.`, "ready");
  } catch (error) {
    state.workflowProfiles = previousProfiles;
    for (const route of previousRoutes) {
      route.chat.createWorkflowId = route.createWorkflowId;
      route.chat.editWorkflowId = route.editWorkflowId;
    }
    refreshWorkflowControls();
    setStatus(error.message || String(error), "error");
  } finally {
    state.workflowBusy = false;
    updateWorkflowManagerState();
  }
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
  state.panel?.querySelectorAll(".lllm-mode-control input, .lllm-generation-action input, .lllm-workflow-routing select, .lllm-workflow-manager input, .lllm-workflow-manager select, .lllm-workflow-manager button, .lllm-settings input, .lllm-settings select, .lllm-settings textarea, .lllm-current-details textarea, .lllm-secondary-details textarea")
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
  loadSecondaryInstructionsFromNode(selectedSlot());
  updateWorkflowManagerState();
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

function imageReferenceKey(reference) {
  const value = normalizeImageReference(reference);
  return value ? `${value.type}\u0000${value.subfolder}\u0000${value.filename}` : "";
}

function imageReferenceUrl(reference) {
  const value = normalizeImageReference(reference);
  if (!value) return "";
  return `/view?${new URLSearchParams(value)}`;
}

function latestConversationImage(chat = activeChat()) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const images = Array.isArray(messages[messageIndex]?.images) ? messages[messageIndex].images : [];
    for (let imageIndex = images.length - 1; imageIndex >= 0; imageIndex -= 1) {
      const reference = normalizeImageReference(images[imageIndex]);
      if (reference) return reference;
    }
  }
  return null;
}

function editingSource(sourceImage = null) {
  return normalizeImageReference(sourceImage)
    || normalizeImageReference(activeChat()?.selectedSource)
    || latestConversationImage();
}

function restoreStoredCanonicalPrompt(data) {
  const prompt = String(data?.canonicalPrompt || "");
  if (!prompt.trim()) return false;
  const previousVersion = state.versions[state.versionIndex];
  const chat = activeChat();
  if (chat) {
    chat.initialized = true;
    chat.controlsFingerprint = data.llmAmplified ? String(data.controlsFingerprint || "") : "";
    chat.pendingGeneration = null;
  }
  if (selectedSlot()) writePromptToSlot(prompt);
  else updatePromptEditor(prompt);
  if (previousVersion !== prompt) pushVersion(prompt);
  else syncActiveChat();
  updateComposeMode();
  return true;
}

function selectImageSource(reference, generationData = null) {
  if (state.busy) return setStatus("Wait for the current operation to finish.", "warning");
  const value = normalizeImageReference(reference);
  if (!value) return;
  const chat = activeChat();
  if (!chat) return;
  chat.selectedSource = value;
  chat.updatedAt = Date.now();
  const editAction = state.panel?.querySelector('input[name="lllm-generation-action"][value="edit"]');
  if (editAction) editAction.checked = true;
  const promptRestored = restoreStoredCanonicalPrompt(generationData);
  saveChats();
  renderChatHistory();
  updateComposeMode();
  if (promptRestored && controlsNeedApply()) {
    setStatus(`Selected ${value.filename} and restored its prompt. KoboldCpp will apply the current controls before generation.`, "warning");
  } else {
    setStatus(
      promptRestored
        ? `Selected ${value.filename} as the editing source and restored its canonical prompt.`
        : `Selected ${value.filename} as the editing source.`,
      "ready",
    );
  }
}

function renderImageGallery(message, images, generationData = null) {
  if (!message || !images?.length) return;
  message.classList.add("lllm-has-images");
  const gallery = document.createElement("div");
  gallery.className = "lllm-image-grid";
  for (const item of images) {
    const reference = normalizeImageReference(item);
    if (!reference) continue;
    const card = document.createElement("div");
    card.className = "lllm-image-card";
    card.dataset.source = imageReferenceKey(activeChat()?.selectedSource) === imageReferenceKey(reference) ? "true" : "false";
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "lllm-image-preview";
    const url = imageReferenceUrl(reference);
    const image = document.createElement("img");
    image.src = url;
    image.alt = item.filename || "Generated image";
    preview.title = `Preview ${image.alt}`;
    preview.setAttribute("aria-label", preview.title);
    preview.addEventListener("click", () => openImageLightbox(url, image.alt, preview));
    preview.appendChild(image);
    const useSource = document.createElement("button");
    useSource.type = "button";
    useSource.className = "lllm-use-source";
    useSource.dataset.disableBusy = "";
    useSource.disabled = state.busy;
    useSource.textContent = card.dataset.source === "true" ? "Editing source" : "Edit this image";
    useSource.addEventListener("click", () => selectImageSource(reference, generationData));
    card.append(preview, useSource);
    gallery.appendChild(card);
  }
  message.appendChild(gallery);
}

function useStoredCanonicalPrompt(data, details) {
  if (state.busy) return setStatus("Wait for the current operation to finish.", "warning");
  if (!restoreStoredCanonicalPrompt(data)) return;
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
  panel.append(heading, text);
  if (data.executionPrompt && data.executionPrompt !== data.canonicalPrompt) {
    const executionHeading = document.createElement("strong");
    executionHeading.textContent = "Workflow execution prompt";
    const executionText = document.createElement("div");
    executionText.className = "lllm-prompt-info-text";
    executionText.textContent = data.executionPrompt;
    panel.append(executionHeading, executionText);
  }
  panel.append(usePrompt);
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

  if (data.canonicalPrompt && data.workflowName) {
    const provenance = document.createElement("div");
    provenance.className = "lllm-generation-provenance";
    provenance.textContent = data.generationAction === "edit"
      ? `Edited source · ${data.workflowName}`
      : `Created new · ${data.workflowName}`;
    message.appendChild(provenance);
  }

  const body = document.createElement("div");
  body.className = "lllm-message-text";
  body.textContent = data.text;
  message.appendChild(body);
  renderImageGallery(message, data.images, data);
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
    executionPrompt: String(options.executionPrompt || options.canonicalPrompt || ""),
    generationAction: options.generationAction === "edit" ? "edit" : "create",
    workflowProfileId: String(options.workflowProfileId || ""),
    workflowName: String(options.workflowName || ""),
    sourceImage: normalizeImageReference(options.sourceImage),
    resultNodeIds: Array.isArray(options.resultNodeIds) ? options.resultNodeIds.map(String) : [],
    resultFields: Array.isArray(options.resultFields) && options.resultFields.length ? options.resultFields.map(String) : ["images", "gifs"],
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
  const chat = activeChat();
  const stored = chat?.messages.find((item) => item.id === message.dataset.messageId);
  renderImageGallery(message, images, stored);
  if (stored) {
    stored.images = images;
    if (images[0] && state.panel?.querySelector("#lllm-auto-advance-source")?.checked) {
      chat.selectedSource = normalizeImageReference(images[0]);
    } else if (!chat.selectedSource && images[0]) {
      chat.selectedSource = normalizeImageReference(images[0]);
    }
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

function syncCanonicalEditor(prompt, { userEdit = false } = {}) {
  updatePromptEditor(prompt);
  const chat = activeChat();
  if (!chat) return;
  chat.currentPrompt = prompt;
  chat.initialized = Boolean(prompt.trim());
  if (userEdit) chat.pendingGeneration = null;
  chat.updatedAt = Date.now();
  saveChats();
  updateComposeMode();
}

function commitPromptEditorVersion() {
  const editor = state.panel?.querySelector("#lllm-current-prompt");
  if (!editor || editor.readOnly) return;
  const prompt = editor.value;
  syncCanonicalEditor(prompt, { userEdit: prompt !== state.currentPrompt });
  if (state.versions[state.versionIndex] !== prompt) pushVersion(prompt);
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
  const prompt = useSlotPrompt ? slotPrompt : String(chat?.currentPrompt || "");
  if (useSlotPrompt) {
    if (chat) chat.initialized = Boolean(prompt.trim());
    state.versions = [prompt];
    state.versionIndex = 0;
  } else {
    state.versions = [...(chat?.versions || [""])];
    state.versionIndex = chat?.versionIndex || 0;
  }
  updatePromptEditor(prompt);
  if (chat) chat.slotId = String(node.id);
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
  refreshWorkflowControls();
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

function randomizeSnapshotSeeds(snapshot) {
  for (const node of Object.values(snapshot?.output || {})) {
    for (const name of Object.keys(node?.inputs || {})) {
      if (/^(seed|noise_seed)$/i.test(name)) node.inputs[name] = Math.floor(Math.random() * 0x100000000);
    }
  }
}

function generationMatchesLatestQueuedPrompt() {
  const chat = activeChat();
  const latestGeneration = [...(chat?.messages || [])]
    .reverse()
    .find((message) => Boolean(message.canonicalPrompt));
  if (!latestGeneration) return false;
  return latestGeneration.canonicalPrompt === state.currentPrompt
    && latestGeneration.controlsFingerprint === String(chat?.controlsFingerprint || "");
}

function historyImages(historyItem, resultNodeIds = [], resultFields = ["images", "gifs"]) {
  const images = [];
  const selected = new Set((resultNodeIds || []).map(String));
  for (const [nodeId, output] of Object.entries(historyItem?.outputs || {})) {
    if (selected.size && !selected.has(String(nodeId))) continue;
    for (const field of resultFields || []) {
      const value = output?.[field];
      if (Array.isArray(value)) images.push(...value);
      else if (normalizeImageReference(value)) images.push(value);
    }
  }
  return images;
}

async function waitForResult(promptId, targetMessage, token, resultNodeIds = [], resultFields = ["images", "gifs"]) {
  const started = Date.now();
  while (token === state.pollToken && Date.now() - started < 10 * 60 * 1000) {
    const response = await api.fetchApi(`/history/${encodeURIComponent(promptId)}`);
    if (token !== state.pollToken) return;
    if (response.ok) {
      const history = await response.json();
      if (token !== state.pollToken) return;
      const item = history?.[promptId];
      if (item) {
        const images = historyImages(item, resultNodeIds, resultFields);
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

function writeCanonicalPrompt(prompt, { sync = true } = {}) {
  if (selectedSlot()) return writePromptToSlot(prompt, { sync });
  updatePromptEditor(prompt);
  if (sync) syncActiveChat();
}

async function workflowQueueContext(action, profileId = null) {
  const selectedProfile = profileId == null ? selectedWorkflowProfile(action) : workflowProfileById(profileId);
  if (profileId != null && profileId !== "" && !selectedProfile) {
    throw new Error("The workflow profile used by the previous generation no longer exists.");
  }
  if (selectedProfile) {
    if (!selectedProfile.snapshot?.output) throw new Error(`Workflow profile “${selectedProfile.name}” has no executable snapshot.`);
    return {
      profile: selectedProfile,
      snapshot: structuredClone(selectedProfile.snapshot),
      promptNodeId: selectedProfile.promptNodeId,
      imageNodeId: selectedProfile.imageNodeId,
      resultNodeIds: selectedProfile.resultNodeIds,
      resultFields: selectedProfile.resultFields,
      workflowName: selectedProfile.name,
    };
  }

  if (!selectedSlot()) throw new Error("Select a prompt node or a saved workflow profile before generating.");
  const secondaryInstructions = state.panel.querySelector("#lllm-secondary-instructions")?.value || "";
  writePromptToSlot(state.currentPrompt);
  writeSecondaryInstructionsToNode(secondaryInstructions);
  const snapshot = structuredClone(await app.graphToPrompt());
  const imageNodeId = action === "edit" ? state.panel.querySelector("#lllm-current-image-source")?.value || "" : "";
  if (action === "edit" && !imageNodeId) {
    throw new Error("Add a Prompt Studio Image Source node or select a saved editing workflow.");
  }
  return {
    profile: null,
    snapshot,
    promptNodeId: String(state.selectedSlotId),
    imageNodeId,
    resultNodeIds: [],
    resultFields: ["images", "gifs"],
    workflowName: "Current canvas",
  };
}

async function queueGeneration({
  action = selectedAction(),
  executionPrompt = state.currentPrompt,
  preserveSeed = false,
  workflowProfileId = null,
  sourceImage = null,
} = {}) {
  const operationToken = state.operationToken;
  const source = action === "edit" ? editingSource(sourceImage) : null;
  if (action === "edit" && !source) throw new Error("There is no image in this conversation to edit.");
  const context = await workflowQueueContext(action, workflowProfileId);
  if (operationToken !== state.operationToken) return false;
  const useNewSeed = !preserveSeed
    && generationMatchesLatestQueuedPrompt()
    && state.panel.querySelector("#lllm-randomize-seed")?.checked;
  if (useNewSeed) randomizeSnapshotSeeds(context.snapshot);

  const apiNode = context.snapshot.output?.[String(context.promptNodeId)];
  if (!apiNode || ![SLOT_TYPE, AMPLIFY_TYPE].includes(apiNode.class_type)) {
    throw new Error("The configured prompt node was not included in the executable workflow.");
  }
  const secondaryInstructions = context.profile
    ? String(apiNode.inputs?.secondary_instructions || "")
    : state.panel.querySelector("#lllm-secondary-instructions")?.value || "";
  if (apiNode.class_type === AMPLIFY_TYPE) {
    const slotName = apiNode.inputs?.slot_name || context.workflowName;
    apiNode.class_type = SLOT_TYPE;
    apiNode.inputs = { prompt: executionPrompt, slot_name: slotName, secondary_instructions: secondaryInstructions };
  } else {
    apiNode.inputs.prompt = executionPrompt;
    apiNode.inputs.secondary_instructions = secondaryInstructions;
  }

  if (action === "edit") {
    const imageNode = context.snapshot.output?.[String(context.imageNodeId)];
    if (!imageNode || imageNode.class_type !== IMAGE_SOURCE_TYPE) {
      throw new Error("The configured Prompt Studio Image Source node was not included in the editing workflow.");
    }
    imageNode.inputs.image_ref = JSON.stringify(source);
  }

  if (operationToken !== state.operationToken) return false;

  let queued;
  state.queueing = true;
  try {
    queued = await api.queuePrompt(-1, context.snapshot);
  } finally {
    state.queueing = false;
  }
  const promptId = queued?.prompt_id;
  if (!promptId) throw new Error("ComfyUI did not return a prompt ID.");
  if (operationToken !== state.operationToken) {
    if (typeof api.interrupt === "function") await api.interrupt();
    else await api.fetchApi("/interrupt", { method: "POST" });
    return false;
  }
  const chat = activeChat();
  if (chat) {
    chat.lastGeneration = {
      action,
      canonicalPrompt: state.currentPrompt,
      executionPrompt,
      workflowProfileId: context.profile?.id || "",
      sourceImage: source,
    };
    chat.pendingGeneration = null;
    chat.updatedAt = Date.now();
    saveChats();
  }
  const resultMessage = appendMessage("assistant", `Queued generation ${promptId.slice(0, 8)}…`, {
    label: "ComfyUI",
    canonicalPrompt: state.currentPrompt,
    executionPrompt,
    generationAction: action,
    workflowProfileId: context.profile?.id || "",
    workflowName: context.workflowName,
    sourceImage: source,
    resultNodeIds: context.resultNodeIds,
    resultFields: context.resultFields,
    controlsFingerprint: chat?.controlsFingerprint || "",
    llmAmplified: useLlmAmplification(),
  });
  state.generating = true;
  setStatus("ComfyUI is generating…", "working");
  const token = ++state.pollToken;
  waitForResult(promptId, resultMessage, token, context.resultNodeIds, context.resultFields).catch((error) => {
    if (token !== state.pollToken) return;
    setStatus(error.message || String(error), "error");
    state.generating = false;
    setBusy(false);
  });
  return true;
}

async function generateDirectPrompt(action = selectedAction()) {
  if (state.busy) return;
  if (!selectedSlot() && !selectedWorkflowProfile(action)) {
    return setStatus("Add a prompt node or select a saved workflow profile first.", "warning");
  }
  if (action === "edit" && !editingSource()) {
    return setStatus("There is no image in this conversation to edit.", "warning");
  }
  const input = state.panel.querySelector("#lllm-revision");
  const prompt = input.value.trim();
  if (!prompt) return setStatus("Enter a prompt before generating.", "warning");
  const previousVersion = state.versions[state.versionIndex];
  const promptChanged = previousVersion !== prompt;
  const chat = activeChat();
  if (chat) chat.initialized = true;
  input.value = prompt;
  writeCanonicalPrompt(prompt);
  if (promptChanged) pushVersion(prompt);
  saveSettings();
  state.operationToken += 1;
  setBusy(true);
  setStatus("ComfyUI is generating the direct prompt…", "working");
  try {
    await queueGeneration({ action, executionPrompt: prompt, preserveSeed: promptChanged });
  } catch (error) {
    setStatus(error.message || String(error), "error");
    setBusy(false);
  }
}

async function reviseAndMaybeGenerate({ controlsOnly = false, forceGenerate = false, generationAction = selectedAction() } = {}) {
  if (state.busy) return;
  if (!useLlmAmplification()) return generateDirectPrompt(generationAction);
  const input = state.panel.querySelector("#lllm-revision");
  const revision = input.value.trim();
  const editedPrompt = state.panel.querySelector("#lllm-current-prompt").value.trim();
  const creating = !activeChat()?.initialized;
  if (!selectedSlot() && !selectedWorkflowProfile(generationAction)) {
    return setStatus("Add a prompt node or select a saved workflow profile first.", "warning");
  }
  if (generationAction === "edit" && !editingSource()) {
    return setStatus("There is no image in this conversation to edit.", "warning");
  }
  if (creating && !revision) return setStatus("Describe an image to create the first prompt.", "warning");
  if (!creating && !editedPrompt) return setStatus("The current prompt is empty.", "warning");
  controlsOnly = !creating && (controlsOnly || (!revision && controlsNeedApply()));
  if (!revision && !controlsOnly) return reroll({ applyControls: false, generationAction });

  if (!creating && editedPrompt !== state.currentPrompt) {
    writeCanonicalPrompt(editedPrompt);
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
      writeCanonicalPrompt(prompt, { sync: false });
      state.versions = [prompt];
      state.versionIndex = 0;
      if (chat) chat.initialized = true;
      syncActiveChat();
      updateComposeMode();
    } else {
      writeCanonicalPrompt(prompt);
      pushVersion(prompt);
    }
    if (chat) {
      chat.controlsFingerprint = requestedControlsFingerprint;
      chat.pendingGeneration = {
        action: generationAction,
        canonicalPrompt: prompt,
        executionPrompt: generationAction === "edit"
          && selectedEditPromptMode() === "edit_instruction"
          && revision
          ? revision
          : prompt,
        workflowProfileId: selectedWorkflowProfileId(generationAction),
      };
      saveChats();
    }
    setStatus(creating ? "Initial prompt created." : "Prompt revised.", "ready");
    if (forceGenerate || state.panel.querySelector("#lllm-auto-generate")?.checked) {
      const executionPrompt = chat?.pendingGeneration?.executionPrompt || prompt;
      await queueGeneration({ action: generationAction, executionPrompt, preserveSeed: true });
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

async function reroll({ applyControls = true, generationAction = selectedAction() } = {}) {
  if (state.busy) return;
  const lastGeneration = activeChat()?.lastGeneration;
  const pendingGeneration = activeChat()?.pendingGeneration;
  const selectedProfileId = selectedWorkflowProfileId(generationAction);
  const usePendingGeneration = pendingGeneration?.action === generationAction
    && pendingGeneration.canonicalPrompt === state.currentPrompt
    && pendingGeneration.workflowProfileId === selectedProfileId;
  const repeatLastConfiguration = !usePendingGeneration
    && lastGeneration?.action === generationAction
    && lastGeneration.canonicalPrompt === state.currentPrompt
    && String(lastGeneration?.workflowProfileId || "") === selectedProfileId;
  if (!useLlmAmplification()) return generateDirectPrompt(generationAction);
  if (!activeChat()?.initialized) return setStatus("Create the first prompt before rerolling.", "warning");
  if (applyControls && controlsNeedApply()) {
    return reviseAndMaybeGenerate({ controlsOnly: true, forceGenerate: true, generationAction });
  }
  const editedPrompt = state.panel.querySelector("#lllm-current-prompt").value.trim();
  if (!editedPrompt) return setStatus("The current prompt is empty.", "warning");
  const promptChanged = editedPrompt !== state.currentPrompt;
  if (promptChanged) {
    writeCanonicalPrompt(editedPrompt);
    pushVersion(editedPrompt);
  }
  saveSettings();
  state.operationToken += 1;
  setBusy(true);
  try {
    await queueGeneration({
      action: generationAction,
      executionPrompt: usePendingGeneration
        ? (pendingGeneration.executionPrompt || state.currentPrompt)
        : repeatLastConfiguration
          ? (lastGeneration.executionPrompt || state.currentPrompt)
          : state.currentPrompt,
      preserveSeed: promptChanged,
      workflowProfileId: null,
      sourceImage: repeatLastConfiguration ? lastGeneration.sourceImage : null,
    });
  } catch (error) {
    setStatus(error.message || String(error), "error");
    setBusy(false);
  }
}

function undoPrompt() {
  if (state.busy || state.versionIndex <= 0) return;
  state.versionIndex -= 1;
  const prompt = state.versions[state.versionIndex];
  const chat = activeChat();
  if (chat) chat.pendingGeneration = null;
  writeCanonicalPrompt(prompt);
  updateComposeMode();
  appendMessage("system", `Restored prompt version ${state.versionIndex + 1}.`);
  state.panel.querySelector("#lllm-undo").disabled = state.versionIndex <= 0;
}

async function interrupt() {
  state.operationToken += 1;
  state.pollToken += 1;
  try {
    if (state.generating || state.queueing) {
      if (typeof api.interrupt === "function") await api.interrupt();
      else await api.fetchApi("/interrupt", { method: "POST" });
      setStatus(state.queueing ? "Queue cancellation requested." : "Generation interrupt requested.", "warning");
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
            <label><input id="lllm-randomize-seed" type="checkbox" ${settings.randomize_seed ? "checked" : ""} /> New seed on reroll</label>
            <div class="lllm-generation-action" role="radiogroup" aria-label="Generation action">
              <label><input type="radio" name="lllm-generation-action" value="create" checked /><span>Create</span></label>
              <label><input type="radio" name="lllm-generation-action" value="edit" /><span>Edit</span></label>
            </div>
            <div id="lllm-edit-prompt-action" class="lllm-generation-action lllm-edit-prompt-action" role="radiogroup" aria-label="Editing prompt payload" hidden>
              <label><input type="radio" name="lllm-edit-prompt-mode" value="edit_instruction" /><span>Text only</span></label>
              <label><input type="radio" name="lllm-edit-prompt-mode" value="full_prompt" checked /><span>Full prompt</span></label>
            </div>
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
            <label title="Controls KoboldCpp reasoning effort. High receives up to 4,096 private-reasoning tokens while preserving the final-answer allowance.">Thinking<select id="lllm-thinking"></select></label>
            <label>KoboldCpp URL<input id="lllm-kobold-url" /></label>
            <label>Style modifier<textarea id="lllm-style-modifier" rows="2"></textarea></label>
            <label>Framing modifier<textarea id="lllm-framing-modifier" rows="2"></textarea></label>
            <label title="Final-answer allowance. KoboldCpp receives an additional native-reasoning budget; 0 uses the selected profile default.">Final-answer tokens<input id="lllm-max-tokens" type="number" min="0" max="8192" /></label>
            <label>Temperature<input id="lllm-temperature" type="number" min="0" max="5" step="0.05" /></label>
          </div>
        </details>
        <details class="lllm-secondary-details" open>
          <summary><span>Secondary instructions</span><small>Optional pass-through output</small></summary>
          <textarea id="lllm-secondary-instructions" rows="3" placeholder="Returned unchanged from the secondary output"></textarea>
        </details>
      </section>
    </aside>
    <div id="lllm-studio-settings" class="lllm-studio-settings" hidden>
      <div class="lllm-studio-settings-heading"><strong>Settings</strong><span>Interface</span></div>
      <label class="lllm-image-scale-control">
        <span><strong>Image scale</strong><output id="lllm-image-scale-value" for="lllm-image-scale">100%</output></span>
        <input id="lllm-image-scale" type="range" min="30" max="100" step="5" value="${settings.image_scale}" />
        <small>Scale generated images in chat. Full-size preview is unchanged.</small>
      </label>
      <label class="lllm-studio-checkbox"><input id="lllm-auto-advance-source" type="checkbox" ${settings.auto_advance_source ? "checked" : ""} /> Use the newest result as the next editing source</label>
      <div class="lllm-studio-settings-heading lllm-studio-settings-section"><strong>Workflows</strong><span>Routing and profiles</span></div>
      <div class="lllm-workflow-routing">
        <label><span>Create workflow</span><select id="lllm-create-workflow"></select></label>
        <label><span>Edit workflow</span><select id="lllm-edit-workflow"></select></label>
        <label><span>Current canvas image input</span><select id="lllm-current-image-source"></select></label>
      </div>
      <details class="lllm-workflow-manager">
        <summary>Workflow profile library</summary>
        <div class="lllm-workflow-library-row">
          <label><span>Profile to manage</span><select id="lllm-managed-workflow"></select></label>
          <button id="lllm-new-workflow" type="button">New profile</button>
          <button id="lllm-refresh-profile-canvas" type="button">Refresh canvas nodes</button>
        </div>
        <div id="lllm-profile-canvas-status" class="lllm-profile-canvas-status">Current canvas nodes have not been scanned yet.</div>
        <div id="lllm-workflow-manager-mode" class="lllm-workflow-manager-mode"></div>
        <div class="lllm-workflow-manager-grid">
          <label>Name<input id="lllm-register-name" placeholder="Kontext instruction edit" /></label>
          <label>Kind<select id="lllm-register-kind"><option value="create">Creation</option><option value="edit">Editing</option></select></label>
          <label>Current canvas prompt<select id="lllm-register-prompt-node"></select></label>
          <label id="lllm-register-prompt-mode-row" hidden>Default edit payload<select id="lllm-register-prompt-mode"><option value="full_prompt">Full target prompt</option><option value="edit_instruction">Text box only</option></select></label>
          <label id="lllm-register-image-row" hidden>Image input<select id="lllm-register-image-node"></select></label>
          <label>Primary result<select id="lllm-register-result-node"></select></label>
          <label>History fields<input id="lllm-register-result-fields" value="images,gifs" placeholder="images,gifs" /></label>
        </div>
        <div class="lllm-workflow-manager-actions">
          <button id="lllm-save-new-workflow" class="lllm-primary-action" type="button">Save as new</button>
          <button id="lllm-update-workflow" type="button" disabled>Update selected</button>
          <button id="lllm-delete-workflow" class="lllm-danger-action" type="button" disabled>Delete selected</button>
        </div>
        <small>Saving captures the current ComfyUI canvas and selected Workflow Prompt. Routing above only controls what runs; it never chooses an overwrite target.</small>
      </details>
    </div>
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
  panel.querySelector("#lllm-popout").addEventListener("click", () => togglePopout({ returnToEmbedded: true }));
  panel.querySelector("#lllm-close").addEventListener("click", () => togglePanel(false));
  panel.querySelector("#lllm-refresh-slots").addEventListener("click", refreshSlots);
  panel.querySelector("#lllm-slot-select").addEventListener("change", (event) => {
    state.selectedSlotId = event.target.value || null;
    attachSelectedSlot({ useSlotPrompt: true });
  });
  panel.querySelector("#lllm-create-workflow").addEventListener("change", () => {
    announceWorkflowSelection("create");
  });
  panel.querySelector("#lllm-edit-workflow").addEventListener("change", () => {
    announceWorkflowSelection("edit");
    setEditPromptMode(selectedWorkflowProfile("edit")?.promptMode || "full_prompt", { persist: true });
  });
  panel.querySelector("#lllm-managed-workflow").addEventListener("change", (event) => {
    loadWorkflowProfileIntoManager(event.target.value);
  });
  panel.querySelector("#lllm-new-workflow").addEventListener("click", resetWorkflowManager);
  panel.querySelector("#lllm-refresh-profile-canvas").addEventListener("click", refreshProfileCanvasNodes);
  panel.querySelector("#lllm-register-kind").addEventListener("change", refreshRegistrationControls);
  panel.querySelector("#lllm-save-new-workflow").addEventListener("click", saveNewWorkflowProfile);
  panel.querySelector("#lllm-update-workflow").addEventListener("click", updateManagedWorkflowProfile);
  panel.querySelector("#lllm-delete-workflow").addEventListener("click", deleteSelectedWorkflowProfile);
  panel.querySelectorAll('input[name="lllm-generation-action"]').forEach((control) => {
    control.addEventListener("change", () => {
      updateComposeMode();
      loadSecondaryInstructionsFromNode(selectedSlot());
    });
  });
  panel.querySelectorAll('input[name="lllm-edit-prompt-mode"]').forEach((control) => {
    control.addEventListener("change", () => syncActiveChat());
  });
  panel.querySelector("#lllm-send").addEventListener("click", () => reviseAndMaybeGenerate());
  panel.querySelector("#lllm-reroll").addEventListener("click", () => reroll());
  panel.querySelector("#lllm-undo").addEventListener("click", undoPrompt);
  panel.querySelector("#lllm-stop").addEventListener("click", interrupt);
  panel.querySelector("#lllm-use-llm-amplification").addEventListener("change", () => updateAmplificationMode());
  panel.querySelector("#lllm-secondary-instructions").addEventListener("input", (event) => {
    writeSecondaryInstructionsToNode(event.target.value);
  });
  panel.querySelector("#lllm-secondary-instructions").addEventListener("change", saveSettings);
  panel.querySelector("#lllm-current-prompt").addEventListener("input", (event) => {
    syncCanonicalEditor(event.target.value, { userEdit: true });
  });
  panel.querySelector("#lllm-current-prompt").addEventListener("change", commitPromptEditorVersion);
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
  panel.querySelector("#lllm-auto-generate").addEventListener("change", updateComposeMode);
  panel.querySelector("#lllm-image-scale").addEventListener("input", (event) => applyImageScale(event.target.value));
  panel.querySelector("#lllm-image-scale").addEventListener("change", saveSettings);
  panel.querySelector("#lllm-auto-advance-source").addEventListener("change", saveSettings);
}

function buildLauncher() {
  const launchers = document.createElement("div");
  launchers.id = "lllm-prompt-studio-launchers";
  launchers.setAttribute("role", "group");
  launchers.setAttribute("aria-label", "Prompt Studio launchers");

  const studioButton = document.createElement("button");
  studioButton.id = "lllm-prompt-studio-launcher";
  studioButton.type = "button";
  studioButton.title = "Open Prompt Studio in a new tab";
  studioButton.textContent = "Prompt Studio";
  studioButton.addEventListener("click", () => togglePopout());

  const chatButton = document.createElement("button");
  chatButton.id = "lllm-prompt-chat-launcher";
  chatButton.type = "button";
  chatButton.title = "Open Prompt Chat inside ComfyUI";
  chatButton.textContent = "Prompt chat";
  chatButton.addEventListener("click", () => togglePanel());

  launchers.append(studioButton, chatButton);
  document.body.appendChild(launchers);
  state.launcher = launchers;
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
  if (state.popupCloseTimer) window.clearInterval(state.popupCloseTimer);
  state.popupCloseTimer = null;
  if (state.panel.ownerDocument !== document) document.body.appendChild(state.panel);
  state.panel.hidden = !keepOpen;
  state.popup = null;
  state.returnToEmbedded = false;
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
  if (state.popupCloseTimer) window.clearInterval(state.popupCloseTimer);
  state.popupCloseTimer = window.setInterval(() => {
    if (state.popup !== popup || !popup.closed) return;
    dockPanel({ closePopup: false, keepOpen: state.returnToEmbedded });
  }, 250);
  popup.addEventListener("beforeunload", () => {
    if (!state.dockingPopup && state.popup === popup) {
      dockPanel({ closePopup: false, keepOpen: state.returnToEmbedded });
    }
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

function togglePopout({ returnToEmbedded = false } = {}) {
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
  state.returnToEmbedded = returnToEmbedded;
  state.launcher.dataset.open = "true";
  const mountPanel = () => {
    if (popup.closed || state.popup !== popup) return;
    attachStandalone(popup).then((connected) => {
      if (connected) return;
      setStatus("Prompt Studio could not initialize its standalone page.", "error");
      dockPanel({ keepOpen: returnToEmbedded });
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
  if (!show) {
    commitPromptEditorVersion();
    closeImageLightbox();
  }
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
    try {
      await loadWorkflowProfiles();
    } catch (error) {
      setStatus(error.message || String(error), "warning");
    }
    buildLauncher();
    refreshSlots();
    setupStandaloneBridge();
  },
});
