import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const EXTENSION_NAME = "ComfyUI_PromptStudio.PromptStudio";
const SLOT_TYPE = "KCPP_PromptSlot";
const AMPLIFY_TYPE = "KCPP_PromptAmplify";
const IMAGE_SOURCE_TYPE = "KCPP_ChatImageInput";
const UPSCALE_TYPE = "KCPP_PromptStudioUpscale";
const STORAGE_KEY = "promptstudio.promptStudio.settings.v1";
const STANDALONE_CHANNEL = "promptstudio.promptStudio.standalone.v1";
const WORKFLOW_SYNC_CHANNEL = "promptstudio.promptStudio.workflows.v1";
const WORKFLOW_OBSERVER_KEY = Symbol.for("ComfyUI_PromptStudio.PromptStudio.WorkflowObserver");
const RESOLUTION_ASPECT_RATIOS = [
  "1:1 (Square)",
  "2:3 (Portrait Photo)",
  "3:2 (Photo)",
  "3:4 (Portrait Standard)",
  "4:3 (Standard)",
  "9:16 (Portrait Widescreen)",
  "16:9 (Widescreen)",
  "21:9 (Ultrawide)",
];
const CONTROL_IDS = [
  "promptstudio-kobold-url",
  "promptstudio-profile",
  "promptstudio-style",
  "promptstudio-framing",
  "promptstudio-style-modifier",
  "promptstudio-framing-modifier",
  "promptstudio-thinking",
  "promptstudio-embellishment",
  "promptstudio-max-tokens",
  "promptstudio-temperature",
];

const state = {
  panel: null,
  launcher: null,
  popup: null,
  popupCloseTimer: null,
  dockingPopup: false,
  returnToEmbedded: false,
  standaloneChannel: null,
  workflowSyncChannel: null,
  config: null,
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
  workflowIssues: [],
  workflowRevision: 0,
  workflowStoreLoaded: false,
  workflowSaveChain: Promise.resolve(),
  workflowBusy: false,
  workflowRefreshTimer: null,
  workflowRefreshBroadcast: false,
  chatSaveTimer: null,
  chatSaveChain: Promise.resolve(),
  lightboxTrigger: null,
};

function loadCss() {
  if (document.querySelector("link[data-promptstudio-prompt-studio]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("../css/prompt_studio.css", import.meta.url).href;
  link.dataset.promptstudioPromptStudio = "true";
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
    use_prompt_upscaling: true,
    randomize_seed: true,
    auto_generate: true,
    auto_advance_source: true,
    image_scale: 100,
    resolution_aspect_ratio: "1:1 (Square)",
    resolution_megapixels: 1.0,
    resolution_multiple: 8,
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
      kobold_url: value("promptstudio-kobold-url"),
      model_profile: value("promptstudio-profile"),
      style_preset: value("promptstudio-style"),
      framing_preset: value("promptstudio-framing"),
      style_modifier: value("promptstudio-style-modifier"),
      framing_modifier: value("promptstudio-framing-modifier"),
      thinking_mode: value("promptstudio-thinking"),
      embellishment_level: value("promptstudio-embellishment"),
      max_response_tokens: Number(value("promptstudio-max-tokens") || 0),
      temperature: Number(value("promptstudio-temperature") || 0.7),
      secondary_instructions: value("promptstudio-secondary-instructions"),
      use_llm_amplification: checked("promptstudio-use-llm-amplification"),
      use_prompt_upscaling: checked("promptstudio-use-prompt-upscaling"),
      randomize_seed: checked("promptstudio-randomize-seed"),
      auto_generate: checked("promptstudio-auto-generate"),
      auto_advance_source: checked("promptstudio-auto-advance-source"),
      image_scale: Number(value("promptstudio-image-scale") || 100),
      resolution_aspect_ratio: value("promptstudio-resolution-aspect-ratio"),
      resolution_megapixels: Number(value("promptstudio-resolution-megapixels") || 1),
      resolution_multiple: Number(value("promptstudio-resolution-multiple") || 8),
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
  const input = state.panel.querySelector("#promptstudio-image-scale");
  const output = state.panel.querySelector("#promptstudio-image-scale-value");
  if (input) input.value = String(scale);
  if (output) output.textContent = `${scale}%`;
  state.panel.style.setProperty("--ps-image-scale", `${scale}%`);
}

function resolutionSettings() {
  const aspectRatio = state.panel?.querySelector("#promptstudio-resolution-aspect-ratio")?.value;
  const megapixels = state.panel?.querySelector("#promptstudio-resolution-megapixels")?.valueAsNumber;
  const multiple = state.panel?.querySelector("#promptstudio-resolution-multiple")?.valueAsNumber;
  return {
    aspect_ratio: RESOLUTION_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : RESOLUTION_ASPECT_RATIOS[0],
    megapixels: Number.isFinite(megapixels) ? Math.max(0.1, Math.min(16, megapixels)) : 1,
    multiple: Number.isFinite(multiple) ? Math.max(8, Math.min(128, Math.round(multiple / 4) * 4)) : 8,
  };
}

function toggleStudioSettings(force) {
  const popover = state.panel?.querySelector("#promptstudio-studio-settings");
  const button = state.panel?.querySelector("#promptstudio-toggle-studio-settings");
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
  const normalizedAt = (value, fallback) => {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) ? timestamp : fallback;
  };
  const now = Date.now();
  const createdAt = normalizedAt(chat?.createdAt, normalizedAt(chat?.updatedAt, now));
  const updatedAt = normalizedAt(chat?.updatedAt, createdAt);
  const messages = Array.isArray(chat?.messages)
    ? chat.messages.map((message) => ({
        id: String(message?.id || makeId()),
        role: ["user", "assistant", "system"].includes(message?.role) ? message.role : "system",
        text: String(message?.text || ""),
        label: String(message?.label || ""),
        images: Array.isArray(message?.images) ? message.images.map(normalizeImageReference).filter(Boolean) : [],
        canonicalPrompt: String(message?.canonicalPrompt || ""),
        controlsFingerprint: String(message?.controlsFingerprint || ""),
        llmAmplified: Boolean(message?.llmAmplified),
        executionPrompt: String(message?.executionPrompt || message?.canonicalPrompt || ""),
        generationAction: ["edit", "upscale"].includes(message?.generationAction) ? message.generationAction : "create",
        workflowProfileId: String(message?.workflowProfileId || ""),
        workflowName: String(message?.workflowName || ""),
        sourceImage: normalizeImageReference(message?.sourceImage),
        resultNodeIds: Array.isArray(message?.resultNodeIds) ? message.resultNodeIds.map(String) : [],
        resultFields: Array.isArray(message?.resultFields) && message.resultFields.length ? message.resultFields.map(String) : ["images", "gifs"],
        createdAt: normalizedAt(message?.createdAt, updatedAt),
      }))
    : [];
  const storedCurrentPrompt = String(chat?.currentPrompt || "");
  const storedVersions = Array.isArray(chat?.versions) && chat.versions.length
    ? chat.versions.map((value) => String(value))
    : [storedCurrentPrompt];
  const latestGeneratedPrompt = [...messages]
    .reverse()
    .find((message) => message.canonicalPrompt.trim())
    ?.canonicalPrompt || "";
  const recoverGeneratedPrompt = !storedCurrentPrompt.trim()
    && !storedVersions.some((prompt) => prompt.trim())
    && Boolean(latestGeneratedPrompt.trim());
  const currentPrompt = recoverGeneratedPrompt ? latestGeneratedPrompt : storedCurrentPrompt;
  const versions = recoverGeneratedPrompt
    ? [currentPrompt]
    : storedVersions;
  const requestedIndex = Number(recoverGeneratedPrompt ? versions.length - 1 : chat?.versionIndex ?? versions.length - 1);
  const versionIndex = Number.isFinite(requestedIndex)
    ? Math.max(0, Math.min(requestedIndex, versions.length - 1))
    : versions.length - 1;
  return {
    id: String(chat?.id || makeId()),
    createdAt,
    updatedAt,
    initialized: recoverGeneratedPrompt || (chat?.initialized == null ? Boolean(currentPrompt) : Boolean(chat.initialized)),
    currentPrompt,
    versions,
    versionIndex,
    controlsFingerprint: String(chat?.controlsFingerprint || ""),
    createWorkflowId: String(chat?.createWorkflowId || ""),
    editWorkflowId: String(chat?.editWorkflowId || ""),
    upscaleWorkflowId: String(chat?.upscaleWorkflowId || ""),
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
  const width = Number(value.width);
  const height = Number(value.height);
  const normalized = {
    filename,
    subfolder: String(value.subfolder || ""),
    type: ["input", "output", "temp"].includes(value.type) ? value.type : "output",
  };
  if (Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0) {
    normalized.width = width;
    normalized.height = height;
  }
  return normalized;
}

function storedImageReference(value) {
  const reference = normalizeImageReference(value);
  if (!reference) return null;
  return {
    filename: reference.filename,
    subfolder: reference.subfolder,
    type: reference.type,
  };
}

async function imageReferenceWithDimensions(value) {
  const reference = normalizeImageReference(value);
  if (!reference) throw new Error("The image reference is invalid.");
  if (reference.width && reference.height) return reference;
  const response = await api.fetchApi("/promptstudio/prompt-studio/image-size", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: storedImageReference(reference) }),
  });
  const data = await response.json().catch(() => ({}));
  const width = Number(data.width);
  const height = Number(data.height);
  if (!response.ok || !Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    const serverError = data.error || `Image dimensions could not be read (${response.status}).`;
    try {
      // Frontend assets can refresh before ComfyUI restarts and registers a newly added Python route.
      const dimensions = await imageDimensionsFromView(reference);
      return { ...reference, ...dimensions };
    } catch {
      throw new Error(serverError);
    }
  }
  return { ...reference, width, height };
}

function imageDimensionsFromView(reference) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => {
      const width = Number(image.naturalWidth);
      const height = Number(image.naturalHeight);
      if (Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0) {
        resolve({ width, height });
      } else {
        reject(new Error("The image loaded without readable dimensions."));
      }
    }, { once: true });
    image.addEventListener("error", () => reject(new Error("The image could not be loaded.")), { once: true });
    image.src = imageReferenceUrl(reference);
  });
}

function normalizeLastGeneration(value) {
  if (!value || typeof value !== "object") return null;
  return {
    action: ["edit", "upscale"].includes(value.action) ? value.action : "create",
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
        const response = await api.fetchApi("/promptstudio/prompt-studio/chats", {
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
  let recoveredCanonicalPrompt = false;
  try {
    const response = await api.fetchApi("/promptstudio/prompt-studio/chats");
    const stored = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(stored.error || `Chat load failed (${response.status}).`);
    const storedChats = Array.isArray(stored.chats) ? stored.chats : [];
    state.chats = storedChats.map(normalizeChat);
    recoveredCanonicalPrompt = state.chats.some((chat, index) => (
      !String(storedChats[index]?.currentPrompt || "").trim()
      && Boolean(chat.currentPrompt.trim())
    ));
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
  const chat = activeChat();
  if (chat) {
    restoreChatState(chat);
    renderChatHistory();
    renderChatList();
  }
  if (recoveredCanonicalPrompt) saveChats({ immediate: true });
}

function restoreChatState(chat) {
  state.currentPrompt = chat.currentPrompt;
  state.versions = [...chat.versions];
  state.versionIndex = chat.versionIndex;
  updatePromptEditor(chat.currentPrompt);
}

function syncActiveChat() {
  const chat = activeChat();
  if (!chat) return;
  chat.currentPrompt = state.currentPrompt;
  chat.versions = [...state.versions];
  chat.versionIndex = state.versionIndex;
  chat.initialized = Boolean(chat.initialized);
  chat.createWorkflowId = state.panel?.querySelector("#promptstudio-create-workflow")?.value || "";
  chat.editWorkflowId = state.panel?.querySelector("#promptstudio-edit-workflow")?.value || "";
  chat.upscaleWorkflowId = state.panel?.querySelector("#promptstudio-upscale-workflow")?.value || "";
  chat.editPromptMode = selectedEditPromptMode();
  chat.updatedAt = Date.now();
  saveChats();
  renderChatList();
}

function normalizeWorkflowProfile(profile) {
  const snapshot = profile?.snapshot && typeof profile.snapshot === "object" ? profile.snapshot : null;
  const path = String(profile?.path || profile?.id || "").replaceAll("\\", "/");
  return {
    id: path,
    path,
    name: String(profile?.name || workflowNameFromPath(path) || "Workflow").trim() || "Workflow",
    kind: ["edit", "upscale"].includes(profile?.kind) ? profile.kind : "create",
    promptMode: "full_prompt",
    promptNodeId: String(profile?.promptNodeId || ""),
    imageNodeId: String(profile?.imageNodeId || ""),
    upscaleNodeId: String(profile?.upscaleNodeId || ""),
    resultNodeIds: Array.isArray(profile?.resultNodeIds) ? profile.resultNodeIds.map(String) : [],
    resultFields: ["images", "gifs"],
    snapshot,
    updatedAt: Number(profile?.updatedAt || Date.now()),
    sourceModified: Number(profile?.sourceModified || 0),
    stale: Boolean(profile?.stale),
    error: String(profile?.error || ""),
  };
}

function workflowNameFromPath(path) {
  const filename = String(path || "").replaceAll("\\", "/").split("/").pop() || "";
  return filename.replace(/\.json$/i, "");
}

function isPromptStudioWorkflowPath(path) {
  const normalized = String(path || "").replaceAll("\\", "/");
  const filename = normalized.split("/").pop() || "";
  return normalized.startsWith("workflows/")
    && filename.startsWith("[PS]")
    && filename.toLowerCase().endsWith(".json");
}

function scheduleWorkflowRefresh({ broadcast = false } = {}) {
  state.workflowRefreshBroadcast ||= broadcast;
  if (state.workflowRefreshTimer) clearTimeout(state.workflowRefreshTimer);
  const refreshWhenReady = () => {
    if (state.workflowBusy) {
      state.workflowRefreshTimer = setTimeout(refreshWhenReady, 100);
      return;
    }
    state.workflowRefreshTimer = null;
    const shouldBroadcast = state.workflowRefreshBroadcast;
    state.workflowRefreshBroadcast = false;
    refreshWorkflowTemplates()
      .then(() => {
        if (!shouldBroadcast) return;
        state.workflowSyncChannel?.postMessage({
          type: "saved-workflows-refreshed",
          issues: state.workflowIssues,
          revision: state.workflowRevision,
        });
      })
      .catch((error) => {
        setStatus(error.message || "Saved ComfyUI workflows could not be refreshed.", "warning");
      });
  };
  state.workflowRefreshTimer = setTimeout(refreshWhenReady, 50);
}

function setupWorkflowSync() {
  if (typeof BroadcastChannel !== "function" || state.workflowSyncChannel) return;
  const channel = new BroadcastChannel(WORKFLOW_SYNC_CHANNEL);
  channel.addEventListener("message", async (event) => {
    const data = event.data;
    if (data?.type !== "saved-workflows-refreshed") return;
    if (Number(data.revision || 0) < state.workflowRevision) return;
    try {
      const response = await api.fetchApi("/promptstudio/prompt-studio/workflows");
      const stored = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(stored.templates)) return;
      state.workflowProfiles = stored.templates.map(normalizeWorkflowProfile);
      state.workflowIssues = Array.isArray(data.issues) ? data.issues.map(String) : [];
      state.workflowRevision = Number(stored.revision || state.workflowRevision);
      state.workflowStoreLoaded = true;
      refreshWorkflowControls();
      announceWorkflowSelection(selectedAction(), { persist: false });
    } catch (error) {
      setStatus(error.message || "Saved ComfyUI workflows could not be synchronized.", "warning");
    }
  });
  state.workflowSyncChannel = channel;
}

function installWorkflowSaveObserver() {
  if (api[WORKFLOW_OBSERVER_KEY]) return;
  const storeUserData = api.storeUserData;
  const moveUserData = api.moveUserData;
  const deleteUserData = api.deleteUserData;
  if (typeof storeUserData !== "function") return;

  api.storeUserData = async function observedStoreUserData(path, ...args) {
    const response = await storeUserData.call(this, path, ...args);
    if (isPromptStudioWorkflowPath(path)) scheduleWorkflowRefresh({ broadcast: true });
    return response;
  };
  if (typeof moveUserData === "function") {
    api.moveUserData = async function observedMoveUserData(source, destination, ...args) {
      const response = await moveUserData.call(this, source, destination, ...args);
      if (isPromptStudioWorkflowPath(source) || isPromptStudioWorkflowPath(destination)) scheduleWorkflowRefresh({ broadcast: true });
      return response;
    };
  }
  if (typeof deleteUserData === "function") {
    api.deleteUserData = async function observedDeleteUserData(path, ...args) {
      const response = await deleteUserData.call(this, path, ...args);
      if (isPromptStudioWorkflowPath(path)) scheduleWorkflowRefresh({ broadcast: true });
      return response;
    };
  }
  api[WORKFLOW_OBSERVER_KEY] = true;
}

function imageOutputNode(node) {
  const data = node?.constructor?.nodeData;
  if (!data?.output_node) return false;
  const sockets = [...(node?.inputs || []), ...(node?.outputs || [])];
  if (sockets.some((socket) => String(socket?.type || "").split(",").includes("IMAGE"))) return true;
  const identity = `${nodeClassName(node)} ${node?.type || ""} ${node?.title || ""}`;
  return /(?:image.*(?:save|preview|output)|(?:save|preview|output).*image|save.*(?:png|jpe?g|webp))/i.test(identity);
}

function firstExecutableNode(graph, snapshot, classTypes) {
  const output = snapshot?.output || {};
  return (graph?._nodes || []).find((node) => (
    Object.hasOwn(output, String(node.id)) && classTypes.includes(output[String(node.id)]?.class_type)
  ));
}

async function buildWorkflowTemplate(file, workflowData, cached) {
  const Graph = app.rootGraph?.constructor || app.graph?.constructor;
  if (typeof Graph !== "function") throw new Error("ComfyUI's workflow graph is not ready.");
  const graph = new Graph();
  const configureErrors = graph.configure(structuredClone(workflowData));
  if (Array.isArray(configureErrors) && configureErrors.length) {
    throw new Error(`ComfyUI could not load ${configureErrors.length} workflow node${configureErrors.length === 1 ? "" : "s"}.`);
  }
  const snapshot = structuredClone(await app.graphToPrompt(graph));
  const graphUpscaleNodes = (graph._nodes || []).filter((node) => nodeClassName(node) === UPSCALE_TYPE);
  const upscaleWorkflow = graphUpscaleNodes.length > 0 || cached?.kind === "upscale";
  const upscaleNode = firstExecutableNode(graph, snapshot, [UPSCALE_TYPE]);
  if (upscaleWorkflow && !upscaleNode) {
    throw new Error("Upscaling workflows need an executable Prompt Studio Upscale node.");
  }
  const graphImageSources = (graph._nodes || []).filter((node) => nodeClassName(node) === IMAGE_SOURCE_TYPE);
  const editingWorkflow = !upscaleWorkflow && (graphImageSources.length > 0 || cached?.kind === "edit");
  const imageNode = firstExecutableNode(graph, snapshot, [IMAGE_SOURCE_TYPE]);
  if (editingWorkflow && !imageNode) {
    throw new Error("Image workflows need an executable Prompt Studio Image Source node.");
  }
  const promptNode = firstExecutableNode(graph, snapshot, [SLOT_TYPE, AMPLIFY_TYPE]);
  if (!upscaleWorkflow && !promptNode) {
    throw new Error(`${editingWorkflow ? "Editing" : "Creation"} workflows need an executable KoboldCpp Prompt Slot or Prompt Amplify node.`);
  }

  const output = snapshot?.output || {};
  const imageOutputs = (graph._nodes || []).filter((node) => (
    Object.hasOwn(output, String(node.id)) && imageOutputNode(node)
  ));
  if (imageOutputs.length !== 1) {
    throw new Error(`Workflow must have exactly one image output; found ${imageOutputs.length}.`);
  }

  return normalizeWorkflowProfile({
    id: file.path,
    path: file.path,
    name: workflowNameFromPath(file.path),
    kind: upscaleWorkflow ? "upscale" : editingWorkflow ? "edit" : "create",
    promptNodeId: upscaleWorkflow ? "" : String(promptNode.id),
    imageNodeId: editingWorkflow ? String(imageNode.id) : "",
    upscaleNodeId: upscaleWorkflow ? String(upscaleNode.id) : "",
    resultNodeIds: [String(imageOutputs[0].id)],
    snapshot,
    updatedAt: Date.now(),
    sourceModified: Number(file.modified || 0),
  });
}

async function loadWorkflowProfiles() {
  const response = await api.fetchApi("/promptstudio/prompt-studio/workflows");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Workflow cache could not be loaded (${response.status}).`);
  state.workflowProfiles = Array.isArray(data.templates) ? data.templates.map(normalizeWorkflowProfile) : [];
  state.workflowRevision = Number(data.revision || 0);
  state.workflowStoreLoaded = true;
  await refreshWorkflowTemplates({ announce: false });
  refreshWorkflowControls();
  announceWorkflowSelection(selectedAction());
}

async function saveWorkflowProfiles() {
  if (!state.workflowStoreLoaded) throw new Error("The workflow cache was not loaded, so saving is disabled to protect it.");
  const snapshot = structuredClone(state.workflowProfiles);
  const operation = state.workflowSaveChain
    .catch(() => {})
    .then(async () => {
      const response = await api.fetchApi("/promptstudio/prompt-studio/workflows", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 3, revision: state.workflowRevision, templates: snapshot }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409) state.workflowStoreLoaded = false;
        throw new Error(data.error || `Workflow cache could not be saved (${response.status}).`);
      }
      state.workflowRevision = Number(data.revision || state.workflowRevision);
    });
  state.workflowSaveChain = operation;
  return operation;
}

async function refreshWorkflowTemplates({ announce = true } = {}) {
  if (state.workflowBusy) return;
  state.workflowBusy = true;
  renderWorkflowStatus();
  const previous = state.workflowProfiles;
  const cachedByPath = new Map(previous.map((profile) => [profile.path, profile]));
  const next = [];
  const issues = [];
  try {
    const response = await api.fetchApi("/userdata?dir=workflows&recurse=true&full_info=true");
    if (!response.ok) throw new Error(`ComfyUI workflows could not be listed (${response.status}).`);
    const files = (await response.json())
      .filter((file) => (
        file && typeof file.path === "string"
        && file.path.split("/").pop().startsWith("[PS]")
        && file.path.toLowerCase().endsWith(".json")
      ))
      .sort((left, right) => left.path.localeCompare(right.path));

    for (const file of files) {
      const cached = cachedByPath.get(file.path);
      if (cached && !cached.stale && cached.sourceModified === Number(file.modified || 0)) {
        next.push(cached);
        continue;
      }
      try {
        const userDataPath = `workflows/${file.path}`;
        const workflowResponse = typeof api.getUserData === "function"
          ? await api.getUserData(userDataPath)
          : await api.fetchApi(`/userdata/${encodeURIComponent(userDataPath)}`);
        if (!workflowResponse.ok) throw new Error(`ComfyUI could not read the workflow (${workflowResponse.status}).`);
        const workflowData = await workflowResponse.json();
        next.push(await buildWorkflowTemplate(file, workflowData, cached));
      } catch (error) {
        const message = error.message || String(error);
        issues.push(`${workflowNameFromPath(file.path)}: ${message}`);
        if (cached?.snapshot?.output) {
          next.push(normalizeWorkflowProfile({ ...cached, stale: true, error: message }));
        }
      }
    }
    state.workflowProfiles = next;
    state.workflowIssues = issues;
    refreshWorkflowControls();
    if (JSON.stringify(previous) !== JSON.stringify(next)) await saveWorkflowProfiles();
    if (announce) {
      const cachedCount = next.filter((profile) => profile.stale).length;
      if (issues.length) {
        setStatus(
          cachedCount
            ? `${issues.length} ComfyUI workflow update${issues.length === 1 ? "" : "s"} failed; ${cachedCount} cached workflow${cachedCount === 1 ? " is" : "s are"} still available.`
            : `${issues.length} [PS] workflow${issues.length === 1 ? " is" : "s are"} invalid and were not accepted.`,
          "warning",
        );
      } else {
        setStatus(`Loaded ${next.length} compatible [PS] workflow${next.length === 1 ? "" : "s"} from ComfyUI.`, "ready");
      }
    }
  } catch (error) {
    const message = error.message || String(error);
    state.workflowProfiles = previous.map((profile) => normalizeWorkflowProfile({ ...profile, stale: true, error: message }));
    state.workflowIssues = [message];
    refreshWorkflowControls();
    if (announce) setStatus(`${message} The last working cache remains available.`, "warning");
  } finally {
    state.workflowBusy = false;
    refreshWorkflowControls();
  }
}

function controlsFingerprint() {
  if (!state.panel) return "";
  return JSON.stringify(CONTROL_IDS.map((id) => state.panel.querySelector(`#${id}`)?.value ?? ""));
}

function useLlmAmplification() {
  return state.panel?.querySelector("#promptstudio-use-llm-amplification")?.checked !== false;
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
  } else if (selectedWorkflowProfile(selectedAction())) {
    announceWorkflowSelection(selectedAction());
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

function chatActivityAt(chat) {
  if (!chat.messages.length) return chat.createdAt;
  return chat.messages.reduce(
    (newest, message) => Math.max(newest, message.createdAt),
    Number.NEGATIVE_INFINITY,
  );
}

function compareChatsNewestFirst(left, right) {
  return chatActivityAt(right) - chatActivityAt(left)
    || right.createdAt - left.createdAt
    || left.id.localeCompare(right.id);
}

function renderChatList() {
  const list = state.panel?.querySelector("#promptstudio-chat-list");
  if (!list) return;
  list.replaceChildren();
  const ordered = [...state.chats].sort(compareChatsNewestFirst);
  for (const chat of ordered) {
    const row = document.createElement("div");
    row.className = "promptstudio-chat-row";
    row.dataset.active = chat.id === state.activeChatId ? "true" : "false";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "promptstudio-chat-item";
    button.disabled = state.busy;
    const title = document.createElement("span");
    title.className = "promptstudio-chat-title";
    title.textContent = chatTitle(chat.createdAt);
    const date = document.createElement("span");
    date.className = "promptstudio-chat-date";
    date.textContent = `${chat.messages.length} message${chat.messages.length === 1 ? "" : "s"}`;
    button.append(title, date);
    button.addEventListener("click", () => activateChat(chat.id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "promptstudio-chat-delete";
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

function scrollHistoryToEnd({ instant = false } = {}) {
  const history = state.panel?.querySelector("#promptstudio-history");
  if (!history) return;
  const scroll = () => {
    if (instant) history.classList.add("promptstudio-instant-scroll");
    history.scrollTop = history.scrollHeight;
    if (instant) history.classList.remove("promptstudio-instant-scroll");
  };
  scroll();
  const view = history.ownerDocument.defaultView;
  view?.requestAnimationFrame(() => view.requestAnimationFrame(scroll));
  for (const image of history.querySelectorAll("img")) {
    if (!image.complete) image.addEventListener("load", scroll, { once: true });
  }
}

function renderChatHistory() {
  const history = state.panel?.querySelector("#promptstudio-history");
  if (!history) return;
  history.replaceChildren();
  for (const message of activeChat()?.messages || []) renderMessage(message, { scroll: false });
  scrollHistoryToEnd({ instant: true });
  updateComposeMode();
}

function updateComposeMode() {
  if (!state.panel) return;
  const createAction = state.panel.querySelector('input[name="promptstudio-generation-action"][value="create"]');
  const editAction = state.panel.querySelector('input[name="promptstudio-generation-action"][value="edit"]');
  const canEdit = Boolean(editingSource());
  if (editAction) {
    editAction.disabled = state.busy || !canEdit;
    editAction.closest("label").title = canEdit ? "" : "There is no image in this conversation to edit.";
    if (!canEdit && editAction.checked && createAction) createAction.checked = true;
  }
  const amplificationEnabled = useLlmAmplification();
  const creating = !activeChat()?.initialized;
  const heading = state.panel.querySelector("#promptstudio-compose-title");
  const hint = state.panel.querySelector("#promptstudio-compose-hint");
  const input = state.panel.querySelector("#promptstudio-revision");
  const send = state.panel.querySelector("#promptstudio-send");
  const editor = state.panel.querySelector("#promptstudio-current-prompt");
  const action = selectedAction();
  const autoGenerate = state.panel.querySelector("#promptstudio-auto-generate")?.checked !== false;
  const editPromptAction = state.panel.querySelector("#promptstudio-edit-prompt-action");
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
  if (enabled) state.panel.querySelector("#promptstudio-revision").value = "";
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
  updatePromptEditor(value);
  syncActiveChat();
}

function createChat() {
  if (state.busy) return;
  commitPromptEditorVersion();
  syncActiveChat();
  const createAction = state.panel?.querySelector('input[name="promptstudio-generation-action"][value="create"]');
  if (createAction) createAction.checked = true;
  const chat = normalizeChat({
    initialized: false,
    currentPrompt: "",
    versions: [""],
    versionIndex: 0,
    controlsFingerprint: "",
    createWorkflowId: state.panel?.querySelector("#promptstudio-create-workflow")?.value || "",
    editWorkflowId: state.panel?.querySelector("#promptstudio-edit-workflow")?.value || "",
    upscaleWorkflowId: state.panel?.querySelector("#promptstudio-upscale-workflow")?.value || "",
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
    const replacement = normalizeChat({});
    state.chats.push(replacement);
  }
  if (wasActive) {
    const replacement = [...state.chats].sort(compareChatsNewestFirst)[0];
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
  restoreChatState(chat);
  refreshWorkflowControls();
  renderChatHistory();
  renderChatList();
  refreshSecondaryInstructionsControl();
  if (!selectedWorkflowProfile(selectedAction())) {
    setStatus("No compatible [PS] workflow is selected for this action.", "warning");
  } else if (!useLlmAmplification()) {
    setStatus("Direct prompt mode. KoboldCpp will not be used.", "ready");
  } else if (!chat.initialized) {
    setStatus("Describe an image to create the first prompt.", "ready");
  } else if (controlsNeedApply()) {
    setStatus("Generation controls differ from this prompt. KoboldCpp will update it before generation.", "warning");
  } else {
    announceWorkflowSelection(selectedAction());
  }
  const undo = state.panel?.querySelector("#promptstudio-undo");
  if (undo) undo.disabled = state.versionIndex <= 0 || state.busy;
  state.panel?.classList.remove("promptstudio-chats-open");
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

function refreshSecondaryInstructionsControl() {
  const editor = state.panel?.querySelector("#promptstudio-secondary-instructions");
  if (editor) {
    editor.disabled = state.busy;
  }
}

function selectedAction() {
  return state.panel?.querySelector('input[name="promptstudio-generation-action"]:checked')?.value === "edit"
    ? "edit"
    : "create";
}

function selectedEditPromptMode() {
  return state.panel?.querySelector('input[name="promptstudio-edit-prompt-mode"]:checked')?.value === "edit_instruction"
    ? "edit_instruction"
    : "full_prompt";
}

function setEditPromptMode(mode, { persist = false } = {}) {
  const normalized = mode === "edit_instruction" ? "edit_instruction" : "full_prompt";
  const control = state.panel?.querySelector(`input[name="promptstudio-edit-prompt-mode"][value="${normalized}"]`);
  if (control) control.checked = true;
  if (persist) syncActiveChat();
}

function workflowProfileById(profileId) {
  return state.workflowProfiles.find((profile) => profile.id === String(profileId || "")) || null;
}

function selectedWorkflowProfileId(action = selectedAction()) {
  const selectId = action === "upscale"
    ? "#promptstudio-upscale-workflow"
    : action === "edit"
      ? "#promptstudio-edit-workflow"
      : "#promptstudio-create-workflow";
  return workflowProfileById(state.panel?.querySelector(selectId)?.value)?.id || "";
}

function selectedWorkflowProfile(action = selectedAction()) {
  return workflowProfileById(selectedWorkflowProfileId(action));
}

function announceWorkflowSelection(action, { persist = true } = {}) {
  if (persist) syncActiveChat();
  const profile = selectedWorkflowProfile(action);
  refreshSecondaryInstructionsControl();
  const role = action === "upscale" ? "upscaling" : action === "edit" ? "editing" : "creation";
  const verb = action === "upscale" ? "Upscale" : action === "edit" ? "Edit" : "Create";
  if (!profile) {
    setStatus(`No compatible [PS] ${role} workflow is available.`, "warning");
  } else if (profile.stale) {
    setStatus(`“${profile.name}” is invalid in ComfyUI. Prompt Studio will use its last working cache.`, "warning");
  } else {
    setStatus(`${verb} will use “${profile.name}” from ComfyUI.`, "ready");
  }
}

function fillWorkflowSelect(select, kind, remembered) {
  if (!select) return;
  select.replaceChildren();
  const compatible = state.workflowProfiles.filter((item) => (
    kind === "create"
      ? item.kind === "create" && Boolean(item.promptNodeId)
      : kind === "edit"
        ? item.kind === "edit" && Boolean(item.imageNodeId) && Boolean(item.promptNodeId)
        : item.kind === "upscale" && Boolean(item.upscaleNodeId)
  ));
  for (const profile of compatible) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `${profile.name}${profile.stale ? " · cached" : ""}`;
    select.appendChild(option);
  }
  if (!select.options.length) {
    const unavailable = document.createElement("option");
    unavailable.value = "";
    unavailable.textContent = `No compatible ${kind === "upscale" ? "upscaling" : kind === "edit" ? "editing" : "creation"} workflows`;
    select.appendChild(unavailable);
    select.disabled = true;
    return;
  }
  select.disabled = state.busy || state.workflowBusy;
  if ([...select.options].some((option) => option.value === remembered)) select.value = remembered;
}

function refreshWorkflowControls() {
  if (!state.panel) return;
  const chat = activeChat();
  fillWorkflowSelect(state.panel.querySelector("#promptstudio-create-workflow"), "create", chat?.createWorkflowId || "");
  fillWorkflowSelect(state.panel.querySelector("#promptstudio-edit-workflow"), "edit", chat?.editWorkflowId || "");
  fillWorkflowSelect(state.panel.querySelector("#promptstudio-upscale-workflow"), "upscale", chat?.upscaleWorkflowId || "");
  const editWorkflow = workflowProfileById(chat?.editWorkflowId);
  setEditPromptMode(chat?.editPromptMode || editWorkflow?.promptMode || "full_prompt");
  refreshSecondaryInstructionsControl();
  updateComposeMode();
  renderWorkflowStatus();
}

function renderWorkflowStatus() {
  const status = state.panel?.querySelector("#promptstudio-workflow-template-status");
  if (!status) return;
  const cachedCount = state.workflowProfiles.filter((profile) => profile.stale).length;
  const createCount = state.workflowProfiles.filter((profile) => profile.kind === "create").length;
  const editCount = state.workflowProfiles.filter((profile) => profile.kind === "edit" && profile.promptNodeId).length;
  const upscaleCount = state.workflowProfiles.filter((profile) => profile.kind === "upscale" && profile.upscaleNodeId).length;
  status.textContent = state.workflowBusy
    ? "Checking ComfyUI workflows…"
    : `${createCount} creation · ${editCount} editing · ${upscaleCount} upscaling${cachedCount ? ` · ${cachedCount} cached` : ""}${state.workflowIssues.length ? ` · ${state.workflowIssues.length} rejected update${state.workflowIssues.length === 1 ? "" : "s"}` : ""}`;
  status.dataset.kind = state.workflowIssues.length ? "warning" : "ready";
  status.title = state.workflowIssues.join("\n");
}

function setStatus(text, kind = "") {
  const el = state.panel?.querySelector("#promptstudio-status");
  if (!el) return;
  el.textContent = text;
  el.title = text;
  el.dataset.kind = kind;
}

function setBusy(busy) {
  state.busy = busy;
  state.panel?.querySelectorAll("button[data-disable-busy]").forEach((button) => {
    button.disabled = busy;
  });
  state.panel?.querySelectorAll(".promptstudio-mode-control input, .promptstudio-generation-action input, .promptstudio-workflow-routing select, .promptstudio-settings input, .promptstudio-settings select, .promptstudio-settings textarea, .promptstudio-resolution-details input, .promptstudio-resolution-details select, .promptstudio-current-details textarea, .promptstudio-secondary-details textarea")
    .forEach((control) => {
      control.disabled = busy;
    });
  const undo = state.panel?.querySelector("#promptstudio-undo");
  if (undo) undo.disabled = busy || state.versionIndex <= 0;
  const newChat = state.panel?.querySelector("#promptstudio-new-chat");
  if (newChat) newChat.disabled = busy;
  state.panel?.querySelectorAll(".promptstudio-chat-item").forEach((button) => {
    button.disabled = busy;
  });
  refreshWorkflowControls();
}

function closeImageLightbox() {
  const lightbox = state.panel?.querySelector("#promptstudio-lightbox");
  if (!lightbox || lightbox.hidden) return;
  lightbox.hidden = true;
  const image = lightbox.querySelector("#promptstudio-lightbox-image");
  if (image) image.removeAttribute("src");
  state.lightboxTrigger?.focus({ preventScroll: true });
  state.lightboxTrigger = null;
}

function openImageLightbox(url, alt, trigger) {
  const lightbox = state.panel?.querySelector("#promptstudio-lightbox");
  if (!lightbox) return;
  const image = lightbox.querySelector("#promptstudio-lightbox-image");
  const open = lightbox.querySelector("#promptstudio-lightbox-open");
  image.src = url;
  image.alt = alt;
  open.href = url;
  state.lightboxTrigger = trigger;
  lightbox.hidden = false;
  lightbox.focus({ preventScroll: true });
}

function closeUpscaleDialog() {
  const dialog = state.panel?.querySelector("#promptstudio-upscale-dialog");
  if (!dialog || dialog.hidden) return;
  dialog.hidden = true;
  dialog._upscaleRequest = null;
}

function requestImageUpscale(reference, generationData = null) {
  if (state.busy) return setStatus("Wait for the current operation to finish.", "warning");
  const source = normalizeImageReference(reference);
  if (!source) return;
  const profile = selectedWorkflowProfile("upscale");
  if (!profile) return setStatus("Select a compatible [PS] upscaling workflow first.", "warning");
  const dialog = state.panel?.querySelector("#promptstudio-upscale-dialog");
  const factor = dialog?.querySelector("#promptstudio-upscale-factor");
  if (!dialog || !factor) return;
  dialog._upscaleRequest = { source, generationData, workflowProfileId: profile.id };
  factor.value = "2";
  dialog.hidden = false;
  factor.focus({ preventScroll: true });
  factor.select();
}

function imageReferenceKey(reference) {
  const value = normalizeImageReference(reference);
  return value ? `${value.type}\u0000${value.subfolder}\u0000${value.filename}` : "";
}

function imageReferenceUrl(reference) {
  const value = storedImageReference(reference);
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
  updatePromptEditor(prompt);
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
  const editAction = state.panel?.querySelector('input[name="promptstudio-generation-action"][value="edit"]');
  if (editAction) editAction.checked = true;
  const promptRestored = restoreStoredCanonicalPrompt(generationData);
  saveChats();
  refreshRenderedImageSources();
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

function refreshRenderedImageSources() {
  const selectedKey = encodeURIComponent(imageReferenceKey(activeChat()?.selectedSource));
  for (const card of state.panel?.querySelectorAll(".promptstudio-image-card") || []) {
    const selected = card.dataset.imageKey === selectedKey;
    card.dataset.source = selected ? "true" : "false";
    const button = card.querySelector(".promptstudio-use-source");
    if (button) button.textContent = selected ? "Editing source" : "Edit this image";
  }
}

function renderImageGallery(message, images, generationData = null) {
  if (!message || !images?.length) return;
  message.classList.add("promptstudio-has-images");
  const gallery = document.createElement("div");
  gallery.className = "promptstudio-image-grid";
  for (const item of images) {
    const reference = normalizeImageReference(item);
    if (!reference) continue;
    const card = document.createElement("div");
    card.className = "promptstudio-image-card";
    card.dataset.imageKey = encodeURIComponent(imageReferenceKey(reference));
    card.dataset.source = imageReferenceKey(activeChat()?.selectedSource) === imageReferenceKey(reference) ? "true" : "false";
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "promptstudio-image-preview";
    const url = imageReferenceUrl(reference);
    const image = document.createElement("img");
    image.src = url;
    image.alt = item.filename || "Generated image";
    if (reference.width && reference.height) {
      image.width = reference.width;
      image.height = reference.height;
    }
    preview.title = `Preview ${image.alt}`;
    preview.setAttribute("aria-label", preview.title);
    preview.addEventListener("click", () => openImageLightbox(url, image.alt, preview));
    preview.appendChild(image);
    const actions = document.createElement("div");
    actions.className = "promptstudio-image-actions";
    const useSource = document.createElement("button");
    useSource.type = "button";
    useSource.className = "promptstudio-use-source";
    useSource.dataset.disableBusy = "";
    useSource.disabled = state.busy;
    useSource.textContent = card.dataset.source === "true" ? "Editing source" : "Edit this image";
    useSource.addEventListener("click", () => selectImageSource(reference, generationData));
    const upscale = document.createElement("button");
    upscale.type = "button";
    upscale.className = "promptstudio-upscale-image";
    upscale.dataset.disableBusy = "";
    upscale.disabled = state.busy;
    upscale.title = "Upscale this image";
    upscale.setAttribute("aria-label", upscale.title);
    upscale.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5M4 9l6-6M20 9l-6-6M4 15l6 6M20 15l-6 6" /></svg>';
    upscale.addEventListener("click", () => requestImageUpscale(reference, generationData));
    actions.append(useSource, upscale);
    card.append(preview, actions);
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
  if (!message || !data?.canonicalPrompt || !data.images?.length || message.querySelector(".promptstudio-prompt-info")) return;
  message.classList.add("promptstudio-has-prompt");
  const details = document.createElement("details");
  details.className = "promptstudio-prompt-info";
  const summary = document.createElement("summary");
  summary.textContent = "i";
  summary.title = "Show the canonical prompt used for this generation";
  summary.setAttribute("aria-label", summary.title);
  const panel = document.createElement("div");
  panel.className = "promptstudio-prompt-info-panel";
  const heading = document.createElement("strong");
  heading.textContent = "Canonical prompt used";
  const text = document.createElement("div");
  text.className = "promptstudio-prompt-info-text";
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
    executionText.className = "promptstudio-prompt-info-text";
    executionText.textContent = data.executionPrompt;
    panel.append(executionHeading, executionText);
  }
  panel.append(usePrompt);
  details.append(summary, panel);
  message.appendChild(details);
}

function renderMessage(data, { scroll = true } = {}) {
  const history = state.panel?.querySelector("#promptstudio-history");
  if (!history) return null;
  const message = document.createElement("div");
  message.className = `promptstudio-message promptstudio-${data.role}`;
  message.dataset.messageId = data.id;

  if (data.label) {
    const label = document.createElement("div");
    label.className = "promptstudio-message-label";
    label.textContent = data.label;
    message.appendChild(label);
  }

  if (data.canonicalPrompt && data.workflowName) {
    const provenance = document.createElement("div");
    provenance.className = "promptstudio-generation-provenance";
    provenance.textContent = data.generationAction === "upscale"
      ? `Upscaled source · ${data.workflowName}`
      : data.generationAction === "edit"
        ? `Edited source · ${data.workflowName}`
        : `Created new · ${data.workflowName}`;
    message.appendChild(provenance);
  }

  if (data.text) {
    const body = document.createElement("div");
    body.className = "promptstudio-message-text";
    body.textContent = data.text;
    message.appendChild(body);
  }
  renderImageGallery(message, data.images, data);
  renderPromptInfo(message, data);

  history.appendChild(message);
  if (scroll) history.scrollTop = history.scrollHeight;
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
    generationAction: ["edit", "upscale"].includes(options.generationAction) ? options.generationAction : "create",
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

async function appendImages(message, images) {
  if (!message || !images.length) return;
  const chat = activeChat();
  const stored = chat?.messages.find((item) => item.id === message.dataset.messageId);
  const enrichedImages = await Promise.all(images.map(async (image) => {
    try {
      return await imageReferenceWithDimensions(image);
    } catch (_) {
      return normalizeImageReference(image);
    }
  }));
  renderImageGallery(message, enrichedImages, stored);
  if (stored) {
    stored.images = enrichedImages;
    if (enrichedImages[0] && state.panel?.querySelector("#promptstudio-auto-advance-source")?.checked) {
      chat.selectedSource = normalizeImageReference(enrichedImages[0]);
    } else if (!chat.selectedSource && enrichedImages[0]) {
      chat.selectedSource = normalizeImageReference(enrichedImages[0]);
    }
    renderPromptInfo(message, stored);
    chat.updatedAt = Date.now();
    saveChats();
    renderChatList();
  }
  updateComposeMode();
  const history = state.panel?.querySelector("#promptstudio-history");
  if (history) history.scrollTop = history.scrollHeight;
}

function updatePromptEditor(prompt) {
  state.currentPrompt = prompt;
  const editor = state.panel?.querySelector("#promptstudio-current-prompt");
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
  const editor = state.panel?.querySelector("#promptstudio-current-prompt");
  if (!editor || editor.readOnly) return;
  const prompt = editor.value;
  syncCanonicalEditor(prompt, { userEdit: prompt !== state.currentPrompt });
  if (state.versions[state.versionIndex] !== prompt) pushVersion(prompt);
}

function pushVersion(prompt) {
  state.versions = state.versions.slice(0, state.versionIndex + 1);
  state.versions.push(prompt);
  state.versionIndex = state.versions.length - 1;
  const undo = state.panel?.querySelector("#promptstudio-undo");
  if (undo) undo.disabled = state.versionIndex <= 0 || state.busy;
  syncActiveChat();
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
  const response = await api.fetchApi("/promptstudio/prompt-studio/config");
  if (!response.ok) throw new Error(`Could not load Prompt Studio configuration (${response.status}).`);
  state.config = await response.json();
  const settings = getSettings();
  setOptions("promptstudio-profile", state.config.profiles, settings.model_profile);
  setOptions("promptstudio-style", state.config.styles, settings.style_preset);
  setOptions("promptstudio-framing", state.config.framings, settings.framing_preset);
  setOptions("promptstudio-thinking", state.config.thinking_modes, settings.thinking_mode);
  setOptions("promptstudio-embellishment", state.config.embellishment_levels, settings.embellishment_level);
}

function collectRevisionPayload(revision, mode = "revise") {
  const value = (id) => state.panel.querySelector(`#${id}`)?.value;
  return {
    current_prompt: state.currentPrompt,
    revision,
    mode,
    kobold_url: value("promptstudio-kobold-url"),
    model_profile: value("promptstudio-profile"),
    style_preset: value("promptstudio-style"),
    framing_preset: value("promptstudio-framing"),
    style_modifier: value("promptstudio-style-modifier"),
    framing_modifier: value("promptstudio-framing-modifier"),
    thinking_mode: value("promptstudio-thinking"),
    embellishment_level: value("promptstudio-embellishment"),
    max_response_tokens: Number(value("promptstudio-max-tokens") || 0),
    temperature: Number(value("promptstudio-temperature") || 0.7),
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

function compactErrorText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > 1000 ? `${text.slice(0, 997)}...` : text;
}

function generationFailureMessage(historyItem) {
  const status = historyItem?.status;
  if (String(status?.status_str || "").toLowerCase() !== "error") return "";

  let eventName = "";
  let details = null;
  const messages = Array.isArray(status?.messages) ? status.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (!Array.isArray(entry) || !["execution_error", "execution_interrupted"].includes(entry[0])) continue;
    eventName = entry[0];
    details = entry[1] && typeof entry[1] === "object" ? entry[1] : null;
    break;
  }

  const reason = compactErrorText(
    details?.exception_message || details?.error || details?.message || details?.exception_type,
  );
  const nodeType = compactErrorText(details?.node_type);
  const nodeId = compactErrorText(details?.node_id);
  const node = nodeType && nodeId ? `${nodeType}, node ${nodeId}` : nodeType || (nodeId ? `node ${nodeId}` : "");
  const fallback = eventName === "execution_interrupted"
    ? "ComfyUI interrupted execution."
    : "ComfyUI reported an execution error without further details.";
  return `Generation failed: ${reason || fallback}${node ? ` (${node})` : ""}`;
}

function updateMessageText(message, text) {
  if (!message) return;
  const value = String(text || "");
  const body = message.querySelector(".promptstudio-message-text");
  if (body && value) body.textContent = value;
  else if (body) body.remove();
  else if (value) {
    const nextBody = document.createElement("div");
    nextBody.className = "promptstudio-message-text";
    nextBody.textContent = value;
    const gallery = message.querySelector(".promptstudio-image-grid");
    message.insertBefore(nextBody, gallery);
  }
  const chat = activeChat();
  const stored = chat?.messages.find((item) => item.id === message.dataset.messageId);
  if (!stored) return;
  stored.text = value;
  chat.updatedAt = Date.now();
  saveChats();
  renderChatList();
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
        const failureMessage = generationFailureMessage(item);
        if (failureMessage || images.length || completed) {
          await appendImages(targetMessage, images);
          if (failureMessage) {
            updateMessageText(targetMessage, failureMessage);
            setStatus(failureMessage, "error");
          } else if (images.length) {
            updateMessageText(targetMessage, "");
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
  updatePromptEditor(prompt);
  if (sync) syncActiveChat();
}

async function workflowQueueContext(action, profileId = null) {
  const requestedId = profileId == null ? selectedWorkflowProfileId(action) : String(profileId || "");
  await refreshWorkflowTemplates({ announce: false });
  const selectedProfile = workflowProfileById(requestedId);
  const compatible = selectedProfile && (
    action === "create"
      ? selectedProfile.kind === "create" && Boolean(selectedProfile.promptNodeId)
      : action === "edit"
        ? selectedProfile.kind === "edit" && Boolean(selectedProfile.imageNodeId) && Boolean(selectedProfile.promptNodeId)
        : selectedProfile.kind === "upscale" && Boolean(selectedProfile.upscaleNodeId)
  );
  if (!compatible) {
    const role = action === "upscale" ? "upscaling" : action === "edit" ? "editing" : "creation";
    throw new Error(`The selected [PS] ${role} workflow is no longer available.`);
  }
  if (!selectedProfile.snapshot?.output) throw new Error(`Workflow “${selectedProfile.name}” has no executable cache.`);
  return {
    profile: selectedProfile,
    snapshot: structuredClone(selectedProfile.snapshot),
    promptNodeId: selectedProfile.promptNodeId,
    imageNodeId: selectedProfile.imageNodeId,
    upscaleNodeId: selectedProfile.upscaleNodeId,
    resultNodeIds: selectedProfile.resultNodeIds,
    resultFields: selectedProfile.resultFields,
    workflowName: selectedProfile.name,
  };
}

async function queueGeneration({
  action = selectedAction(),
  executionPrompt = state.currentPrompt,
  preserveSeed = false,
  workflowProfileId = null,
  sourceImage = null,
  upscaleFactor = null,
} = {}) {
  const operationToken = state.operationToken;
  let source = action === "create" ? null : editingSource(sourceImage);
  if (action !== "create" && !source) throw new Error(`There is no image in this conversation to ${action}.`);
  const context = await workflowQueueContext(action, workflowProfileId);
  if (operationToken !== state.operationToken) return false;
  if (action === "edit") {
    try {
      source = await imageReferenceWithDimensions(source);
    } catch (error) {
      throw new Error(`Prompt Studio could not preserve the editing source size: ${error.message || String(error)}`);
    }
  }
  if (operationToken !== state.operationToken) return false;
  const useNewSeed = !preserveSeed
    && generationMatchesLatestQueuedPrompt()
    && state.panel.querySelector("#promptstudio-randomize-seed")?.checked;
  if (useNewSeed) randomizeSnapshotSeeds(context.snapshot);

  const secondaryInstructions = state.panel.querySelector("#promptstudio-secondary-instructions")?.value || "";
  if (action !== "upscale") {
    const apiNode = context.snapshot.output?.[String(context.promptNodeId)];
    if (!apiNode || ![SLOT_TYPE, AMPLIFY_TYPE].includes(apiNode.class_type)) {
      throw new Error("The configured prompt node was not included in the executable workflow.");
    }
    const resolution = {
      ...resolutionSettings(),
      resolution_width: action === "edit" ? source.width : 0,
      resolution_height: action === "edit" ? source.height : 0,
    };
    if (apiNode.class_type === AMPLIFY_TYPE) {
      const slotName = apiNode.inputs?.slot_name || context.workflowName;
      apiNode.class_type = SLOT_TYPE;
      apiNode.inputs = { prompt: executionPrompt, slot_name: slotName, secondary_instructions: secondaryInstructions, ...resolution };
    } else {
      apiNode.inputs.prompt = executionPrompt;
      apiNode.inputs.secondary_instructions = secondaryInstructions;
      Object.assign(apiNode.inputs, resolution);
    }
  }

  if (action === "edit") {
    const imageNode = context.snapshot.output?.[String(context.imageNodeId)];
    if (!imageNode || imageNode.class_type !== IMAGE_SOURCE_TYPE) {
      throw new Error("The configured Prompt Studio Image Source node was not included in the editing workflow.");
    }
    imageNode.inputs.image_ref = JSON.stringify(storedImageReference(source));
  } else if (action === "upscale") {
    const factor = Number(upscaleFactor);
    if (!Number.isFinite(factor) || factor < 1 || factor > 16) {
      throw new Error("Upscale factor must be between 1 and 16.");
    }
    const upscaleNode = context.snapshot.output?.[String(context.upscaleNodeId)];
    if (!upscaleNode || upscaleNode.class_type !== UPSCALE_TYPE) {
      throw new Error("The configured Prompt Studio Upscale node was not included in the upscaling workflow.");
    }
    upscaleNode.inputs.image_ref = JSON.stringify(storedImageReference(source));
    upscaleNode.inputs.upscale_factor = factor;
    upscaleNode.inputs.prompt = executionPrompt;
    upscaleNode.inputs.secondary_instructions = secondaryInstructions;
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
    if (action === "edit") chat.selectedSource = source;
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

async function queueUpscale(source, generationData = null, factor = null, workflowProfileId = null) {
  if (state.busy) return;
  const usePrompt = state.panel?.querySelector("#promptstudio-use-prompt-upscaling")?.checked !== false;
  const executionPrompt = usePrompt
    ? String(generationData?.canonicalPrompt || state.currentPrompt || "")
    : "";
  state.operationToken += 1;
  setBusy(true);
  setStatus("ComfyUI is upscaling…", "working");
  try {
    await queueGeneration({
      action: "upscale",
      executionPrompt,
      workflowProfileId,
      sourceImage: source,
      upscaleFactor: factor,
    });
  } catch (error) {
    setStatus(error.message || String(error), "error");
    setBusy(false);
  }
}

async function generateDirectPrompt(action = selectedAction()) {
  if (state.busy) return;
  if (!selectedWorkflowProfile(action)) {
    return setStatus("Select a compatible [PS] workflow first.", "warning");
  }
  if (action === "edit" && !editingSource()) {
    return setStatus("There is no image in this conversation to edit.", "warning");
  }
  const input = state.panel.querySelector("#promptstudio-revision");
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
  const input = state.panel.querySelector("#promptstudio-revision");
  const revision = input.value.trim();
  const editedPrompt = state.panel.querySelector("#promptstudio-current-prompt").value.trim();
  const creating = !activeChat()?.initialized;
  if (!selectedWorkflowProfile(generationAction)) {
    return setStatus("Select a compatible [PS] workflow first.", "warning");
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
    const response = await api.fetchApi("/promptstudio/prompt-studio/revise", {
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
    if (forceGenerate || state.panel.querySelector("#promptstudio-auto-generate")?.checked) {
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
  const editedPrompt = state.panel.querySelector("#promptstudio-current-prompt").value.trim();
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
  state.panel.querySelector("#promptstudio-undo").disabled = state.versionIndex <= 0;
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
  panel.id = "promptstudio-prompt-studio";
  panel.hidden = true;
  panel.innerHTML = `
    <aside class="promptstudio-chat-sidebar">
      <div class="promptstudio-chat-sidebar-header">
        <div><span>Prompt Studio</span><strong>Sessions</strong></div>
        <button id="promptstudio-new-chat" type="button">New chat</button>
      </div>
      <div id="promptstudio-chat-list" class="promptstudio-chat-list"></div>
    </aside>
    <main class="promptstudio-main">
      <div id="promptstudio-history" class="promptstudio-history"></div>
      <div class="promptstudio-compose">
        <div class="promptstudio-compose-heading">
          <strong id="promptstudio-compose-title">Describe the next change</strong>
          <span id="promptstudio-status" class="promptstudio-status" role="status" aria-live="polite">Loading…</span>
          <span id="promptstudio-compose-hint">Leave empty to reroll</span>
        </div>
        <textarea id="promptstudio-revision" rows="3" placeholder="Make the background more varied…"></textarea>
        <div class="promptstudio-compose-footer">
          <div class="promptstudio-toggles">
            <label class="promptstudio-auto-generate-toggle"><input id="promptstudio-auto-generate" type="checkbox" ${settings.auto_generate ? "checked" : ""} /> Generate after revision</label>
            <label><input id="promptstudio-randomize-seed" type="checkbox" ${settings.randomize_seed ? "checked" : ""} /> New seed on reroll</label>
            <div class="promptstudio-generation-action" role="radiogroup" aria-label="Generation action">
              <label><input type="radio" name="promptstudio-generation-action" value="create" checked /><span>Create</span></label>
              <label><input type="radio" name="promptstudio-generation-action" value="edit" /><span>Edit</span></label>
            </div>
            <div id="promptstudio-edit-prompt-action" class="promptstudio-generation-action promptstudio-edit-prompt-action" role="radiogroup" aria-label="Editing prompt payload" hidden>
              <label><input type="radio" name="promptstudio-edit-prompt-mode" value="edit_instruction" /><span>Text only</span></label>
              <label><input type="radio" name="promptstudio-edit-prompt-mode" value="full_prompt" checked /><span>Full prompt</span></label>
            </div>
          </div>
          <div class="promptstudio-actions">
            <button id="promptstudio-toggle-inspector" class="promptstudio-inspector-button" type="button">Settings</button>
            <button id="promptstudio-undo" type="button" data-disable-busy disabled>Undo</button>
            <button id="promptstudio-stop" type="button">Stop</button>
            <button id="promptstudio-reroll" type="button" data-disable-busy>Reroll</button>
            <button id="promptstudio-send" class="promptstudio-primary" type="button" data-disable-busy>Revise & Generate</button>
          </div>
        </div>
      </div>
    </main>
    <aside class="promptstudio-inspector">
      <header class="promptstudio-header">
        <div class="promptstudio-brand">
          <span class="promptstudio-brand-mark">PS</span>
          <div><strong>Prompt Studio</strong><span>Iterative local generation</span></div>
        </div>
        <div class="promptstudio-header-actions">
          <button id="promptstudio-toggle-chats" class="promptstudio-chats-button" type="button" title="Show chats" aria-label="Show chats">Sessions</button>
          <button id="promptstudio-popout" type="button" title="Open Prompt Studio in its own tab" aria-label="Open Prompt Studio in its own tab">↗</button>
          <button id="promptstudio-toggle-studio-settings" type="button" title="Prompt Studio settings" aria-label="Prompt Studio settings" aria-expanded="false">⚙</button>
          <button id="promptstudio-close" type="button" title="Close Prompt Studio" aria-label="Close Prompt Studio">×</button>
        </div>
      </header>
      <section class="promptstudio-mode-control">
        <label>
          <input id="promptstudio-use-llm-amplification" type="checkbox" ${settings.use_llm_amplification ? "checked" : ""} />
          <span><strong>Use LLM amplification</strong><small>Rewrite prompts through KoboldCpp</small></span>
        </label>
      </section>
      <section class="promptstudio-control-deck">
        <details class="promptstudio-current-details" open>
          <summary><span>Canonical prompt</span><small>Used for the next generation</small></summary>
          <textarea id="promptstudio-current-prompt" rows="8" placeholder="The selected prompt node's current text"></textarea>
        </details>
        <details class="promptstudio-settings" open>
          <summary><span>Generation controls</span><small>Model, style and LLM settings</small></summary>
          <div class="promptstudio-settings-grid">
            <label class="promptstudio-control-wide">Model profile<select id="promptstudio-profile"></select></label>
            <label>Style<select id="promptstudio-style"></select></label>
            <label>Framing<select id="promptstudio-framing"></select></label>
            <label>Embellishment<select id="promptstudio-embellishment"></select></label>
            <label title="Controls KoboldCpp reasoning effort. High receives up to 4,096 private-reasoning tokens while preserving the final-answer allowance.">Thinking<select id="promptstudio-thinking"></select></label>
            <label class="promptstudio-control-wide">KoboldCpp URL<input id="promptstudio-kobold-url" /></label>
            <label class="promptstudio-control-wide">Style modifier<textarea id="promptstudio-style-modifier" rows="2"></textarea></label>
            <label class="promptstudio-control-wide">Framing modifier<textarea id="promptstudio-framing-modifier" rows="2"></textarea></label>
            <label title="Final-answer allowance. KoboldCpp receives an additional native-reasoning budget; 0 uses the selected profile default.">Final-answer tokens<input id="promptstudio-max-tokens" type="number" min="0" max="8192" /></label>
            <label>Temperature<input id="promptstudio-temperature" type="number" min="0" max="5" step="0.05" /></label>
          </div>
        </details>
        <details class="promptstudio-resolution-details" open>
          <summary><span>Resolution</span><small>Create size; Edit preserves source</small></summary>
          <div class="promptstudio-resolution-grid">
            <label>Aspect ratio<select id="promptstudio-resolution-aspect-ratio">${RESOLUTION_ASPECT_RATIOS.map((value) => `<option value="${value}">${value}</option>`).join("")}</select></label>
            <label>Megapixels<input id="promptstudio-resolution-megapixels" type="number" min="0.1" max="16" step="0.1" value="1" /></label>
            <label>Multiple<input id="promptstudio-resolution-multiple" type="number" min="8" max="128" step="4" value="8" /></label>
          </div>
        </details>
        <details class="promptstudio-secondary-details" open>
          <summary><span>Secondary instructions</span><small>Optional pass-through output</small></summary>
          <textarea id="promptstudio-secondary-instructions" rows="3" placeholder="Returned unchanged from the secondary output"></textarea>
        </details>
      </section>
    </aside>
    <div id="promptstudio-studio-settings" class="promptstudio-studio-settings" hidden>
      <header class="promptstudio-studio-settings-header">
        <div><strong>Settings</strong><span>Configure how Prompt Studio looks and connects to ComfyUI.</span></div>
        <span class="promptstudio-studio-settings-context">Prompt Studio</span>
      </header>
      <div class="promptstudio-studio-settings-layout">
        <section class="promptstudio-studio-settings-card" aria-labelledby="promptstudio-interface-settings-title">
          <header class="promptstudio-studio-settings-card-header">
            <div><strong id="promptstudio-interface-settings-title">Interface</strong><span>Chat display and editing behavior</span></div>
          </header>
          <div class="promptstudio-studio-settings-list">
            <label class="promptstudio-studio-setting promptstudio-image-scale-control">
              <span class="promptstudio-studio-setting-copy"><strong>Image scale</strong><small>Scale generated images in chat. Full-size preview is unchanged.</small></span>
              <span class="promptstudio-image-scale-field">
                <output id="promptstudio-image-scale-value" for="promptstudio-image-scale">100%</output>
                <input id="promptstudio-image-scale" type="range" min="30" max="100" step="5" value="${settings.image_scale}" />
              </span>
            </label>
            <label class="promptstudio-studio-setting promptstudio-studio-setting-toggle">
              <span class="promptstudio-studio-setting-copy"><strong>Continue from newest result</strong><small>Automatically use the latest generated image as the next editing source.</small></span>
              <input id="promptstudio-auto-advance-source" type="checkbox" role="switch" ${settings.auto_advance_source ? "checked" : ""} />
            </label>
          </div>
        </section>
        <section class="promptstudio-studio-settings-card" aria-labelledby="promptstudio-workflow-settings-title">
          <header class="promptstudio-studio-settings-card-header promptstudio-workflow-settings-header">
            <div>
              <strong id="promptstudio-workflow-settings-title">ComfyUI workflow templates</strong>
              <span id="promptstudio-workflow-template-status" class="promptstudio-workflow-template-status">Checking [PS] workflows…</span>
            </div>
            <button id="promptstudio-refresh-workflows" type="button" title="Refresh [PS] workflows" aria-label="Refresh [PS] workflows">↻</button>
          </header>
          <div class="promptstudio-workflow-routing">
            <div class="promptstudio-workflow-routing-fields">
              <label><span>Create template</span><select id="promptstudio-create-workflow"></select></label>
              <label><span>Edit template</span><select id="promptstudio-edit-workflow"></select></label>
              <label><span>Upscale template</span><select id="promptstudio-upscale-workflow"></select></label>
            </div>
            <label class="promptstudio-studio-setting promptstudio-studio-setting-toggle">
              <span class="promptstudio-studio-setting-copy"><strong>Use prompt when upscaling</strong><small>Inject the image's prompt into the Prompt Studio Upscale node.</small></span>
              <input id="promptstudio-use-prompt-upscaling" type="checkbox" role="switch" ${settings.use_prompt_upscaling ? "checked" : ""} />
            </label>
            <div class="promptstudio-studio-settings-note">
              <p>Name saved ComfyUI workflows with a <strong>[PS]</strong> prefix. Each needs exactly one image output. Create and Edit need a Prompt Slot or Prompt Amplify node; Edit also needs Prompt Studio Image Source. Upscale requires Prompt Studio Upscale.</p>
              <p>Saved workflows refresh here immediately and are checked before generation. Invalid updates keep the last working copy marked <strong>cached</strong>.</p>
            </div>
          </div>
        </section>
      </div>
    </div>
    <div id="promptstudio-lightbox" class="promptstudio-lightbox" role="dialog" aria-modal="true" aria-label="Image preview" tabindex="-1" hidden>
      <img id="promptstudio-lightbox-image" alt="" />
      <div class="promptstudio-lightbox-actions">
        <a id="promptstudio-lightbox-open" href="#" target="_blank" rel="noopener" title="Open image in new tab" aria-label="Open image in new tab">↗</a>
        <button id="promptstudio-lightbox-close" type="button" title="Close image preview" aria-label="Close image preview">×</button>
      </div>
    </div>
    <div id="promptstudio-upscale-dialog" class="promptstudio-upscale-dialog" role="dialog" aria-modal="true" aria-labelledby="promptstudio-upscale-title" hidden>
      <form id="promptstudio-upscale-form" class="promptstudio-upscale-card">
        <strong id="promptstudio-upscale-title">Upscale image</strong>
        <label for="promptstudio-upscale-factor">Upscale factor</label>
        <input id="promptstudio-upscale-factor" type="number" min="1" max="16" step="0.1" value="2" required />
        <div class="promptstudio-upscale-dialog-actions">
          <button id="promptstudio-upscale-cancel" type="button">Cancel</button>
          <button class="promptstudio-primary" type="submit">Upscale</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(panel);
  state.panel = panel;

  panel.querySelector("#promptstudio-kobold-url").value = settings.kobold_url;
  panel.querySelector("#promptstudio-max-tokens").value = settings.max_response_tokens;
  panel.querySelector("#promptstudio-temperature").value = settings.temperature;
  panel.querySelector("#promptstudio-style-modifier").value = settings.style_modifier;
  panel.querySelector("#promptstudio-framing-modifier").value = settings.framing_modifier;
  panel.querySelector("#promptstudio-secondary-instructions").value = settings.secondary_instructions;
  panel.querySelector("#promptstudio-resolution-aspect-ratio").value = RESOLUTION_ASPECT_RATIOS.includes(settings.resolution_aspect_ratio)
    ? settings.resolution_aspect_ratio
    : RESOLUTION_ASPECT_RATIOS[0];
  panel.querySelector("#promptstudio-resolution-megapixels").value = String(Math.max(0.1, Math.min(16, Number(settings.resolution_megapixels) || 1)));
  panel.querySelector("#promptstudio-resolution-multiple").value = String(Math.max(8, Math.min(128, Math.round((Number(settings.resolution_multiple) || 8) / 4) * 4)));
  applyImageScale(settings.image_scale);
  updateAmplificationMode({ announce: false, persist: false });
  panel.querySelector("#promptstudio-toggle-chats").addEventListener("click", () => {
    panel.classList.remove("promptstudio-inspector-open");
    panel.classList.toggle("promptstudio-chats-open");
  });
  panel.querySelector("#promptstudio-toggle-inspector").addEventListener("click", () => {
    panel.classList.remove("promptstudio-chats-open");
    panel.classList.toggle("promptstudio-inspector-open");
  });
  panel.querySelector("#promptstudio-toggle-studio-settings").addEventListener("click", () => toggleStudioSettings());
  panel.addEventListener("click", (event) => {
    const popover = panel.querySelector("#promptstudio-studio-settings");
    if (popover.hidden || popover.contains(event.target) || event.target === panel.querySelector("#promptstudio-toggle-studio-settings")) return;
    toggleStudioSettings(false);
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || panel.querySelector("#promptstudio-studio-settings").hidden) return;
    toggleStudioSettings(false);
    panel.querySelector("#promptstudio-toggle-studio-settings").focus();
  });
  panel.querySelector("#promptstudio-lightbox").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeImageLightbox();
  });
  panel.querySelector("#promptstudio-lightbox").addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeImageLightbox();
  });
  panel.querySelector("#promptstudio-lightbox-close").addEventListener("click", closeImageLightbox);
  panel.querySelector("#promptstudio-upscale-dialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeUpscaleDialog();
  });
  panel.querySelector("#promptstudio-upscale-dialog").addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeUpscaleDialog();
  });
  panel.querySelector("#promptstudio-upscale-cancel").addEventListener("click", closeUpscaleDialog);
  panel.querySelector("#promptstudio-upscale-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const dialog = panel.querySelector("#promptstudio-upscale-dialog");
    const request = dialog._upscaleRequest;
    const factor = panel.querySelector("#promptstudio-upscale-factor").valueAsNumber;
    if (!request || !Number.isFinite(factor) || factor < 1 || factor > 16) return;
    closeUpscaleDialog();
    queueUpscale(request.source, request.generationData, factor, request.workflowProfileId);
  });
  panel.querySelector("#promptstudio-new-chat").addEventListener("click", createChat);
  panel.querySelector("#promptstudio-popout").addEventListener("click", () => togglePopout({ returnToEmbedded: true }));
  panel.querySelector("#promptstudio-close").addEventListener("click", () => togglePanel(false));
  panel.querySelector("#promptstudio-refresh-workflows").addEventListener("click", () => refreshWorkflowTemplates());
  panel.querySelector("#promptstudio-create-workflow").addEventListener("change", () => {
    announceWorkflowSelection("create");
  });
  panel.querySelector("#promptstudio-edit-workflow").addEventListener("change", () => {
    announceWorkflowSelection("edit");
    setEditPromptMode(selectedEditPromptMode(), { persist: true });
  });
  panel.querySelector("#promptstudio-upscale-workflow").addEventListener("change", () => {
    announceWorkflowSelection("upscale");
  });
  panel.querySelectorAll('input[name="promptstudio-generation-action"]').forEach((control) => {
    control.addEventListener("change", () => {
      updateComposeMode();
      refreshSecondaryInstructionsControl();
      announceWorkflowSelection(selectedAction());
    });
  });
  panel.querySelectorAll('input[name="promptstudio-edit-prompt-mode"]').forEach((control) => {
    control.addEventListener("change", () => syncActiveChat());
  });
  panel.querySelector("#promptstudio-send").addEventListener("click", () => reviseAndMaybeGenerate());
  panel.querySelector("#promptstudio-reroll").addEventListener("click", () => reroll());
  panel.querySelector("#promptstudio-undo").addEventListener("click", undoPrompt);
  panel.querySelector("#promptstudio-stop").addEventListener("click", interrupt);
  panel.querySelector("#promptstudio-use-llm-amplification").addEventListener("change", () => updateAmplificationMode());
  panel.querySelector("#promptstudio-secondary-instructions").addEventListener("change", saveSettings);
  panel.querySelector("#promptstudio-current-prompt").addEventListener("input", (event) => {
    syncCanonicalEditor(event.target.value, { userEdit: true });
  });
  panel.querySelector("#promptstudio-current-prompt").addEventListener("change", commitPromptEditorVersion);
  panel.querySelector("#promptstudio-revision").addEventListener("input", (event) => {
    syncManualPrompt(event.target.value);
  });
  panel.querySelector("#promptstudio-revision").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      reviseAndMaybeGenerate();
    }
  });
  panel.querySelectorAll(".promptstudio-settings input, .promptstudio-settings select, .promptstudio-settings textarea")
    .forEach((element) => element.addEventListener("change", markControlsChanged));
  panel.querySelectorAll(".promptstudio-resolution-details input, .promptstudio-resolution-details select")
    .forEach((element) => element.addEventListener("change", saveSettings));
  panel.querySelectorAll(".promptstudio-toggles input")
    .forEach((element) => element.addEventListener("change", saveSettings));
  panel.querySelector("#promptstudio-auto-generate").addEventListener("change", updateComposeMode);
  panel.querySelector("#promptstudio-image-scale").addEventListener("input", (event) => applyImageScale(event.target.value));
  panel.querySelector("#promptstudio-image-scale").addEventListener("change", saveSettings);
  panel.querySelector("#promptstudio-auto-advance-source").addEventListener("change", saveSettings);
  panel.querySelector("#promptstudio-use-prompt-upscaling").addEventListener("change", saveSettings);
}

function buildLauncher() {
  const launchers = document.createElement("div");
  launchers.id = "promptstudio-prompt-studio-launchers";
  launchers.setAttribute("role", "group");
  launchers.setAttribute("aria-label", "Prompt Studio launchers");

  const studioButton = document.createElement("button");
  studioButton.id = "promptstudio-prompt-studio-launcher";
  studioButton.type = "button";
  studioButton.title = "Open Prompt Studio in a new tab";
  studioButton.textContent = "Prompt Studio";
  studioButton.addEventListener("click", () => togglePopout());

  const chatButton = document.createElement("button");
  chatButton.id = "promptstudio-prompt-chat-launcher";
  chatButton.type = "button";
  chatButton.title = "Open Prompt Chat inside ComfyUI";
  chatButton.textContent = "Prompt chat";
  chatButton.addEventListener("click", () => togglePanel());

  launchers.append(studioButton, chatButton);
  document.body.appendChild(launchers);
  state.launcher = launchers;
}

function updatePopoutButton() {
  const button = state.panel?.querySelector("#promptstudio-popout");
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
  const mount = popup.document.querySelector("#promptstudio-popout-mount");
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
  globalThis.__promptstudioPromptStudioHost = { attach: attachStandalone };
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
  try {
    if (!state.config) await loadConfig();
    await refreshWorkflowTemplates({ announce: false });
  } catch (error) {
    setStatus(error.message || String(error), "error");
  }
}

app.registerExtension({
  name: EXTENSION_NAME,
  async setup() {
    loadCss();
    buildPanel();
    setupWorkflowSync();
    installWorkflowSaveObserver();
    await loadChats();
    try {
      await loadWorkflowProfiles();
    } catch (error) {
      setStatus(error.message || String(error), "warning");
    }
    buildLauncher();
    refreshWorkflowControls();
    setupStandaloneBridge();
  },
});
