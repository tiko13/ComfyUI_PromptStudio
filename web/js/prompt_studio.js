import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const EXTENSION_NAME = "ComfyUI_PromptStudio.PromptStudio";
const ICON_URL = new URL("../prompt-studio-icon.svg", import.meta.url).href;
const ACTIVITY_ICON_URL = new URL("../prompt-studio-activity-icon.svg", import.meta.url).href;
const SLOT_TYPE = "KCPP_PromptSlot";
const AMPLIFY_TYPE = "KCPP_PromptAmplify";
const IMAGE_SOURCE_TYPE = "KCPP_ChatImageInput";
const UPSCALE_TYPE = "KCPP_PromptStudioUpscale";
const LORA_LOADER_TYPE = "KCPP_PromptStudioLoraLoader";
const MODEL_LOADER_TYPE = "KCPP_PromptStudioModelLoader";
const STORAGE_KEY = "promptstudio.promptStudio.settings.v1";
const LORA_STORAGE_KEY = "promptstudio.promptStudio.loras.v1";
const MODEL_STORAGE_KEY = "promptstudio.promptStudio.models.v1";
const CONSULT_STORAGE_KEY = "promptstudio.promptStudio.consult.settings.v1";
const STANDALONE_CHANNEL = "promptstudio.promptStudio.standalone.v1";
const WORKFLOW_SYNC_CHANNEL = "promptstudio.promptStudio.workflows.v1";
const CHAT_SYNC_CHANNEL = "promptstudio.promptStudio.chats.v1";
const MAX_DROPPED_IMAGE_BYTES = 20 * 1024 * 1024;
const CONSULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CONSULT_EXPERIMENT_MARKER = "PROMPT_STUDIO_EXPERIMENT";
const MAX_CONSULT_EXPERIMENT_PROMPT_CHARS = 64 * 1024;
const MAX_CONSULT_EXPERIMENT_GUIDANCE_CHARS = 16 * 1024;
const PROMPT_AGENT_DEFAULT_MAX_ITERATIONS = 5;
const PROMPT_AGENT_MAX_ITERATIONS = 10;
const PROMPT_AGENT_MAX_SAVED_ITERATIONS = 50;
const PROMPT_AGENT_MAX_GOAL_CHARS = 32 * 1024;
const PROMPT_AGENT_TARGET_SCORE = 85;
const PROMPT_AGENT_MIN_CONFIDENCE = 0.7;
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
const RENDER_CONTROL_IDS = [
  "promptstudio-profile",
  "promptstudio-style",
  "promptstudio-framing",
  "promptstudio-style-modifier",
  "promptstudio-framing-modifier",
  "promptstudio-embellishment",
];
const DISCONNECTED_CONTROL_SELECTOR = "input, textarea, select, button";
const DISCONNECTED_ALLOWED_CONTROL_IDS = [
  "promptstudio-close",
  "promptstudio-mobile-close",
  "promptstudio-close-chats",
  "promptstudio-close-inspector",
  "promptstudio-consult-close",
  "promptstudio-lightbox-close",
  "promptstudio-upscale-cancel",
  "promptstudio-generation-failure-cancel",
];
const TYPE_ANYWHERE_WINDOWS = new WeakSet();

const state = {
  panel: null,
  launcher: null,
  popup: null,
  popupCloseTimer: null,
  dockingPopup: false,
  returnToEmbedded: false,
  standaloneChannel: null,
  workflowSyncChannel: null,
  chatSyncChannel: null,
  config: null,
  mainPrompt: "",
  currentPrompt: "",
  versions: [],
  versionIndex: -1,
  busy: false,
  generating: false,
  queueing: false,
  operationToken: 0,
  pollToken: 0,
  activeGenerationPromptId: "",
  consultGenerationTarget: null,
  consultAgentGenerationTarget: null,
  consultAgentRunning: false,
  consultAgentRunToken: 0,
  generationProgress: new Map(),
  chats: [],
  activeChatId: null,
  chatRevision: 0,
  chatStoreLoaded: false,
  chatPersistenceBlocked: false,
  chatSaveInFlight: false,
  chatMutationVersion: 0,
  chatSyncInFlight: false,
  chatSyncTimer: null,
  consultBusy: false,
  consultVisionAvailable: null,
  consultVisionReason: "",
  consultSelectedImages: new Map(),
  consultImageChoices: new Map(),
  consultUploadedImages: [],
  mainPastedImage: null,
  workflowProfiles: [],
  workflowIssues: [],
  workflowRevision: 0,
  workflowStoreLoaded: false,
  workflowSaveChain: Promise.resolve(),
  workflowBusy: false,
  workflowRefreshTimer: null,
  workflowRefreshBroadcast: false,
  loraSelections: {},
  loraCatalogs: new Map(),
  loraRenderToken: 0,
  modelSelections: {},
  modelCatalogs: new Map(),
  modelRenderToken: 0,
  chatSaveTimer: null,
  chatSaveChain: Promise.resolve(),
  lightboxTrigger: null,
  generationRetry: null,
  generationFailureTrigger: null,
  dragDepth: 0,
  activityIndicatorDocument: null,
  activityIndicatorVisible: false,
  activityOriginalTitle: "",
  activityOriginalFavicon: null,
  activityOriginalFaviconHref: null,
  activityOriginalFaviconType: null,
  activityCreatedFavicon: false,
  apiConnected: true,
  disconnectedControls: new Map(),
  disconnectedControlObserver: null,
};

function backgroundActivityLabel() {
  const selector = state.consultBusy ? "#promptstudio-consult-status" : "#promptstudio-status";
  return state.panel?.querySelector(selector)?.textContent?.trim() || "Prompt Studio is working";
}

function restoreBackgroundActivityVisual() {
  if (!state.activityIndicatorVisible) return;
  const doc = state.activityIndicatorDocument;
  if (doc) doc.title = state.activityOriginalTitle;
  const favicon = state.activityOriginalFavicon;
  if (favicon) {
    if (state.activityCreatedFavicon) {
      favicon.remove();
    } else {
      if (state.activityOriginalFaviconHref === null) favicon.removeAttribute("href");
      else favicon.setAttribute("href", state.activityOriginalFaviconHref);
      if (state.activityOriginalFaviconType === null) favicon.removeAttribute("type");
      else favicon.setAttribute("type", state.activityOriginalFaviconType);
    }
  }
  state.activityIndicatorVisible = false;
  state.activityOriginalTitle = "";
  state.activityOriginalFavicon = null;
  state.activityOriginalFaviconHref = null;
  state.activityOriginalFaviconType = null;
  state.activityCreatedFavicon = false;
}

function detachBackgroundActivityDocument() {
  restoreBackgroundActivityVisual();
  state.activityIndicatorDocument?.removeEventListener("visibilitychange", syncBackgroundActivityIndicator);
  state.activityIndicatorDocument = null;
}

function syncBackgroundActivityIndicator() {
  const doc = state.panel?.ownerDocument || null;
  const active = state.busy || state.consultBusy;
  if (state.activityIndicatorDocument !== doc) {
    detachBackgroundActivityDocument();
    state.activityIndicatorDocument = doc;
    doc?.addEventListener("visibilitychange", syncBackgroundActivityIndicator);
  }
  if (!doc || !active || doc.visibilityState !== "hidden") {
    restoreBackgroundActivityVisual();
    if (!active) detachBackgroundActivityDocument();
    return;
  }

  if (!state.activityIndicatorVisible) {
    state.activityOriginalTitle = doc.title;
    let favicon = doc.querySelector('link[rel~="icon"]');
    if (!favicon) {
      favicon = doc.createElement("link");
      favicon.rel = "icon";
      doc.head?.appendChild(favicon);
      state.activityCreatedFavicon = true;
    }
    state.activityOriginalFavicon = favicon;
    state.activityOriginalFaviconHref = favicon.getAttribute("href");
    state.activityOriginalFaviconType = favicon.getAttribute("type");
    favicon.type = "image/svg+xml";
    favicon.href = ACTIVITY_ICON_URL;
    state.activityIndicatorVisible = true;
  }
  doc.title = `● ${backgroundActivityLabel()} · ${state.activityOriginalTitle || "Prompt Studio"}`;
}

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
    llm_provider: "koboldcpp",
    kobold_url: "http://localhost:5001",
    ollama_url: "http://localhost:11434",
    ollama_model: "",
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
    use_latest_image_context: false,
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
      llm_provider: value("promptstudio-llm-provider"),
      kobold_url: value("promptstudio-kobold-url"),
      ollama_url: value("promptstudio-ollama-url"),
      ollama_model: value("promptstudio-ollama-model"),
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
      use_latest_image_context: checked("promptstudio-use-latest-image-context"),
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
  const scale = Number.isFinite(numeric) ? Math.max(10, Math.min(100, Math.round(numeric / 5) * 5)) : 100;
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
  if (show) toggleConsult(false);
  popover.hidden = !show;
  button.setAttribute("aria-expanded", show ? "true" : "false");
}

function getConsultSettings() {
  const defaults = {
    thinking_mode: "Disabled",
    max_response_tokens: 800,
    temperature: 0.7,
    top_p: 0.9,
    top_k: 100,
    min_p: 0,
    rep_pen: 1.05,
    rep_pen_range: 360,
    sampler_seed: -1,
  };
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(CONSULT_STORAGE_KEY) || "{}");
  } catch (_) {
    return defaults;
  }
  const source = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  const number = (key, min, max) => {
    const value = Number(source[key]);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : defaults[key];
  };
  return {
    thinking_mode: ["Disabled", "Minimal", "Low", "Medium", "High"].includes(source.thinking_mode)
      ? source.thinking_mode
      : defaults.thinking_mode,
    max_response_tokens: Math.round(number("max_response_tokens", 1, 8192)),
    temperature: number("temperature", 0, 5),
    top_p: number("top_p", 0, 1),
    top_k: Math.round(number("top_k", 0, 200)),
    min_p: number("min_p", 0, 1),
    rep_pen: number("rep_pen", 0.5, 3),
    rep_pen_range: Math.round(number("rep_pen_range", 0, 4096)),
    sampler_seed: Math.round(number("sampler_seed", -1, 999999)),
  };
}

function saveConsultSettings() {
  if (!state.panel) return;
  const value = (id) => state.panel.querySelector(`#${id}`)?.value;
  try {
    localStorage.setItem(CONSULT_STORAGE_KEY, JSON.stringify({
      thinking_mode: value("promptstudio-consult-thinking"),
      max_response_tokens: Number(value("promptstudio-consult-max-tokens") || 800),
      temperature: Number(value("promptstudio-consult-temperature") || 0.7),
      top_p: Number(value("promptstudio-consult-top-p") || 0.9),
      top_k: Number(value("promptstudio-consult-top-k") || 100),
      min_p: Number(value("promptstudio-consult-min-p") || 0),
      rep_pen: Number(value("promptstudio-consult-rep-pen") || 1.05),
      rep_pen_range: Number(value("promptstudio-consult-rep-pen-range") || 360),
      sampler_seed: Number(value("promptstudio-consult-seed") || -1),
    }));
  } catch (error) {
    setConsultStatus(error.message || "Chat generation settings could not be saved.", "warning");
  }
}

function toggleConsult(force) {
  const overlay = state.panel?.querySelector("#promptstudio-consult");
  if (!overlay) return;
  const show = force ?? overlay.hidden;
  if (show) {
    toggleStudioSettings(false);
    closePanelDrawers();
    renderConsultHistory();
    renderConsultAttachments();
    refreshConsultVisionCapability();
  }
  overlay.hidden = !show;
  state.panel.querySelectorAll(".promptstudio-consult-toggle").forEach((button) => {
    button.setAttribute("aria-expanded", show ? "true" : "false");
  });
  if (show) {
    overlay.querySelector("#promptstudio-consult-input")?.focus({ preventScroll: true });
  }
}

function toggleConsultSubpanel(name) {
  const attachments = state.panel?.querySelector("#promptstudio-consult-attachments");
  const generation = state.panel?.querySelector("#promptstudio-consult-generation-settings");
  const attachmentButton = state.panel?.querySelector("#promptstudio-consult-toggle-attachments");
  const generationButton = state.panel?.querySelector("#promptstudio-consult-toggle-generation-settings");
  if (!attachments || !generation || !attachmentButton || !generationButton) return;
  const target = name === "generation" ? generation : attachments;
  const other = target === generation ? attachments : generation;
  const show = target.hidden;
  target.hidden = !show;
  other.hidden = true;
  attachmentButton.setAttribute("aria-expanded", show && target === attachments ? "true" : "false");
  generationButton.setAttribute("aria-expanded", show && target === generation ? "true" : "false");
  if (show && target === attachments) renderConsultAttachments();
}

function loadLoraSelections() {
  try {
    const stored = JSON.parse(localStorage.getItem(LORA_STORAGE_KEY) || "{}");
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  } catch (_) {
    return {};
  }
}

function saveLoraSelections() {
  try {
    localStorage.setItem(LORA_STORAGE_KEY, JSON.stringify(state.loraSelections));
  } catch (error) {
    setStatus(error.message || "LoRA selections could not be saved.", "warning");
  }
}

function loadModelSelections() {
  try {
    const stored = JSON.parse(localStorage.getItem(MODEL_STORAGE_KEY) || "{}");
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  } catch (_) {
    return {};
  }
}

function saveModelSelections() {
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(state.modelSelections));
  } catch (error) {
    setStatus(error.message || "Model selections could not be saved.", "warning");
  }
}

function isEditableTarget(target) {
  if (!target || target.nodeType !== 1) return false;
  return Boolean(
    target.closest?.("input, textarea, select, [role=\"textbox\"]")
    || target.isContentEditable,
  );
}

function openPromptStudioDialog() {
  return state.panel?.querySelector('[role="dialog"][aria-modal="true"]:not([hidden])');
}

function insertTypedCharacter(input, character) {
  const caret = input.value.length;
  input.focus({ preventScroll: true });
  input.setSelectionRange(caret, caret);
  input.setRangeText(character, caret, caret, "end");
  const view = input.ownerDocument.defaultView;
  input.dispatchEvent(new view.InputEvent("input", {
    bubbles: true,
    data: character,
    inputType: "insertText",
  }));
}

function typeAnywhereInput(ownerDocument) {
  if (
    !state.panel
    || state.panel.hidden
    || state.panel.ownerDocument !== ownerDocument
  ) return null;

  const consult = state.panel.querySelector("#promptstudio-consult");
  if (consult && !consult.hidden) {
    return consult.querySelector("#promptstudio-consult-input");
  }

  const settings = state.panel.querySelector("#promptstudio-studio-settings");
  if (settings && !settings.hidden) return null;

  return state.panel.querySelector("#promptstudio-revision");
}

function installTypeAnywhereFocus(ownerDocument) {
  const view = ownerDocument?.defaultView;
  if (!view || TYPE_ANYWHERE_WINDOWS.has(view)) return;
  TYPE_ANYWHERE_WINDOWS.add(view);
  view.addEventListener("click", (event) => {
    if (
      !state.panel
      || state.panel.hidden
      || state.panel.ownerDocument !== ownerDocument
    ) return;
    // Let the active modal handle its own backdrop and controls without
    // dismissing an underlying consultation or settings layer first.
    if (openPromptStudioDialog()) return;

    const target = event.target;
    let dismissed = false;
    const consult = state.panel.querySelector("#promptstudio-consult");
    const consultToggles = state.panel.querySelectorAll(".promptstudio-consult-toggle");
    if (
      consult
      && !consult.hidden
      && !consult.contains(target)
      && ![...consultToggles].some((button) => button.contains(target))
    ) {
      toggleConsult(false);
      dismissed = true;
    }

    const settings = state.panel.querySelector("#promptstudio-studio-settings");
    const settingsToggle = state.panel.querySelector("#promptstudio-toggle-studio-settings");
    if (
      settings
      && !settings.hidden
      && !settings.contains(target)
      && !settingsToggle?.contains(target)
    ) {
      toggleStudioSettings(false);
      dismissed = true;
    }
    if (dismissed) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, { capture: true });
  view.addEventListener("keydown", (event) => {
    if (
      !event.defaultPrevented
      && event.key === "Escape"
      && state.panel
      && !state.panel.hidden
      && state.panel.ownerDocument === ownerDocument
      && !openPromptStudioDialog()
    ) {
      const settings = state.panel.querySelector("#promptstudio-studio-settings");
      if (settings && !settings.hidden) {
        event.preventDefault();
        event.stopPropagation();
        toggleStudioSettings(false);
        state.panel.querySelector("#promptstudio-toggle-studio-settings")?.focus();
        return;
      }
      const consult = state.panel.querySelector("#promptstudio-consult");
      if (consult && !consult.hidden) {
        event.preventDefault();
        event.stopPropagation();
        toggleConsult(false);
        state.panel.querySelector("#promptstudio-toggle-consult")?.focus();
        return;
      }
      if (
        state.panel.classList.contains("promptstudio-chats-open")
        || state.panel.classList.contains("promptstudio-inspector-open")
      ) {
        event.preventDefault();
        event.stopPropagation();
        closePanelDrawers();
        return;
      }
    }
    if (
      event.defaultPrevented
      || !state.panel
      || state.panel.hidden
      || state.panel.ownerDocument !== ownerDocument
      || openPromptStudioDialog()
      || isEditableTarget(event.target)
      || isEditableTarget(ownerDocument.activeElement)
    ) return;

    const input = typeAnywhereInput(ownerDocument);
    if (!input || input.disabled || input.readOnly) return;

    if (event.isComposing || event.key === "Dead" || event.key === "Process") {
      input.focus({ preventScroll: true });
      return;
    }

    const altGraph = event.getModifierState?.("AltGraph");
    if (
      event.metaKey
      || (!altGraph && (event.ctrlKey || event.altKey))
      || [...event.key].length !== 1
    ) return;

    event.preventDefault();
    event.stopPropagation();
    insertTypedCharacter(input, event.key);
  }, { capture: true });
}

function setPanelDrawer(drawer, force) {
  if (!state.panel) return;
  const drawerClass = `promptstudio-${drawer}-open`;
  const otherDrawer = drawer === "chats" ? "inspector" : "chats";
  const show = force ?? !state.panel.classList.contains(drawerClass);
  state.panel.classList.toggle(drawerClass, show);
  state.panel.classList.remove(`promptstudio-${otherDrawer}-open`);
  state.panel.querySelectorAll(`[data-promptstudio-drawer="${drawer}"]`).forEach((button) => {
    button.setAttribute("aria-expanded", show ? "true" : "false");
  });
  state.panel.querySelectorAll(`[data-promptstudio-drawer="${otherDrawer}"]`).forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });
}

function closePanelDrawers() {
  if (!state.panel) return;
  state.panel.classList.remove("promptstudio-chats-open", "promptstudio-inspector-open");
  state.panel.querySelectorAll("[data-promptstudio-drawer]").forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function activeChat() {
  return state.chats.find((chat) => chat.id === state.activeChatId) || null;
}

function chatAcceptsImageDrop(chat = activeChat()) {
  return Boolean(
    chat
    && !chat.initialized
    && !chat.messages.length
    && !String(chat.mainPrompt || "").trim()
    && !String(chat.finalPrompt || "").trim()
  );
}

function promptVersion(mainPrompt = state.mainPrompt, finalPrompt = state.currentPrompt) {
  return {
    mainPrompt: String(mainPrompt || ""),
    finalPrompt: String(finalPrompt || ""),
  };
}

function normalizePromptVersion(value, fallbackMain = "", fallbackFinal = "") {
  if (value && typeof value === "object") {
    return promptVersion(
      value.mainPrompt ?? fallbackMain,
      value.finalPrompt ?? value.currentPrompt ?? fallbackFinal,
    );
  }
  const legacyPrompt = String(value ?? fallbackFinal ?? "");
  return promptVersion(legacyPrompt || fallbackMain, legacyPrompt);
}

function promptVersionsEqual(left, right) {
  return Boolean(left && right
    && left.mainPrompt === right.mainPrompt
    && left.finalPrompt === right.finalPrompt);
}

function normalizeLoraStack(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object" && String(entry.name || "").trim())
    .map((entry) => ({
      name: String(entry.name),
      strength: Number.isFinite(Number(entry.strength)) ? Number(entry.strength) : 1,
    }));
}

function normalizeGenerationLoraState(value) {
  if (!Array.isArray(value)) return null;
  const normalized = [];
  const nodeIds = new Set();
  for (const entry of value) {
    const nodeId = String(entry?.nodeId || "").trim();
    if (!nodeId || nodeIds.has(nodeId)) continue;
    nodeIds.add(nodeId);
    normalized.push({
      nodeId,
      loraType: String(entry?.loraType || "").trim(),
      selections: normalizeLoraStack(entry?.selections),
    });
  }
  return normalized;
}

function normalizeGenerationModelState(value) {
  if (!Array.isArray(value)) return null;
  const normalized = [];
  const nodeIds = new Set();
  for (const entry of value) {
    const nodeId = String(entry?.nodeId || "").trim();
    const modelName = cleanModelName(entry?.modelName);
    if (!nodeId || !modelName || nodeIds.has(nodeId)) continue;
    nodeIds.add(nodeId);
    normalized.push({
      nodeId,
      modelType: String(entry?.modelType || "").trim(),
      modelName,
    });
  }
  return normalized;
}

function cleanModelName(value) {
  return String(value || "").trim().replace(/^[/\\]+|[/\\]+$/g, "");
}

function modelNameKey(value) {
  return cleanModelName(value).replaceAll("\\", "/").toLowerCase();
}

function normalizeGenerationSnapshot(value) {
  const output = value?.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  return { output };
}

function normalizeConsultContext(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function normalizeConsultExperimentProposal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prompt = String(value.prompt || "").trim();
  if (!prompt || prompt.length > MAX_CONSULT_EXPERIMENT_PROMPT_CHARS) return null;
  const styleGuidance = String(value.style_guidance ?? value.styleGuidance ?? "").trim();
  const framingGuidance = String(value.framing_guidance ?? value.framingGuidance ?? "").trim();
  if (
    styleGuidance.length > MAX_CONSULT_EXPERIMENT_GUIDANCE_CHARS
    || framingGuidance.length > MAX_CONSULT_EXPERIMENT_GUIDANCE_CHARS
  ) return null;
  const requestedAction = String(value.action || "propose").trim().toLowerCase();
  return {
    prompt,
    styleGuidance,
    framingGuidance,
    action: ["propose", "generate", "promote"].includes(requestedAction) ? requestedAction : "propose",
  };
}

function normalizeConsultExperimentGeneration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    promptId: String(value.promptId || ""),
    generationState: ["queued", "generating", "complete", "error"].includes(value.generationState)
      ? value.generationState
      : "",
    text: String(value.text || ""),
    images: Array.isArray(value.images) ? value.images.map(normalizeImageReference).filter(Boolean) : [],
    mainPrompt: String(value.mainPrompt || ""),
    finalPrompt: String(value.finalPrompt || ""),
    executionPrompt: String(value.executionPrompt || value.finalPrompt || ""),
    generationAction: value.generationAction === "edit" ? "edit" : "create",
    workflowProfileId: String(value.workflowProfileId || ""),
    workflowName: String(value.workflowName || ""),
    loraState: normalizeGenerationLoraState(value.loraState),
    modelState: normalizeGenerationModelState(value.modelState),
    generationSnapshot: normalizeGenerationSnapshot(value.generationSnapshot),
    sourceImage: normalizeImageReference(value.sourceImage),
    resultNodeIds: Array.isArray(value.resultNodeIds) ? value.resultNodeIds.map(String) : [],
    resultFields: Array.isArray(value.resultFields) && value.resultFields.length
      ? value.resultFields.map(String)
      : ["images", "gifs"],
    createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : Date.now(),
  };
}

function normalizeConsultExperiment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.active !== true) return null;
  const startedAt = Number.isFinite(Number(value.startedAt)) ? Number(value.startedAt) : Date.now();
  const updatedAt = Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : startedAt;
  if (updatedAt < Date.now() - CONSULT_RETENTION_MS) return null;
  return {
    id: String(value.id || makeId()),
    active: true,
    baseMainPrompt: String(value.baseMainPrompt || ""),
    baseFinalPrompt: String(value.baseFinalPrompt || ""),
    stylePreset: String(value.stylePreset || "None"),
    stylePresetText: String(value.stylePresetText || ""),
    framingPreset: String(value.framingPreset || "None"),
    framingPresetText: String(value.framingPresetText || ""),
    candidatePrompt: String(value.candidatePrompt || ""),
    styleGuidance: String(value.styleGuidance || ""),
    framingGuidance: String(value.framingGuidance || ""),
    selectedMessageId: String(value.selectedMessageId || ""),
    startedAt,
    updatedAt,
  };
}

function normalizePromptAgentRubric(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const criteria = Array.isArray(value.criteria)
    ? value.criteria.slice(0, 12).map((item, index) => ({
        id: String(item?.id || `criterion_${index + 1}`).slice(0, 80),
        description: String(item?.description || "").slice(0, 1000),
        weight: Math.max(0.1, Math.min(100, Number(item?.weight) || 1)),
        hard: item?.hard === true,
      })).filter((item) => item.description)
    : [];
  if (!criteria.length) return null;
  return {
    summary: String(value.summary || "").slice(0, 4000),
    reference_notes: Array.isArray(value.reference_notes)
      ? value.reference_notes.slice(0, 4).map((item, index) => ({
          label: String(item?.label || `Reference ${index + 1}`).slice(0, 80),
          purpose: String(item?.purpose || "general reference").slice(0, 200),
          visible_content: String(item?.visible_content || "").slice(0, 4000),
          apply: String(item?.apply || "").slice(0, 2000),
        })).filter((item) => item.visible_content && item.apply)
      : [],
    criteria,
    forbidden: Array.isArray(value.forbidden)
      ? value.forbidden.map((item) => String(item || "").slice(0, 1000)).filter(Boolean).slice(0, 12)
      : [],
  };
}

function normalizePromptAgentCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prompt = String(value.prompt || "").trim();
  if (!prompt || prompt.length > MAX_CONSULT_EXPERIMENT_PROMPT_CHARS) return null;
  const styleGuidance = String(value.style_guidance ?? value.styleGuidance ?? "").trim();
  const framingGuidance = String(value.framing_guidance ?? value.framingGuidance ?? "").trim();
  if (
    styleGuidance.length > MAX_CONSULT_EXPERIMENT_GUIDANCE_CHARS
    || framingGuidance.length > MAX_CONSULT_EXPERIMENT_GUIDANCE_CHARS
  ) return null;
  return {
    prompt,
    styleGuidance,
    framingGuidance,
    changeSummary: String(value.change_summary ?? value.changeSummary ?? "").slice(0, 4000),
  };
}

function normalizePromptAgentEvaluation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    score: Math.max(0, Math.min(100, Number(value.score) || 0)),
    confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)),
    pass: value.pass === true,
    criteria: Array.isArray(value.criteria)
      ? value.criteria.slice(0, 12).map((item) => ({
          id: String(item?.id || "").slice(0, 80),
          status: ["pass", "partial", "fail"].includes(item?.status) ? item.status : "fail",
          score: Math.max(0, Math.min(100, Number(item?.score) || 0)),
          evidence: String(item?.evidence || "").slice(0, 2000),
        })).filter((item) => item.id)
      : [],
    defects: Array.isArray(value.defects)
      ? value.defects.map((item) => String(item || "").slice(0, 1000)).filter(Boolean).slice(0, 12)
      : [],
    nextRevision: String(value.next_revision ?? value.nextRevision ?? "").slice(0, 4000),
    summary: String(value.summary || "").slice(0, 4000),
  };
}

function normalizePromptAgentIteration(value, fallbackIndex = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const createdAt = Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : Date.now();
  return {
    id: String(value.id || makeId()),
    index: Math.max(1, Math.trunc(Number(value.index) || fallbackIndex + 1)),
    status: ["architecting", "generating", "evaluating", "complete", "error"].includes(value.status)
      ? value.status
      : "architecting",
    candidate: normalizePromptAgentCandidate(value.candidate),
    generation: normalizeConsultExperimentGeneration(value.generation),
    evaluation: normalizePromptAgentEvaluation(value.evaluation),
    validation: value.validation === true,
    createdAt,
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : createdAt,
  };
}

function normalizeConsultAgent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const goal = String(value.goal || "").trim();
  if (!goal) return null;
  const startedAt = Number.isFinite(Number(value.startedAt)) ? Number(value.startedAt) : Date.now();
  const updatedAt = Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : startedAt;
  if (updatedAt < Date.now() - CONSULT_RETENTION_MS) return null;
  const status = [
    "compiling", "architecting", "generating", "evaluating", "validating",
    "paused", "complete", "stopped", "error",
  ].includes(value.status) ? value.status : "paused";
  return {
    id: String(value.id || makeId()),
    active: value.active === true && !["complete", "stopped", "error"].includes(status),
    status,
    resumeStatus: [
      "compiling", "architecting", "generating", "evaluating", "validating",
    ].includes(value.resumeStatus) ? value.resumeStatus : "",
    goal,
    references: Array.isArray(value.references)
      ? value.references.slice(0, 4).map((item) => ({
          image: normalizeImageReference(item?.image),
          purpose: String(item?.purpose || "general reference").slice(0, 200),
        })).filter((item) => item.image)
      : [],
    rubric: normalizePromptAgentRubric(value.rubric),
    initialStyle: {
      name: String(value.initialStyle?.name || "None"),
      instruction: String(value.initialStyle?.instruction || "").slice(0, MAX_CONSULT_EXPERIMENT_GUIDANCE_CHARS),
    },
    initialFraming: {
      name: String(value.initialFraming?.name || "None"),
      instruction: String(value.initialFraming?.instruction || "").slice(0, MAX_CONSULT_EXPERIMENT_GUIDANCE_CHARS),
    },
    feedback: Array.isArray(value.feedback)
      ? value.feedback.slice(-20).map((item) => ({
          text: String(item?.text || "").trim().slice(0, 4000),
          createdAt: Number.isFinite(Number(item?.createdAt)) ? Number(item.createdAt) : updatedAt,
        })).filter((item) => item.text)
      : [],
    iterations: Array.isArray(value.iterations)
      ? value.iterations.map(normalizePromptAgentIteration).filter(Boolean).slice(-PROMPT_AGENT_MAX_SAVED_ITERATIONS)
      : [],
    currentIterationId: String(value.currentIterationId || ""),
    bestIterationId: String(value.bestIterationId || ""),
    maxIterations: Math.max(
      1,
      Math.min(PROMPT_AGENT_MAX_ITERATIONS, Math.trunc(Number(value.maxIterations) || PROMPT_AGENT_DEFAULT_MAX_ITERATIONS)),
    ),
    cycleStartIndex: Math.max(1, Math.trunc(Number(value.cycleStartIndex) || 1)),
    targetScore: Math.max(1, Math.min(100, Number(value.targetScore) || PROMPT_AGENT_TARGET_SCORE)),
    minConfidence: Math.max(0, Math.min(1, Number(value.minConfidence) || PROMPT_AGENT_MIN_CONFIDENCE)),
    validationRequired: value.validationRequired !== false,
    error: String(value.error || "").slice(0, 4000),
    startedAt,
    updatedAt,
  };
}

function normalizeConsultMessage(message) {
  const id = String(message?.id || makeId());
  const role = message?.role === "assistant" ? "assistant" : "user";
  const createdAt = Number(message?.createdAt);
  const updatedAt = Number(message?.updatedAt);
  const normalizedCreatedAt = Number.isFinite(createdAt) ? createdAt : Date.now();
  const normalizedUpdatedAt = Number.isFinite(updatedAt) ? updatedAt : normalizedCreatedAt;
  const normalized = {
    id,
    role,
    text: String(message?.text || ""),
    context: normalizeConsultContext(message?.context),
    images: Array.isArray(message?.images)
      ? message.images.map(normalizeImageReference).filter(Boolean).slice(0, 4)
      : [],
    experimentId: String(message?.experimentId || ""),
    createdAt: normalizedCreatedAt,
    updatedAt: normalizedUpdatedAt,
  };
  if (role !== "assistant") return normalized;

  const variants = Array.isArray(message?.variants)
    ? message.variants
        .filter((variant) => variant && typeof variant === "object")
        .map((variant, index) => ({
          id: String(variant.id || `${id}-response-${index}`),
          text: String(variant.text || ""),
          proposal: normalizeConsultExperimentProposal(variant.proposal),
          generation: normalizeConsultExperimentGeneration(variant.generation),
          createdAt: Number.isFinite(Number(variant.createdAt))
            ? Number(variant.createdAt)
            : normalizedCreatedAt,
        }))
        .filter((variant) => variant.text.trim())
    : [];
  if (!variants.length && normalized.text.trim()) {
    variants.push({
      id: `${id}-response-0`,
      text: normalized.text,
      proposal: normalizeConsultExperimentProposal(message?.proposal),
      generation: normalizeConsultExperimentGeneration(message?.generation),
      createdAt: normalizedCreatedAt,
    });
  }
  const requestedIndex = Number(message?.variantIndex);
  const variantIndex = Number.isFinite(requestedIndex)
    ? Math.max(0, Math.min(Math.trunc(requestedIndex), variants.length - 1))
    : Math.max(0, variants.length - 1);
  return {
    ...normalized,
    text: variants[variantIndex]?.text || normalized.text,
    proposal: variants[variantIndex]?.proposal || null,
    generation: variants[variantIndex]?.generation || null,
    variants,
    variantIndex,
  };
}

function retainedConsultMessages(messages, now = Date.now()) {
  const cutoff = now - CONSULT_RETENTION_MS;
  const retained = messages.filter((message) => {
    const timestampMs = consultTimestampMs(message.createdAt);
    return Number.isFinite(timestampMs) && timestampMs >= cutoff;
  });
  while (retained[0]?.role === "assistant") retained.shift();
  return retained.slice(-100);
}

function consultTimestampMs(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return NaN;
  return timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp;
}

function consultMessagesAfterClear(messages, clearedAt) {
  const cutoff = consultTimestampMs(clearedAt);
  if (!Number.isFinite(cutoff) || cutoff <= 0) return messages;
  return messages.filter((message) => consultTimestampMs(message.createdAt) >= cutoff);
}

function pruneExpiredConsultMessages(now = Date.now()) {
  let changed = false;
  for (const chat of state.chats) {
    const retained = retainedConsultMessages(
      consultMessagesAfterClear(chat.consultMessages || [], chat.consultClearedAt),
      now,
    );
    if (retained.length !== (chat.consultMessages || []).length) {
      chat.consultMessages = retained;
      changed = true;
    }
    const experimentUpdatedAt = Number(chat.consultExperiment?.updatedAt || 0);
    if (chat.consultExperiment && experimentUpdatedAt < now - CONSULT_RETENTION_MS) {
      chat.consultExperiment = null;
      changed = true;
    }
    const agentUpdatedAt = Number(chat.consultAgent?.updatedAt || 0);
    if (chat.consultAgent && agentUpdatedAt < now - CONSULT_RETENTION_MS) {
      chat.consultAgent = null;
      chat.consultAgentMode = false;
      changed = true;
    }
  }
  return changed;
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
        mainPrompt: String(message?.mainPrompt || message?.canonicalPrompt || ""),
        canonicalPrompt: String(message?.canonicalPrompt || ""),
        controlsFingerprint: String(message?.controlsFingerprint || ""),
        llmAmplified: Boolean(message?.llmAmplified),
        executionPrompt: String(message?.executionPrompt || message?.canonicalPrompt || ""),
        generationAction: ["edit", "upscale"].includes(message?.generationAction) ? message.generationAction : "create",
        workflowProfileId: String(message?.workflowProfileId || ""),
        workflowName: String(message?.workflowName || ""),
        loraState: normalizeGenerationLoraState(message?.loraState),
        modelState: normalizeGenerationModelState(message?.modelState),
        generationSnapshot: normalizeGenerationSnapshot(message?.generationSnapshot),
        sourceImage: normalizeImageReference(message?.sourceImage),
        upscaleFactor: message?.upscaleFactor != null && Number.isFinite(Number(message.upscaleFactor))
          ? Number(message.upscaleFactor)
          : null,
        resultNodeIds: Array.isArray(message?.resultNodeIds) ? message.resultNodeIds.map(String) : [],
        resultFields: Array.isArray(message?.resultFields) && message.resultFields.length ? message.resultFields.map(String) : ["images", "gifs"],
        promptId: String(message?.promptId || ""),
        generationState: ["queued", "generating", "complete", "error"].includes(message?.generationState) ? message.generationState : "",
        createdAt: normalizedAt(message?.createdAt, updatedAt),
        updatedAt: normalizedAt(message?.updatedAt, normalizedAt(message?.createdAt, updatedAt)),
      }))
    : [];
  const consultClearedAt = normalizedAt(chat?.consultClearedAt, 0);
  const consultMessages = Array.isArray(chat?.consultMessages)
    ? retainedConsultMessages(consultMessagesAfterClear(
        chat.consultMessages.map(normalizeConsultMessage),
        consultClearedAt,
      ))
    : [];
  const consultExperiment = normalizeConsultExperiment(chat?.consultExperiment);
  const consultAgent = normalizeConsultAgent(chat?.consultAgent);
  const consultAgentMode = typeof chat?.consultAgentMode === "boolean"
    ? chat.consultAgentMode
    : Boolean(consultAgent?.active);
  const storedFinalPrompt = String(chat?.finalPrompt ?? chat?.currentPrompt ?? "");
  const storedMainPrompt = String(chat?.mainPrompt ?? storedFinalPrompt);
  const storedVersions = Array.isArray(chat?.versions) && chat.versions.length
    ? chat.versions.map((value) => normalizePromptVersion(value, storedMainPrompt, storedFinalPrompt))
    : [promptVersion(storedMainPrompt, storedFinalPrompt)];
  const latestGeneration = [...messages]
    .reverse()
    .find((message) => message.canonicalPrompt.trim());
  const recoverGeneratedPrompt = !storedFinalPrompt.trim()
    && !storedVersions.some((version) => version.finalPrompt.trim())
    && Boolean(latestGeneration?.canonicalPrompt.trim());
  const mainPrompt = recoverGeneratedPrompt ? latestGeneration.mainPrompt : storedMainPrompt;
  const finalPrompt = recoverGeneratedPrompt ? latestGeneration.canonicalPrompt : storedFinalPrompt;
  const versions = recoverGeneratedPrompt
    ? [promptVersion(mainPrompt, finalPrompt)]
    : storedVersions;
  const requestedIndex = Number(recoverGeneratedPrompt ? versions.length - 1 : chat?.versionIndex ?? versions.length - 1);
  const versionIndex = Number.isFinite(requestedIndex)
    ? Math.max(0, Math.min(requestedIndex, versions.length - 1))
    : versions.length - 1;
  return {
    id: String(chat?.id || makeId()),
    createdAt,
    updatedAt,
    initialized: recoverGeneratedPrompt || (chat?.initialized == null ? Boolean(finalPrompt) : Boolean(chat.initialized)),
    mainPrompt,
    mainPromptDirty: Boolean(chat?.mainPromptDirty),
    finalPrompt,
    currentPrompt: finalPrompt,
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
    consultClearedAt,
    consultMessages,
    consultExperiment,
    consultAgent,
    consultAgentMode,
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
    type: ["input", "output", "temp", "promptstudio"].includes(value.type) ? value.type : "output",
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
    mainPrompt: String(value.mainPrompt || value.canonicalPrompt || ""),
    canonicalPrompt: String(value.canonicalPrompt || ""),
    executionPrompt: String(value.executionPrompt || ""),
    workflowProfileId: String(value.workflowProfileId || ""),
    sourceImage: normalizeImageReference(value.sourceImage),
  };
}

function normalizePendingGeneration(value) {
  if (!value || typeof value !== "object") return null;
  return {
    action: ["edit", "upscale"].includes(value.action) ? value.action : "create",
    mainPrompt: String(value.mainPrompt || value.canonicalPrompt || ""),
    canonicalPrompt: String(value.canonicalPrompt || ""),
    executionPrompt: String(value.executionPrompt || ""),
    workflowProfileId: String(value.workflowProfileId || ""),
    workflowName: String(value.workflowName || ""),
    loraState: normalizeGenerationLoraState(value.loraState),
    modelState: normalizeGenerationModelState(value.modelState),
    generationSnapshot: normalizeGenerationSnapshot(value.generationSnapshot),
    replayFingerprint: String(value.replayFingerprint || ""),
    sourceImage: normalizeImageReference(value.sourceImage),
    upscaleFactor: value.upscaleFactor != null && Number.isFinite(Number(value.upscaleFactor))
      ? Number(value.upscaleFactor)
      : null,
    resultNodeIds: Array.isArray(value.resultNodeIds) ? value.resultNodeIds.map(String) : [],
    resultFields: Array.isArray(value.resultFields) && value.resultFields.length
      ? value.resultFields.map(String)
      : ["images", "gifs"],
  };
}

function mergeChatMessages(remoteMessages, localMessages) {
  const merged = new Map();
  for (const message of [...remoteMessages, ...localMessages]) {
    const current = merged.get(message.id);
    if (!current) {
      merged.set(message.id, message);
      continue;
    }
    const newer = Number(message.updatedAt || message.createdAt) >= Number(current.updatedAt || current.createdAt)
      ? message
      : current;
    const older = newer === message ? current : message;
    const images = new Map();
    for (const image of [...(older.images || []), ...(newer.images || [])]) {
      const key = imageReferenceKey(image);
      if (key) images.set(key, image);
    }
    const combined = { ...older, ...newer, images: [...images.values()] };
    if (Array.isArray(older.variants) || Array.isArray(newer.variants)) {
      const variants = new Map();
      for (const variant of [...(older.variants || []), ...(newer.variants || [])]) {
        if (variant?.id) variants.set(variant.id, variant);
      }
      combined.variants = [...variants.values()].sort((left, right) => (
        Number(left.createdAt || 0) - Number(right.createdAt || 0)
        || String(left.id).localeCompare(String(right.id))
      ));
      const selectedVariantId = newer.variants?.[newer.variantIndex]?.id;
      const selectedIndex = combined.variants.findIndex((variant) => variant.id === selectedVariantId);
      combined.variantIndex = selectedIndex >= 0 ? selectedIndex : combined.variants.length - 1;
      combined.text = combined.variants[combined.variantIndex]?.text || combined.text;
      combined.proposal = combined.variants[combined.variantIndex]?.proposal || null;
      combined.generation = combined.variants[combined.variantIndex]?.generation || null;
    }
    merged.set(message.id, combined);
  }
  return [...merged.values()].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

function mergeChatStores(remoteStore, localStore) {
  const remoteChats = Array.isArray(remoteStore?.chats) ? remoteStore.chats.map(normalizeChat) : [];
  const localChats = Array.isArray(localStore?.chats) ? localStore.chats.map(normalizeChat) : [];
  const merged = new Map(remoteChats.map((chat) => [chat.id, chat]));
  for (const localChat of localChats) {
    const remoteChat = merged.get(localChat.id);
    if (!remoteChat) {
      merged.set(localChat.id, localChat);
      continue;
    }
    const newer = localChat.updatedAt >= remoteChat.updatedAt ? localChat : remoteChat;
    const older = newer === localChat ? remoteChat : localChat;
    const consultClearedAt = Math.max(
      Number(remoteChat.consultClearedAt || 0),
      Number(localChat.consultClearedAt || 0),
    );
    merged.set(localChat.id, {
      ...older,
      ...newer,
      createdAt: Math.min(localChat.createdAt, remoteChat.createdAt),
      updatedAt: Math.max(localChat.updatedAt, remoteChat.updatedAt),
      messages: mergeChatMessages(remoteChat.messages, localChat.messages),
      consultClearedAt,
      consultMessages: consultMessagesAfterClear(
        mergeChatMessages(remoteChat.consultMessages, localChat.consultMessages),
        consultClearedAt,
      ),
    });
  }
  return {
    activeChatId: localStore?.activeChatId || remoteStore?.activeChatId || null,
    chats: [...merged.values()],
  };
}

function applyChatStoreSnapshot(stored, { preserveActive = true } = {}) {
  const previousActiveId = preserveActive ? state.activeChatId : null;
  const storedChats = Array.isArray(stored?.chats) ? stored.chats : [];
  state.chats = storedChats.map(normalizeChat);
  state.chatRevision = Number(stored?.revision || state.chatRevision);
  state.chatStoreLoaded = true;
  state.chatPersistenceBlocked = false;
  state.activeChatId = state.chats.some((chat) => chat.id === previousActiveId)
    ? previousActiveId
    : state.chats.some((chat) => chat.id === stored?.activeChatId)
      ? stored.activeChatId
      : state.chats[0]?.id || null;
  const chat = activeChat();
  if (chat) {
    restoreChatState(chat);
    refreshWorkflowControls();
    refreshSecondaryInstructionsControl();
  }
  renderChatHistory();
  renderConsultHistory();
  renderChatList();
  resumeSyncedGeneration();
}

async function writeChatStore(snapshot, revision) {
  return api.fetchApi("/promptstudio/prompt-studio/chats", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...snapshot, revision }),
  });
}

async function persistChats() {
  if (state.chatPersistenceBlocked || !state.chatStoreLoaded) return;
  state.chatSaveInFlight = true;
  try {
    let snapshot = structuredClone({ activeChatId: state.activeChatId, chats: state.chats });
    let response = await writeChatStore(snapshot, state.chatRevision);
    let data = await response.json().catch(() => ({}));
    if (response.status === 409) {
      const latestResponse = await api.fetchApi("/promptstudio/prompt-studio/chats");
      const latest = await latestResponse.json().catch(() => ({}));
      if (!latestResponse.ok) throw new Error(latest.error || `Chat synchronization failed (${latestResponse.status}).`);
      snapshot = mergeChatStores(latest, {
        activeChatId: state.activeChatId,
        chats: structuredClone(state.chats),
      });
      const mergedMutationVersion = state.chatMutationVersion;
      response = await writeChatStore(snapshot, Number(latest.revision || 0));
      data = await response.json().catch(() => ({}));
      if (response.ok && state.chatMutationVersion === mergedMutationVersion) {
        applyChatStoreSnapshot({ ...snapshot, revision: data.revision }, { preserveActive: true });
      }
    }
    if (!response.ok) throw new Error(data.error || `Chat save failed (${response.status}).`);
    state.chatRevision = Number(data.revision || state.chatRevision);
    state.chatSyncChannel?.postMessage({ type: "chat-store-updated", revision: state.chatRevision });
  } finally {
    state.chatSaveInFlight = false;
  }
}

function saveChats({ immediate = false } = {}) {
  if (state.chatPersistenceBlocked || !state.chatStoreLoaded) return;
  if (pruneExpiredConsultMessages()) renderConsultHistory();
  state.chatMutationVersion += 1;
  if (state.chatSaveTimer) clearTimeout(state.chatSaveTimer);
  const persist = () => {
    state.chatSaveTimer = null;
    state.chatSaveChain = state.chatSaveChain
      .catch(() => {})
      .then(persistChats)
      .catch((error) => setStatus(error.message || "Chat history could not be saved.", "warning"));
  };
  if (immediate) persist();
  else state.chatSaveTimer = setTimeout(persist, 150);
}

async function refreshChatsFromServer({ force = false } = {}) {
  if (!state.chatStoreLoaded || state.chatPersistenceBlocked || state.chatSyncInFlight) return;
  if (!force && (state.chatSaveTimer || state.chatSaveInFlight || state.busy)) return;
  state.chatSyncInFlight = true;
  try {
    const response = await api.fetchApi(`/promptstudio/prompt-studio/chats?revision=${encodeURIComponent(state.chatRevision)}`);
    if (response.status === 204) return;
    const stored = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(stored.error || `Chat synchronization failed (${response.status}).`);
    if (Number(stored.revision || 0) <= state.chatRevision) return;
    applyChatStoreSnapshot(stored, { preserveActive: true });
  } catch (error) {
    if (force) setStatus(error.message || "Chat history could not be synchronized.", "warning");
  } finally {
    state.chatSyncInFlight = false;
  }
}

function setupChatSync() {
  if (!state.chatSyncTimer) {
    state.chatSyncTimer = window.setInterval(() => refreshChatsFromServer(), 1250);
    window.addEventListener("focus", () => refreshChatsFromServer());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshChatsFromServer();
    });
  }
  if (typeof BroadcastChannel !== "function" || state.chatSyncChannel) return;
  const channel = new BroadcastChannel(CHAT_SYNC_CHANNEL);
  channel.addEventListener("message", (event) => {
    if (event.data?.type !== "chat-store-updated") return;
    if (Number(event.data.revision || 0) <= state.chatRevision) return;
    refreshChatsFromServer();
  });
  state.chatSyncChannel = channel;
}

async function loadChats() {
  let recoveredOrMigratedPromptState = false;
  try {
    const response = await api.fetchApi("/promptstudio/prompt-studio/chats");
    const stored = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(stored.error || `Chat load failed (${response.status}).`);
    const storedChats = Array.isArray(stored.chats) ? stored.chats : [];
    state.chats = storedChats.map(normalizeChat);
    recoveredOrMigratedPromptState = state.chats.some((chat, index) => {
      const storedChat = storedChats[index];
      return (
        (!String(storedChat?.currentPrompt || "").trim() && Boolean(chat.currentPrompt.trim()))
        || typeof storedChat?.mainPrompt !== "string"
        || typeof storedChat?.finalPrompt !== "string"
        || (Array.isArray(storedChat?.versions) && storedChat.versions.some((version) => typeof version !== "object"))
      );
    });
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
  if (recoveredOrMigratedPromptState) saveChats({ immediate: true });
}

function restoreChatState(chat) {
  state.mainPrompt = chat.mainPrompt;
  state.currentPrompt = chat.finalPrompt;
  state.versions = [...chat.versions];
  state.versionIndex = chat.versionIndex;
  updatePromptEditors(chat.mainPrompt, chat.finalPrompt);
}

function syncActiveChat() {
  const chat = activeChat();
  if (!chat) return;
  chat.mainPrompt = state.mainPrompt;
  chat.finalPrompt = state.currentPrompt;
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
  const snapshotLoraNodes = Object.entries(snapshot?.output || {})
    .filter(([, node]) => node?.class_type === LORA_LOADER_TYPE)
    .map(([id, node]) => ({
      id: String(id),
      loraType: String(node.inputs?.lora_type || "").trim(),
    }));
  const loraNodes = Array.isArray(profile?.loraNodes)
    ? profile.loraNodes.map((node) => ({
      id: String(node?.id || ""),
      loraType: String(node?.loraType || "").trim(),
    })).filter((node) => node.id)
    : snapshotLoraNodes;
  const snapshotModelNodes = Object.entries(snapshot?.output || {})
    .filter(([, node]) => node?.class_type === MODEL_LOADER_TYPE)
    .map(([id, node]) => ({
      id: String(id),
      modelType: String(node.inputs?.model_type || "").trim(),
      modelName: cleanModelName(node.inputs?.unet_name),
    }));
  const modelNodes = Array.isArray(profile?.modelNodes)
    ? profile.modelNodes.map((node) => ({
      id: String(node?.id || ""),
      modelType: String(node?.modelType || "").trim(),
      modelName: cleanModelName(node?.modelName),
    })).filter((node) => node.id)
    : snapshotModelNodes;
  return {
    id: path,
    path,
    name: String(profile?.name || workflowNameFromPath(path) || "Workflow").trim() || "Workflow",
    kind: ["edit", "upscale"].includes(profile?.kind) ? profile.kind : "create",
    promptMode: "full_prompt",
    promptNodeId: String(profile?.promptNodeId || ""),
    imageNodeId: String(profile?.imageNodeId || ""),
    upscaleNodeId: String(profile?.upscaleNodeId || ""),
    loraNodes,
    modelNodes,
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
  const loraNodes = Object.entries(output)
    .filter(([, node]) => node?.class_type === LORA_LOADER_TYPE)
    .map(([id, node]) => ({
      id: String(id),
      loraType: String(node.inputs?.lora_type || "").trim(),
    }));
  const modelNodes = Object.entries(output)
    .filter(([, node]) => node?.class_type === MODEL_LOADER_TYPE)
    .map(([id, node]) => ({
      id: String(id),
      modelType: String(node.inputs?.model_type || "").trim(),
      modelName: cleanModelName(node.inputs?.unet_name),
    }));
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
    loraNodes,
    modelNodes,
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
  return JSON.stringify(RENDER_CONTROL_IDS.map((id) => state.panel.querySelector(`#${id}`)?.value ?? ""));
}

function useLlmAmplification() {
  return state.panel?.querySelector("#promptstudio-use-llm-amplification")?.checked !== false;
}

function selectedLlmProvider() {
  return state.panel?.querySelector("#promptstudio-llm-provider")?.value === "ollama" ? "ollama" : "koboldcpp";
}

function llmProviderName() {
  return selectedLlmProvider() === "ollama" ? "Ollama" : "KoboldCpp";
}

function controlsNeedApply() {
  const chat = activeChat();
  return Boolean(useLlmAmplification() && chat?.initialized && chat.controlsFingerprint !== controlsFingerprint());
}

function mainPromptNeedsRender() {
  const chat = activeChat();
  return Boolean(useLlmAmplification() && chat?.initialized && chat.mainPromptDirty);
}

function promptNeedsRender() {
  return mainPromptNeedsRender() || controlsNeedApply();
}

function markControlsChanged() {
  saveSettings();
  if (!useLlmAmplification()) {
    setStatus(`Direct prompt mode. ${llmProviderName()} will not be used.`, "ready");
  } else if (!activeChat()?.initialized) {
    setStatus("Describe an image to create the first prompt.", "ready");
  } else if (mainPromptNeedsRender()) {
    setStatus(`Main prompt changed. ${llmProviderName()} will rebuild the final prompt before generation.`, "warning");
  } else if (controlsNeedApply()) {
    setStatus(`Generation controls changed. ${llmProviderName()} will update the prompt before generation.`, "warning");
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
    (newest, message) => Math.max(newest, message.updatedAt || message.createdAt),
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

function setImageDropFeedback(text, kind = "") {
  const feedback = state.panel?.querySelector(".promptstudio-empty-drop-feedback");
  if (!feedback) return;
  feedback.textContent = text;
  feedback.dataset.kind = kind;
}

function refreshEmptyImageDropZone() {
  const history = state.panel?.querySelector("#promptstudio-history");
  if (!history) return;
  const existing = history.querySelector(".promptstudio-empty-drop");
  if (!chatAcceptsImageDrop()) {
    existing?.remove();
    history.dataset.dragActive = "false";
    return;
  }
  if (existing) {
    existing.querySelector("button").disabled = state.busy;
    existing.querySelector(".promptstudio-empty-drop-copy").textContent =
      `${llmProviderName()} will read it and build a prompt with the selected profile and style.`;
    return;
  }
  const zone = document.createElement("div");
  zone.className = "promptstudio-empty-drop";
  zone.innerHTML = `
    <span class="promptstudio-empty-drop-icon" aria-hidden="true">+</span>
    <strong>Type a prompt or drop an image to start</strong>
    <span class="promptstudio-empty-drop-copy">${llmProviderName()} will read it and build a prompt with the selected profile and style.</span>
    <button type="button" data-disable-busy>Choose image</button>
    <small class="promptstudio-empty-drop-feedback" aria-live="polite">A vision-capable model must be active to import an image.</small>`;
  zone.querySelector("button").disabled = state.busy;
  zone.querySelector("button").addEventListener("click", () => {
    state.panel?.querySelector("#promptstudio-image-import")?.click();
  });
  history.appendChild(zone);
}

function renderChatHistory() {
  const history = state.panel?.querySelector("#promptstudio-history");
  if (!history) return;
  history.replaceChildren();
  for (const message of activeChat()?.messages || []) renderMessage(message, { scroll: false });
  refreshEmptyImageDropZone();
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
  refreshLatestImageContextControl();
  const creating = !activeChat()?.initialized;
  const heading = state.panel.querySelector("#promptstudio-compose-title");
  const hint = state.panel.querySelector("#promptstudio-compose-hint");
  const input = state.panel.querySelector("#promptstudio-revision");
  const send = state.panel.querySelector("#promptstudio-send");
  const editor = state.panel.querySelector("#promptstudio-current-prompt");
  const action = selectedAction();
  const autoGenerate = state.panel.querySelector("#promptstudio-auto-generate")?.checked !== false;
  const hasRevision = Boolean(input?.value.trim());
  const editPromptAction = state.panel.querySelector("#promptstudio-edit-prompt-action");
  if (editPromptAction) editPromptAction.hidden = action !== "edit";
  if (!amplificationEnabled) {
    if (heading) heading.textContent = "Direct prompt";
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
  if (hint) hint.textContent = creating
    ? `${llmProviderName()} will create the initial prompt`
    : "Leave empty to create from the current prompt";
  if (input) input.placeholder = creating ? "A portrait of an astronaut in a greenhouse…" : "Make the background more varied…";
  if (send) {
    if (!autoGenerate) send.textContent = creating ? "Create prompt" : "Revise prompt";
    else {
      send.textContent = action === "edit"
        ? (hasRevision ? "Revise & edit selected" : "Edit selected")
        : (hasRevision ? "Revise & create new" : "Create new");
    }
  }
  if (editor) editor.readOnly = creating;
  refreshEmptyImageDropZone();
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
    clearMainPastedImage();
    setStatus(`Direct prompt mode. ${llmProviderName()} will not be used.`, "ready");
  }
}

function syncManualPrompt(value) {
  if (useLlmAmplification()) return;
  const chat = activeChat();
  if (chat) chat.initialized = Boolean(value.trim());
  updatePromptEditors(value, value);
  syncActiveChat();
  refreshEmptyImageDropZone();
}

function createChat() {
  if (state.busy) return;
  commitPromptEditorVersion();
  syncActiveChat();
  clearMainPastedImage();
  const createAction = state.panel?.querySelector('input[name="promptstudio-generation-action"][value="create"]');
  if (createAction) createAction.checked = true;
  const chat = normalizeChat({
    initialized: false,
    mainPrompt: "",
    finalPrompt: "",
    currentPrompt: "",
    versions: [promptVersion("", "")],
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
    consultMessages: [],
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
    clearMainPastedImage();
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
  const switchingChats = chatId !== state.activeChatId;
  if (switchingChats) commitPromptEditorVersion();
  const chat = state.chats.find((item) => item.id === chatId);
  if (!chat) return;
  state.activeChatId = chat.id;
  state.consultSelectedImages.clear();
  state.consultUploadedImages = [];
  if (switchingChats) clearMainPastedImage();
  restoreChatState(chat);
  refreshWorkflowControls();
  renderChatHistory();
  renderConsultHistory();
  renderChatList();
  refreshSecondaryInstructionsControl();
  if (!selectedWorkflowProfile(selectedAction())) {
    setStatus("No compatible [PS] workflow is selected for this action.", "warning");
  } else if (!useLlmAmplification()) {
    setStatus(`Direct prompt mode. ${llmProviderName()} will not be used.`, "ready");
  } else if (!chat.initialized) {
    setStatus("Describe an image to create the first prompt.", "ready");
  } else if (mainPromptNeedsRender()) {
    setStatus(`Main prompt changed. ${llmProviderName()} will rebuild the final prompt before generation.`, "warning");
  } else if (controlsNeedApply()) {
    setStatus(`Generation controls differ from this prompt. ${llmProviderName()} will update it before generation.`, "warning");
  } else {
    announceWorkflowSelection(selectedAction());
  }
  const undo = state.panel?.querySelector("#promptstudio-undo");
  if (undo) undo.disabled = state.versionIndex <= 0 || state.busy;
  setPanelDrawer("chats", false);
  saveChats();
  resumeSyncedGeneration();
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

function modelSelectionKey(profileId, nodeId) {
  return `${String(profileId || "")}\u0000${String(nodeId || "")}`;
}

function selectionForModelNode(profileId, descriptor) {
  const stored = cleanModelName(state.modelSelections[modelSelectionKey(profileId, descriptor?.id)]);
  return stored || cleanModelName(descriptor?.modelName);
}

function setSelectionForModelNode(profileId, nodeId, modelName) {
  const key = modelSelectionKey(profileId, nodeId);
  const normalized = cleanModelName(modelName);
  if (normalized) state.modelSelections[key] = normalized;
  else delete state.modelSelections[key];
  saveModelSelections();
}

function generationModelState(profile, descriptors = profile?.modelNodes) {
  if (!profile || !Array.isArray(descriptors)) return [];
  return descriptors
    .map((descriptor) => ({
      nodeId: String(descriptor?.id || "").trim(),
      modelType: String(descriptor?.modelType || "").trim(),
      modelName: selectionForModelNode(profile.id, descriptor),
    }))
    .filter((entry) => entry.nodeId && entry.modelName);
}

function loraSelectionKey(profileId, nodeId) {
  return `${String(profileId || "")}\u0000${String(nodeId || "")}`;
}

function selectionsForLoraNode(profileId, nodeId) {
  const stored = state.loraSelections[loraSelectionKey(profileId, nodeId)];
  return normalizeLoraStack(stored);
}

function setSelectionsForLoraNode(profileId, nodeId, selections) {
  const key = loraSelectionKey(profileId, nodeId);
  if (selections.length) state.loraSelections[key] = selections;
  else delete state.loraSelections[key];
  saveLoraSelections();
}

function generationLoraState(profile, descriptors = profile?.loraNodes) {
  if (!profile || !Array.isArray(descriptors)) return [];
  return descriptors
    .map((descriptor) => ({
      nodeId: String(descriptor?.id || "").trim(),
      loraType: String(descriptor?.loraType || "").trim(),
      selections: selectionsForLoraNode(profile.id, descriptor?.id),
    }))
    .filter((entry) => entry.nodeId);
}

function generationUiFingerprint() {
  if (!state.panel) return "";
  const controls = [
    ...state.panel.querySelectorAll(
      ".promptstudio-mode-control input, .promptstudio-generation-action input, "
      + ".promptstudio-workflow-routing select, .promptstudio-settings input, "
      + ".promptstudio-settings select, .promptstudio-settings textarea, "
      + ".promptstudio-resolution-details input, .promptstudio-resolution-details select, "
      + ".promptstudio-secondary-details textarea, .promptstudio-toggles input, #promptstudio-kobold-url",
    ),
  ].map((control, index) => ({
    key: control.id || control.name || `${control.tagName}:${index}`,
    value: ["checkbox", "radio"].includes(control.type) ? Boolean(control.checked) : String(control.value ?? ""),
  }));
  const action = selectedAction();
  const profile = selectedWorkflowProfile(action);
  return JSON.stringify({
    action,
    profileId: profile?.id || "",
    mainPrompt: state.mainPrompt,
    finalPrompt: state.currentPrompt,
    sourceImage: action === "create" ? null : storedImageReference(editingSource()),
    loraState: generationLoraState(profile),
    modelState: generationModelState(profile),
    controls,
  });
}

async function loadModelCatalog(modelType, { refresh = false } = {}) {
  const normalizedType = String(modelType || "").trim();
  if (!normalizedType) return [];
  const key = normalizedType.toLowerCase();
  if (refresh) state.modelCatalogs.delete(key);
  if (!state.modelCatalogs.has(key)) {
    const request = (async () => {
      const response = await api.fetchApi(
        `/promptstudio/prompt-studio/models?type=${encodeURIComponent(normalizedType)}`,
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Models could not be listed (${response.status}).`);
      return Array.isArray(data.models)
        ? data.models
          .filter((item) => item && typeof item.name === "string")
          .map((item) => ({
            name: item.name,
            label: String(item.label || item.name),
          }))
        : [];
    })().catch((error) => {
      state.modelCatalogs.delete(key);
      throw error;
    });
    state.modelCatalogs.set(key, request);
  }
  return state.modelCatalogs.get(key);
}

function buildModelNodeControls(profile, descriptor, catalog) {
  const group = document.createElement("div");
  group.className = "promptstudio-lora-group promptstudio-model-group";

  const heading = document.createElement("div");
  heading.className = "promptstudio-lora-group-heading";
  const title = document.createElement("strong");
  title.textContent = descriptor.modelType
    ? `Model Type: ${descriptor.modelType}`
    : "Model Type is not set";
  const nodeLabel = document.createElement("small");
  nodeLabel.textContent = `Node ${descriptor.id}`;
  heading.append(title, nodeLabel);
  group.appendChild(heading);

  if (!descriptor.modelType) {
    const note = document.createElement("p");
    note.className = "promptstudio-lora-empty";
    note.textContent = "Enter a top-level diffusion-model folder name in this loader node.";
    group.appendChild(note);
    return group;
  }

  const select = document.createElement("select");
  select.setAttribute("aria-label", `Select a ${descriptor.modelType} diffusion model`);
  const canonicalByName = new Map(catalog.map((item) => [modelNameKey(item.name), item]));
  const requested = selectionForModelNode(profile.id, descriptor);
  const selected = canonicalByName.get(modelNameKey(requested))?.name || catalog[0]?.name || "";
  for (const item of catalog) {
    const option = document.createElement("option");
    option.value = item.name;
    option.textContent = item.label;
    option.selected = item.name === selected;
    select.appendChild(option);
  }
  if (!catalog.length) {
    const option = document.createElement("option");
    option.textContent = "No models found";
    select.appendChild(option);
    select.disabled = true;
  } else if (selected !== requested) {
    setSelectionForModelNode(profile.id, descriptor.id, selected);
  }
  select.addEventListener("change", () => {
    setSelectionForModelNode(profile.id, descriptor.id, select.value);
  });
  group.appendChild(select);
  return group;
}

async function refreshModelSection({ refresh = false } = {}) {
  const details = state.panel?.querySelector("#promptstudio-model-details");
  const container = state.panel?.querySelector("#promptstudio-model-groups");
  const summary = state.panel?.querySelector("#promptstudio-model-summary");
  if (!details || !container || !summary) return;
  const profile = selectedWorkflowProfile(selectedAction());
  const descriptors = Array.isArray(profile?.modelNodes) ? profile.modelNodes : [];
  details.hidden = !descriptors.length;
  if (!descriptors.length) {
    container.replaceChildren();
    return;
  }

  const token = ++state.modelRenderToken;
  summary.textContent = "Loading available models…";
  container.textContent = "";
  try {
    const catalogs = await Promise.all(
      descriptors.map((descriptor) => loadModelCatalog(descriptor.modelType, { refresh })),
    );
    if (token !== state.modelRenderToken) return;
    container.replaceChildren(
      ...descriptors.map((descriptor, index) => buildModelNodeControls(profile, descriptor, catalogs[index])),
    );
    summary.textContent = `${descriptors.length} loader${descriptors.length === 1 ? "" : "s"}`;
  } catch (error) {
    if (token !== state.modelRenderToken) return;
    summary.textContent = "Unavailable";
    const note = document.createElement("p");
    note.className = "promptstudio-lora-empty";
    note.textContent = error.message || "Models could not be listed.";
    container.replaceChildren(note);
  }
}

async function loadLoraCatalog(loraType, { refresh = false } = {}) {
  const normalizedType = String(loraType || "").trim();
  if (!normalizedType) return [];
  const key = normalizedType.toLowerCase();
  if (refresh) state.loraCatalogs.delete(key);
  if (!state.loraCatalogs.has(key)) {
    const request = (async () => {
      const response = await api.fetchApi(
        `/promptstudio/prompt-studio/loras?type=${encodeURIComponent(normalizedType)}`,
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `LoRAs could not be listed (${response.status}).`);
      return Array.isArray(data.loras)
        ? data.loras
          .filter((item) => item && typeof item.name === "string")
          .map((item) => ({
            name: item.name,
            label: String(item.label || item.name),
          }))
        : [];
    })().catch((error) => {
      state.loraCatalogs.delete(key);
      throw error;
    });
    state.loraCatalogs.set(key, request);
  }
  return state.loraCatalogs.get(key);
}

function buildLoraNodeControls(profile, descriptor, catalog) {
  const group = document.createElement("div");
  group.className = "promptstudio-lora-group";

  const heading = document.createElement("div");
  heading.className = "promptstudio-lora-group-heading";
  const title = document.createElement("strong");
  title.textContent = descriptor.loraType
    ? `LoRA Type: ${descriptor.loraType}`
    : "LoRA Type is not set";
  const nodeLabel = document.createElement("small");
  nodeLabel.textContent = `Node ${descriptor.id}`;
  heading.append(title, nodeLabel);
  group.appendChild(heading);

  if (!descriptor.loraType) {
    const note = document.createElement("p");
    note.className = "promptstudio-lora-empty";
    note.textContent = "Enter a top-level LoRA folder name in this loader node.";
    group.appendChild(note);
    return group;
  }

  const canonicalByName = new Map(catalog.map((item) => [item.name.toLowerCase(), item]));
  const storedSelections = selectionsForLoraNode(profile.id, descriptor.id);
  const retainedNames = new Set();
  let selections = storedSelections
    .map((entry) => {
      const canonical = canonicalByName.get(entry.name.toLowerCase());
      const key = canonical?.name.toLowerCase();
      if (!canonical || retainedNames.has(key)) return null;
      retainedNames.add(key);
      return { name: canonical.name, strength: entry.strength };
    })
    .filter(Boolean);
  if (JSON.stringify(selections) !== JSON.stringify(storedSelections)) {
    setSelectionsForLoraNode(profile.id, descriptor.id, selections);
  }
  const used = new Set(selections.map((entry) => entry.name.toLowerCase()));

  const rows = document.createElement("div");
  rows.className = "promptstudio-lora-rows";
  selections.forEach((selection, index) => {
    const row = document.createElement("div");
    row.className = "promptstudio-lora-row";

    const name = document.createElement("span");
    name.className = "promptstudio-lora-name";
    name.textContent = canonicalByName.get(selection.name.toLowerCase())?.label || selection.name;
    name.title = selection.name;

    const strength = document.createElement("input");
    strength.type = "number";
    strength.min = "-100";
    strength.max = "100";
    strength.step = "0.01";
    strength.value = String(selection.strength);
    strength.setAttribute("aria-label", `Strength for ${name.textContent}`);
    strength.addEventListener("change", () => {
      const numeric = Number(strength.value);
      selections[index].strength = Number.isFinite(numeric)
        ? Math.max(-100, Math.min(100, numeric))
        : 1;
      strength.value = String(selections[index].strength);
      setSelectionsForLoraNode(profile.id, descriptor.id, selections);
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "promptstudio-lora-remove";
    remove.textContent = "×";
    remove.title = `Remove ${name.textContent}`;
    remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", () => {
      selections.splice(index, 1);
      setSelectionsForLoraNode(profile.id, descriptor.id, selections);
      refreshLoraSection();
    });
    row.append(name, strength, remove);
    rows.appendChild(row);
  });
  group.appendChild(rows);

  const addRow = document.createElement("div");
  addRow.className = "promptstudio-lora-add";
  const select = document.createElement("select");
  select.setAttribute("aria-label", `Add a ${descriptor.loraType} LoRA`);
  for (const item of catalog) {
    if (used.has(item.name.toLowerCase())) continue;
    const option = document.createElement("option");
    option.value = item.name;
    option.textContent = item.label;
    select.appendChild(option);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = "Add";
  add.disabled = !select.options.length;
  add.addEventListener("click", () => {
    if (!select.value) return;
    selections.push({ name: select.value, strength: 1 });
    setSelectionsForLoraNode(profile.id, descriptor.id, selections);
    refreshLoraSection();
  });
  if (!select.options.length) {
    const option = document.createElement("option");
    option.textContent = catalog.length ? "All available LoRAs added" : "No LoRAs found";
    select.appendChild(option);
    select.disabled = true;
  }
  addRow.append(select, add);
  group.appendChild(addRow);
  return group;
}

async function refreshLoraSection({ refresh = false } = {}) {
  const details = state.panel?.querySelector("#promptstudio-lora-details");
  const container = state.panel?.querySelector("#promptstudio-lora-groups");
  const summary = state.panel?.querySelector("#promptstudio-lora-summary");
  if (!details || !container || !summary) return;
  const profile = selectedWorkflowProfile(selectedAction());
  const descriptors = Array.isArray(profile?.loraNodes) ? profile.loraNodes : [];
  details.hidden = !descriptors.length;
  if (!descriptors.length) {
    container.replaceChildren();
    return;
  }

  const token = ++state.loraRenderToken;
  summary.textContent = "Loading available LoRAs…";
  container.textContent = "";
  try {
    const catalogs = await Promise.all(
      descriptors.map((descriptor) => loadLoraCatalog(descriptor.loraType, { refresh })),
    );
    if (token !== state.loraRenderToken) return;
    container.replaceChildren(
      ...descriptors.map((descriptor, index) => buildLoraNodeControls(profile, descriptor, catalogs[index])),
    );
    const selectedCount = descriptors.reduce(
      (count, descriptor) => count + selectionsForLoraNode(profile.id, descriptor.id).length,
      0,
    );
    summary.textContent = `${selectedCount} selected`;
  } catch (error) {
    if (token !== state.loraRenderToken) return;
    summary.textContent = "Unavailable";
    const note = document.createElement("p");
    note.className = "promptstudio-lora-empty";
    note.textContent = error.message || "LoRAs could not be listed.";
    container.replaceChildren(note);
  }
}

function announceWorkflowSelection(action, { persist = true } = {}) {
  if (persist) syncActiveChat();
  const profile = selectedWorkflowProfile(action);
  refreshSecondaryInstructionsControl();
  refreshLoraSection();
  refreshModelSection();
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
  refreshLoraSection();
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
  syncBackgroundActivityIndicator();
}

function isDisconnectedAllowedControl(control) {
  return control?.dataset?.promptstudioAllowDisconnected === "true";
}

function freezeDisconnectedControls(root = state.panel) {
  if (state.apiConnected || !root) return;
  const controls = [
    ...(root.matches?.(DISCONNECTED_CONTROL_SELECTOR) ? [root] : []),
    ...root.querySelectorAll(DISCONNECTED_CONTROL_SELECTOR),
  ];
  controls.forEach((control) => {
    if (isDisconnectedAllowedControl(control)) return;
    if (!state.disconnectedControls.has(control)) {
      state.disconnectedControls.set(control, control.disabled);
    } else if (!control.disabled) {
      state.disconnectedControls.set(control, false);
    }
    control.disabled = true;
  });
}

function setApiConnected(connected, { announce = true } = {}) {
  connected = Boolean(connected);
  if (state.apiConnected === connected && state.panel?.dataset.apiConnected) return;
  state.apiConnected = connected;
  const panel = state.panel;
  if (!panel) return;
  const banner = panel.querySelector("#promptstudio-api-connection");
  panel.dataset.apiConnected = connected ? "true" : "false";
  if (banner) banner.hidden = connected;

  if (!connected) {
    freezeDisconnectedControls();
    const activeElement = panel.ownerDocument?.activeElement;
    if (activeElement && panel.contains(activeElement) && !isDisconnectedAllowedControl(activeElement)) {
      activeElement.blur();
    }
    setStatus("ComfyUI disconnected — Prompt Studio is frozen.", "error");
    setConsultStatus("ComfyUI disconnected — messages are paused.", "error");
    return;
  }

  for (const [control, wasDisabled] of state.disconnectedControls) {
    if (control.isConnected) control.disabled = wasDisabled;
  }
  state.disconnectedControls.clear();
  if (announce) {
    setStatus("ComfyUI reconnected. Prompt Studio is ready.", "ready");
    if (!state.consultBusy) setConsultStatus("Ready", "ready");
  }
}

function setupApiConnectionState() {
  api.addEventListener("reconnecting", () => setApiConnected(false));
  api.addEventListener("reconnected", () => setApiConnected(true));
  api.addEventListener("status", (event) => setApiConnected(event.detail !== null));

  state.disconnectedControlObserver?.disconnect();
  state.disconnectedControlObserver = new MutationObserver((mutations) => {
    if (state.apiConnected) return;
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) freezeDisconnectedControls(node);
        });
      } else if (
        mutation.type === "attributes"
        && mutation.target.matches?.(DISCONNECTED_CONTROL_SELECTOR)
        && !mutation.target.disabled
        && !isDisconnectedAllowedControl(mutation.target)
      ) {
        state.disconnectedControls.set(mutation.target, false);
        mutation.target.disabled = true;
      }
    }
  });
  state.disconnectedControlObserver.observe(state.panel, {
    attributes: true,
    attributeFilter: ["disabled"],
    childList: true,
    subtree: true,
  });
  setApiConnected(api.socket ? api.socket.readyState === WebSocket.OPEN : true, { announce: false });
}

function setBusy(busy) {
  state.busy = busy;
  queueMicrotask(syncBackgroundActivityIndicator);
  state.panel?.querySelectorAll("button[data-disable-busy]").forEach((button) => {
    button.disabled = busy;
  });
  state.panel?.querySelectorAll(".promptstudio-mode-control input, .promptstudio-generation-action input, .promptstudio-workflow-routing select, .promptstudio-settings input, .promptstudio-settings select, .promptstudio-settings textarea, .promptstudio-resolution-details input, .promptstudio-resolution-details select, .promptstudio-current-details textarea, .promptstudio-secondary-details textarea, #promptstudio-kobold-url")
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
  refreshLatestImageContextControl();
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

function closeGenerationFailureDialog({ clearRetry = true, restoreFocus = true } = {}) {
  const dialog = state.panel?.querySelector("#promptstudio-generation-failure-dialog");
  if (!dialog || dialog.hidden) return;
  dialog.hidden = true;
  if (clearRetry) state.generationRetry = null;
  if (restoreFocus) state.generationFailureTrigger?.focus({ preventScroll: true });
  state.generationFailureTrigger = null;
}

function showGenerationFailure(message, retry) {
  const text = String(message || "Generation failed.");
  state.generating = false;
  state.queueing = false;
  setBusy(false);
  setStatus(text, "error");
  const dialog = state.panel?.querySelector("#promptstudio-generation-failure-dialog");
  if (!dialog) return;
  state.generationRetry = typeof retry === "function" ? retry : null;
  state.generationFailureTrigger = state.panel.ownerDocument.activeElement;
  dialog.querySelector("#promptstudio-generation-failure-message").textContent = text;
  dialog.hidden = false;
  dialog.querySelector("#promptstudio-generation-failure-retry").focus({ preventScroll: true });
}

function generationRetryOptionsFromMessage(message) {
  if (!message) return null;
  return {
    action: message.generationAction || "create",
    executionPrompt: message.executionPrompt || message.canonicalPrompt || "",
    mainPrompt: message.mainPrompt || "",
    finalPrompt: message.canonicalPrompt || "",
    preserveSeed: true,
    workflowProfileId: message.workflowProfileId || null,
    loraState: message.loraState,
    modelState: message.modelState,
    generationSnapshot: message.generationSnapshot,
    workflowName: message.workflowName || "",
    sourceImage: message.sourceImage || null,
    upscaleFactor: message.upscaleFactor ?? null,
    resultNodeIds: message.resultNodeIds,
    resultFields: message.resultFields,
  };
}

async function retryGeneration(options) {
  if (state.busy || !options) return;
  closeGenerationFailureDialog({ restoreFocus: false });
  state.operationToken += 1;
  setBusy(true);
  setStatus("Retrying generation...", "working");
  try {
    await queueGeneration(options);
  } catch (error) {
    const message = error.message || String(error);
    showGenerationFailure(message, () => retryGeneration(options));
  }
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
  if (value.type === "promptstudio") {
    return `/promptstudio/prompt-studio/image?filename=${encodeURIComponent(value.filename)}`;
  }
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

function latestGeneratedImage(chat = activeChat()) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message?.generationState !== "complete") continue;
    const images = Array.isArray(message.images) ? message.images : [];
    for (let imageIndex = images.length - 1; imageIndex >= 0; imageIndex -= 1) {
      const reference = normalizeImageReference(images[imageIndex]);
      if (reference) return reference;
    }
  }
  return null;
}

function refreshLatestImageContextControl() {
  const control = state.panel?.querySelector("#promptstudio-latest-image-context-control");
  const input = state.panel?.querySelector("#promptstudio-use-latest-image-context");
  if (!control || !input) return;
  const image = latestGeneratedImage();
  input.disabled = state.busy || !image;
  control.dataset.available = image ? "true" : "false";
  control.title = image
    ? `Send ${image.filename} with prompt-revision requests. Requires a vision-capable local model.`
    : "Generate an image in this session before using it as LLM context.";
}

function editingSource(sourceImage = null) {
  return normalizeImageReference(sourceImage)
    || normalizeImageReference(activeChat()?.selectedSource)
    || latestConversationImage();
}

function restoreStoredCanonicalPrompt(data) {
  const finalPrompt = String(data?.canonicalPrompt || "");
  if (!finalPrompt.trim()) return false;
  const mainPrompt = String(data?.mainPrompt || finalPrompt);
  const previousVersion = state.versions[state.versionIndex];
  const chat = activeChat();
  if (chat) {
    chat.initialized = true;
    chat.controlsFingerprint = data.llmAmplified ? String(data.controlsFingerprint || "") : "";
    chat.mainPromptDirty = false;
    chat.pendingGeneration = null;
  }
  updatePromptEditors(mainPrompt, finalPrompt);
  const restoredVersion = promptVersion(mainPrompt, finalPrompt);
  if (!promptVersionsEqual(previousVersion, restoredVersion)) pushVersion();
  else syncActiveChat();
  updateComposeMode();
  return true;
}

function restoreStoredLoraState(data) {
  const storedState = normalizeGenerationLoraState(data?.loraState);
  const profileId = String(data?.workflowProfileId || "");
  if (storedState === null || !profileId) return false;
  const profile = workflowProfileById(profileId);
  const validNodeIds = new Set(
    (Array.isArray(profile?.loraNodes) ? profile.loraNodes : [])
      .map((descriptor) => String(descriptor?.id || "").trim())
      .filter(Boolean),
  );
  const restorable = storedState.filter((entry) => validNodeIds.has(entry.nodeId));
  if (!restorable.length) return false;
  let changed = false;
  for (const entry of restorable) {
    const key = loraSelectionKey(profileId, entry.nodeId);
    const current = selectionsForLoraNode(profileId, entry.nodeId);
    if (JSON.stringify(current) === JSON.stringify(entry.selections)) continue;
    changed = true;
    if (entry.selections.length) state.loraSelections[key] = entry.selections;
    else delete state.loraSelections[key];
  }
  if (changed) saveLoraSelections();
  if (selectedWorkflowProfileId() === profileId) refreshLoraSection();
  return true;
}

function restoreStoredModelState(data) {
  const storedState = normalizeGenerationModelState(data?.modelState);
  const profileId = String(data?.workflowProfileId || "");
  if (storedState === null || !profileId) return false;
  const profile = workflowProfileById(profileId);
  const validNodeIds = new Set(
    (Array.isArray(profile?.modelNodes) ? profile.modelNodes : [])
      .map((descriptor) => String(descriptor?.id || "").trim())
      .filter(Boolean),
  );
  const restorable = storedState.filter((entry) => validNodeIds.has(entry.nodeId));
  if (!restorable.length) return false;
  let changed = false;
  for (const entry of restorable) {
    const key = modelSelectionKey(profileId, entry.nodeId);
    if (String(state.modelSelections[key] || "") === entry.modelName) continue;
    state.modelSelections[key] = entry.modelName;
    changed = true;
  }
  if (changed) saveModelSelections();
  if (selectedWorkflowProfileId() === profileId) refreshModelSection();
  return true;
}

function restoreStoredGenerationRouting(data) {
  const action = data?.generationAction === "edit" ? "edit" : data?.generationAction === "create" ? "create" : "";
  const profileId = String(data?.workflowProfileId || "");
  const profile = workflowProfileById(profileId);
  if (!action || !profile || profile.kind !== action) return false;
  const actionControl = state.panel?.querySelector(
    `input[name="promptstudio-generation-action"][value="${action}"]`,
  );
  const workflowControl = state.panel?.querySelector(
    action === "edit" ? "#promptstudio-edit-workflow" : "#promptstudio-create-workflow",
  );
  if (!actionControl || !workflowControl || ![...workflowControl.options].some((option) => option.value === profileId)) {
    return false;
  }
  actionControl.checked = true;
  workflowControl.value = profileId;
  updateComposeMode();
  refreshSecondaryInstructionsControl();
  refreshLoraSection();
  refreshModelSection();
  syncActiveChat();
  return true;
}

function armStoredGenerationReplay(data) {
  const generationSnapshot = normalizeGenerationSnapshot(data?.generationSnapshot);
  const chat = activeChat();
  const action = data?.generationAction === "edit" ? "edit" : data?.generationAction === "create" ? "create" : "";
  const workflowProfileId = String(data?.workflowProfileId || "");
  if (!chat || !generationSnapshot || !action
      || selectedAction() !== action || selectedWorkflowProfileId(action) !== workflowProfileId) {
    return false;
  }
  chat.pendingGeneration = {
    action,
    mainPrompt: String(data?.mainPrompt || data?.canonicalPrompt || ""),
    canonicalPrompt: String(data?.canonicalPrompt || ""),
    executionPrompt: String(data?.executionPrompt || data?.canonicalPrompt || ""),
    workflowProfileId,
    workflowName: String(data?.workflowName || ""),
    loraState: normalizeGenerationLoraState(data?.loraState),
    modelState: normalizeGenerationModelState(data?.modelState),
    generationSnapshot,
    replayFingerprint: "",
    sourceImage: normalizeImageReference(data?.sourceImage),
    upscaleFactor: data?.upscaleFactor ?? null,
    resultNodeIds: Array.isArray(data?.resultNodeIds) ? data.resultNodeIds.map(String) : [],
    resultFields: Array.isArray(data?.resultFields) && data.resultFields.length
      ? data.resultFields.map(String)
      : ["images", "gifs"],
  };
  if (action === "edit" && chat.pendingGeneration.sourceImage) {
    chat.selectedSource = chat.pendingGeneration.sourceImage;
    refreshRenderedImageSources();
  }
  chat.pendingGeneration.replayFingerprint = generationUiFingerprint();
  chat.updatedAt = Date.now();
  saveChats();
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
  const loraRestored = restoreStoredLoraState(generationData);
  const modelRestored = restoreStoredModelState(generationData);
  const restoredSelections = [
    modelRestored ? "model" : "",
    loraRestored ? "LoRAs" : "",
  ].filter(Boolean).join(" and ");
  const restoredSuffix = restoredSelections ? ` and ${restoredSelections}` : "";
  saveChats();
  refreshRenderedImageSources();
  updateComposeMode();
  if (promptRestored && controlsNeedApply()) {
    setStatus(
      `Selected ${value.filename} and restored its prompt${restoredSuffix}. ${llmProviderName()} will apply the current controls before generation.`,
      "warning",
    );
  } else {
    setStatus(
      promptRestored
        ? `Selected ${value.filename} as the editing source and restored its main and final prompts${restoredSuffix}.`
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
  const routingRestored = restoreStoredGenerationRouting(data);
  const loraRestored = restoreStoredLoraState(data);
  const modelRestored = restoreStoredModelState(data);
  const restoredSelections = [
    modelRestored ? "model" : "",
    loraRestored ? "LoRAs" : "",
  ].filter(Boolean).join(" and ");
  const restoredSuffix = restoredSelections ? ` and ${restoredSelections}` : "";
  const generationRestored = routingRestored && armStoredGenerationReplay(data);
  details.open = false;
  if (generationRestored) {
    setStatus(
      "Prompts, model, LoRAs, and the complete generation state were restored. Generate without changes to repeat the exact queued parameters.",
      "ready",
    );
  } else if (controlsNeedApply()) {
    setStatus(
      `Prompts${restoredSuffix} restored. ${llmProviderName()} will rebuild the final prompt with the current controls before generation.`,
      "warning",
    );
  } else {
    setStatus(`Main and final prompts${restoredSuffix} restored from this generation.`, "ready");
  }
}

function appendStoredGenerationInfo(panel, data) {
  const workflowHeading = document.createElement("strong");
  workflowHeading.textContent = "Generation";
  const workflowText = document.createElement("div");
  workflowText.className = "promptstudio-prompt-info-text promptstudio-generation-overview";
  const action = data.generationAction === "edit"
    ? "Edit"
    : data.generationAction === "upscale" ? "Upscale" : "Create";
  workflowText.textContent = [
    `Action: ${action}`,
    `Workflow: ${data.workflowName || data.workflowProfileId || "Unknown"}`,
    data.promptId ? `ComfyUI prompt ID: ${data.promptId}` : "",
    data.sourceImage?.filename ? `Source image: ${data.sourceImage.filename}` : "",
    data.upscaleFactor != null ? `Upscale factor: ${data.upscaleFactor}` : "",
    ...(Array.isArray(data.images) ? data.images : []).map((image) => (
      `Output: ${image.filename}${image.width && image.height ? ` (${image.width} × ${image.height})` : ""}`
    )),
  ].filter(Boolean).join("\n");
  panel.append(workflowHeading, workflowText);

  const modelHeading = document.createElement("strong");
  modelHeading.textContent = "Models";
  const modelPanel = document.createElement("div");
  modelPanel.className = "promptstudio-generation-loras";
  const modelState = normalizeGenerationModelState(data.modelState);
  if (modelState?.length) {
    for (const loader of modelState) {
      const group = document.createElement("div");
      group.className = "promptstudio-generation-lora-loader";
      const label = document.createElement("b");
      label.textContent = `${loader.modelType || "Model loader"} · node ${loader.nodeId}`;
      const model = document.createElement("span");
      model.textContent = loader.modelName;
      group.append(label, model);
      modelPanel.appendChild(group);
    }
  } else {
    modelPanel.textContent = modelState === null
      ? "Not recorded for this older generation."
      : "This workflow had no Prompt Studio Model loaders.";
  }
  panel.append(modelHeading, modelPanel);

  const loraHeading = document.createElement("strong");
  loraHeading.textContent = "LoRAs";
  const loraPanel = document.createElement("div");
  loraPanel.className = "promptstudio-generation-loras";
  const loraState = normalizeGenerationLoraState(data.loraState);
  if (loraState?.length) {
    for (const loader of loraState) {
      const group = document.createElement("div");
      group.className = "promptstudio-generation-lora-loader";
      const label = document.createElement("b");
      label.textContent = `${loader.loraType || "LoRA loader"} · node ${loader.nodeId}`;
      group.appendChild(label);
      if (loader.selections.length) {
        const list = document.createElement("ul");
        for (const selection of loader.selections) {
          const item = document.createElement("li");
          item.textContent = `${selection.name} — strength ${selection.strength}`;
          list.appendChild(item);
        }
        group.appendChild(list);
      } else {
        const empty = document.createElement("span");
        empty.textContent = "No LoRAs selected";
        group.appendChild(empty);
      }
      loraPanel.appendChild(group);
    }
  } else {
    loraPanel.textContent = loraState === null
      ? "Not recorded for this older generation."
      : "This workflow had no Prompt Studio LoRA loaders.";
  }
  panel.append(loraHeading, loraPanel);

  const parametersHeading = document.createElement("strong");
  parametersHeading.textContent = "All workflow inputs";
  const parameters = document.createElement("div");
  parameters.className = "promptstudio-generation-parameters";
  const snapshot = normalizeGenerationSnapshot(data.generationSnapshot);
  const nodes = Object.entries(snapshot?.output || {});
  if (!nodes.length) {
    parameters.textContent = "Not recorded for this older generation.";
  } else {
    for (const [nodeId, node] of nodes) {
      const nodeDetails = document.createElement("details");
      nodeDetails.className = "promptstudio-generation-node";
      const summary = document.createElement("summary");
      const title = String(node?._meta?.title || node?.class_type || "Workflow node");
      summary.textContent = `${title} · node ${nodeId}`;
      const nodeType = document.createElement("div");
      nodeType.className = "promptstudio-generation-node-type";
      nodeType.textContent = `Class: ${String(node?.class_type || "Unknown")}`;
      const inputs = document.createElement("pre");
      inputs.textContent = JSON.stringify(node?.inputs || {}, null, 2);
      nodeDetails.append(summary, nodeType, inputs);
      parameters.appendChild(nodeDetails);
    }
  }
  panel.append(parametersHeading, parameters);
}

function renderPromptInfo(message, data) {
  if (!message || !data?.canonicalPrompt || !data.images?.length || message.querySelector(".promptstudio-prompt-info")) return;
  message.classList.add("promptstudio-has-prompt");
  const details = document.createElement("details");
  details.className = "promptstudio-prompt-info";
  const summary = document.createElement("summary");
  summary.textContent = "i";
  summary.title = "Show prompts and all workflow inputs used for this generation";
  summary.setAttribute("aria-label", summary.title);
  const panel = document.createElement("div");
  panel.className = "promptstudio-prompt-info-panel";
  const heading = document.createElement("strong");
  heading.textContent = "Main prompt";
  const text = document.createElement("div");
  text.className = "promptstudio-prompt-info-text";
  text.textContent = data.mainPrompt || data.canonicalPrompt;
  const finalHeading = document.createElement("strong");
  finalHeading.textContent = "Final prompt used";
  const finalText = document.createElement("div");
  finalText.className = "promptstudio-prompt-info-text";
  finalText.textContent = data.canonicalPrompt;
  const usePrompt = document.createElement("button");
  usePrompt.type = "button";
  usePrompt.dataset.disableBusy = "";
  usePrompt.disabled = state.busy;
  usePrompt.textContent = "Use these prompts";
  usePrompt.addEventListener("click", () => useStoredCanonicalPrompt(data, details));
  panel.append(heading, text, finalHeading, finalText);
  if (data.executionPrompt && data.executionPrompt !== data.canonicalPrompt) {
    const executionHeading = document.createElement("strong");
    executionHeading.textContent = "Workflow execution prompt";
    const executionText = document.createElement("div");
    executionText.className = "promptstudio-prompt-info-text";
    executionText.textContent = data.executionPrompt;
    panel.append(executionHeading, executionText);
  }
  appendStoredGenerationInfo(panel, data);
  panel.append(usePrompt);
  details.append(summary, panel);
  message.appendChild(details);
}

function renderGenerationProgress(message, data) {
  if (!message) return;
  message.querySelector(".promptstudio-generation-progress")?.remove();
  if (!["queued", "generating"].includes(data?.generationState)) return;

  const progress = state.generationProgress.get(String(data.promptId || ""));
  const value = Number(progress?.value);
  const max = Number(progress?.max);
  const determinate = Number.isFinite(value) && Number.isFinite(max) && max > 0;
  const percent = determinate ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : null;
  const statusText = progress?.phase === "finalizing"
    ? "Finalizing…"
    : data.generationAction === "upscale"
      ? "Upscaling…"
      : "Generating…";

  const container = document.createElement("div");
  container.className = "promptstudio-generation-progress";
  container.setAttribute("aria-live", "polite");

  const status = document.createElement("div");
  status.className = "promptstudio-generation-progress-status";
  const label = document.createElement("span");
  label.textContent = statusText;
  const amount = document.createElement("span");
  amount.className = "promptstudio-generation-progress-amount";
  amount.textContent = percent == null ? "" : `${percent}%`;
  status.append(label, amount);

  const track = document.createElement("div");
  track.className = "promptstudio-generation-progress-track";
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-label", statusText);
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  if (percent == null) {
    track.dataset.indeterminate = "true";
  } else {
    track.setAttribute("aria-valuenow", String(percent));
  }
  const fill = document.createElement("span");
  fill.className = "promptstudio-generation-progress-fill";
  if (percent != null) fill.style.width = `${percent}%`;
  track.appendChild(fill);
  container.append(status, track);
  message.appendChild(container);
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
  renderGenerationProgress(message, data);
  renderImageGallery(message, data.images, data);
  renderPromptInfo(message, data);

  history.appendChild(message);
  if (scroll) history.scrollTop = history.scrollHeight;
  return message;
}

function appendMessage(role, text, options = {}) {
  const now = Date.now();
  const data = {
    id: makeId(),
    role,
    text: String(text || ""),
    label: options.label || "",
    images: Array.isArray(options.images) ? options.images.map(normalizeImageReference).filter(Boolean) : [],
    mainPrompt: String(options.mainPrompt || options.canonicalPrompt || ""),
    canonicalPrompt: String(options.canonicalPrompt || ""),
    controlsFingerprint: String(options.controlsFingerprint || ""),
    llmAmplified: Boolean(options.llmAmplified),
    executionPrompt: String(options.executionPrompt || options.canonicalPrompt || ""),
    generationAction: ["edit", "upscale"].includes(options.generationAction) ? options.generationAction : "create",
    workflowProfileId: String(options.workflowProfileId || ""),
    workflowName: String(options.workflowName || ""),
    loraState: normalizeGenerationLoraState(options.loraState),
    modelState: normalizeGenerationModelState(options.modelState),
    generationSnapshot: normalizeGenerationSnapshot(options.generationSnapshot),
    sourceImage: normalizeImageReference(options.sourceImage),
    upscaleFactor: options.upscaleFactor != null && Number.isFinite(Number(options.upscaleFactor))
      ? Number(options.upscaleFactor)
      : null,
    resultNodeIds: Array.isArray(options.resultNodeIds) ? options.resultNodeIds.map(String) : [],
    resultFields: Array.isArray(options.resultFields) && options.resultFields.length ? options.resultFields.map(String) : ["images", "gifs"],
    promptId: String(options.promptId || ""),
    generationState: ["queued", "generating", "complete", "error"].includes(options.generationState) ? options.generationState : "",
    createdAt: now,
    updatedAt: now,
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
    stored.updatedAt = Date.now();
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

function updateMainPromptEditor(prompt) {
  state.mainPrompt = prompt;
  const editor = state.panel?.querySelector("#promptstudio-main-prompt");
  if (editor) editor.value = prompt;
}

function updatePromptEditor(prompt) {
  state.currentPrompt = prompt;
  const editor = state.panel?.querySelector("#promptstudio-current-prompt");
  if (editor) editor.value = prompt;
}

function updatePromptEditors(mainPrompt, finalPrompt) {
  updateMainPromptEditor(mainPrompt);
  updatePromptEditor(finalPrompt);
}

function syncMainPromptEditor(prompt, { userEdit = false } = {}) {
  updateMainPromptEditor(prompt);
  const chat = activeChat();
  if (!chat) return;
  chat.mainPrompt = prompt;
  if (userEdit) {
    chat.mainPromptDirty = true;
    chat.pendingGeneration = null;
  }
  chat.updatedAt = Date.now();
  saveChats();
  refreshEmptyImageDropZone();
  if (!userEdit || !chat.initialized) return;
  if (!prompt.trim()) {
    setStatus("The main prompt is empty.", "warning");
  } else {
    setStatus(`Main prompt changed. ${llmProviderName()} will rebuild the final prompt before generation.`, "warning");
  }
}

function syncCanonicalEditor(prompt, { userEdit = false } = {}) {
  updatePromptEditor(prompt);
  const chat = activeChat();
  if (!chat) return;
  chat.finalPrompt = prompt;
  chat.currentPrompt = prompt;
  chat.initialized = Boolean(prompt.trim());
  if (userEdit) chat.pendingGeneration = null;
  chat.updatedAt = Date.now();
  saveChats();
  updateComposeMode();
}

function commitPromptEditorVersion() {
  const mainEditor = state.panel?.querySelector("#promptstudio-main-prompt");
  const editor = state.panel?.querySelector("#promptstudio-current-prompt");
  if (mainEditor && !mainEditor.readOnly) {
    const mainPrompt = mainEditor.value;
    syncMainPromptEditor(mainPrompt, { userEdit: mainPrompt !== state.mainPrompt });
  }
  if (editor && !editor.readOnly) {
    const prompt = editor.value;
    syncCanonicalEditor(prompt, { userEdit: prompt !== state.currentPrompt });
  }
  if (!promptVersionsEqual(state.versions[state.versionIndex], promptVersion())) pushVersion();
}

function pushVersion(finalPrompt = state.currentPrompt, mainPrompt = state.mainPrompt) {
  const version = promptVersion(mainPrompt, finalPrompt);
  if (promptVersionsEqual(state.versions[state.versionIndex], version)) {
    syncActiveChat();
    return;
  }
  state.versions = state.versions.slice(0, state.versionIndex + 1);
  state.versions.push(version);
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

async function loadOllamaModels({ announce = false } = {}) {
  const select = state.panel?.querySelector("#promptstudio-ollama-model");
  const button = state.panel?.querySelector("#promptstudio-refresh-ollama-models");
  const endpoint = state.panel?.querySelector("#promptstudio-ollama-url")?.value.trim();
  if (!select || !endpoint) return;
  const selected = select.value || getSettings().ollama_model;
  if (button) button.disabled = true;
  try {
    const response = await api.fetchApi("/promptstudio/prompt-studio/ollama-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ollama_url: endpoint }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Could not load Ollama models (${response.status}).`);
    const models = Array.isArray(data.models) ? data.models.map(String).filter(Boolean) : [];
    setOptions("promptstudio-ollama-model", models, selected);
    if (!models.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No local models found";
      select.appendChild(option);
    } else if (!models.includes(selected)) {
      select.value = models[0];
    }
    saveSettings();
    if (announce) setStatus(`Loaded ${models.length} Ollama model${models.length === 1 ? "" : "s"}.`, models.length ? "ready" : "warning");
  } catch (error) {
    if (announce) setStatus(error.message || String(error), "warning");
  } finally {
    if (button) button.disabled = false;
  }
}

function syncLlmProviderControls({ refreshModels = false } = {}) {
  const provider = selectedLlmProvider();
  state.panel?.querySelectorAll("[data-llm-provider]").forEach((element) => {
    element.hidden = element.dataset.llmProvider !== provider;
  });
  const help = state.panel?.querySelector("#promptstudio-llm-amplification-help");
  if (help) help.textContent = `Rewrite prompts through ${llmProviderName()}`;
  const thinking = state.panel?.querySelector("#promptstudio-thinking-control");
  if (thinking) thinking.title = provider === "ollama"
    ? "Controls Ollama thinking. Minimal and Low both request Ollama's low thinking level."
    : "Private-reasoning limits: Minimal 200 tokens, Low 500, Medium 1,000, and High uses the available context window.";
  const tokens = state.panel?.querySelector("#promptstudio-token-control");
  if (tokens) tokens.title = provider === "ollama"
    ? "Final-answer allowance. Ollama receives an additional thinking allowance; 0 uses the selected profile default."
    : "Final-answer allowance. KoboldCpp receives an additional native-reasoning budget; 0 uses the selected profile default.";
  if (refreshModels && provider === "ollama") loadOllamaModels({ announce: true });
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
  if (selectedLlmProvider() === "ollama") await loadOllamaModels({ announce: false });
}

function collectRevisionPayload(
  revision,
  mode = "revise",
  currentPrompt = state.currentPrompt,
  currentFinalPrompt = state.currentPrompt,
  contextImage = null,
) {
  const value = (id) => state.panel.querySelector(`#${id}`)?.value;
  const payload = {
    current_prompt: currentPrompt,
    current_final_prompt: currentFinalPrompt,
    revision,
    mode,
    llm_provider: value("promptstudio-llm-provider"),
    kobold_url: value("promptstudio-kobold-url"),
    ollama_url: value("promptstudio-ollama-url"),
    ollama_model: value("promptstudio-ollama-model"),
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
  const storedContextImage = storedImageReference(contextImage);
  if (storedContextImage) payload.context_image = storedContextImage;
  return payload;
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
  return latestGeneration.mainPrompt === state.mainPrompt
    && latestGeneration.canonicalPrompt === state.currentPrompt
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
  stored.updatedAt = Date.now();
  chat.updatedAt = stored.updatedAt;
  saveChats();
  renderChatList();
  if (!message.isConnected) renderChatHistory();
}

function messageElement(messageId) {
  return [...(state.panel?.querySelectorAll(".promptstudio-message") || [])]
    .find((message) => message.dataset.messageId === messageId) || null;
}

function pendingGenerationMessage(promptId) {
  const id = String(promptId || "");
  if (!id) return null;
  return (activeChat()?.messages || []).find((message) => (
    message.promptId === id && ["queued", "generating"].includes(message.generationState)
  )) || null;
}

function updateGenerationProgress(promptId, progress = {}) {
  const stored = pendingGenerationMessage(promptId);
  if (!stored) return;
  const id = String(promptId);
  const current = state.generationProgress.get(id) || {};
  state.generationProgress.set(id, { ...current, ...progress });
  const element = messageElement(stored.id);
  if (element) renderGenerationProgress(element, stored);
}

function setupGenerationProgressEvents() {
  const eventPromptId = (event) => String(
    event?.detail?.prompt_id || event?.detail?.promptId || state.activeGenerationPromptId || "",
  );
  api.addEventListener("execution_start", (event) => {
    updateGenerationProgress(eventPromptId(event), { phase: "generating" });
  });
  api.addEventListener("executing", (event) => {
    updateGenerationProgress(eventPromptId(event), {
      phase: event?.detail == null ? "finalizing" : "generating",
    });
  });
  api.addEventListener("progress", (event) => {
    updateGenerationProgress(eventPromptId(event), {
      phase: "generating",
      value: Number(event?.detail?.value),
      max: Number(event?.detail?.max),
    });
  });
  api.addEventListener("progress_state", (event) => {
    const running = Object.values(event?.detail?.nodes || {})
      .filter((node) => node?.state === "running");
    if (!running.length) return;
    updateGenerationProgress(eventPromptId(event), {
      phase: "generating",
      value: running.reduce((total, node) => total + Number(node?.value || 0), 0),
      max: running.reduce((total, node) => total + Number(node?.max || 0), 0),
    });
  });
  api.addEventListener("execution_success", (event) => {
    updateGenerationProgress(eventPromptId(event), { phase: "finalizing" });
  });
}

function setMessageGenerationState(message, generationState) {
  const chat = activeChat();
  const stored = chat?.messages.find((item) => item.id === message?.dataset.messageId);
  if (!stored) return;
  stored.generationState = generationState;
  if (!["queued", "generating"].includes(generationState)) {
    state.generationProgress.delete(stored.promptId);
    if (state.activeGenerationPromptId === stored.promptId) state.activeGenerationPromptId = "";
  }
  if (message?.isConnected) renderGenerationProgress(message, stored);
  stored.updatedAt = Date.now();
  chat.updatedAt = stored.updatedAt;
  saveChats();
  renderChatList();
  refreshLatestImageContextControl();
  if (!message?.isConnected) renderChatHistory();
}

function markGenerationAttemptFailed(message, text) {
  updateMessageText(message, text);
  setMessageGenerationState(message, "error");
}

function setConsultExperimentGeneration(messageId, variantId, generation) {
  const chat = activeChat();
  const message = chat?.consultMessages.find((item) => item.id === messageId);
  const variant = message?.variants?.find((item) => item.id === variantId);
  if (!chat || !message || !variant) return false;
  variant.generation = normalizeConsultExperimentGeneration(generation);
  if (selectedConsultVariant(message)?.id === variant.id) {
    message.generation = variant.generation;
  }
  message.updatedAt = Date.now();
  chat.updatedAt = message.updatedAt;
  saveChats();
  renderConsultHistory();
  return true;
}

function activeConsultAgent(chat = activeChat()) {
  return normalizeConsultAgent(chat?.consultAgent);
}

function promptAgentModeEnabled(chat = activeChat()) {
  return chat?.consultAgentMode === true;
}

function requestedPromptAgentIterations() {
  const requested = Number(state.panel?.querySelector("#promptstudio-agent-max-iterations")?.value);
  return Math.max(
    1,
    Math.min(
      PROMPT_AGENT_MAX_ITERATIONS,
      Math.trunc(requested || PROMPT_AGENT_DEFAULT_MAX_ITERATIONS),
    ),
  );
}

function promptAgentEffectiveGoal(agent) {
  const base = String(agent?.goal || "").trim();
  const feedback = (agent?.feedback || [])
    .map((item, index) => `Follow-up ${index + 1}: ${String(item?.text || "").trim()}`)
    .filter((item) => !item.endsWith(": "));
  if (!feedback.length) return base.slice(0, PROMPT_AGENT_MAX_GOAL_CHARS);
  const feedbackText = `\n\nApply these later user corrections as authoritative refinements:\n${feedback.join("\n")}`;
  if (base.length + feedbackText.length <= PROMPT_AGENT_MAX_GOAL_CHARS) return base + feedbackText;
  const baseBudget = Math.min(base.length, Math.floor(PROMPT_AGENT_MAX_GOAL_CHARS / 2));
  const feedbackBudget = PROMPT_AGENT_MAX_GOAL_CHARS - baseBudget - 2;
  return `${base.slice(0, baseBudget)}\n\n${feedbackText.slice(-feedbackBudget)}`;
}

function promptAgentIteration(agent, iterationId) {
  return agent?.iterations.find((item) => item.id === String(iterationId || "")) || null;
}

function updateConsultAgent(mutator, { immediate = false } = {}) {
  const chat = activeChat();
  const agent = activeConsultAgent(chat);
  if (!chat || !agent) return null;
  mutator(agent);
  agent.updatedAt = Date.now();
  chat.consultAgent = normalizeConsultAgent(agent);
  chat.updatedAt = agent.updatedAt;
  saveChats({ immediate });
  renderConsultHistory();
  updateConsultExperimentUi();
  return chat.consultAgent;
}

function setConsultAgentGeneration(iterationId, generation, status = "generating") {
  return updateConsultAgent((agent) => {
    const iteration = promptAgentIteration(agent, iterationId);
    if (!iteration) return;
    iteration.generation = normalizeConsultExperimentGeneration(generation);
    iteration.status = status;
    iteration.updatedAt = Date.now();
    agent.currentIterationId = iteration.id;
    agent.status = status === "generating" ? (iteration.validation ? "validating" : "generating") : agent.status;
  }, { immediate: true });
}

async function waitForConsultAgentResult(
  promptId,
  agentTarget,
  token,
  resultNodeIds = [],
  resultFields = ["images", "gifs"],
) {
  const started = Date.now();
  while (token === state.pollToken && Date.now() - started < 10 * 60 * 1000) {
    const response = await api.fetchApi(`/history/${encodeURIComponent(promptId)}`);
    if (token !== state.pollToken) return null;
    if (response.ok) {
      const history = await response.json();
      if (token !== state.pollToken) return null;
      const item = history?.[promptId];
      if (item) {
        const images = historyImages(item, resultNodeIds, resultFields);
        const completed = Boolean(item.status?.completed);
        const failure = generationFailureMessage(item);
        if (failure || images.length || completed) {
          const enrichedImages = await Promise.all(images.map(async (image) => {
            try {
              return await imageReferenceWithDimensions(image);
            } catch (_) {
              return normalizeImageReference(image);
            }
          }));
          const agent = activeConsultAgent();
          const iteration = promptAgentIteration(agent, agentTarget.iterationId);
          const current = normalizeConsultExperimentGeneration(iteration?.generation) || {};
          const generation = normalizeConsultExperimentGeneration({
            ...current,
            generationState: failure || !enrichedImages.length ? "error" : "complete",
            text: failure || (!enrichedImages.length ? "Generation completed without an image output." : ""),
            images: enrichedImages,
            updatedAt: Date.now(),
          });
          setConsultAgentGeneration(
            agentTarget.iterationId,
            generation,
            generation.generationState === "complete" ? "evaluating" : "error",
          );
          state.generationProgress.delete(String(promptId));
          if (state.activeGenerationPromptId === String(promptId)) state.activeGenerationPromptId = "";
          state.generating = false;
          state.consultAgentGenerationTarget = null;
          if (generation.generationState !== "complete") throw new Error(generation.text);
          return generation;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  if (token !== state.pollToken) return null;
  throw new Error("Stopped waiting for the Prompt Agent generation result.");
}

async function waitForConsultExperimentResult(
  promptId,
  consultTarget,
  token,
  resultNodeIds = [],
  resultFields = ["images", "gifs"],
) {
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
        const failure = generationFailureMessage(item);
        if (failure || images.length || completed) {
          const chat = activeChat();
          const message = chat?.consultMessages.find((entry) => entry.id === consultTarget.messageId);
          const variant = message?.variants?.find((entry) => entry.id === consultTarget.variantId);
          const current = normalizeConsultExperimentGeneration(variant?.generation) || {};
          const enrichedImages = await Promise.all(images.map(async (image) => {
            try {
              return await imageReferenceWithDimensions(image);
            } catch (_) {
              return normalizeImageReference(image);
            }
          }));
          const generation = {
            ...current,
            generationState: failure || !enrichedImages.length ? "error" : "complete",
            text: failure || (!enrichedImages.length ? "Generation completed without an image output." : ""),
            images: enrichedImages,
            updatedAt: Date.now(),
          };
          setConsultExperimentGeneration(consultTarget.messageId, consultTarget.variantId, generation);
          state.generationProgress.delete(String(promptId));
          if (state.activeGenerationPromptId === String(promptId)) state.activeGenerationPromptId = "";
          state.generating = false;
          state.consultGenerationTarget = null;
          setBusy(false);
          setConsultBusy(false);
          if (generation.generationState === "complete") {
            setConsultStatus(`Generated ${enrichedImages.length} experimental image${enrichedImages.length === 1 ? "" : "s"}.`, "ready");
          } else {
            setConsultStatus(generation.text, "error");
          }
          return;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  if (token === state.pollToken) {
    const chat = activeChat();
    const message = chat?.consultMessages.find((entry) => entry.id === consultTarget.messageId);
    const variant = message?.variants?.find((entry) => entry.id === consultTarget.variantId);
    const current = normalizeConsultExperimentGeneration(variant?.generation) || {};
    setConsultExperimentGeneration(consultTarget.messageId, consultTarget.variantId, {
      ...current,
      generationState: "error",
      text: "Stopped waiting for the experimental generation result.",
      updatedAt: Date.now(),
    });
    state.generating = false;
    state.consultGenerationTarget = null;
    setBusy(false);
    setConsultBusy(false);
    setConsultStatus("Stopped waiting for the experimental generation result.", "error");
  }
}

function resumeSyncedGeneration() {
  if (state.busy || state.generating || !state.panel) return;
  const agent = activeConsultAgent();
  if (agent?.active && agent.status !== "paused") {
    if (!state.workflowStoreLoaded) return;
    runConsultAgent(agent.id);
    return;
  }
  const pending = [...(activeChat()?.messages || [])]
    .reverse()
    .find((message) => ["queued", "generating"].includes(message.generationState) && message.promptId);
  if (!pending) {
    const consultMessages = [...(activeChat()?.consultMessages || [])].reverse();
    for (const message of consultMessages) {
      const variants = [...(message?.variants || [])].reverse();
      const variant = variants.find((item) => (
        ["queued", "generating"].includes(item?.generation?.generationState)
        && item.generation.promptId
      ));
      if (!variant) continue;
      const generation = normalizeConsultExperimentGeneration(variant.generation);
      const target = { messageId: message.id, variantId: variant.id, promptId: generation.promptId };
      state.generating = true;
      state.activeGenerationPromptId = generation.promptId;
      state.consultGenerationTarget = target;
      setBusy(true);
      setConsultBusy(true);
      setConsultStatus(`Following experimental generation ${generation.promptId.slice(0, 8)}…`, "working");
      const token = ++state.pollToken;
      waitForConsultExperimentResult(
        generation.promptId,
        target,
        token,
        generation.resultNodeIds,
        generation.resultFields,
      ).catch((error) => {
        if (token !== state.pollToken) return;
        setConsultExperimentGeneration(message.id, variant.id, {
          ...generation,
          generationState: "error",
          text: error.message || String(error),
          updatedAt: Date.now(),
        });
        state.generating = false;
        state.consultGenerationTarget = null;
        setBusy(false);
        setConsultBusy(false);
        setConsultStatus(error.message || String(error), "error");
      });
      return;
    }
    return;
  }
  const targetMessage = [...state.panel.querySelectorAll(".promptstudio-message")]
    .find((message) => message.dataset.messageId === pending.id);
  if (!targetMessage) return;
  state.generating = true;
  state.activeGenerationPromptId = pending.promptId;
  setBusy(true);
  setStatus(`Following synced generation ${pending.promptId.slice(0, 8)}…`, "working");
  const token = ++state.pollToken;
  const retryOptions = generationRetryOptionsFromMessage(pending);
  waitForResult(pending.promptId, targetMessage, token, pending.resultNodeIds, pending.resultFields, retryOptions).catch((error) => {
    if (token !== state.pollToken) return;
    const message = error.message || String(error);
    markGenerationAttemptFailed(targetMessage, message);
    showGenerationFailure(message, retryOptions ? () => retryGeneration(retryOptions) : null);
  });
}

async function waitForResult(
  promptId,
  targetMessage,
  token,
  resultNodeIds = [],
  resultFields = ["images", "gifs"],
  retryOptions = null,
) {
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
            setMessageGenerationState(targetMessage, "error");
            showGenerationFailure(failureMessage, retryOptions ? () => retryGeneration(retryOptions) : null);
          } else if (images.length) {
            updateMessageText(targetMessage, "");
            setMessageGenerationState(targetMessage, "complete");
            setStatus(`Generated ${images.length} image${images.length === 1 ? "" : "s"}.`, "ready");
          } else {
            const message = "Generation completed without an image output.";
            updateMessageText(targetMessage, message);
            setMessageGenerationState(targetMessage, "error");
            showGenerationFailure(message, retryOptions ? () => retryGeneration(retryOptions) : null);
          }
          if (!failureMessage && images.length) {
            setBusy(false);
            state.generating = false;
          }
          return;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  if (token === state.pollToken) {
    const message = "Stopped waiting for the generation result.";
    markGenerationAttemptFailed(targetMessage, message);
    showGenerationFailure(message, retryOptions ? () => retryGeneration(retryOptions) : null);
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
    loraNodes: selectedProfile.loraNodes,
    modelNodes: selectedProfile.modelNodes,
    resultNodeIds: selectedProfile.resultNodeIds,
    resultFields: selectedProfile.resultFields,
    workflowName: selectedProfile.name,
  };
}

async function queueGeneration({
  action = selectedAction(),
  executionPrompt = state.currentPrompt,
  mainPrompt = state.mainPrompt,
  finalPrompt = state.currentPrompt,
  preserveSeed = false,
  forceNewSeed = false,
  alwaysNewSeed = false,
  workflowProfileId = null,
  loraState = null,
  modelState = null,
  generationSnapshot = null,
  workflowName = "",
  sourceImage = null,
  upscaleFactor = null,
  resultNodeIds = null,
  resultFields = null,
  consultTarget = null,
  agentTarget = null,
} = {}) {
  if (!state.apiConnected) throw new Error("ComfyUI is disconnected. Wait for it to reconnect before generating.");
  const operationToken = state.operationToken;
  let source = action === "create" ? null : editingSource(sourceImage);
  if (action !== "create" && !source) throw new Error(`There is no image in this conversation to ${action}.`);
  const context = await workflowQueueContext(action, workflowProfileId);
  if (operationToken !== state.operationToken) return false;
  const storedGenerationSnapshot = normalizeGenerationSnapshot(generationSnapshot);
  if (generationSnapshot != null && !storedGenerationSnapshot) {
    throw new Error("The stored generation snapshot is invalid.");
  }
  const replayExactGeneration = Boolean(storedGenerationSnapshot);
  if (replayExactGeneration) {
    context.snapshot.output = structuredClone(storedGenerationSnapshot.output);
  }
  if (action === "edit") {
    try {
      source = await imageReferenceWithDimensions(source);
    } catch (error) {
      throw new Error(`Prompt Studio could not preserve the editing source size: ${error.message || String(error)}`);
    }
  }
  if (operationToken !== state.operationToken) return false;
  const useNewSeed = alwaysNewSeed || (
    (forceNewSeed || (!preserveSeed && generationMatchesLatestQueuedPrompt()))
    && state.panel.querySelector("#promptstudio-randomize-seed")?.checked
  );
  if (!replayExactGeneration && useNewSeed) randomizeSnapshotSeeds(context.snapshot);

  const secondaryInstructions = state.panel.querySelector("#promptstudio-secondary-instructions")?.value || "";
  if (!replayExactGeneration && action !== "upscale") {
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

  if (!replayExactGeneration && action === "edit") {
    const imageNode = context.snapshot.output?.[String(context.imageNodeId)];
    if (!imageNode || imageNode.class_type !== IMAGE_SOURCE_TYPE) {
      throw new Error("The configured Prompt Studio Image Source node was not included in the editing workflow.");
    }
    imageNode.inputs.image_ref = JSON.stringify(storedImageReference(source));
  } else if (!replayExactGeneration && action === "upscale") {
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

  const requestedLoraState = normalizeGenerationLoraState(loraState);
  const queuedLoraState = replayExactGeneration && requestedLoraState !== null
    ? requestedLoraState
    : generationLoraState(context.profile, context.loraNodes)
      .map((entry) => {
        const requested = requestedLoraState?.find((item) => item.nodeId === entry.nodeId);
        return requested ? { ...entry, selections: requested.selections } : entry;
      });
  for (const descriptor of replayExactGeneration ? [] : (context.loraNodes || [])) {
    const loraNode = context.snapshot.output?.[String(descriptor.id)];
    if (!loraNode || loraNode.class_type !== LORA_LOADER_TYPE) {
      throw new Error("A configured Prompt Studio LoRA Loader was not included in the executable workflow.");
    }
    loraNode.inputs ||= {};
    const storedState = queuedLoraState.find((entry) => entry.nodeId === String(descriptor.id));
    loraNode.inputs.lora_stack_json = JSON.stringify(
      storedState?.selections || [],
    );
  }

  const requestedModelState = normalizeGenerationModelState(modelState);
  const queuedModelState = replayExactGeneration
    ? requestedModelState ?? (context.modelNodes || []).map((descriptor) => ({
      nodeId: String(descriptor.id),
      modelType: String(descriptor.modelType || "").trim(),
      modelName: String(
        context.snapshot.output?.[String(descriptor.id)]?.inputs?.unet_name || "",
      ).trim(),
    })).filter((entry) => entry.modelName)
    : generationModelState(context.profile, context.modelNodes)
      .map((entry) => requestedModelState?.find((item) => item.nodeId === entry.nodeId) || entry);
  for (const descriptor of context.modelNodes || []) {
    const modelNode = context.snapshot.output?.[String(descriptor.id)];
    if (!modelNode || modelNode.class_type !== MODEL_LOADER_TYPE) {
      throw new Error("A configured Prompt Studio Model Loader was not included in the executable workflow.");
    }
    const storedState = queuedModelState.find((entry) => entry.nodeId === String(descriptor.id));
    if (!storedState?.modelName) {
      throw new Error(`Select a diffusion model for Prompt Studio Model Loader node ${descriptor.id}.`);
    }
    if (descriptor.modelType) {
      const catalog = await loadModelCatalog(descriptor.modelType);
      const canonical = catalog.find((item) => modelNameKey(item.name) === modelNameKey(storedState.modelName));
      if (!canonical) {
        throw new Error(
          `Diffusion model '${storedState.modelName}' is not available in the `
          + `'${descriptor.modelType}' Model Type folder.`,
        );
      }
      storedState.modelName = canonical.name;
      if (selectionForModelNode(context.profile.id, descriptor) !== canonical.name) {
        setSelectionForModelNode(context.profile.id, descriptor.id, canonical.name);
      }
    }
    modelNode.inputs ||= {};
    modelNode.inputs.unet_name = storedState.modelName;
  }

  if (operationToken !== state.operationToken) return false;
  const queuedGenerationSnapshot = normalizeGenerationSnapshot(structuredClone(context.snapshot));
  const queuedResultNodeIds = replayExactGeneration && Array.isArray(resultNodeIds) && resultNodeIds.length
    ? resultNodeIds.map(String)
    : context.resultNodeIds;
  const queuedResultFields = replayExactGeneration && Array.isArray(resultFields) && resultFields.length
    ? resultFields.map(String)
    : context.resultFields;
  const queuedWorkflowName = String(workflowName || context.workflowName);

  const retryOptions = {
    action,
    executionPrompt,
    mainPrompt,
    finalPrompt,
    preserveSeed,
    workflowProfileId: context.profile?.id || workflowProfileId,
    loraState: queuedLoraState,
    modelState: queuedModelState,
    generationSnapshot: queuedGenerationSnapshot,
    workflowName: queuedWorkflowName,
    sourceImage: source,
    upscaleFactor,
    resultNodeIds: queuedResultNodeIds,
    resultFields: queuedResultFields,
  };

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
  if (agentTarget?.agentId && agentTarget?.iterationId) {
    const generation = normalizeConsultExperimentGeneration({
      promptId,
      generationState: "generating",
      mainPrompt,
      finalPrompt,
      executionPrompt,
      generationAction: action,
      workflowProfileId: context.profile?.id || "",
      workflowName: queuedWorkflowName,
      loraState: queuedLoraState,
      modelState: queuedModelState,
      generationSnapshot: queuedGenerationSnapshot,
      sourceImage: source,
      resultNodeIds: queuedResultNodeIds,
      resultFields: queuedResultFields,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    setConsultAgentGeneration(agentTarget.iterationId, generation, "generating");
    state.activeGenerationPromptId = promptId;
    state.consultAgentGenerationTarget = { ...agentTarget, promptId };
    state.generating = true;
    const token = ++state.pollToken;
    return waitForConsultAgentResult(
      promptId,
      agentTarget,
      token,
      queuedResultNodeIds,
      queuedResultFields,
    );
  }
  if (consultTarget?.messageId && consultTarget?.variantId) {
    const generation = normalizeConsultExperimentGeneration({
      promptId,
      generationState: "generating",
      mainPrompt,
      finalPrompt,
      executionPrompt,
      generationAction: action,
      workflowProfileId: context.profile?.id || "",
      workflowName: queuedWorkflowName,
      loraState: queuedLoraState,
      modelState: queuedModelState,
      generationSnapshot: queuedGenerationSnapshot,
      sourceImage: source,
      resultNodeIds: queuedResultNodeIds,
      resultFields: queuedResultFields,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    setConsultExperimentGeneration(consultTarget.messageId, consultTarget.variantId, generation);
    state.activeGenerationPromptId = promptId;
    state.consultGenerationTarget = { ...consultTarget, promptId };
    state.generating = true;
    const token = ++state.pollToken;
    waitForConsultExperimentResult(
      promptId,
      consultTarget,
      token,
      queuedResultNodeIds,
      queuedResultFields,
    ).catch((error) => {
      if (token !== state.pollToken) return;
      const failed = { ...generation, generationState: "error", text: error.message || String(error), updatedAt: Date.now() };
      setConsultExperimentGeneration(consultTarget.messageId, consultTarget.variantId, failed);
      state.generating = false;
      state.consultGenerationTarget = null;
      setBusy(false);
      setConsultBusy(false);
      setConsultStatus(failed.text, "error");
    });
    return true;
  }
  const chat = activeChat();
  if (chat) {
    if (action === "edit") chat.selectedSource = source;
    chat.lastGeneration = {
      action,
      mainPrompt,
      canonicalPrompt: finalPrompt,
      executionPrompt,
      workflowProfileId: context.profile?.id || "",
      sourceImage: source,
    };
    chat.pendingGeneration = null;
    chat.updatedAt = Date.now();
    saveChats();
  }
  state.activeGenerationPromptId = promptId;
  state.generationProgress.set(promptId, { phase: "generating" });
  const resultMessage = appendMessage("assistant", "", {
    label: "ComfyUI",
    mainPrompt,
    canonicalPrompt: finalPrompt,
    executionPrompt,
    generationAction: action,
    workflowProfileId: context.profile?.id || "",
    workflowName: queuedWorkflowName,
    loraState: queuedLoraState,
    modelState: queuedModelState,
    generationSnapshot: queuedGenerationSnapshot,
    sourceImage: source,
    upscaleFactor,
    resultNodeIds: queuedResultNodeIds,
    resultFields: queuedResultFields,
    promptId,
    generationState: "generating",
    controlsFingerprint: chat?.controlsFingerprint || "",
    llmAmplified: useLlmAmplification(),
  });
  state.generating = true;
  setStatus("ComfyUI is generating…", "working");
  const token = ++state.pollToken;
  waitForResult(promptId, resultMessage, token, queuedResultNodeIds, queuedResultFields, retryOptions).catch((error) => {
    if (token !== state.pollToken) return;
    const message = error.message || String(error);
    markGenerationAttemptFailed(resultMessage, message);
    showGenerationFailure(message, () => retryGeneration(retryOptions));
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
      mainPrompt: String(generationData?.mainPrompt || state.mainPrompt || ""),
      finalPrompt: String(generationData?.canonicalPrompt || state.currentPrompt || ""),
      workflowProfileId,
      sourceImage: source,
      upscaleFactor: factor,
    });
  } catch (error) {
    const message = error.message || String(error);
    showGenerationFailure(message, () => queueUpscale(source, generationData, factor, workflowProfileId));
  }
}

async function generateDirectPrompt(action = selectedAction()) {
  if (!state.apiConnected) return setStatus("ComfyUI is disconnected. Prompt Studio is frozen.", "error");
  if (state.busy) return;
  const pendingGeneration = activeChat()?.pendingGeneration;
  if (
    pendingGeneration?.action === action
    && pendingGeneration.mainPrompt === state.mainPrompt
    && pendingGeneration.canonicalPrompt === state.currentPrompt
    && pendingGeneration.workflowProfileId === selectedWorkflowProfileId(action)
    && pendingGeneration.generationSnapshot
    && pendingGeneration.replayFingerprint === generationUiFingerprint()
  ) {
    return createNewFromCurrentPrompt({ applyControls: false, generationAction: action });
  }
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
  const directVersion = promptVersion(prompt, prompt);
  const promptChanged = !promptVersionsEqual(previousVersion, directVersion);
  const chat = activeChat();
  if (chat) {
    chat.initialized = true;
    chat.mainPromptDirty = false;
  }
  input.value = prompt;
  updatePromptEditors(prompt, prompt);
  if (promptChanged) pushVersion();
  else syncActiveChat();
  saveSettings();
  state.operationToken += 1;
  setBusy(true);
  setStatus("ComfyUI is generating the direct prompt…", "working");
  try {
    await queueGeneration({ action, executionPrompt: prompt, preserveSeed: promptChanged });
  } catch (error) {
    const message = error.message || String(error);
    showGenerationFailure(message, () => generateDirectPrompt(action));
  }
}

async function requestPromptRevision(payload, actionLabel) {
  if (!state.apiConnected) throw new Error("ComfyUI is disconnected. Wait for it to reconnect before sending.");
  const response = await api.fetchApi("/promptstudio/prompt-studio/revise", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${actionLabel} failed (${response.status}).`);
  const prompt = String(data.prompt || "").trim();
  if (!prompt) throw new Error(`${llmProviderName()} returned an empty prompt.`);
  return prompt;
}

function llmConnectionPayload() {
  const value = (id) => state.panel.querySelector(`#${id}`)?.value;
  return {
    llm_provider: value("promptstudio-llm-provider"),
    kobold_url: value("promptstudio-kobold-url"),
    ollama_url: value("promptstudio-ollama-url"),
    ollama_model: value("promptstudio-ollama-model"),
  };
}

async function requireVisionCapability() {
  const response = await api.fetchApi("/promptstudio/prompt-studio/vision-capability", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(llmConnectionPayload()),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.available) {
    throw new Error(data.reason || data.error || `${llmProviderName()} vision capability could not be verified.`);
  }
  return data;
}

function clipboardImageFiles(event) {
  const itemFiles = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === "file" && item.type?.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (itemFiles.length) return itemFiles;
  return [...(event.clipboardData?.files || [])]
    .filter((file) => file?.type?.startsWith("image/"));
}

function pastedImageFileError(file) {
  if (!file || typeof file.arrayBuffer !== "function") return "The clipboard did not contain a readable image.";
  if (file.type && !file.type.startsWith("image/")) return "The clipboard item is not an image.";
  if (file.size <= 0) return "The pasted image is empty.";
  if (file.size > MAX_DROPPED_IMAGE_BYTES) return "The pasted image is larger than the 20 MB import limit.";
  return "";
}

async function uploadPromptStudioImage(file) {
  const form = new FormData();
  form.append("image", file, file.name || `prompt-studio-${Date.now()}.png`);
  const response = await api.fetchApi("/promptstudio/prompt-studio/import-image", {
    method: "POST",
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  const reference = normalizeImageReference(data.image);
  if (!response.ok || !reference) {
    throw new Error(data.error || data.message || `Prompt Studio could not sanitize the dropped image (${response.status}).`);
  }
  return imageReferenceWithDimensions(reference);
}

function renderMainPastedImage() {
  const attachment = state.panel?.querySelector("#promptstudio-pasted-image");
  if (!attachment) return;
  const reference = normalizeImageReference(state.mainPastedImage);
  attachment.hidden = !reference;
  if (!reference) {
    attachment.querySelector("img")?.removeAttribute("src");
    return;
  }
  const image = attachment.querySelector("img");
  image.src = imageReferenceUrl(reference);
  image.alt = reference.filename || "Pasted reference image";
  const name = attachment.querySelector("small");
  if (name) name.textContent = reference.filename || "Attached to the next LLM request";
}

function clearMainPastedImage() {
  state.mainPastedImage = null;
  renderMainPastedImage();
}

async function pasteMainReference(file) {
  if (state.busy) return setStatus("Wait for the current operation to finish.", "warning");
  if (!useLlmAmplification()) {
    return setStatus("Enable “Use LLM amplification” before pasting a reference image.", "warning");
  }
  const validationError = pastedImageFileError(file);
  if (validationError) return setStatus(validationError, "warning");

  const operationToken = ++state.operationToken;
  setBusy(true);
  setStatus(`Checking ${llmProviderName()} vision support…`, "working");
  try {
    await requireVisionCapability();
    if (operationToken !== state.operationToken) return;
    setStatus("Sanitizing and attaching the pasted image…", "working");
    const reference = await uploadPromptStudioImage(file);
    if (operationToken !== state.operationToken) return;
    state.mainPastedImage = reference;
    renderMainPastedImage();
    setStatus("Pasted image attached to the next prompt.", "ready");
  } catch (error) {
    if (operationToken !== state.operationToken) return;
    setStatus(error.message || String(error), "error");
  } finally {
    if (operationToken === state.operationToken) setBusy(false);
  }
}

function handleMainImagePaste(event) {
  const files = clipboardImageFiles(event);
  if (!files.length) return;
  event.preventDefault();
  if (files.length > 1) {
    setStatus("Paste one reference image at a time in the main chat.", "warning");
    return;
  }
  pasteMainReference(files[0]);
}

async function requestImageCaption(reference) {
  const payload = {
    ...collectRevisionPayload("Caption the image", "render", "", ""),
    image: storedImageReference(reference),
  };
  const response = await api.fetchApi("/promptstudio/prompt-studio/caption-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${llmProviderName()} could not caption the image (${response.status}).`);
  const prompt = String(data.prompt || "").trim();
  if (!prompt) throw new Error(`${llmProviderName()} returned an empty image caption.`);
  return prompt;
}

function consultCurrentGenerationSettings() {
  const value = (id) => state.panel?.querySelector(`#${id}`)?.value;
  const checked = (id) => Boolean(state.panel?.querySelector(`#${id}`)?.checked);
  const presetInstruction = (collection, name) => {
    const templates = Array.isArray(state.config?.[collection]) ? state.config[collection] : [];
    const template = templates.find((item) => String(item?.name || "") === String(name || ""));
    return String(template?.instruction || "");
  };
  const action = selectedAction();
  const profile = selectedWorkflowProfile(action);
  const style = value("promptstudio-style");
  const framing = value("promptstudio-framing");
  return {
    action,
    workflow: profile?.name || "",
    model_profile: value("promptstudio-profile"),
    style,
    style_preset_text: presetInstruction("style_templates", style),
    framing,
    framing_preset_text: presetInstruction("framing_templates", framing),
    style_modifier: value("promptstudio-style-modifier"),
    framing_modifier: value("promptstudio-framing-modifier"),
    embellishment: value("promptstudio-embellishment"),
    resolution: action === "create" ? resolutionSettings() : "source image dimensions",
    randomize_seed: checked("promptstudio-randomize-seed"),
    models: generationModelState(profile),
    loras: generationLoraState(profile),
    secondary_instructions: value("promptstudio-secondary-instructions"),
    local_llm: {
      provider: llmProviderName(),
      model: selectedLlmProvider() === "ollama" ? value("promptstudio-ollama-model") : "KoboldCpp active model",
      thinking: value("promptstudio-thinking"),
      final_answer_tokens: Number(value("promptstudio-max-tokens") || 0),
      temperature: Number(value("promptstudio-temperature") || 0.7),
    },
  };
}

function activeConsultExperiment(chat = activeChat()) {
  return normalizeConsultExperiment(chat?.consultExperiment);
}

function consultPresetInstruction(collection, name) {
  const templates = Array.isArray(state.config?.[collection]) ? state.config[collection] : [];
  return String(templates.find((item) => String(item?.name || "") === String(name || ""))?.instruction || "");
}

function updateConsultExperimentUi() {
  const experiment = activeConsultExperiment();
  const agent = activeConsultAgent();
  const banner = state.panel?.querySelector("#promptstudio-consult-experiment");
  const start = state.panel?.querySelector("#promptstudio-consult-start-experiment");
  const agentMode = state.panel?.querySelector("#promptstudio-consult-toggle-agent");
  const send = state.panel?.querySelector("#promptstudio-consult-send");
  const input = state.panel?.querySelector("#promptstudio-consult-input");
  if (banner) {
    banner.hidden = !experiment;
    const label = banner.querySelector("span");
    if (label && experiment) {
      label.textContent = `Prompt experiment · ${experiment.stylePreset || "No style"} · ${experiment.framingPreset || "No framing"}`;
    }
  }
  if (start) {
    start.disabled = Boolean(experiment) || Boolean(agent?.active) || state.consultBusy || state.busy;
    start.textContent = experiment ? "Experiment active" : "Start prompt experiment";
  }
  if (agentMode) {
    const enabled = promptAgentModeEnabled();
    agentMode.disabled = Boolean(experiment) || Boolean(agent?.active) || state.consultBusy || state.busy;
    agentMode.setAttribute("aria-pressed", enabled ? "true" : "false");
    agentMode.textContent = enabled ? "Prompt agent on" : "Prompt agent";
  }
  if (send) {
    send.textContent = promptAgentModeEnabled() && !agent?.active
      ? (agent ? "Continue agent" : "Start agent")
      : "Send";
  }
  if (input) {
    input.placeholder = promptAgentModeEnabled()
      ? (agent ? "Tell the agent what to change in the next iterations…" : "Describe the image for Prompt Agent…")
      : "Ask your local model… Paste screenshots with Ctrl+V.";
  }
}

function toggleConsultAgentMode() {
  const chat = activeChat();
  if (!chat || state.busy || state.consultBusy || activeConsultExperiment(chat) || activeConsultAgent(chat)?.active) return;
  chat.consultAgentMode = !promptAgentModeEnabled(chat);
  chat.updatedAt = Date.now();
  saveChats();
  updateConsultExperimentUi();
  setConsultStatus(
    chat.consultAgentMode
      ? (chat.consultAgent ? "Prompt Agent mode on. Describe the next correction and send it." : "Prompt Agent mode on. Describe the image and send it.")
      : "Prompt Agent mode off. Messages will go to ordinary chat.",
    "ready",
  );
  state.panel?.querySelector("#promptstudio-consult-input")?.focus({ preventScroll: true });
}

function startConsultExperiment() {
  const chat = activeChat();
  if (!chat || state.consultBusy || state.busy || activeConsultExperiment(chat) || activeConsultAgent(chat)?.active) return;
  const baseMainPrompt = String(state.mainPrompt || "").trim();
  const baseFinalPrompt = String(state.currentPrompt || "").trim();
  if (!baseMainPrompt && !baseFinalPrompt) {
    setConsultStatus("Create or attach a Studio prompt before starting an experiment.", "warning");
    return;
  }
  const stylePreset = state.panel?.querySelector("#promptstudio-style")?.value || "None";
  const framingPreset = state.panel?.querySelector("#promptstudio-framing")?.value || "None";
  const now = Date.now();
  chat.consultExperiment = {
    id: makeId(),
    active: true,
    baseMainPrompt: baseMainPrompt || baseFinalPrompt,
    baseFinalPrompt: baseFinalPrompt || baseMainPrompt,
    stylePreset,
    stylePresetText: consultPresetInstruction("style_templates", stylePreset),
    framingPreset,
    framingPresetText: consultPresetInstruction("framing_templates", framingPreset),
    candidatePrompt: baseFinalPrompt || baseMainPrompt,
    styleGuidance: "",
    framingGuidance: "",
    selectedMessageId: "",
    startedAt: now,
    updatedAt: now,
  };
  chat.consultAgentMode = false;
  chat.updatedAt = now;
  saveChats();
  updateConsultExperimentUi();
  setConsultStatus("Prompt experiment started. Studio controls remain read-only.", "ready");
  state.panel?.querySelector("#promptstudio-consult-input")?.focus({ preventScroll: true });
}

function endConsultExperiment() {
  const chat = activeChat();
  if (!chat || state.consultBusy || state.busy || !activeConsultExperiment(chat)) return;
  chat.consultExperiment = null;
  chat.updatedAt = Date.now();
  saveChats();
  updateConsultExperimentUi();
  setConsultStatus("Prompt experiment ended. General chat has no automatic Studio context.", "ready");
}

function promptAgentCandidatePayload(candidate) {
  const normalized = normalizePromptAgentCandidate(candidate);
  if (!normalized) return null;
  return {
    prompt: normalized.prompt,
    style_guidance: normalized.styleGuidance,
    framing_guidance: normalized.framingGuidance,
    change_summary: normalized.changeSummary,
  };
}

function promptAgentEvaluationPayload(evaluation) {
  const normalized = normalizePromptAgentEvaluation(evaluation);
  if (!normalized) return null;
  return {
    score: normalized.score,
    confidence: normalized.confidence,
    pass: normalized.pass,
    criteria: normalized.criteria.map((item) => ({
      ...item,
      evidence: item.evidence.slice(0, 600),
    })),
    defects: normalized.defects.map((item) => item.slice(0, 500)),
    next_revision: normalized.nextRevision.slice(0, 2000),
    summary: normalized.summary.slice(0, 1000),
  };
}

function promptAgentReferencesPayload(agent) {
  return (agent?.references || []).map((item) => ({
    image: storedImageReference(item.image),
    purpose: item.purpose,
  })).filter((item) => item.image);
}

async function requestPromptAgentPhase(phase, agent, extra = {}) {
  const generationSettings = collectConsultGenerationSettings();
  const response = await api.fetchApi("/promptstudio/prompt-studio/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...llmConnectionPayload(),
      ...generationSettings,
      max_response_tokens: Math.max(1200, Number(generationSettings.max_response_tokens) || 0),
      phase,
      goal: promptAgentEffectiveGoal(agent),
      references: promptAgentReferencesPayload(agent),
      rubric: agent.rubric,
      target_score: agent.targetScore,
      min_confidence: agent.minConfidence,
      ...extra,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Prompt Agent ${phase} failed (${response.status}).`);
  return data;
}

function promptAgentCompletedIterations(agent, { includeValidation = false } = {}) {
  return (agent?.iterations || []).filter((iteration) => (
    iteration.evaluation
    && (includeValidation || !iteration.validation)
  ));
}

function promptAgentBestIteration(agent) {
  const cycleStartIndex = agent?.cycleStartIndex || 1;
  const selected = promptAgentIteration(agent, agent?.bestIterationId);
  return (selected?.index >= cycleStartIndex ? selected : null)
    || [...promptAgentCompletedIterations(agent, { includeValidation: true })]
      .filter((iteration) => iteration.index >= cycleStartIndex)
      .sort((left, right) => (
        Number(right.evaluation?.score || 0) - Number(left.evaluation?.score || 0)
        || Number(right.evaluation?.confidence || 0) - Number(left.evaluation?.confidence || 0)
      ))[0]
    || null;
}

function promptAgentPlateaued(agent) {
  const completed = promptAgentCompletedIterations(agent)
    .filter((iteration) => iteration.index >= (agent?.cycleStartIndex || 1))
    .slice(-3);
  if (completed.length < 3) return false;
  const scores = completed.map((item) => Number(item.evaluation?.score || 0));
  return scores[1] - scores[0] < 2 && scores[2] - scores[1] < 2;
}

function createPromptAgentIteration({ validation = false, candidate = null } = {}) {
  const id = makeId();
  updateConsultAgent((agent) => {
    const index = agent.iterations.reduce(
      (highest, iteration) => Math.max(highest, iteration.index),
      0,
    ) + 1;
    agent.iterations.push(normalizePromptAgentIteration({
      id,
      index,
      status: candidate ? "generating" : "architecting",
      candidate,
      validation,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, index - 1));
    agent.currentIterationId = id;
    agent.status = validation ? "validating" : (candidate ? "generating" : "architecting");
    agent.error = "";
  }, { immediate: true });
  return id;
}

function finishPromptAgent(status, message = "") {
  updateConsultAgent((agent) => {
    agent.active = false;
    agent.status = status;
    agent.resumeStatus = "";
    agent.error = status === "error" ? message : "";
  }, { immediate: true });
  state.consultAgentRunning = false;
  state.consultAgentGenerationTarget = null;
  state.activeGenerationPromptId = "";
  state.generating = false;
  setBusy(false);
  setConsultBusy(false);
  setConsultStatus(message || (status === "complete" ? "Prompt Agent completed." : "Prompt Agent stopped."), status === "error" ? "error" : "ready");
}

async function runConsultAgent(agentId = activeConsultAgent()?.id) {
  if (state.consultAgentRunning) return;
  let agent = activeConsultAgent();
  if (!agent || agent.id !== agentId || !agent.active) return;
  if (agent.status === "paused") {
    updateConsultAgent((current) => {
      current.status = current.resumeStatus || (current.rubric ? "architecting" : "compiling");
      current.resumeStatus = "";
    }, { immediate: true });
    agent = activeConsultAgent();
  }
  state.consultAgentRunning = true;
  const runToken = ++state.consultAgentRunToken;
  setBusy(true);
  setConsultBusy(true);
  try {
    while (runToken === state.consultAgentRunToken) {
      agent = activeConsultAgent();
      if (!agent || agent.id !== agentId || !agent.active || agent.status === "paused") return;

      if (!agent.rubric) {
        updateConsultAgent((current) => {
          current.status = "compiling";
        }, { immediate: true });
        setConsultStatus("Prompt Agent is compiling the acceptance rubric…", "working");
        const compiled = await requestPromptAgentPhase("compile", agent);
        if (runToken !== state.consultAgentRunToken) return;
        const rubric = normalizePromptAgentRubric(compiled.rubric);
        if (!rubric) throw new Error("Prompt Agent returned an invalid acceptance rubric.");
        updateConsultAgent((current) => {
          current.rubric = rubric;
          current.status = "architecting";
        }, { immediate: true });
        continue;
      }

      let iteration = promptAgentIteration(agent, agent.currentIterationId);
      if (!iteration || iteration.status === "complete") {
        const last = [...agent.iterations].reverse().find((item) => (
          item.evaluation && item.index >= (agent.cycleStartIndex || 1)
        ));
        if (last?.evaluation?.pass && !last.validation && agent.validationRequired) {
          createPromptAgentIteration({ validation: true, candidate: last.candidate });
          continue;
        }
        if (last?.evaluation?.pass && (!agent.validationRequired || last.validation)) {
          finishPromptAgent("complete", `Prompt Agent completed with a score of ${Math.round(last.evaluation.score)}.`);
          return;
        }
        const cycleCompleted = promptAgentCompletedIterations(agent)
          .filter((item) => item.index >= (agent.cycleStartIndex || 1));
        if (cycleCompleted.length >= agent.maxIterations) {
          finishPromptAgent("stopped", `Prompt Agent reached ${agent.maxIterations} iterations without a validated pass; the best result is ready.`);
          return;
        }
        if (promptAgentPlateaued(agent)) {
          finishPromptAgent("stopped", "Prompt Agent stopped after the score plateaued without a validated pass; the best result is ready.");
          return;
        }
        createPromptAgentIteration();
        continue;
      }

      if (iteration.status === "architecting") {
        setConsultStatus(`Prompt Agent is designing iteration ${iteration.index}…`, "working");
        const previous = [...agent.iterations]
          .slice(0, Math.max(0, agent.iterations.indexOf(iteration)))
          .reverse()
          .find((item) => item.evaluation);
        const designed = await requestPromptAgentPhase("architect", agent, {
          iteration: iteration.index,
          initial_style: agent.initialStyle,
          initial_framing: agent.initialFraming,
          previous_candidate: promptAgentCandidatePayload(previous?.candidate),
          previous_evaluation: previous?.index >= (agent.cycleStartIndex || 1)
            ? promptAgentEvaluationPayload(previous.evaluation)
            : null,
        });
        if (runToken !== state.consultAgentRunToken) return;
        const candidate = normalizePromptAgentCandidate(designed.candidate);
        if (!candidate) throw new Error("Prompt Agent returned an invalid prompt candidate.");
        updateConsultAgent((current) => {
          const target = promptAgentIteration(current, iteration.id);
          target.candidate = candidate;
          target.status = "generating";
          target.updatedAt = Date.now();
          current.status = "generating";
        }, { immediate: true });
        continue;
      }

      if (iteration.status === "generating") {
        const pending = normalizeConsultExperimentGeneration(iteration.generation);
        let generation = pending;
        if (pending?.promptId && ["queued", "generating"].includes(pending.generationState)) {
          state.activeGenerationPromptId = pending.promptId;
          state.consultAgentGenerationTarget = {
            agentId: agent.id,
            iterationId: iteration.id,
            promptId: pending.promptId,
          };
          state.generating = true;
          const pollToken = ++state.pollToken;
          setConsultStatus(`Following Prompt Agent generation ${pending.promptId.slice(0, 8)}…`, "working");
          generation = await waitForConsultAgentResult(
            pending.promptId,
            state.consultAgentGenerationTarget,
            pollToken,
            pending.resultNodeIds,
            pending.resultFields,
          );
        } else {
          setConsultStatus(
            iteration.validation
              ? "Prompt Agent is validating the candidate with a fresh seed…"
              : `Prompt Agent is generating iteration ${iteration.index}…`,
            "working",
          );
          generation = await queueGeneration({
            action: "create",
            executionPrompt: iteration.candidate.prompt,
            mainPrompt: promptAgentEffectiveGoal(agent),
            finalPrompt: iteration.candidate.prompt,
            preserveSeed: !iteration.validation,
            alwaysNewSeed: iteration.validation,
            agentTarget: {
              agentId: agent.id,
              iterationId: iteration.id,
            },
          });
        }
        if (runToken !== state.consultAgentRunToken || !generation) return;
        updateConsultAgent((current) => {
          const target = promptAgentIteration(current, iteration.id);
          target.status = "evaluating";
          target.updatedAt = Date.now();
          current.status = iteration.validation ? "validating" : "evaluating";
        }, { immediate: true });
        continue;
      }

      if (iteration.status === "evaluating") {
        const generation = normalizeConsultExperimentGeneration(iteration.generation);
        if (!generation?.images.length) throw new Error("Prompt Agent has no generated image to evaluate.");
        setConsultStatus(
          iteration.validation
            ? "Prompt Agent is judging the fresh-seed validation…"
            : `Prompt Agent is visually judging iteration ${iteration.index}…`,
          "working",
        );
        const judged = await requestPromptAgentPhase("evaluate", agent, {
          generated_images: generation.images.map(storedImageReference).filter(Boolean),
        });
        if (runToken !== state.consultAgentRunToken) return;
        const evaluation = normalizePromptAgentEvaluation(judged.evaluation);
        if (!evaluation) throw new Error("Prompt Agent returned an invalid visual evaluation.");
        updateConsultAgent((current) => {
          const target = promptAgentIteration(current, iteration.id);
          const previousBest = promptAgentBestIteration(current);
          target.evaluation = evaluation;
          target.status = "complete";
          target.updatedAt = Date.now();
          if (
            !previousBest
            || evaluation.score > Number(previousBest.evaluation?.score || 0)
            || (
              evaluation.score === Number(previousBest.evaluation?.score || 0)
              && evaluation.confidence > Number(previousBest.evaluation?.confidence || 0)
            )
          ) {
            current.bestIterationId = target.id;
          }
          current.status = evaluation.pass && !target.validation ? "validating" : "architecting";
        }, { immediate: true });
        continue;
      }

      if (iteration.status === "error") {
        throw new Error(iteration.generation?.text || "Prompt Agent generation failed.");
      }
    }
  } catch (error) {
    if (runToken !== state.consultAgentRunToken) return;
    finishPromptAgent("error", error.message || String(error));
  } finally {
    if (runToken === state.consultAgentRunToken) {
      state.consultAgentRunning = false;
    }
    const current = activeConsultAgent();
    if (current?.active && current.status === "paused" && !state.generating) {
      setBusy(false);
      setConsultBusy(false);
      setConsultStatus("Prompt Agent paused.", "warning");
    }
  }
}

async function startConsultAgent() {
  const chat = activeChat();
  if (!chat || state.busy || state.consultBusy || activeConsultExperiment(chat) || activeConsultAgent(chat)?.active) return;
  const input = state.panel?.querySelector("#promptstudio-consult-input");
  const goal = String(input?.value || "").trim();
  if (!goal) {
    setConsultStatus("Describe the desired image in the chat box before starting Prompt Agent.", "warning");
    input?.focus({ preventScroll: true });
    return;
  }
  if (!selectedWorkflowProfile("create")) {
    setConsultStatus("Select a compatible [PS] creation workflow before starting Prompt Agent.", "warning");
    return;
  }
  setConsultStatus(`Checking ${llmProviderName()} vision support…`, "working");
  try {
    await requireVisionCapability();
  } catch (error) {
    setConsultStatus(error.message || String(error), "warning");
    return;
  }
  const references = [...state.consultSelectedImages.values()].slice(0, 4).map((item) => ({
    image: item.reference,
    purpose: item.purpose,
  }));
  const styleName = state.panel?.querySelector("#promptstudio-style")?.value || "None";
  const framingName = state.panel?.querySelector("#promptstudio-framing")?.value || "None";
  const maxIterations = requestedPromptAgentIterations();
  const now = Date.now();
  chat.consultAgent = normalizeConsultAgent({
    id: makeId(),
    active: true,
    status: "compiling",
    goal,
    references,
    rubric: null,
    initialStyle: {
      name: styleName,
      instruction: consultPresetInstruction("style_templates", styleName),
    },
    initialFraming: {
      name: framingName,
      instruction: consultPresetInstruction("framing_templates", framingName),
    },
    iterations: [],
    maxIterations,
    cycleStartIndex: 1,
    targetScore: PROMPT_AGENT_TARGET_SCORE,
    minConfidence: PROMPT_AGENT_MIN_CONFIDENCE,
    validationRequired: true,
    startedAt: now,
    updatedAt: now,
  });
  chat.updatedAt = now;
  chat.consultAgentMode = true;
  input.value = "";
  state.consultSelectedImages.clear();
  state.consultUploadedImages = [];
  saveChats({ immediate: true });
  state.operationToken += 1;
  renderConsultAttachments();
  renderConsultHistory();
  updateConsultExperimentUi();
  runConsultAgent(chat.consultAgent.id);
}

async function continueConsultAgent() {
  const chat = activeChat();
  const agent = activeConsultAgent(chat);
  const input = state.panel?.querySelector("#promptstudio-consult-input");
  const feedback = String(input?.value || "").trim();
  if (!chat || !agent || agent.active || state.busy || state.consultBusy) return;
  if (!feedback) {
    setConsultStatus("Describe what the next Prompt Agent iterations should change.", "warning");
    input?.focus({ preventScroll: true });
    return;
  }
  if (!selectedWorkflowProfile("create")) {
    setConsultStatus("Select a compatible [PS] creation workflow before continuing Prompt Agent.", "warning");
    return;
  }
  setConsultStatus(`Checking ${llmProviderName()} vision support…`, "working");
  try {
    await requireVisionCapability();
  } catch (error) {
    setConsultStatus(error.message || String(error), "warning");
    return;
  }

  const selectedReferences = [...state.consultSelectedImages.values()].slice(0, 4).map((item) => ({
    image: item.reference,
    purpose: item.purpose,
  }));
  const selectedKeys = new Set(selectedReferences.map((item) => imageReferenceKey(item.image)));
  const references = [
    ...selectedReferences,
    ...agent.references.filter((item) => !selectedKeys.has(imageReferenceKey(item.image))),
  ].slice(0, 4);
  const cycleStartIndex = agent.iterations.reduce(
    (highest, iteration) => Math.max(highest, iteration.index),
    0,
  ) + 1;
  const now = Date.now();
  chat.consultAgent = normalizeConsultAgent({
    ...agent,
    active: true,
    status: "compiling",
    resumeStatus: "",
    references,
    rubric: null,
    feedback: [...agent.feedback, { text: feedback, createdAt: now }],
    currentIterationId: "",
    bestIterationId: "",
    maxIterations: requestedPromptAgentIterations(),
    cycleStartIndex,
    error: "",
    updatedAt: now,
  });
  chat.consultAgentMode = true;
  chat.updatedAt = now;
  input.value = "";
  state.consultSelectedImages.clear();
  state.consultUploadedImages = [];
  saveChats({ immediate: true });
  state.operationToken += 1;
  renderConsultAttachments();
  renderConsultHistory();
  updateConsultExperimentUi();
  runConsultAgent(chat.consultAgent.id);
}

function pauseConsultAgent() {
  if (!activeConsultAgent()?.active || !state.consultAgentRunning) return;
  state.consultAgentRunToken += 1;
  updateConsultAgent((agent) => {
    agent.resumeStatus = agent.status;
    agent.status = "paused";
  }, { immediate: true });
  state.consultAgentRunning = false;
  if (!state.generating) {
    setBusy(false);
    setConsultBusy(false);
  }
  setConsultStatus(
    state.generating ? "Prompt Agent will pause after the current image completes." : "Prompt Agent paused.",
    "warning",
  );
}

function resumeConsultAgent() {
  const agent = activeConsultAgent();
  if (!agent?.active || agent.status !== "paused" || state.generating) return;
  runConsultAgent(agent.id);
}

function retryConsultAgent() {
  const agent = activeConsultAgent();
  if (!agent || agent.status !== "error") return;
  updateConsultAgent((current) => {
    const iteration = promptAgentIteration(current, current.currentIterationId);
    if (iteration?.status === "error") {
      iteration.generation = null;
      iteration.status = iteration.candidate ? "generating" : "architecting";
    }
    current.active = true;
    current.status = iteration?.status || (current.rubric ? "architecting" : "compiling");
    current.error = "";
  }, { immediate: true });
  runConsultAgent(agent.id);
}

async function stopConsultAgent() {
  const agent = activeConsultAgent();
  if (!agent?.active) return;
  state.operationToken += 1;
  state.consultAgentRunToken += 1;
  state.pollToken += 1;
  if (state.generating || state.queueing) {
    try {
      if (typeof api.interrupt === "function") await api.interrupt();
      else await api.fetchApi("/interrupt", { method: "POST" });
    } catch (_) {
      // The persisted stopped state remains authoritative even if ComfyUI already finished.
    }
  }
  finishPromptAgent("stopped", "Prompt Agent stopped. The best completed result remains available.");
}

function promotePromptAgentBest() {
  if (state.busy || state.consultBusy) return;
  const agent = activeConsultAgent();
  const best = promptAgentBestIteration(agent);
  if (!agent || !best?.candidate) return;
  const effectiveGoal = promptAgentEffectiveGoal(agent);
  const previousVersion = promptVersion();
  state.mainPrompt = effectiveGoal;
  syncCanonicalEditor(best.candidate.prompt, { userEdit: best.candidate.prompt !== state.currentPrompt });
  if (!promptVersionsEqual(previousVersion, promptVersion())) pushVersion(best.candidate.prompt, effectiveGoal);
  const generation = normalizeConsultExperimentGeneration(best.generation);
  if (generation?.images.length) {
    appendMessage("assistant", "", {
      label: "Promoted Prompt Agent result",
      images: generation.images,
      mainPrompt: effectiveGoal,
      canonicalPrompt: best.candidate.prompt,
      executionPrompt: generation.executionPrompt || best.candidate.prompt,
      generationAction: "create",
      workflowProfileId: generation.workflowProfileId,
      workflowName: generation.workflowName,
      loraState: generation.loraState,
      modelState: generation.modelState,
      generationSnapshot: generation.generationSnapshot,
      resultNodeIds: generation.resultNodeIds,
      resultFields: generation.resultFields,
      generationState: "complete",
      controlsFingerprint: controlsFingerprint(),
      llmAmplified: true,
    });
  }
  syncActiveChat();
  saveChats();
  setStatus("Prompt Agent best result promoted to Studio. Presets and controls were not changed.", "ready");
  setConsultStatus("Best Prompt Agent result promoted to Studio.", "ready");
}

function consultExperimentContext(experiment = activeConsultExperiment()) {
  if (!experiment) return null;
  return {
    base_main_prompt: experiment.baseMainPrompt,
    base_final_prompt: experiment.baseFinalPrompt,
    current_prompt: experiment.candidatePrompt || experiment.baseFinalPrompt,
    style_preset: experiment.stylePreset,
    style_preset_text: experiment.stylePresetText,
    framing_preset: experiment.framingPreset,
    framing_preset_text: experiment.framingPresetText,
    style_guidance: experiment.styleGuidance,
    framing_guidance: experiment.framingGuidance,
  };
}

function parseConsultExperimentAnswer(answer, experimentActive = Boolean(activeConsultExperiment())) {
  const raw = String(answer || "").trim();
  if (!experimentActive) return { text: raw, proposal: null };
  const pattern = new RegExp(
    `<${CONSULT_EXPERIMENT_MARKER}>\\s*([\\s\\S]*?)\\s*</${CONSULT_EXPERIMENT_MARKER}>`,
    "gi",
  );
  const matches = [...raw.matchAll(pattern)];
  if (!matches.length) return { text: raw, proposal: null };
  const block = matches[matches.length - 1];
  let encoded = String(block[1] || "").trim();
  encoded = encoded.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  let proposal = null;
  try {
    proposal = normalizeConsultExperimentProposal(JSON.parse(encoded));
  } catch (_) {
    proposal = null;
  }
  if (!proposal) return { text: raw.replace(pattern, "").trim(), proposal: null };
  const text = raw.replace(pattern, "").trim() || "Prepared an experimental prompt candidate.";
  return { text, proposal };
}

function updateActiveConsultExperiment(message) {
  const chat = activeChat();
  const experiment = activeConsultExperiment(chat);
  const proposal = normalizeConsultExperimentProposal(message?.proposal);
  if (!chat || !experiment || !proposal) return;
  experiment.candidatePrompt = proposal.prompt;
  experiment.styleGuidance = proposal.styleGuidance;
  experiment.framingGuidance = proposal.framingGuidance;
  experiment.selectedMessageId = String(message.id || "");
  experiment.updatedAt = Date.now();
  chat.consultExperiment = experiment;
  chat.updatedAt = experiment.updatedAt;
}

function consultExperimentLatestImage(chat = activeChat()) {
  const experiment = activeConsultExperiment(chat);
  if (!experiment) return null;
  const messages = [...(chat?.consultMessages || [])].reverse();
  for (const message of messages) {
    if (String(message?.experimentId || "") !== experiment.id) continue;
    const generation = normalizeConsultExperimentGeneration(message?.generation);
    if (generation?.generationState !== "complete") continue;
    const image = normalizeImageReference(generation.images[0]);
    if (image) return image;
  }
  return null;
}

function consultRecentImageChoices() {
  const choices = [];
  const seen = new Set();
  const agent = activeConsultAgent();
  for (const iteration of [...(agent?.iterations || [])].reverse()) {
    const agentImages = normalizeConsultExperimentGeneration(iteration.generation)?.images || [];
    for (const item of [...agentImages].reverse()) {
      const reference = normalizeImageReference(item);
      const key = imageReferenceKey(reference);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      choices.push({ key, reference, purpose: "generated result", uploaded: false });
      if (choices.length >= 12) return choices;
    }
  }
  for (const item of [...(agent?.references || [])].reverse()) {
    const reference = normalizeImageReference(item.image);
    const key = imageReferenceKey(reference);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    choices.push({ key, reference, purpose: item.purpose, uploaded: true });
    if (choices.length >= 12) return choices;
  }
  for (const message of [...(activeChat()?.consultMessages || [])].reverse()) {
    const experimentImages = normalizeConsultExperimentGeneration(message?.generation)?.images || [];
    for (const item of [...experimentImages].reverse()) {
      const reference = normalizeImageReference(item);
      const key = imageReferenceKey(reference);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      choices.push({
        key,
        reference,
        purpose: "generated result",
        uploaded: false,
      });
      if (choices.length >= 12) return choices;
    }
    const attached = message.context?.attached_images || [];
    for (let index = message.images.length - 1; index >= 0; index -= 1) {
      const reference = normalizeImageReference(message.images[index]);
      const key = imageReferenceKey(reference);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      choices.push({
        key,
        reference,
        purpose: attached[index]?.purpose || "reference image",
        uploaded: attached[index]?.purpose !== "generated result",
      });
      if (choices.length >= 12) return choices;
    }
  }
  for (const message of [...(activeChat()?.messages || [])].reverse()) {
    for (const image of [...(message.images || [])].reverse()) {
      const reference = normalizeImageReference(image);
      const key = imageReferenceKey(reference);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      choices.push({
        key,
        reference,
        purpose: "generated result",
        uploaded: false,
      });
      if (choices.length >= 12) return choices;
    }
  }
  return choices;
}

function updateConsultAttachmentSummary() {
  const summary = state.panel?.querySelector("#promptstudio-consult-attachment-summary");
  if (!summary) return;
  const contextCount = [
    "promptstudio-consult-attach-main",
    "promptstudio-consult-attach-final",
    "promptstudio-consult-attach-settings",
  ].filter((id) => state.panel.querySelector(`#${id}`)?.checked).length;
  const parts = [];
  if (contextCount) parts.push(`${contextCount} context`);
  if (state.consultSelectedImages.size) {
    parts.push(`${state.consultSelectedImages.size} image${state.consultSelectedImages.size === 1 ? "" : "s"}`);
  }
  summary.textContent = parts.length ? parts.join(" · ") : "No context attached";
}

function renderConsultAttachments() {
  const list = state.panel?.querySelector("#promptstudio-consult-image-list");
  const visionStatus = state.panel?.querySelector("#promptstudio-consult-vision-status");
  const upload = state.panel?.querySelector("#promptstudio-consult-upload");
  if (!list || !visionStatus) return;
  state.consultImageChoices.clear();
  const choices = [...state.consultUploadedImages, ...consultRecentImageChoices()];
  for (const choice of choices) state.consultImageChoices.set(choice.key, choice);
  list.replaceChildren();

  if (state.consultVisionAvailable === false) {
    visionStatus.textContent = state.consultVisionReason || `${llmProviderName()} does not support image input.`;
    visionStatus.dataset.kind = "warning";
  } else if (state.consultVisionAvailable === true) {
    visionStatus.textContent = `${llmProviderName()} vision is available. Attach up to four images per message.`;
    visionStatus.dataset.kind = "ready";
  } else {
    visionStatus.textContent = `Checking ${llmProviderName()} vision support…`;
    visionStatus.dataset.kind = "working";
  }
  if (upload) {
    upload.disabled = state.consultBusy;
    upload.dataset.visionAvailable = state.consultVisionAvailable === true ? "true" : "false";
    upload.title = state.consultVisionAvailable === false
      ? state.consultVisionReason || "The connected model does not support image input."
      : "Upload or drop a reference image";
  }

  if (!choices.length) {
    const empty = document.createElement("span");
    empty.className = "promptstudio-consult-image-empty";
    empty.textContent = "No generated images in this session yet.";
    list.appendChild(empty);
  }

  for (const choice of choices) {
    const selected = state.consultSelectedImages.get(choice.key);
    const card = document.createElement("label");
    card.className = "promptstudio-consult-image-choice";
    card.dataset.selected = selected ? "true" : "false";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(selected);
    checkbox.disabled = state.consultVisionAvailable !== true || state.consultBusy;
    const image = document.createElement("img");
    image.src = imageReferenceUrl(choice.reference);
    image.alt = choice.reference.filename || "Consultation image";
    const meta = document.createElement("span");
    meta.className = "promptstudio-consult-image-choice-meta";
    const name = document.createElement("b");
    name.textContent = choice.uploaded ? "Uploaded reference" : choice.reference.filename;
    const purpose = document.createElement("select");
    purpose.setAttribute("aria-label", `Role for ${image.alt}`);
    for (const [value, label] of [
      ["base image", "Base / target image"],
      ["generated result", "Generated result"],
      ["reference image", "General reference"],
      ["pose reference", "Pose reference"],
      ["style reference", "Style reference"],
      ["composition reference", "Composition reference"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      purpose.appendChild(option);
    }
    purpose.value = selected?.purpose || choice.purpose;
    purpose.disabled = state.consultVisionAvailable !== true || state.consultBusy;
    purpose.addEventListener("click", (event) => event.stopPropagation());
    purpose.addEventListener("change", () => {
      if (state.consultSelectedImages.has(choice.key)) {
        state.consultSelectedImages.set(choice.key, { ...choice, purpose: purpose.value });
      }
    });
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        if (state.consultSelectedImages.size >= 4) {
          checkbox.checked = false;
          setConsultStatus("Attach at most four images to one message.", "warning");
          return;
        }
        state.consultSelectedImages.set(choice.key, { ...choice, purpose: purpose.value });
      } else {
        state.consultSelectedImages.delete(choice.key);
      }
      card.dataset.selected = checkbox.checked ? "true" : "false";
      updateConsultAttachmentSummary();
    });
    meta.append(name, purpose);
    card.append(checkbox, image, meta);
    list.appendChild(card);
  }
  updateConsultAttachmentSummary();
}

async function refreshConsultVisionCapability() {
  state.consultVisionAvailable = null;
  state.consultVisionReason = "";
  renderConsultAttachments();
  try {
    await requireVisionCapability();
    state.consultVisionAvailable = true;
  } catch (error) {
    state.consultVisionAvailable = false;
    state.consultVisionReason = error.message || String(error);
    state.consultSelectedImages.clear();
  }
  renderConsultAttachments();
}

async function uploadConsultReference(file) {
  if (!file || state.consultBusy) return;
  if (!file.type?.startsWith("image/")) {
    return setConsultStatus("Choose an image file.", "warning");
  }
  if (file.size <= 0 || file.size > MAX_DROPPED_IMAGE_BYTES) {
    return setConsultStatus("Reference images must be between 1 byte and 20 MB.", "warning");
  }
  try {
    await requireVisionCapability();
    setConsultStatus("Sanitizing the reference image…", "working");
    const reference = await uploadPromptStudioImage(file);
    const key = imageReferenceKey(reference);
    const choice = {
      key,
      reference,
      purpose: "reference image",
      uploaded: true,
    };
    state.consultUploadedImages = [
      choice,
      ...state.consultUploadedImages.filter((item) => item.key !== key),
    ].slice(0, 8);
    if (state.consultSelectedImages.size < 4) {
      state.consultSelectedImages.set(key, choice);
    }
    setConsultStatus("Reference image attached.", "ready");
    renderConsultAttachments();
  } catch (error) {
    setConsultStatus(error.message || String(error), "error");
  }
}

async function handleConsultImagePaste(event) {
  const files = clipboardImageFiles(event);
  if (!files.length) return;
  event.preventDefault();
  if (state.consultBusy) {
    setConsultStatus("Wait for the current answer to finish.", "warning");
    return;
  }
  const availableSlots = Math.max(0, 4 - state.consultSelectedImages.size);
  if (!availableSlots) {
    setConsultStatus("A consultation message can contain at most four images.", "warning");
    return;
  }
  const selected = files.slice(0, availableSlots);
  for (const file of selected) {
    const validationError = pastedImageFileError(file);
    if (validationError) {
      setConsultStatus(validationError, "warning");
      continue;
    }
    await uploadConsultReference(file);
  }
  if (files.length > availableSlots) {
    setConsultStatus(`Only ${availableSlots} more image${availableSlots === 1 ? "" : "s"} could be attached.`, "warning");
  }
}

function consultAttachedContext(selectedImages) {
  const context = {};
  if (state.panel?.querySelector("#promptstudio-consult-attach-main")?.checked) {
    context.main_prompt = state.mainPrompt;
  }
  if (state.panel?.querySelector("#promptstudio-consult-attach-final")?.checked) {
    context.final_prompt = state.currentPrompt;
  }
  if (state.panel?.querySelector("#promptstudio-consult-attach-settings")?.checked) {
    context.current_generation_settings = consultCurrentGenerationSettings();
  }
  if (selectedImages.length) {
    context.attached_images = selectedImages.map((choice, index) => ({
      label: `Image ${String.fromCharCode(65 + index)}`,
      purpose: choice.purpose,
      filename: choice.reference.filename,
    }));
  }
  const experiment = consultExperimentContext();
  if (experiment) context.prompt_experiment = experiment;
  return Object.keys(context).length ? context : null;
}

function setConsultStatus(text, kind = "") {
  const status = state.panel?.querySelector("#promptstudio-consult-status");
  if (!status) return;
  status.textContent = text;
  status.title = text;
  status.dataset.kind = kind;
  syncBackgroundActivityIndicator();
}

function setConsultBusy(busy) {
  state.consultBusy = busy;
  queueMicrotask(syncBackgroundActivityIndicator);
  state.panel?.querySelectorAll(".promptstudio-consult button, .promptstudio-consult input, .promptstudio-consult select, .promptstudio-consult textarea")
    .forEach((control) => {
      if (control.id === "promptstudio-consult-close" || control.dataset.agentControl === "true") return;
      control.disabled = busy;
    });
  if (!busy) renderConsultAttachments();
  updateConsultExperimentUi();
}

function consultRequestMessages(messages) {
  const experimentId = activeConsultExperiment()?.id || "";
  const scopedMessages = messages.filter((message) => (
    experimentId
      ? String(message.experimentId || "") === experimentId
      : !String(message.experimentId || "")
  ));
  const selected = scopedMessages.slice(-60).map((message) => ({
    role: message.role,
    text: message.text,
    context: message.context,
    images: message.role === "user"
      ? message.images.map(storedImageReference).filter(Boolean)
      : [],
  }));
  let imageBudget = 8;
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    if (selected[index].images.length <= imageBudget) {
      imageBudget -= selected[index].images.length;
    } else {
      selected[index].images = [];
    }
  }
  return selected;
}

function collectConsultGenerationSettings() {
  const value = (id) => state.panel?.querySelector(`#${id}`)?.value;
  return {
    thinking_mode: value("promptstudio-consult-thinking"),
    max_response_tokens: Number(value("promptstudio-consult-max-tokens") || 800),
    temperature: Number(value("promptstudio-consult-temperature") || 0.7),
    top_p: Number(value("promptstudio-consult-top-p") || 0.9),
    top_k: Number(value("promptstudio-consult-top-k") || 100),
    min_p: Number(value("promptstudio-consult-min-p") || 0),
    rep_pen: Number(value("promptstudio-consult-rep-pen") || 1.05),
    rep_pen_range: Number(value("promptstudio-consult-rep-pen-range") || 360),
    sampler_seed: Number(value("promptstudio-consult-seed") || -1),
  };
}

function selectedConsultVariant(message) {
  const variants = Array.isArray(message?.variants) ? message.variants : [];
  const index = Math.max(0, Math.min(Number(message?.variantIndex) || 0, variants.length - 1));
  return variants[index] || null;
}

function copyConsultExperimentPrompt(prompt) {
  const value = String(prompt || "");
  const clipboard = state.panel?.ownerDocument.defaultView?.navigator?.clipboard;
  if (!value || !clipboard?.writeText) {
    setConsultStatus("Clipboard access is unavailable.", "warning");
    return;
  }
  clipboard.writeText(value)
    .then(() => setConsultStatus("Experimental prompt copied.", "ready"))
    .catch((error) => setConsultStatus(error.message || "Could not copy the prompt.", "error"));
}

function promoteConsultExperiment(messageId) {
  if (state.busy || state.consultBusy) return;
  const chat = activeChat();
  const message = chat?.consultMessages.find((item) => item.id === messageId);
  const variant = selectedConsultVariant(message);
  const proposal = normalizeConsultExperimentProposal(variant?.proposal || message?.proposal);
  if (!chat || !proposal) return;
  const previousVersion = promptVersion();
  syncCanonicalEditor(proposal.prompt, { userEdit: proposal.prompt !== state.currentPrompt });
  if (!promptVersionsEqual(previousVersion, promptVersion())) pushVersion(proposal.prompt, state.mainPrompt);

  const generation = normalizeConsultExperimentGeneration(variant?.generation || message?.generation);
  if (generation?.images.length) {
    appendMessage("assistant", "", {
      label: "Promoted consultation experiment",
      images: generation.images,
      mainPrompt: generation.mainPrompt || state.mainPrompt,
      canonicalPrompt: proposal.prompt,
      executionPrompt: generation.executionPrompt || proposal.prompt,
      generationAction: generation.generationAction,
      workflowProfileId: generation.workflowProfileId,
      workflowName: generation.workflowName,
      loraState: generation.loraState,
      modelState: generation.modelState,
      generationSnapshot: generation.generationSnapshot,
      sourceImage: generation.sourceImage,
      resultNodeIds: generation.resultNodeIds,
      resultFields: generation.resultFields,
      generationState: "complete",
      controlsFingerprint: controlsFingerprint(),
      llmAmplified: useLlmAmplification(),
    });
  }
  chat.updatedAt = Date.now();
  saveChats();
  setStatus("Consultation prompt promoted to the Final Prompt. Presets and controls were not changed.", "ready");
  setConsultStatus("Selected experiment promoted to Studio.", "ready");
}

async function generateConsultExperiment(messageId) {
  if (state.busy || state.consultBusy) return;
  const chat = activeChat();
  const experiment = activeConsultExperiment(chat);
  const message = chat?.consultMessages.find((item) => item.id === messageId);
  const variant = selectedConsultVariant(message);
  const proposal = normalizeConsultExperimentProposal(variant?.proposal || message?.proposal);
  const previousGeneration = normalizeConsultExperimentGeneration(variant?.generation || message?.generation);
  if (!chat || !experiment || !message || !variant || !proposal) return;
  const action = selectedAction();
  if (!selectedWorkflowProfile(action)) {
    setConsultStatus("Select a compatible [PS] workflow in Studio before generating.", "warning");
    return;
  }
  if (action === "edit" && !editingSource()) {
    setConsultStatus("The current Studio editing action has no source image.", "warning");
    return;
  }
  state.operationToken += 1;
  setBusy(true);
  setConsultBusy(true);
  setConsultStatus("ComfyUI is generating inside the prompt experiment…", "working");
  try {
    await queueGeneration({
      action,
      executionPrompt: proposal.prompt,
      mainPrompt: experiment.baseMainPrompt,
      finalPrompt: proposal.prompt,
      preserveSeed: previousGeneration?.generationState !== "complete",
      forceNewSeed: previousGeneration?.generationState === "complete",
      consultTarget: {
        messageId: message.id,
        variantId: variant.id,
      },
    });
  } catch (error) {
    setBusy(false);
    setConsultBusy(false);
    setConsultStatus(error.message || String(error), "error");
  }
}

function renderConsultExperimentProposal(bubble, message) {
  const variant = selectedConsultVariant(message);
  const proposal = normalizeConsultExperimentProposal(variant?.proposal || message?.proposal);
  if (!proposal) return;
  const generation = normalizeConsultExperimentGeneration(variant?.generation || message?.generation);
  const experimentActive = Boolean(
    message?.experimentId
    && message.experimentId === activeConsultExperiment()?.id
  );
  const card = document.createElement("section");
  card.className = "promptstudio-consult-experiment-card";

  const heading = document.createElement("strong");
  heading.textContent = "Prompt experiment";
  const prompt = document.createElement("div");
  prompt.className = "promptstudio-consult-experiment-prompt";
  prompt.textContent = proposal.prompt;
  card.append(heading, prompt);

  for (const [label, value] of [
    ["Temporary style guidance", proposal.styleGuidance],
    ["Temporary framing guidance", proposal.framingGuidance],
  ]) {
    if (!value) continue;
    const detail = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = label;
    const text = document.createElement("div");
    text.textContent = value;
    detail.append(summary, text);
    card.appendChild(detail);
  }

  if (generation) {
    const status = document.createElement("span");
    status.className = "promptstudio-consult-experiment-generation-status";
    status.dataset.kind = generation.generationState;
    status.textContent = generation.generationState === "complete"
      ? "Generated in consultation"
      : generation.generationState === "error"
        ? generation.text || "Generation failed"
        : "Generating in consultation…";
    card.appendChild(status);
    if (generation.images.length) {
      const gallery = document.createElement("div");
      gallery.className = "promptstudio-consult-message-images";
      generation.images.forEach((reference) => {
        const image = document.createElement("img");
        image.src = imageReferenceUrl(reference);
        image.alt = reference.filename || "Experimental result";
        gallery.appendChild(image);
      });
      card.appendChild(gallery);
    }
  }

  const actions = document.createElement("div");
  actions.className = "promptstudio-consult-experiment-actions";
  const generate = document.createElement("button");
  generate.type = "button";
  generate.textContent = generation?.generationState === "complete" ? "Generate again" : "Generate here";
  generate.className = proposal.action === "generate" ? "promptstudio-primary" : "";
  generate.disabled = !experimentActive || state.busy || state.consultBusy || generation?.generationState === "generating";
  if (!experimentActive) generate.title = "Restart an experiment to generate another candidate.";
  generate.addEventListener("click", () => generateConsultExperiment(message.id));
  const promote = document.createElement("button");
  promote.type = "button";
  promote.textContent = "Promote to Studio";
  promote.className = proposal.action === "promote" ? "promptstudio-primary" : "";
  promote.disabled = state.busy || state.consultBusy;
  promote.addEventListener("click", () => promoteConsultExperiment(message.id));
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy prompt";
  copy.disabled = state.busy || state.consultBusy;
  copy.addEventListener("click", () => copyConsultExperimentPrompt(proposal.prompt));
  actions.append(generate, promote, copy);
  card.appendChild(actions);
  bubble.appendChild(card);
}

function promptAgentStatusLabel(agent) {
  const labels = {
    compiling: "Compiling rubric",
    architecting: "Designing next prompt",
    generating: "Generating",
    evaluating: "Judging pixels",
    validating: "Fresh-seed validation",
    paused: "Paused",
    complete: "Complete",
    stopped: "Stopped",
    error: "Error",
  };
  return labels[agent?.status] || "Ready";
}

function copyPromptAgentBest() {
  const best = promptAgentBestIteration(activeConsultAgent());
  const clipboard = state.panel?.ownerDocument.defaultView?.navigator?.clipboard;
  if (!best?.candidate?.prompt || !clipboard?.writeText) {
    setConsultStatus("Clipboard access is unavailable.", "warning");
    return;
  }
  clipboard.writeText(best.candidate.prompt)
    .then(() => setConsultStatus("Best Prompt Agent prompt copied.", "ready"))
    .catch((error) => setConsultStatus(error.message || "Could not copy the prompt.", "error"));
}

function renderConsultAgentCard(history, agent) {
  if (!history || !agent) return;
  const card = document.createElement("section");
  card.className = "promptstudio-agent-card";
  card.dataset.status = agent.status;

  const header = document.createElement("header");
  const title = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = "Prompt agent";
  const status = document.createElement("span");
  status.textContent = promptAgentStatusLabel(agent);
  status.dataset.kind = agent.status === "error" ? "error" : agent.status === "complete" ? "ready" : "working";
  title.append(heading, status);
  const progress = document.createElement("span");
  const completedCount = promptAgentCompletedIterations(agent)
    .filter((iteration) => iteration.index >= (agent.cycleStartIndex || 1))
    .length;
  const totalCompleted = promptAgentCompletedIterations(agent).length;
  const best = promptAgentBestIteration(agent);
  progress.textContent = `${completedCount} / ${agent.maxIterations} this run${totalCompleted > completedCount ? ` · ${totalCompleted} total` : ""}${best?.evaluation ? ` · best ${Math.round(best.evaluation.score)}` : ""}`;
  header.append(title, progress);
  card.appendChild(header);

  const goal = document.createElement("div");
  goal.className = "promptstudio-agent-goal";
  goal.textContent = agent.goal;
  card.appendChild(goal);

  if (agent.feedback.length) {
    const feedback = document.createElement("div");
    feedback.className = "promptstudio-agent-feedback";
    const feedbackTitle = document.createElement("strong");
    feedbackTitle.textContent = "User refinements";
    const feedbackList = document.createElement("ol");
    agent.feedback.forEach((entry) => {
      const item = document.createElement("li");
      item.textContent = entry.text;
      feedbackList.appendChild(item);
    });
    feedback.append(feedbackTitle, feedbackList);
    card.appendChild(feedback);
  }

  if (agent.rubric) {
    const rubric = document.createElement("details");
    rubric.className = "promptstudio-agent-rubric";
    const summary = document.createElement("summary");
    summary.textContent = `Acceptance rubric · ${agent.rubric.criteria.length} criteria`;
    const rubricSummary = document.createElement("p");
    rubricSummary.textContent = agent.rubric.summary;
    const list = document.createElement("ul");
    agent.rubric.criteria.forEach((criterion) => {
      const item = document.createElement("li");
      item.textContent = `${criterion.hard ? "Required" : "Preferred"} · ${criterion.description} (${criterion.weight})`;
      list.appendChild(item);
    });
    rubric.append(summary, rubricSummary, list);
    card.appendChild(rubric);
  }

  const iterations = document.createElement("div");
  iterations.className = "promptstudio-agent-iterations";
  for (const iteration of agent.iterations) {
    const item = document.createElement("article");
    item.className = "promptstudio-agent-iteration";
    item.dataset.best = iteration.id === agent.bestIterationId ? "true" : "false";
    const itemHeader = document.createElement("header");
    const itemTitle = document.createElement("strong");
    itemTitle.textContent = iteration.validation ? "Fresh-seed validation" : `Iteration ${iteration.index}`;
    const itemStatus = document.createElement("span");
    itemStatus.textContent = iteration.evaluation
      ? `${Math.round(iteration.evaluation.score)} / 100 · ${Math.round(iteration.evaluation.confidence * 100)}% confidence`
      : promptAgentStatusLabel({ status: iteration.status });
    itemHeader.append(itemTitle, itemStatus);
    item.appendChild(itemHeader);

    if (iteration.candidate) {
      const prompt = document.createElement("details");
      const promptSummary = document.createElement("summary");
      promptSummary.textContent = iteration.candidate.changeSummary || "Candidate prompt";
      const promptText = document.createElement("div");
      promptText.className = "promptstudio-agent-prompt";
      promptText.textContent = iteration.candidate.prompt;
      prompt.append(promptSummary, promptText);
      item.appendChild(prompt);
      for (const [label, guidance] of [
        ["Run-local style guidance", iteration.candidate.styleGuidance],
        ["Run-local framing guidance", iteration.candidate.framingGuidance],
      ]) {
        if (!guidance) continue;
        const detail = document.createElement("details");
        const detailSummary = document.createElement("summary");
        detailSummary.textContent = label;
        const detailText = document.createElement("div");
        detailText.className = "promptstudio-agent-prompt";
        detailText.textContent = guidance;
        detail.append(detailSummary, detailText);
        item.appendChild(detail);
      }
    }

    const generation = normalizeConsultExperimentGeneration(iteration.generation);
    if (generation?.images.length) {
      const gallery = document.createElement("div");
      gallery.className = "promptstudio-consult-message-images";
      generation.images.forEach((reference) => {
        const image = document.createElement("img");
        image.src = imageReferenceUrl(reference);
        image.alt = reference.filename || "Prompt Agent result";
        image.tabIndex = 0;
        image.addEventListener("click", () => openImageLightbox(image.src, image.alt, image));
        gallery.appendChild(image);
      });
      item.appendChild(gallery);
    }

    if (iteration.evaluation) {
      const verdict = document.createElement("details");
      verdict.className = "promptstudio-agent-verdict";
      const verdictSummary = document.createElement("summary");
      verdictSummary.textContent = iteration.evaluation.pass
        ? `Pass · ${iteration.evaluation.summary || "requirements satisfied"}`
        : `Refine · ${iteration.evaluation.summary || "requirements not yet satisfied"}`;
      const criteria = document.createElement("ul");
      iteration.evaluation.criteria.forEach((criterion) => {
        const row = document.createElement("li");
        row.dataset.status = criterion.status;
        row.textContent = `${criterion.status} · ${criterion.evidence || criterion.id}`;
        criteria.appendChild(row);
      });
      if (iteration.evaluation.nextRevision) {
        const next = document.createElement("p");
        next.textContent = `Next revision: ${iteration.evaluation.nextRevision}`;
        verdict.append(verdictSummary, criteria, next);
      } else {
        verdict.append(verdictSummary, criteria);
      }
      item.appendChild(verdict);
    }
    iterations.appendChild(item);
  }
  card.appendChild(iterations);

  if (agent.error) {
    const error = document.createElement("div");
    error.className = "promptstudio-agent-error";
    error.textContent = agent.error;
    card.appendChild(error);
  }

  const actions = document.createElement("div");
  actions.className = "promptstudio-agent-actions";
  if (agent.active) {
    const pause = document.createElement("button");
    pause.type = "button";
    pause.dataset.agentControl = "true";
    pause.textContent = agent.status === "paused" ? "Resume" : "Pause";
    pause.disabled = agent.status === "paused" && state.generating;
    pause.addEventListener("click", agent.status === "paused" ? resumeConsultAgent : pauseConsultAgent);
    const stop = document.createElement("button");
    stop.type = "button";
    stop.dataset.agentControl = "true";
    stop.textContent = "Stop";
    stop.addEventListener("click", stopConsultAgent);
    actions.append(pause, stop);
  } else if (agent.status === "error") {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry from checkpoint";
    retry.addEventListener("click", retryConsultAgent);
    actions.appendChild(retry);
  }
  if (best?.candidate) {
    const promote = document.createElement("button");
    promote.type = "button";
    promote.className = "promptstudio-primary";
    promote.textContent = "Promote best to Studio";
    promote.disabled = state.busy || state.consultBusy;
    promote.addEventListener("click", promotePromptAgentBest);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy best prompt";
    copy.disabled = state.busy || state.consultBusy;
    copy.addEventListener("click", copyPromptAgentBest);
    actions.append(promote, copy);
  }
  card.appendChild(actions);
  history.appendChild(card);
}

function renderConsultHistory() {
  const history = state.panel?.querySelector("#promptstudio-consult-history");
  if (!history) return;
  history.replaceChildren();
  const messages = activeChat()?.consultMessages || [];
  const agent = activeConsultAgent();
  if (agent) renderConsultAgentCard(history, agent);
  if (!messages.length && !agent) {
    const empty = document.createElement("div");
    empty.className = "promptstudio-consult-empty";
    empty.innerHTML = "<strong>Talk with your local model</strong><span>Ask a general question, or attach prompts, settings, generated results, and reference images for comparison.</span>";
    history.appendChild(empty);
    return;
  }
  for (const [messageIndex, message] of messages.entries()) {
    const bubble = document.createElement("article");
    bubble.className = `promptstudio-consult-message promptstudio-consult-message-${message.role}`;
    const body = document.createElement("div");
    body.className = "promptstudio-consult-message-text";
    body.textContent = message.text;
    bubble.appendChild(body);
    if (message.role === "assistant") renderConsultExperimentProposal(bubble, message);
    const attached = message.context?.attached_images || [];
    if (message.images.length) {
      const gallery = document.createElement("div");
      gallery.className = "promptstudio-consult-message-images";
      message.images.forEach((reference, index) => {
        const figure = document.createElement("figure");
        const image = document.createElement("img");
        image.src = imageReferenceUrl(reference);
        image.alt = attached[index]?.label || `Image ${index + 1}`;
        const caption = document.createElement("figcaption");
        caption.textContent = [attached[index]?.label, attached[index]?.purpose].filter(Boolean).join(" · ");
        figure.append(image, caption);
        gallery.appendChild(figure);
      });
      bubble.appendChild(gallery);
    }
    const tags = [];
    if (message.context?.main_prompt != null) tags.push("Main prompt");
    if (message.context?.final_prompt != null) tags.push("Final prompt");
    if (message.context?.current_generation_settings) tags.push("Current settings");
    if (tags.length) {
      const contextTags = document.createElement("div");
      contextTags.className = "promptstudio-consult-message-context";
      contextTags.textContent = `Attached: ${tags.join(", ")}`;
      bubble.appendChild(contextTags);
    }
    const currentExperimentId = activeConsultExperiment()?.id || "";
    const responseMatchesScope = currentExperimentId
      ? message.experimentId === currentExperimentId
      : !message.experimentId;
    if (message.role === "assistant" && messageIndex === messages.length - 1 && responseMatchesScope) {
      const variants = message.variants || [];
      const selectedIndex = Math.max(0, Math.min(message.variantIndex || 0, variants.length - 1));
      const controls = document.createElement("div");
      controls.className = "promptstudio-consult-response-controls";

      if (selectedIndex > 0) {
        const previous = document.createElement("button");
        previous.type = "button";
        previous.className = "promptstudio-consult-response-arrow";
        previous.setAttribute("aria-label", "Show previous answer");
        previous.title = "Show previous answer";
        previous.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 18-6-6 6-6"/></svg>';
        previous.addEventListener("click", () => selectConsultResponse(message.id, selectedIndex - 1));
        controls.appendChild(previous);
      } else {
        controls.appendChild(document.createElement("span"));
      }

      const position = document.createElement("span");
      position.className = "promptstudio-consult-response-position";
      position.textContent = variants.length > 1 ? `${selectedIndex + 1} / ${variants.length}` : "";
      controls.appendChild(position);

      const next = document.createElement("button");
      next.type = "button";
      next.className = "promptstudio-consult-response-arrow";
      const hasNewer = selectedIndex < variants.length - 1;
      next.setAttribute("aria-label", hasNewer ? "Show next answer" : "Regenerate answer");
      next.title = hasNewer ? "Show next answer" : "Regenerate answer";
      next.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 6 6 6-6 6"/></svg>';
      next.addEventListener("click", () => {
        if (hasNewer) selectConsultResponse(message.id, selectedIndex + 1);
        else regenerateConsultResponse(message.id);
      });
      controls.appendChild(next);
      bubble.appendChild(controls);
    }
    history.appendChild(bubble);
  }
  history.scrollTop = history.scrollHeight;
  updateConsultExperimentUi();
}

function selectConsultResponse(messageId, variantIndex) {
  if (state.consultBusy) return;
  const chat = activeChat();
  const message = chat?.consultMessages.find((item) => item.id === messageId);
  if (!chat || message?.role !== "assistant" || !message.variants?.[variantIndex]) return;
  const selectedAt = Date.now();
  message.variantIndex = variantIndex;
  message.text = message.variants[variantIndex].text;
  message.proposal = message.variants[variantIndex].proposal || null;
  message.generation = message.variants[variantIndex].generation || null;
  updateActiveConsultExperiment(message);
  message.updatedAt = selectedAt;
  chat.updatedAt = selectedAt;
  saveChats();
  renderConsultHistory();
  setConsultStatus(`Showing answer ${variantIndex + 1} of ${message.variants.length}.`, "ready");
}

async function requestConsultResponse(messages) {
  if (!state.apiConnected) throw new Error("ComfyUI is disconnected. Wait for it to reconnect before sending.");
  const generationSettings = collectConsultGenerationSettings();
  const experimentMode = Boolean(activeConsultExperiment());
  const response = await api.fetchApi("/promptstudio/prompt-studio/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...llmConnectionPayload(),
      ...generationSettings,
      experiment_mode: experimentMode,
      messages: consultRequestMessages(messages),
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Consultation failed (${response.status}).`);
  const answer = String(data.message || "").trim();
  if (!answer) throw new Error(`${llmProviderName()} returned an empty response.`);
  return parseConsultExperimentAnswer(answer, experimentMode);
}

async function regenerateConsultResponse(messageId) {
  if (state.consultBusy) return;
  const chat = activeChat();
  const messageIndex = chat?.consultMessages.findIndex((message) => message.id === messageId) ?? -1;
  const message = chat?.consultMessages[messageIndex];
  if (
    !chat
    || messageIndex !== chat.consultMessages.length - 1
    || message?.role !== "assistant"
    || chat.consultMessages[messageIndex - 1]?.role !== "user"
  ) return;

  setConsultBusy(true);
  setConsultStatus(`${llmProviderName()} is regenerating the answer…`, "working");
  try {
    const answer = await requestConsultResponse(chat.consultMessages.slice(0, messageIndex));
    const answeredAt = Date.now();
    message.variants.push({
      id: makeId(),
      text: answer.text,
      proposal: answer.proposal,
      generation: null,
      createdAt: answeredAt,
    });
    message.variantIndex = message.variants.length - 1;
    message.text = answer.text;
    message.proposal = answer.proposal;
    message.generation = null;
    updateActiveConsultExperiment(message);
    message.updatedAt = answeredAt;
    chat.updatedAt = answeredAt;
    saveChats();
    renderConsultHistory();
    setConsultStatus("Ready", "ready");
  } catch (error) {
    setConsultStatus(error.message || String(error), "error");
  } finally {
    setConsultBusy(false);
  }
}

async function sendConsultMessage() {
  if (!state.apiConnected) return setConsultStatus("ComfyUI is disconnected. Messages are paused.", "error");
  if (state.consultBusy) return;
  const chat = activeChat();
  const input = state.panel?.querySelector("#promptstudio-consult-input");
  if (!chat || !input) return;
  if (promptAgentModeEnabled(chat)) {
    const agent = activeConsultAgent(chat);
    if (agent?.active) {
      return setConsultStatus("Pause or stop the active Prompt Agent before adding feedback.", "warning");
    }
    return agent ? continueConsultAgent() : startConsultAgent();
  }
  const text = input.value.trim();
  const selectedImages = [...state.consultSelectedImages.values()].slice(0, 4);
  const experimentImage = consultExperimentLatestImage(chat);
  if (
    experimentImage
    && state.consultVisionAvailable === true
    && selectedImages.length < 4
    && !selectedImages.some((choice) => imageReferenceKey(choice.reference) === imageReferenceKey(experimentImage))
  ) {
    selectedImages.push({
      key: imageReferenceKey(experimentImage),
      reference: experimentImage,
      purpose: "generated result",
      uploaded: false,
    });
  }
  const context = consultAttachedContext(selectedImages);
  if (!text && !context && !selectedImages.length) {
    return setConsultStatus("Enter a message or attach context.", "warning");
  }
  if (selectedImages.length && state.consultVisionAvailable !== true) {
    return setConsultStatus(state.consultVisionReason || "The connected model cannot accept images.", "warning");
  }

  const now = Date.now();
  chat.consultMessages.push(normalizeConsultMessage({
    id: makeId(),
    role: "user",
    text,
    context,
    images: selectedImages.map((choice) => choice.reference),
    experimentId: activeConsultExperiment(chat)?.id || "",
    createdAt: now,
    updatedAt: now,
  }));
  chat.consultMessages = chat.consultMessages.slice(-100);
  chat.updatedAt = now;
  input.value = "";
  state.consultSelectedImages.clear();
  state.consultUploadedImages = [];
  state.panel.querySelectorAll(".promptstudio-consult-context-options input").forEach((control) => {
    control.checked = false;
  });
  saveChats();
  renderConsultHistory();
  renderConsultAttachments();
  setConsultBusy(true);
  setConsultStatus(`${llmProviderName()} is thinking…`, "working");
  try {
    const answer = await requestConsultResponse(chat.consultMessages);
    const answeredAt = Date.now();
    const assistantMessage = normalizeConsultMessage({
      id: makeId(),
      role: "assistant",
      text: answer.text,
      proposal: answer.proposal,
      experimentId: activeConsultExperiment(chat)?.id || "",
      createdAt: answeredAt,
      updatedAt: answeredAt,
    });
    chat.consultMessages.push(assistantMessage);
    updateActiveConsultExperiment(assistantMessage);
    chat.consultMessages = chat.consultMessages.slice(-100);
    chat.updatedAt = answeredAt;
    saveChats();
    renderConsultHistory();
    setConsultStatus("Ready", "ready");
  } catch (error) {
    setConsultStatus(error.message || String(error), "error");
  } finally {
    setConsultBusy(false);
  }
}

function clearConsultHistory() {
  const chat = activeChat();
  if (!chat || state.consultBusy) return;
  const input = state.panel?.querySelector("#promptstudio-consult-input");
  const contextControls = [
    ...state.panel?.querySelectorAll(".promptstudio-consult-context-options input") || [],
  ];
  const hasDraft = Boolean(input?.value.trim());
  const hasPendingContext = state.consultSelectedImages.size > 0
    || state.consultUploadedImages.length > 0
    || Boolean(activeConsultExperiment(chat))
    || Boolean(activeConsultAgent(chat))
    || contextControls.some((control) => control.checked);
  if (!chat.consultMessages.length && !hasDraft && !hasPendingContext) {
    setConsultStatus("Conversation is already clear.", "ready");
    return;
  }
  const view = state.panel?.ownerDocument.defaultView;
  if (!view?.confirm("Clear this assistant conversation, draft, and all pending context?")) return;
  const clearedAt = Date.now();
  chat.consultMessages = [];
  chat.consultClearedAt = clearedAt;
  chat.consultExperiment = null;
  chat.consultAgent = null;
  chat.consultAgentMode = false;
  chat.updatedAt = clearedAt;
  if (input) input.value = "";
  state.consultSelectedImages.clear();
  state.consultUploadedImages = [];
  contextControls.forEach((control) => {
    control.checked = false;
  });
  saveChats({ immediate: true });
  renderConsultHistory();
  renderConsultAttachments();
  updateConsultAttachmentSummary();
  updateConsultExperimentUi();
  setConsultStatus("Conversation cleared.", "ready");
}

async function importDroppedImage(file) {
  if (state.busy) return setStatus("Wait for the current operation to finish.", "warning");
  if (!chatAcceptsImageDrop()) {
    return setStatus("Image import is only available in a new, completely empty chat.", "warning");
  }
  if (!useLlmAmplification()) {
    const message = "Enable “Use LLM amplification” before dropping an image; captioning needs the selected LLM and prompt controls.";
    setStatus(message, "warning");
    setImageDropFeedback(message, "warning");
    return;
  }
  if (!file || typeof file !== "object" || typeof file.arrayBuffer !== "function") {
    const message = "Drop one image file to start the chat.";
    setStatus(message, "warning");
    setImageDropFeedback(message, "warning");
    return;
  }
  if (file.type && !file.type.startsWith("image/")) {
    const message = `“${file.name}” is not an image file.`;
    setStatus(message, "warning");
    setImageDropFeedback(message, "warning");
    return;
  }
  if (file.size <= 0 || file.size > MAX_DROPPED_IMAGE_BYTES) {
    const message = file.size > MAX_DROPPED_IMAGE_BYTES
      ? "The dropped image is larger than the 20 MB import limit."
      : "The dropped image is empty.";
    setStatus(message, "warning");
    setImageDropFeedback(message, "warning");
    return;
  }

  const operationToken = ++state.operationToken;
  setBusy(true);
  setStatus(`Checking ${llmProviderName()} vision support…`, "working");
  setImageDropFeedback(`Checking ${llmProviderName()} vision support…`, "working");
  try {
    await requireVisionCapability();
    if (operationToken !== state.operationToken) return;
    setStatus("Sanitizing and storing the image…", "working");
    setImageDropFeedback("Sanitizing and storing the image…", "working");
    const reference = await uploadPromptStudioImage(file);
    if (operationToken !== state.operationToken) return;
    setStatus(`${llmProviderName()} is reading the image…`, "working");
    setImageDropFeedback(`${llmProviderName()} is reading the image…`, "working");
    const mainPrompt = await requestImageCaption(reference);
    if (operationToken !== state.operationToken) return;
    setStatus(`${llmProviderName()} is applying the selected prompt style…`, "working");
    setImageDropFeedback(`${llmProviderName()} is applying the selected prompt style…`, "working");
    const finalPrompt = await requestPromptRevision(
      collectRevisionPayload(mainPrompt, "render", "", ""),
      "Image-prompt rendering",
    );
    if (operationToken !== state.operationToken) return;

    const chat = activeChat();
    if (!chat || !chatAcceptsImageDrop(chat)) {
      throw new Error("The active chat changed before the image caption was ready.");
    }
    updatePromptEditors(mainPrompt, finalPrompt);
    state.versions = [promptVersion()];
    state.versionIndex = 0;
    chat.initialized = true;
    chat.mainPromptDirty = false;
    chat.controlsFingerprint = controlsFingerprint();
    chat.pendingGeneration = null;
    chat.selectedSource = reference;
    syncActiveChat();
    refreshEmptyImageDropZone();
    appendMessage("assistant", "", {
      label: "Imported image",
      images: [reference],
      mainPrompt,
      canonicalPrompt: finalPrompt,
      executionPrompt: finalPrompt,
      controlsFingerprint: chat.controlsFingerprint,
      llmAmplified: true,
    });
    updateComposeMode();
    refreshRenderedImageSources();
    setStatus("Image captioned and selected as the editing source.", "ready");
  } catch (error) {
    if (operationToken !== state.operationToken) return;
    const message = error.message || String(error);
    setStatus(message, "error");
    setImageDropFeedback(message, "error");
  } finally {
    if (operationToken === state.operationToken) setBusy(false);
  }
}

function importSelectedImageFiles(fileList) {
  const files = [...(fileList || [])];
  if (files.length !== 1) {
    const message = files.length
      ? "Drop exactly one image into an empty chat."
      : "The drop did not contain an image file.";
    setStatus(message, "warning");
    setImageDropFeedback(message, "warning");
    return;
  }
  importDroppedImage(files[0]);
}

async function reviseAndMaybeGenerate({
  controlsOnly = false,
  forceGenerate = false,
  regenerateFinal = false,
  generationAction = selectedAction(),
  revisionOverride = null,
  recordRevision = true,
} = {}) {
  if (!state.apiConnected) return setStatus("ComfyUI is disconnected. Prompt Studio is frozen.", "error");
  if (state.busy) return;
  if (!useLlmAmplification()) return generateDirectPrompt(generationAction);
  const input = state.panel.querySelector("#promptstudio-revision");
  let revision = revisionOverride == null ? input.value.trim() : String(revisionOverride).trim();
  const creating = !activeChat()?.initialized;
  const pastedContextImage = normalizeImageReference(state.mainPastedImage);
  if (!revision && pastedContextImage) {
    revision = creating
      ? "Create an image inspired by the attached visual reference."
      : "Make the current prompt visually closer to the attached reference image.";
  }
  if (creating && !revision) revision = state.mainPrompt.trim();
  if (!selectedWorkflowProfile(generationAction)) {
    return setStatus("Select a compatible [PS] workflow first.", "warning");
  }
  if (generationAction === "edit" && !editingSource()) {
    return setStatus("There is no image in this conversation to edit.", "warning");
  }
  if (creating && !revision) return setStatus("Describe an image to create the first prompt.", "warning");
  if (!creating && !state.currentPrompt.trim()) return setStatus("The final prompt is empty.", "warning");
  if (!creating && !state.mainPrompt.trim()) return setStatus("The main prompt is empty.", "warning");
  const contextImage = pastedContextImage || (
    state.panel.querySelector("#promptstudio-use-latest-image-context")?.checked
      ? latestGeneratedImage()
      : null
  );

  const promptNeedsRebuild = !creating && promptNeedsRender();
  controlsOnly = !creating && (controlsOnly || (!revision && promptNeedsRebuild));
  if (!revision && !controlsOnly) return createNewFromCurrentPrompt({ applyControls: false, generationAction });
  if (!creating) commitPromptEditorVersion();
  if (revision && !controlsOnly && recordRevision) {
    appendMessage("user", revision, {
      images: pastedContextImage ? [pastedContextImage] : [],
    });
    input.value = "";
    updateComposeMode();
  }
  saveSettings();
  const operationToken = ++state.operationToken;
  setBusy(true);
  const revisionStatus = (
    creating
      ? `${llmProviderName()} is rendering the initial final prompt...`
      : regenerateFinal
        ? `${llmProviderName()} is regenerating the final prompt...`
        : controlsOnly || promptNeedsRebuild
        ? `${llmProviderName()} is rebuilding the final prompt from the main prompt and controls...`
        : `${llmProviderName()} is revising the main and final prompts...`
  );
  setStatus(
    contextImage ? `${llmProviderName()} is checking image support...` : revisionStatus,
    "working",
  );
  const requestedControlsFingerprint = controlsFingerprint();
  const previousMainPrompt = state.mainPrompt;
  const previousFinalPrompt = state.currentPrompt;
  let generationOptions = null;

  try {
    if (contextImage) {
      await requireVisionCapability();
      if (operationToken !== state.operationToken) return;
      setStatus(revisionStatus, "working");
    }
    let mainPrompt;
    let finalPrompt;
    if (creating) {
      mainPrompt = revision;
      finalPrompt = await requestPromptRevision(
        collectRevisionPayload(mainPrompt, "render", "", "", contextImage),
        "Prompt rendering",
      );
    } else if (controlsOnly) {
      mainPrompt = previousMainPrompt;
      finalPrompt = await requestPromptRevision(
        collectRevisionPayload(mainPrompt, "render", "", previousFinalPrompt, contextImage),
        "Control update",
      );
    } else if (promptNeedsRebuild) {
      mainPrompt = await requestPromptRevision(
        collectRevisionPayload(revision, "revise_main", previousMainPrompt, previousFinalPrompt, contextImage),
        "Main-prompt revision",
      );
      if (operationToken !== state.operationToken) return;
      finalPrompt = await requestPromptRevision(
        collectRevisionPayload(mainPrompt, "render", "", previousFinalPrompt, contextImage),
        "Final-prompt rendering",
      );
    } else {
      [mainPrompt, finalPrompt] = await Promise.all([
        requestPromptRevision(
          collectRevisionPayload(revision, "revise_main", previousMainPrompt, previousFinalPrompt, contextImage),
          "Main-prompt revision",
        ),
        requestPromptRevision(
          collectRevisionPayload(revision, "revise", previousFinalPrompt, previousFinalPrompt, contextImage),
          "Final-prompt revision",
        ),
      ]);
    }
    if (operationToken !== state.operationToken) return;

    const chat = activeChat();
    updatePromptEditors(mainPrompt, finalPrompt);
    if (creating) {
      state.versions = [promptVersion()];
      state.versionIndex = 0;
      if (chat) chat.initialized = true;
      syncActiveChat();
      updateComposeMode();
    } else {
      pushVersion();
    }
    if (
      pastedContextImage
      && imageReferenceKey(state.mainPastedImage) === imageReferenceKey(pastedContextImage)
    ) {
      clearMainPastedImage();
    }
    if (chat) {
      chat.controlsFingerprint = requestedControlsFingerprint;
      chat.mainPromptDirty = false;
      chat.pendingGeneration = {
        action: generationAction,
        mainPrompt,
        canonicalPrompt: finalPrompt,
        executionPrompt: generationAction === "edit"
          && selectedEditPromptMode() === "edit_instruction"
          && revision
          ? revision
          : finalPrompt,
        workflowProfileId: selectedWorkflowProfileId(generationAction),
      };
      saveChats();
    }
    setStatus(
      creating
        ? "Initial main and final prompts created."
        : regenerateFinal
          ? "Final prompt regenerated."
          : "Main and final prompts updated.",
      "ready",
    );
    if (forceGenerate || state.panel.querySelector("#promptstudio-auto-generate")?.checked) {
      const executionPrompt = chat?.pendingGeneration?.executionPrompt || finalPrompt;
      generationOptions = {
        action: generationAction,
        executionPrompt,
        mainPrompt,
        finalPrompt,
        preserveSeed: true,
        forceNewSeed: regenerateFinal,
      };
      await queueGeneration(generationOptions);
    } else {
      setBusy(false);
    }
  } catch (error) {
    if (operationToken !== state.operationToken) return;
    const message = error.message || String(error);
    appendMessage("system", message);
    if (generationOptions) {
      showGenerationFailure(message, () => retryGeneration(generationOptions));
    } else {
      showGenerationFailure(message, () => reviseAndMaybeGenerate({
        controlsOnly,
        forceGenerate,
        regenerateFinal,
        generationAction,
        revisionOverride: revision,
        recordRevision: false,
      }));
    }
  }
}

async function createNewFromCurrentPrompt({ applyControls = true, generationAction = selectedAction() } = {}) {
  if (state.busy) return;
  const lastGeneration = activeChat()?.lastGeneration;
  const pendingGeneration = activeChat()?.pendingGeneration;
  const selectedProfileId = selectedWorkflowProfileId(generationAction);
  const pendingGenerationMatches = pendingGeneration?.action === generationAction
    && pendingGeneration.mainPrompt === state.mainPrompt
    && pendingGeneration.canonicalPrompt === state.currentPrompt
    && pendingGeneration.workflowProfileId === selectedProfileId;
  const replayStoredGeneration = Boolean(
    pendingGenerationMatches
    && pendingGeneration?.generationSnapshot
    && pendingGeneration.replayFingerprint
    && pendingGeneration.replayFingerprint === generationUiFingerprint(),
  );
  const usePendingGeneration = pendingGenerationMatches
    && (!pendingGeneration?.generationSnapshot || replayStoredGeneration);
  const repeatLastConfiguration = !usePendingGeneration
    && lastGeneration?.action === generationAction
    && lastGeneration.mainPrompt === state.mainPrompt
    && lastGeneration.canonicalPrompt === state.currentPrompt
    && String(lastGeneration?.workflowProfileId || "") === selectedProfileId;
  if (!useLlmAmplification() && !replayStoredGeneration) return generateDirectPrompt(generationAction);
  if (!activeChat()?.initialized) return setStatus("Create the first prompt before creating another image.", "warning");
  if (!replayStoredGeneration && applyControls && promptNeedsRender()) {
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
  const generationOptions = {
    action: generationAction,
    executionPrompt: usePendingGeneration
      ? (pendingGeneration.executionPrompt || state.currentPrompt)
      : repeatLastConfiguration
        ? (lastGeneration.executionPrompt || state.currentPrompt)
        : state.currentPrompt,
    preserveSeed: replayStoredGeneration || promptChanged,
    workflowProfileId: replayStoredGeneration ? pendingGeneration.workflowProfileId : null,
    loraState: replayStoredGeneration ? pendingGeneration.loraState : null,
    modelState: replayStoredGeneration ? pendingGeneration.modelState : null,
    generationSnapshot: replayStoredGeneration ? pendingGeneration.generationSnapshot : null,
    workflowName: replayStoredGeneration ? pendingGeneration.workflowName : "",
    sourceImage: replayStoredGeneration
      ? pendingGeneration.sourceImage
      : repeatLastConfiguration ? lastGeneration.sourceImage : null,
    upscaleFactor: replayStoredGeneration ? pendingGeneration.upscaleFactor : null,
    resultNodeIds: replayStoredGeneration ? pendingGeneration.resultNodeIds : null,
    resultFields: replayStoredGeneration ? pendingGeneration.resultFields : null,
  };
  try {
    await queueGeneration(generationOptions);
  } catch (error) {
    const message = error.message || String(error);
    showGenerationFailure(message, () => retryGeneration(generationOptions));
  }
}

async function reroll({ generationAction = selectedAction() } = {}) {
  if (state.busy) return;
  if (!useLlmAmplification()) return generateDirectPrompt(generationAction);
  if (!activeChat()?.initialized) return setStatus("Create the first prompt before rerolling.", "warning");
  return reviseAndMaybeGenerate({
    controlsOnly: true,
    forceGenerate: true,
    regenerateFinal: true,
    generationAction,
  });
}

function undoPrompt() {
  if (state.busy || state.versionIndex <= 0) return;
  state.versionIndex -= 1;
  const version = state.versions[state.versionIndex];
  const chat = activeChat();
  if (chat) {
    chat.mainPromptDirty = false;
    chat.pendingGeneration = null;
  }
  updatePromptEditors(version.mainPrompt, version.finalPrompt);
  syncActiveChat();
  updateComposeMode();
  appendMessage("system", `Restored prompt version ${state.versionIndex + 1}.`);
  state.panel.querySelector("#promptstudio-undo").disabled = state.versionIndex <= 0;
}

async function interrupt() {
  if (activeConsultAgent()?.active) return stopConsultAgent();
  state.operationToken += 1;
  state.pollToken += 1;
  const interruptedPromptId = state.activeGenerationPromptId;
  const consultTarget = state.consultGenerationTarget;
  try {
    if (state.generating || state.queueing) {
      if (typeof api.interrupt === "function") await api.interrupt();
      else await api.fetchApi("/interrupt", { method: "POST" });
      const pending = pendingGenerationMessage(interruptedPromptId);
      if (pending) markGenerationAttemptFailed(messageElement(pending.id), "Generation interrupted.");
      if (consultTarget) {
        const chat = activeChat();
        const message = chat?.consultMessages.find((entry) => entry.id === consultTarget.messageId);
        const variant = message?.variants?.find((entry) => entry.id === consultTarget.variantId);
        const generation = normalizeConsultExperimentGeneration(variant?.generation) || {};
        setConsultExperimentGeneration(consultTarget.messageId, consultTarget.variantId, {
          ...generation,
          generationState: "error",
          text: "Generation interrupted.",
          updatedAt: Date.now(),
        });
        setConsultStatus("Experimental generation interrupted.", "warning");
      }
      setStatus(state.queueing ? "Queue cancellation requested." : "Generation interrupt requested.", "warning");
    } else {
      setStatus("Prompt revision cancelled.", "warning");
    }
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    state.activeGenerationPromptId = "";
    state.consultGenerationTarget = null;
    state.generating = false;
    setBusy(false);
    setConsultBusy(false);
  }
}

function buildPanel() {
  const settings = getSettings();
  const consultSettings = getConsultSettings();
  const panel = document.createElement("section");
  panel.id = "promptstudio-prompt-studio";
  panel.hidden = true;
  panel.innerHTML = `
    <div id="promptstudio-api-connection" class="promptstudio-api-connection" role="alert" hidden>
      <span aria-hidden="true"></span>
      <strong>ComfyUI disconnected</strong>
      <small>Prompt Studio is frozen until the API connection returns.</small>
    </div>
    <aside class="promptstudio-chat-sidebar">
      <div class="promptstudio-chat-sidebar-header">
        <div class="promptstudio-chat-sidebar-title">
          <div><span>Prompt Studio</span><strong>Sessions</strong></div>
          <button id="promptstudio-close-chats" class="promptstudio-mobile-drawer-close" type="button">Done</button>
        </div>
        <button id="promptstudio-new-chat" type="button">New chat</button>
      </div>
      <div id="promptstudio-chat-list" class="promptstudio-chat-list"></div>
    </aside>
    <main class="promptstudio-main">
      <header class="promptstudio-mobile-header">
        <strong>Prompt Studio</strong>
        <div class="promptstudio-mobile-header-actions">
          <button id="promptstudio-mobile-toggle-consult" class="promptstudio-consult-toggle promptstudio-standalone-only" type="button" title="Talk with the local model" aria-label="Talk with the local model" aria-expanded="false">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v10H9l-4 4V5Z" /></svg>
          </button>
          <button id="promptstudio-mobile-toggle-chats" type="button" data-promptstudio-drawer="chats" aria-expanded="false">Chats</button>
          <button id="promptstudio-mobile-toggle-inspector" type="button" data-promptstudio-drawer="inspector" aria-expanded="false">Controls</button>
          <button id="promptstudio-mobile-close" type="button" title="Close Prompt Studio" aria-label="Close Prompt Studio">×</button>
        </div>
      </header>
      <div id="promptstudio-history" class="promptstudio-history"></div>
      <input id="promptstudio-image-import" type="file" accept="image/*" hidden />
      <div class="promptstudio-compose">
        <div class="promptstudio-compose-heading">
          <strong id="promptstudio-compose-title">Describe the next change</strong>
          <span id="promptstudio-status" class="promptstudio-status" role="status" aria-live="polite">Loading…</span>
          <span id="promptstudio-compose-hint">Leave empty to create from the current prompt</span>
        </div>
        <textarea id="promptstudio-revision" rows="3" placeholder="Make the background more varied…" title="Paste an image with Ctrl+V to attach it as a visual reference."></textarea>
        <div id="promptstudio-pasted-image" class="promptstudio-pasted-image" hidden>
          <img alt="" />
          <span><strong>Pasted reference</strong><small></small></span>
          <button type="button" title="Remove pasted reference" aria-label="Remove pasted reference" data-disable-busy>×</button>
        </div>
        <div class="promptstudio-compose-footer">
          <div class="promptstudio-toggles">
            <label class="promptstudio-auto-generate-toggle"><input id="promptstudio-auto-generate" type="checkbox" ${settings.auto_generate ? "checked" : ""} /> Generate after revision</label>
            <label id="promptstudio-latest-image-context-control" class="promptstudio-image-context-toggle" data-available="false">
              <input id="promptstudio-use-latest-image-context" type="checkbox" ${settings.use_latest_image_context ? "checked" : ""} />
              Use latest image for LLM
            </label>
            <label><input id="promptstudio-randomize-seed" type="checkbox" ${settings.randomize_seed ? "checked" : ""} /> New seed on create / reroll</label>
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
            <button id="promptstudio-reroll" type="button" title="Regenerate the final prompt and create a new image" data-disable-busy>Reroll</button>
            <button id="promptstudio-send" class="promptstudio-primary" type="button" data-disable-busy>Create new</button>
          </div>
        </div>
      </div>
    </main>
    <aside class="promptstudio-inspector">
      <header class="promptstudio-header">
        <div class="promptstudio-brand">
          <img class="promptstudio-brand-mark" src="${ICON_URL}" alt="" aria-hidden="true" />
          <div><strong>Prompt Studio</strong><span>by tiko13</span></div>
        </div>
        <div class="promptstudio-header-actions">
          <button id="promptstudio-toggle-chats" class="promptstudio-chats-button" type="button" title="Show chats" aria-label="Show chats" data-promptstudio-drawer="chats" aria-expanded="false">Sessions</button>
          <button id="promptstudio-toggle-consult" class="promptstudio-consult-toggle promptstudio-standalone-only" type="button" title="Talk with the local model" aria-label="Talk with the local model" aria-expanded="false">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v10H9l-4 4V5Z" /></svg>
          </button>
          <button id="promptstudio-popout" type="button" title="Open Prompt Studio in its own tab" aria-label="Open Prompt Studio in its own tab">↗</button>
          <button id="promptstudio-toggle-studio-settings" type="button" title="Prompt Studio settings" aria-label="Prompt Studio settings" aria-expanded="false">⚙</button>
          <button id="promptstudio-close-inspector" class="promptstudio-mobile-drawer-close" type="button">Done</button>
          <button id="promptstudio-close" type="button" title="Close Prompt Studio" aria-label="Close Prompt Studio">×</button>
        </div>
      </header>
      <section class="promptstudio-mode-control">
        <label>
          <input id="promptstudio-use-llm-amplification" type="checkbox" ${settings.use_llm_amplification ? "checked" : ""} />
          <span><strong>Use LLM amplification</strong><small id="promptstudio-llm-amplification-help">Rewrite prompts through ${settings.llm_provider === "ollama" ? "Ollama" : "KoboldCpp"}</small></span>
        </label>
      </section>
      <section class="promptstudio-control-deck">
        <details class="promptstudio-current-details" open>
          <summary><span>Main prompt</span><small>Editable source intent</small></summary>
          <textarea id="promptstudio-main-prompt" rows="5" placeholder="The user's model-neutral image description"></textarea>
        </details>
        <details class="promptstudio-current-details" open>
          <summary><span>Final prompt</span><small>Editable; rebuilt when controls change</small></summary>
          <textarea id="promptstudio-current-prompt" rows="8" placeholder="The rendered prompt sent to the selected workflow"></textarea>
        </details>
        <details class="promptstudio-settings" open>
          <summary><span>Generation controls</span><small>Model, style and prompt shaping</small></summary>
          <div class="promptstudio-settings-grid">
            <label class="promptstudio-control-wide">Model profile<select id="promptstudio-profile"></select></label>
            <label>Style<select id="promptstudio-style"></select></label>
            <label>Framing<select id="promptstudio-framing"></select></label>
            <label>Embellishment<select id="promptstudio-embellishment"></select></label>
            <label id="promptstudio-thinking-control" title="Controls local-LLM reasoning effort.">Thinking<select id="promptstudio-thinking"></select></label>
            <label class="promptstudio-control-wide">Style modifier<textarea id="promptstudio-style-modifier" rows="2"></textarea></label>
            <label class="promptstudio-control-wide">Framing modifier<textarea id="promptstudio-framing-modifier" rows="2"></textarea></label>
            <label id="promptstudio-token-control" title="Final-answer allowance; 0 uses the selected profile default.">Final-answer tokens<input id="promptstudio-max-tokens" type="number" min="0" max="8192" /></label>
            <label>Temperature<input id="promptstudio-temperature" type="number" min="0" max="5" step="0.05" /></label>
          </div>
        </details>
        <details id="promptstudio-lora-details" class="promptstudio-lora-details" open hidden>
          <summary>
            <span>LoRA</span>
            <span class="promptstudio-lora-summary-tools">
              <small id="promptstudio-lora-summary">0 selected</small>
              <button id="promptstudio-refresh-loras" type="button" title="Refresh LoRAs" aria-label="Refresh LoRAs">↻</button>
            </span>
          </summary>
          <div id="promptstudio-lora-groups" class="promptstudio-lora-groups"></div>
        </details>
        <details id="promptstudio-model-details" class="promptstudio-model-details" open hidden>
          <summary>
            <span>Model</span>
            <span class="promptstudio-lora-summary-tools">
              <small id="promptstudio-model-summary">0 loaders</small>
              <button id="promptstudio-refresh-models" type="button" title="Refresh models" aria-label="Refresh models">↻</button>
            </span>
          </summary>
          <div id="promptstudio-model-groups" class="promptstudio-lora-groups"></div>
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
    <button class="promptstudio-mobile-scrim" type="button" aria-label="Close open drawer"></button>
    <div id="promptstudio-studio-settings" class="promptstudio-studio-settings" hidden>
      <header class="promptstudio-studio-settings-header">
        <div><strong>Settings</strong><span>Configure Prompt Studio, local services and ComfyUI workflows.</span></div>
        <span class="promptstudio-studio-settings-context">Prompt Studio</span>
      </header>
      <div class="promptstudio-studio-settings-layout">
        <section class="promptstudio-studio-settings-card" aria-labelledby="promptstudio-general-settings-title">
          <header class="promptstudio-studio-settings-card-header">
            <div><strong id="promptstudio-general-settings-title">General</strong><span>Connection, chat display and editing behavior</span></div>
          </header>
          <div class="promptstudio-studio-settings-list">
            <label class="promptstudio-studio-setting promptstudio-endpoint-control">
              <span class="promptstudio-studio-setting-copy"><strong>LLM provider</strong><small>Choose the local service used to rewrite prompts.</small></span>
              <select id="promptstudio-llm-provider" aria-label="LLM provider">
                <option value="koboldcpp" ${settings.llm_provider !== "ollama" ? "selected" : ""}>KoboldCpp</option>
                <option value="ollama" ${settings.llm_provider === "ollama" ? "selected" : ""}>Ollama</option>
              </select>
            </label>
            <label class="promptstudio-studio-setting promptstudio-endpoint-control" data-llm-provider="koboldcpp">
              <span class="promptstudio-studio-setting-copy"><strong>KoboldCpp endpoint</strong><small>Base URL for the local generation server.</small></span>
              <input id="promptstudio-kobold-url" type="url" inputmode="url" spellcheck="false" aria-label="KoboldCpp endpoint" />
            </label>
            <label class="promptstudio-studio-setting promptstudio-endpoint-control" data-llm-provider="ollama">
              <span class="promptstudio-studio-setting-copy"><strong>Ollama endpoint</strong><small>Base URL for the local Ollama server.</small></span>
              <input id="promptstudio-ollama-url" type="url" inputmode="url" spellcheck="false" aria-label="Ollama endpoint" />
            </label>
            <label class="promptstudio-studio-setting promptstudio-endpoint-control" data-llm-provider="ollama">
              <span class="promptstudio-studio-setting-copy"><strong>Ollama model</strong><small>Select a model installed in Ollama.</small></span>
              <span class="promptstudio-ollama-model-field">
                <select id="promptstudio-ollama-model" aria-label="Ollama model"></select>
                <button id="promptstudio-refresh-ollama-models" type="button" title="Refresh Ollama models" aria-label="Refresh Ollama models">â†»</button>
              </span>
            </label>
            <label class="promptstudio-studio-setting promptstudio-image-scale-control">
              <span class="promptstudio-studio-setting-copy"><strong>Image scale</strong><small>Scale generated images in chat. Full-size preview is unchanged.</small></span>
              <span class="promptstudio-image-scale-field">
                <output id="promptstudio-image-scale-value" for="promptstudio-image-scale">100%</output>
                <input id="promptstudio-image-scale" type="range" min="10" max="100" step="5" value="${settings.image_scale}" />
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
    <section id="promptstudio-consult" class="promptstudio-consult" aria-labelledby="promptstudio-consult-title" hidden>
      <header class="promptstudio-consult-header">
        <div>
          <strong id="promptstudio-consult-title">Local model chat</strong>
          <span>Discuss prompts, settings, and images. Consultation history expires after 7 days.</span>
        </div>
        <div class="promptstudio-consult-header-actions">
          <button id="promptstudio-consult-clear" type="button">Clear</button>
          <button id="promptstudio-consult-close" type="button" title="Close chat" aria-label="Close chat">×</button>
        </div>
      </header>
      <div id="promptstudio-consult-experiment" class="promptstudio-consult-experiment-banner" hidden>
        <span>Prompt experiment</span>
        <button id="promptstudio-consult-end-experiment" type="button">End</button>
      </div>
      <div id="promptstudio-consult-history" class="promptstudio-consult-history"></div>
      <section id="promptstudio-consult-attachments" class="promptstudio-consult-attachments" hidden>
        <div class="promptstudio-consult-context-options">
          <div class="promptstudio-consult-section-heading">
            <div><strong>Studio context</strong><span>Include a snapshot with your next message</span></div>
            <div class="promptstudio-consult-mode-actions">
              <button id="promptstudio-consult-start-experiment" type="button">Start prompt experiment</button>
              <label class="promptstudio-agent-rounds" title="Maximum autonomous prompt iterations before stopping">
                <span>Rounds</span>
                <input id="promptstudio-agent-max-iterations" type="number" min="1" max="${PROMPT_AGENT_MAX_ITERATIONS}" step="1" value="${PROMPT_AGENT_DEFAULT_MAX_ITERATIONS}" />
              </label>
            </div>
          </div>
          <div class="promptstudio-consult-context-grid">
            <label class="promptstudio-consult-context-card">
              <input id="promptstudio-consult-attach-main" type="checkbox" />
              <span class="promptstudio-consult-context-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 4h10M7 9h10M7 14h7M5 20h14V2H5v18Z" /></svg></span>
              <span class="promptstudio-consult-context-copy"><strong>Main prompt</strong><small>Original scene intent</small></span>
              <span class="promptstudio-consult-context-check" aria-hidden="true">✓</span>
            </label>
            <label class="promptstudio-consult-context-card">
              <input id="promptstudio-consult-attach-final" type="checkbox" />
              <span class="promptstudio-consult-context-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m6 13 3 3 9-10M5 20h14V2H5v18Z" /></svg></span>
              <span class="promptstudio-consult-context-copy"><strong>Final prompt</strong><small>Exact rendered prompt</small></span>
              <span class="promptstudio-consult-context-check" aria-hidden="true">✓</span>
            </label>
            <label class="promptstudio-consult-context-card">
              <input id="promptstudio-consult-attach-settings" type="checkbox" />
              <span class="promptstudio-consult-context-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6" /></svg></span>
              <span class="promptstudio-consult-context-copy"><strong>Generation settings</strong><small>Preset text, workflow and model</small></span>
              <span class="promptstudio-consult-context-check" aria-hidden="true">✓</span>
            </label>
          </div>
        </div>
        <div class="promptstudio-consult-image-picker">
          <div class="promptstudio-consult-image-picker-heading">
            <div><strong>Images</strong><span id="promptstudio-consult-vision-status"></span></div>
          </div>
          <div class="promptstudio-consult-image-strip">
            <div id="promptstudio-consult-image-list" class="promptstudio-consult-image-list"></div>
            <button id="promptstudio-consult-upload" class="promptstudio-consult-upload-target" type="button" aria-label="Upload or drop a reference image">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M5 13v6h14v-6" /></svg>
              <strong>Drop reference</strong>
              <span>or click to browse</span>
            </button>
          </div>
        </div>
      </section>
      <section id="promptstudio-consult-generation-settings" class="promptstudio-consult-generation-settings" hidden>
        <div class="promptstudio-consult-section-heading">
          <strong>Chat generation settings</strong>
          <span>Used only for this assistant conversation</span>
        </div>
        <div class="promptstudio-consult-generation-grid">
          <label title="Controls the local model's private reasoning effort.">Thinking
            <select id="promptstudio-consult-thinking">
              ${["Disabled", "Minimal", "Low", "Medium", "High"].map((value) => `<option value="${value}" ${consultSettings.thinking_mode === value ? "selected" : ""}>${value}</option>`).join("")}
            </select>
          </label>
          <label title="Maximum final-answer tokens returned by the chat model.">Response tokens
            <input id="promptstudio-consult-max-tokens" type="number" min="1" max="8192" step="1" value="${Math.max(1, Math.min(8192, Number(consultSettings.max_response_tokens) || 800))}" />
          </label>
          <label>Temperature
            <input id="promptstudio-consult-temperature" type="number" min="0" max="5" step="0.05" value="${consultSettings.temperature}" />
          </label>
          <label>Top P
            <input id="promptstudio-consult-top-p" type="number" min="0" max="1" step="0.01" value="${consultSettings.top_p}" />
          </label>
          <label>Top K
            <input id="promptstudio-consult-top-k" type="number" min="0" max="200" step="1" value="${consultSettings.top_k}" />
          </label>
          <label>Min P
            <input id="promptstudio-consult-min-p" type="number" min="0" max="1" step="0.01" value="${consultSettings.min_p}" />
          </label>
          <label>Repeat penalty
            <input id="promptstudio-consult-rep-pen" type="number" min="0.5" max="3" step="0.01" value="${consultSettings.rep_pen}" />
          </label>
          <label>Repeat range
            <input id="promptstudio-consult-rep-pen-range" type="number" min="0" max="4096" step="1" value="${consultSettings.rep_pen_range}" />
          </label>
          <label title="-1 asks the provider to choose a random seed.">Seed
            <input id="promptstudio-consult-seed" type="number" min="-1" max="999999" step="1" value="${consultSettings.sampler_seed}" />
          </label>
        </div>
      </section>
      <footer class="promptstudio-consult-compose">
        <div class="promptstudio-consult-compose-tools">
          <button id="promptstudio-consult-toggle-agent" type="button" aria-pressed="false" title="Send the composer text as a Prompt Agent goal or follow-up correction">Prompt agent</button>
          <button id="promptstudio-consult-toggle-attachments" type="button" aria-expanded="false">Attach context</button>
          <button id="promptstudio-consult-toggle-generation-settings" type="button" aria-expanded="false">Gen settings</button>
          <span id="promptstudio-consult-attachment-summary">No context attached</span>
          <span id="promptstudio-consult-status" class="promptstudio-consult-status" role="status" aria-live="polite">Ready</span>
        </div>
        <div class="promptstudio-consult-input-row">
          <textarea id="promptstudio-consult-input" rows="3" placeholder="Ask your local model… Paste screenshots with Ctrl+V."></textarea>
          <button id="promptstudio-consult-send" class="promptstudio-primary" type="button">Send</button>
        </div>
      </footer>
      <input id="promptstudio-consult-file" type="file" accept="image/*" hidden />
    </section>
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
    </div>
    <div id="promptstudio-generation-failure-dialog" class="promptstudio-generation-failure-dialog" role="dialog" aria-modal="true" aria-labelledby="promptstudio-generation-failure-title" aria-describedby="promptstudio-generation-failure-message promptstudio-generation-failure-help" hidden>
      <div class="promptstudio-generation-failure-card">
        <strong id="promptstudio-generation-failure-title">Generation failed</strong>
        <p id="promptstudio-generation-failure-message" class="promptstudio-generation-failure-message"></p>
        <p id="promptstudio-generation-failure-help">If you fixed the underlying problem, you can try the same generation again.</p>
        <div class="promptstudio-generation-failure-actions">
          <button id="promptstudio-generation-failure-cancel" type="button">Cancel</button>
          <button id="promptstudio-generation-failure-retry" class="promptstudio-primary" type="button">Yes, Generate</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(panel);
  state.panel = panel;
  DISCONNECTED_ALLOWED_CONTROL_IDS.forEach((id) => {
    panel.querySelector(`#${id}`)?.setAttribute("data-promptstudio-allow-disconnected", "true");
  });
  panel.querySelector(".promptstudio-mobile-scrim")?.setAttribute("data-promptstudio-allow-disconnected", "true");
  installTypeAnywhereFocus(panel.ownerDocument);
  const history = panel.querySelector("#promptstudio-history");
  const imageImport = panel.querySelector("#promptstudio-image-import");
  const carriesFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
  history.addEventListener("dragenter", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    state.dragDepth += 1;
    history.dataset.dragActive = chatAcceptsImageDrop() ? "true" : "refused";
  });
  history.addEventListener("dragover", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = chatAcceptsImageDrop() ? "copy" : "none";
  });
  history.addEventListener("dragleave", (event) => {
    if (!state.dragDepth) return;
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (!state.dragDepth) history.dataset.dragActive = "false";
  });
  history.addEventListener("drop", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    state.dragDepth = 0;
    history.dataset.dragActive = "false";
    if (!chatAcceptsImageDrop()) {
      setStatus("Image import is only available in a new, completely empty chat.", "warning");
      return;
    }
    importSelectedImageFiles(event.dataTransfer?.files);
  });
  imageImport.addEventListener("change", () => {
    importSelectedImageFiles(imageImport.files);
    imageImport.value = "";
  });

  panel.querySelector("#promptstudio-kobold-url").value = settings.kobold_url;
  panel.querySelector("#promptstudio-ollama-url").value = settings.ollama_url;
  if (settings.ollama_model) {
    const option = document.createElement("option");
    option.value = settings.ollama_model;
    option.textContent = settings.ollama_model;
    panel.querySelector("#promptstudio-ollama-model").appendChild(option);
  }
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
  syncLlmProviderControls();
  updateAmplificationMode({ announce: false, persist: false });
  panel.querySelector("#promptstudio-toggle-chats").addEventListener("click", () => setPanelDrawer("chats"));
  panel.querySelector("#promptstudio-mobile-toggle-chats").addEventListener("click", () => setPanelDrawer("chats"));
  panel.querySelector("#promptstudio-toggle-consult").addEventListener("click", () => toggleConsult());
  panel.querySelector("#promptstudio-mobile-toggle-consult").addEventListener("click", () => toggleConsult());
  panel.querySelector("#promptstudio-toggle-inspector").addEventListener("click", () => setPanelDrawer("inspector"));
  panel.querySelector("#promptstudio-mobile-toggle-inspector").addEventListener("click", () => setPanelDrawer("inspector"));
  panel.querySelector("#promptstudio-close-chats").addEventListener("click", closePanelDrawers);
  panel.querySelector("#promptstudio-close-inspector").addEventListener("click", closePanelDrawers);
  panel.querySelector(".promptstudio-mobile-scrim").addEventListener("click", closePanelDrawers);
  panel.querySelector("#promptstudio-toggle-studio-settings").addEventListener("click", () => toggleStudioSettings());
  panel.querySelector("#promptstudio-consult-close").addEventListener("click", () => toggleConsult(false));
  panel.querySelector("#promptstudio-consult-clear").addEventListener("click", clearConsultHistory);
  panel.querySelector("#promptstudio-consult-start-experiment").addEventListener("click", startConsultExperiment);
  panel.querySelector("#promptstudio-consult-toggle-agent").addEventListener("click", toggleConsultAgentMode);
  panel.querySelector("#promptstudio-consult-end-experiment").addEventListener("click", endConsultExperiment);
  panel.querySelector("#promptstudio-consult-toggle-attachments").addEventListener("click", () => {
    toggleConsultSubpanel("attachments");
  });
  panel.querySelector("#promptstudio-consult-toggle-generation-settings").addEventListener("click", () => {
    toggleConsultSubpanel("generation");
  });
  panel.querySelectorAll(".promptstudio-consult-context-options input").forEach((control) => {
    control.addEventListener("change", updateConsultAttachmentSummary);
  });
  panel.querySelectorAll(".promptstudio-consult-generation-settings input, .promptstudio-consult-generation-settings select")
    .forEach((control) => control.addEventListener("change", saveConsultSettings));
  const consultUpload = panel.querySelector("#promptstudio-consult-upload");
  consultUpload.addEventListener("click", () => {
    if (state.consultVisionAvailable === false) {
      setConsultStatus(state.consultVisionReason || "The connected model does not support image input.", "warning");
      return;
    }
    panel.querySelector("#promptstudio-consult-file").click();
  });
  consultUpload.addEventListener("dragenter", (event) => {
    if (consultUpload.disabled || ![...(event.dataTransfer?.types || [])].includes("Files")) return;
    event.preventDefault();
    consultUpload.dataset.dragActive = "true";
  });
  consultUpload.addEventListener("dragover", (event) => {
    if (consultUpload.disabled || ![...(event.dataTransfer?.types || [])].includes("Files")) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    consultUpload.dataset.dragActive = "true";
  });
  consultUpload.addEventListener("dragleave", (event) => {
    if (event.relatedTarget && consultUpload.contains(event.relatedTarget)) return;
    consultUpload.dataset.dragActive = "false";
  });
  consultUpload.addEventListener("drop", async (event) => {
    if (consultUpload.disabled) return;
    event.preventDefault();
    consultUpload.dataset.dragActive = "false";
    const files = [...(event.dataTransfer?.files || [])].filter((file) => file.type?.startsWith("image/"));
    if (files.length !== 1) {
      setConsultStatus("Drop exactly one image reference.", "warning");
      return;
    }
    await uploadConsultReference(files[0]);
  });
  panel.querySelector("#promptstudio-consult-file").addEventListener("change", async (event) => {
    const [file] = event.target.files || [];
    event.target.value = "";
    await uploadConsultReference(file);
  });
  panel.querySelector("#promptstudio-consult-send").addEventListener("click", sendConsultMessage);
  panel.querySelector("#promptstudio-consult-input").addEventListener("paste", handleConsultImagePaste);
  panel.querySelector("#promptstudio-consult-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendConsultMessage();
    }
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
  panel.querySelector("#promptstudio-generation-failure-dialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeGenerationFailureDialog();
  });
  panel.querySelector("#promptstudio-generation-failure-dialog").addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeGenerationFailureDialog();
  });
  panel.querySelector("#promptstudio-generation-failure-cancel").addEventListener("click", () => {
    closeGenerationFailureDialog();
  });
  panel.querySelector("#promptstudio-generation-failure-retry").addEventListener("click", () => {
    const retry = state.generationRetry;
    if (!retry) return;
    closeGenerationFailureDialog({ restoreFocus: false });
    retry();
  });
  panel.querySelector("#promptstudio-new-chat").addEventListener("click", createChat);
  panel.querySelector("#promptstudio-popout").addEventListener("click", () => togglePopout({ returnToEmbedded: true }));
  panel.querySelector("#promptstudio-close").addEventListener("click", () => togglePanel(false));
  panel.querySelector("#promptstudio-mobile-close").addEventListener("click", () => togglePanel(false));
  panel.querySelector("#promptstudio-refresh-workflows").addEventListener("click", () => refreshWorkflowTemplates());
  panel.querySelector("#promptstudio-refresh-loras").addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    refreshLoraSection({ refresh: true });
  });
  panel.querySelector("#promptstudio-refresh-models").addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    refreshModelSection({ refresh: true });
  });
  panel.querySelector("#promptstudio-llm-provider").addEventListener("change", () => {
    syncLlmProviderControls({ refreshModels: true });
    markControlsChanged();
    updateComposeMode();
    if (!panel.querySelector("#promptstudio-consult").hidden) refreshConsultVisionCapability();
  });
  panel.querySelector("#promptstudio-refresh-ollama-models").addEventListener("click", () => loadOllamaModels({ announce: true }));
  panel.querySelector("#promptstudio-ollama-url").addEventListener("change", () => {
    saveSettings();
    if (selectedLlmProvider() === "ollama") loadOllamaModels({ announce: true });
    if (!panel.querySelector("#promptstudio-consult").hidden) refreshConsultVisionCapability();
  });
  panel.querySelector("#promptstudio-ollama-model").addEventListener("change", () => {
    markControlsChanged();
    if (!panel.querySelector("#promptstudio-consult").hidden) refreshConsultVisionCapability();
  });
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
  panel.querySelector("#promptstudio-main-prompt").addEventListener("input", (event) => {
    syncMainPromptEditor(event.target.value, { userEdit: true });
  });
  panel.querySelector("#promptstudio-main-prompt").addEventListener("change", commitPromptEditorVersion);
  panel.querySelector("#promptstudio-current-prompt").addEventListener("input", (event) => {
    syncCanonicalEditor(event.target.value, { userEdit: true });
  });
  panel.querySelector("#promptstudio-current-prompt").addEventListener("change", commitPromptEditorVersion);
  panel.querySelector("#promptstudio-revision").addEventListener("input", (event) => {
    syncManualPrompt(event.target.value);
    updateComposeMode();
  });
  panel.querySelector("#promptstudio-revision").addEventListener("paste", handleMainImagePaste);
  panel.querySelector("#promptstudio-revision").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      reviseAndMaybeGenerate();
    }
  });
  panel.querySelector("#promptstudio-pasted-image button").addEventListener("click", () => {
    clearMainPastedImage();
    setStatus("Pasted reference removed.", "ready");
  });
  panel.querySelectorAll(".promptstudio-settings input, .promptstudio-settings select, .promptstudio-settings textarea")
    .forEach((element) => element.addEventListener("change", markControlsChanged));
  panel.querySelector("#promptstudio-kobold-url").addEventListener("change", () => {
    markControlsChanged();
    if (!panel.querySelector("#promptstudio-consult").hidden) refreshConsultVisionCapability();
  });
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
  toggleConsult(false);
  if (state.popupCloseTimer) window.clearInterval(state.popupCloseTimer);
  state.popupCloseTimer = null;
  if (state.panel.ownerDocument !== document) document.body.appendChild(state.panel);
  syncBackgroundActivityIndicator();
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
  syncBackgroundActivityIndicator();
  installTypeAnywhereFocus(popup.document);
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
    const popup = state.popup;
    if (!popup || popup.closed) return;
    try {
      if (popup.name !== data.windowName) return;
    } catch (_) {
      return;
    }
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
    closePanelDrawers();
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
  scrollHistoryToEnd({ instant: true });
}

app.registerExtension({
  name: EXTENSION_NAME,
  beforeRegisterNodeDef(_nodeType, nodeData) {
    if (nodeData?.name !== LORA_LOADER_TYPE) return;
    if (nodeData.input?.optional) delete nodeData.input.optional.lora_stack_json;
  },
  async setup() {
    state.loraSelections = loadLoraSelections();
    state.modelSelections = loadModelSelections();
    loadCss();
    buildPanel();
    setupApiConnectionState();
    setupGenerationProgressEvents();
    setupWorkflowSync();
    installWorkflowSaveObserver();
    await loadChats();
    setupChatSync();
    resumeSyncedGeneration();
    try {
      await loadWorkflowProfiles();
    } catch (error) {
      setStatus(error.message || String(error), "warning");
    }
    resumeSyncedGeneration();
    buildLauncher();
    refreshWorkflowControls();
    setupStandaloneBridge();
  },
});
