import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

import {
  ADVANCED_LLM_ACK_STORAGE_KEY,
  AMPLIFY_TYPE,
  CHAT_SCROLL_STICK_THRESHOLD,
  CHAT_SYNC_CHANNEL,
  COMFY_RESTART_ENDPOINTS,
  CONSULT_CHAT_ENDPOINT,
  CONSULT_EXPERIMENT_MARKER,
  CONSULT_JOB_POLL_MS,
  CONSULT_RETENTION_MS,
  CONSULT_STATUS_RETRY_LIMIT,
  CONSULT_STORAGE_KEY,
  DISCONNECTED_ALLOWED_CONTROL_IDS,
  DISCONNECTED_CONTROL_SELECTOR,
  EXTENSION_NAME,
  ICON_URL,
  IMAGE_SOURCE_TYPE,
  KOBOLD_STATUS_POLL_MS,
  LLAMACPP_CONFIG_BUILDER_ENDPOINT,
  LLAMACPP_CONFIG_PROFILES_ENDPOINT,
  LLAMACPP_AUTOSTART_ENDPOINT,
  LLAMACPP_FILE_PICKER_ENDPOINT,
  LLAMACPP_SERVER_ENDPOINT,
  LLM_ABORT_ENDPOINT,
  LLM_HANDOFF_COMPLETE_ENDPOINT,
  LLM_PROFILE_DEFAULTS,
  LLM_PROFILE_PRESETS,
  LLM_PROFILE_STORAGE_KEY,
  LLM_PROFILE_STORAGE_VERSION,
  LLM_RELEASE_ENDPOINT,
  LLM_STATUS_ENDPOINT,
  LLM_THINKING_MODE_OPTIONS,
  LORA_LOADER_TYPE,
  LORA_STORAGE_KEY,
  MANAGER_QUEUE_START_ENDPOINTS,
  MANAGER_UPDATE_ALL_ENDPOINTS,
  MAX_CONSULT_EXPERIMENT_GUIDANCE_CHARS,
  MAX_CONSULT_EXPERIMENT_PROMPT_CHARS,
  MAX_DROPPED_IMAGE_BYTES,
  MODEL_LOADER_TYPE,
  MODEL_STORAGE_KEY,
  MUTATION_CONFIG_CATEGORIES,
  MUTATION_CONFIG_ENDPOINT,
  MUTATION_CONFIG_POLL_MS,
  PROMPT_AGENT_CANCEL_ENDPOINT,
  PROMPT_AGENT_DEFAULT_MAX_ITERATIONS,
  PROMPT_AGENT_ENDPOINT,
  PROMPT_AGENT_MAX_CONTEXT_CHARS,
  PROMPT_AGENT_MAX_CONTEXT_MESSAGES,
  PROMPT_AGENT_MAX_GOAL_CHARS,
  PROMPT_AGENT_MAX_ITERATIONS,
  PROMPT_AGENT_MAX_SAVED_ITERATIONS,
  PROMPT_AGENT_MIN_CONFIDENCE,
  PROMPT_AGENT_TARGET_SCORE,
  PROMPTSTUDIO_COMFY_UPDATE_ENDPOINT,
  RENDER_CONTROL_IDS,
  RENDER_CONTROL_SETTINGS,
  RESOLUTION_ASPECT_RATIOS,
  SETTINGS_DEFAULTS,
  SIDEBAR_GROUP_ORDER_STORAGE_KEY,
  SLOT_TYPE,
  STANDALONE_CHANNEL,
  STUDIO_DISCUSS_ENDPOINT,
  STUDIO_ROUTE_ENDPOINT,
  STUDIO_SETTINGS_VERSION,
  STORAGE_KEY,
  TYPE_ANYWHERE_WINDOWS,
  UPSCALE_TYPE,
  VIDEO_STUDIO_PRESENCE_TIMEOUT_MS,
  WORKFLOW_OBSERVER_KEY,
  WORKFLOW_SYNC_CHANNEL,
} from "./prompt-studio/core/constants.js";
import { makeId } from "./prompt-studio/core/id.js";
import { state } from "./prompt-studio/core/state.js";
import {
  normalizeGenerationLoraState,
  normalizeGenerationModelState,
  normalizeGenerationSnapshot,
  normalizeLoraStack,
} from "./prompt-studio/chat/generation-state.js";
import {
  cleanModelName,
  modelNameKey,
} from "./prompt-studio/generation/model-name.js";
import {
  isPromptStudioWorkflowPath,
  normalizeWorkflowProfile,
  workflowNameFromPath,
} from "./prompt-studio/generation/workflow-profile.js";
import { createWorkflowTemplateBuilder } from "./prompt-studio/generation/workflow-template.js";
import { normalizeImageReference } from "./prompt-studio/chat/image-reference.js";
import { createChatModel } from "./prompt-studio/chat/model.js";
import { createChatStoreController } from "./prompt-studio/chat/store-controller.js";
import {
  consultMessagesAfterClear,
  consultTimestampMs,
  normalizeConsultAgent,
  normalizeConsultContext,
  normalizeConsultExperiment,
  normalizeConsultExperimentGeneration,
  normalizeConsultExperimentProposal,
  normalizeConsultMessage,
  normalizePromptAgentCandidate,
  normalizePromptAgentConversationContext,
  normalizePromptAgentEvaluation,
  normalizePromptAgentIteration,
  normalizePromptAgentRubric,
  retainedConsultMessages,
} from "./prompt-studio/consult/model.js";
import { createVideoStudioBridge } from "./prompt-studio/integrations/video-studio-bridge.js";
import {
  llmActivityLabel,
  llmGeneratedTokenCount,
  thinkingModeEnablesReasoning,
} from "./prompt-studio/llm/status.js";
import {
  loadLlmProfiles,
  normalizeLlmProfile,
} from "./prompt-studio/settings/llm-profile-store.js";
import {
  getSettings,
  migrateLlamacppConfigLocation,
} from "./prompt-studio/settings/storage.js";
import {
  hasPendingStudioGenerations,
  pendingStudioGenerationCount,
  syncBackgroundActivityIndicator,
} from "./prompt-studio/ui/background-activity.js";

const { buildWorkflowTemplate } = createWorkflowTemplateBuilder({ app, nodeClassName });

const { setupVideoStudioBridge } = createVideoStudioBridge({ refreshVideoHandoffActions });
const {
  controlsFingerprintFromSettings,
  deduplicateEmptyChats,
  isEmptyChat,
  migratedStudioSettings,
  newChatStudioSettings,
  normalizeChat,
  normalizeSessionLoraSelections,
  normalizeSessionModelSelections,
  normalizeStoredControlsFingerprint,
  normalizeStudioControlChanges,
  normalizeStudioDiscussion,
  normalizeStudioProposal,
  normalizeStudioSettings,
  studioSettingsFromControlsFingerprint,
} = createChatModel({
  getDefaultLoraSelections: () => state.loraSelections,
  getDefaultModelSelections: () => state.modelSelections,
  loraSelectionKey,
  modelSelectionKey,
  normalizeLlmProvider,
  normalizePromptVersion,
  promptVersion,
});
const {
  loadChats,
  saveChats,
  setupChatSync,
} = createChatStoreController({
  activeChat,
  deduplicateEmptyChats,
  imageReferenceKey,
  newChatStudioSettings,
  normalizeChat,
  pruneExpiredConsultMessages,
  refreshSecondaryInstructionsControl,
  refreshStudioStatus,
  refreshWorkflowControls,
  renderChatHistory,
  renderChatList,
  renderConsultHistory,
  restoreChatState,
  resumeConsultJobs,
  resumeSyncedGeneration,
  setStatus,
});

function loadCss() {
  if (document.querySelector("link[data-promptstudio-prompt-studio]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("../css/prompt_studio.css", import.meta.url).href;
  link.dataset.promptstudioPromptStudio = "true";
  document.head.appendChild(link);
}

function consumeInstallerSettings() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("promptstudio_setup") !== "1") return;
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch (_) {
    stored = {};
  }
  const provider = params.get("provider");
  const next = { ...stored };
  if (provider === "ollama") {
    next.llm_provider = "ollama";
    next.ollama_url = "http://127.0.0.1:11434";
    next.ollama_model = params.get("model") || next.ollama_model || "";
    next.use_llm_amplification = true;
  } else if (provider === "koboldcpp") {
    next.llm_provider = "koboldcpp";
    next.kobold_url = params.get("kobold_url") || "http://127.0.0.1:5001";
    next.use_llm_amplification = true;
  } else if (provider === "none") {
    next.use_llm_amplification = false;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (_) {
    // Prompt Studio still opens with normal defaults when browser storage is disabled.
  }
  for (const key of ["promptstudio_setup", "provider", "model", "kobold_url"]) params.delete(key);
  const query = params.toString();
  window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
}

consumeInstallerSettings();

function availableLlmProfiles() {
  return state.llmProfiles.length
    ? state.llmProfiles
    : [normalizeLlmProfile({ ...LLM_PROFILE_DEFAULTS, id: "__default__", name: "Default" })];
}

function persistLlmProfiles() {
  try {
    localStorage.setItem(LLM_PROFILE_STORAGE_KEY, JSON.stringify({
      version: LLM_PROFILE_STORAGE_VERSION,
      profiles: state.llmProfiles.map((profile) => normalizeLlmProfile(profile)),
    }));
    return true;
  } catch (error) {
    setStatus(error.message || "LLM profiles could not be saved.", "warning");
    return false;
  }
}

function selectedLlmProfile() {
  if (selectedLlmProvider() === "llamacpp") {
    const configProfile = state.panel?.querySelector("#promptstudio-llamacpp-config-profile")?.value
      || getSettings().llamacpp_config_profile;
    const configured = state.llamacppConfigLlmProfiles.get(String(configProfile || ""));
    if (configured) return configured;
  }
  const selectedId = state.panel?.querySelector("#promptstudio-llm-profile")?.value
    || getSettings().llm_profile
    || LLM_PROFILE_DEFAULTS.id;
  const profiles = availableLlmProfiles();
  return profiles.find((profile) => profile.id === selectedId) || profiles[0];
}

function selectedLlamacppGenerationSettings() {
  const configProfile = state.panel?.querySelector("#promptstudio-llamacpp-config-profile")?.value
    || getSettings().llamacpp_config_profile;
  const profile = state.llamacppConfigLlmProfiles.get(String(configProfile || ""));
  if (!profile) return getSettings().llamacpp_generation_settings || null;
  const { id, name, ...settings } = profile;
  return { ...settings, thinking_modes: [...profile.thinking_modes] };
}

function selectedLlmThinkingMode() {
  const profile = selectedLlmProfile();
  const mainValue = state.panel?.querySelector("#promptstudio-thinking")?.value;
  const consultValue = state.panel?.querySelector("#promptstudio-consult-thinking")?.value;
  const requested = mainValue || consultValue || getSettings().thinking_mode || profile.thinking_mode;
  return profile.thinking_modes.find((mode) => mode.toLowerCase() === String(requested).toLowerCase())
    || profile.thinking_mode
    || profile.thinking_modes[0];
}

function renderLlmThinkingModeOptions(requestedMode = null) {
  const select = state.panel?.querySelector("#promptstudio-thinking");
  if (!select) return;
  const profile = selectedLlmProfile();
  const requested = requestedMode || select.value || getSettings().thinking_mode || profile.thinking_mode;
  select.replaceChildren(...profile.thinking_modes.map((mode) => {
    const option = document.createElement("option");
    option.value = mode;
    option.textContent = mode;
    return option;
  }));
  const selected = profile.thinking_modes.find((mode) => mode.toLowerCase() === String(requested).toLowerCase())
    || profile.thinking_mode
    || profile.thinking_modes[0];
  select.value = selected;
  const consult = state.panel.querySelector("#promptstudio-consult-thinking");
  if (consult) {
    const option = document.createElement("option");
    option.value = selected;
    option.textContent = selected;
    consult.replaceChildren(option);
    consult.value = selected;
  }
}

function llmProfileGenerationSettings() {
  const profile = selectedLlmProfile();
  const thinkingMode = selectedLlmThinkingMode();
  const thinkingEnabled = thinkingModeEnablesReasoning(thinkingMode);
  return {
    thinking_mode: thinkingMode,
    max_response_tokens: profile.max_response_tokens,
    llamacpp_reasoning_budget_tokens: profile.llamacpp_reasoning_budget_tokens,
    temperature: thinkingEnabled ? profile.thinking_temperature : profile.temperature,
    top_p: thinkingEnabled ? profile.thinking_top_p : profile.top_p,
    top_k: thinkingEnabled ? profile.thinking_top_k : profile.top_k,
    min_p: thinkingEnabled ? profile.thinking_min_p : profile.min_p,
    presence_penalty: thinkingEnabled ? profile.thinking_presence_penalty : profile.presence_penalty,
    rep_pen: thinkingEnabled ? profile.thinking_rep_pen : profile.rep_pen,
    rep_pen_range: thinkingEnabled ? profile.thinking_rep_pen_range : profile.rep_pen_range,
    sampler_seed: profile.sampler_seed,
    request_timeout: profile.request_timeout,
    stop_sequence: profile.stop_sequence,
  };
}

function renderLlmProfileOptions(selectedId = null) {
  const select = state.panel?.querySelector("#promptstudio-llm-profile");
  if (!select) return;
  const requested = selectedId || select.value || LLM_PROFILE_DEFAULTS.id;
  const profiles = availableLlmProfiles();
  select.replaceChildren(...profiles.map((profile) => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    return option;
  }));
  select.value = profiles.some((profile) => profile.id === requested)
    ? requested
    : profiles[0]?.id || "";
  const edit = state.panel.querySelector("#promptstudio-edit-llm-profile");
  if (edit) edit.disabled = select.value === "__default__";
  renderLlmThinkingModeOptions();
}

function syncLlmProfileControls() {
  if (!state.panel) return;
  const profile = selectedLlmProfile();
  const sampler = llmProfileGenerationSettings();
  const setValue = (id, value) => {
    const control = state.panel.querySelector(`#${id}`);
    if (control) control.value = String(value ?? "");
  };
  setValue("promptstudio-thinking", sampler.thinking_mode);
  setValue("promptstudio-temperature", sampler.temperature);
  setValue("promptstudio-consult-thinking", sampler.thinking_mode);
  setValue("promptstudio-consult-max-tokens", profile.max_response_tokens);
  setValue("promptstudio-consult-temperature", sampler.temperature);
  setValue("promptstudio-consult-top-p", sampler.top_p);
  setValue("promptstudio-consult-top-k", sampler.top_k);
  setValue("promptstudio-consult-min-p", sampler.min_p);
  setValue("promptstudio-consult-presence-penalty", sampler.presence_penalty);
  setValue("promptstudio-consult-rep-pen", sampler.rep_pen);
  setValue("promptstudio-consult-rep-pen-range", sampler.rep_pen_range);
  setValue("promptstudio-consult-seed", profile.sampler_seed);
  const summary = state.panel.querySelector("#promptstudio-consult-profile-summary");
  if (summary) summary.textContent = `${profile.name} · ${thinkingModeEnablesReasoning(sampler.thinking_mode) ? "thinking" : "non-thinking"} · temperature ${sampler.temperature} · top p ${sampler.top_p}`;
  const name = state.panel.querySelector("#promptstudio-consult-profile-name");
  if (name) name.textContent = profile.name;
}

function setLlmProfileEditorThinkingModes(modes) {
  const selected = new Set((Array.isArray(modes) ? modes : []).map((mode) => String(mode).toLowerCase()));
  state.panel?.querySelectorAll('#promptstudio-llm-profile-editor [name="thinking_modes"]').forEach((control) => {
    control.checked = selected.has(control.value.toLowerCase());
  });
}

function openLlmProfileEditor(trigger = null, { create = false } = {}) {
  const editor = state.panel?.querySelector("#promptstudio-llm-profile-editor");
  if (!editor) return;
  const profile = create
    ? normalizeLlmProfile({ ...LLM_PROFILE_DEFAULTS, id: "", name: "New profile" })
    : selectedLlmProfile();
  if (!create && profile.id === "__default__") return;
  const setValue = (name, value) => {
    const control = editor.querySelector(`[name="${name}"]`);
    if (control) control.value = String(value ?? "");
  };
  Object.entries(profile).forEach(([name, value]) => {
    if (name !== "thinking_modes") setValue(name, value);
  });
  setLlmProfileEditorThinkingModes(profile.thinking_modes);
  state.llmProfileEditorId = create ? null : profile.id;
  editor.querySelector("#promptstudio-llm-profile-editor-title").textContent = create
    ? "Add LLM profile"
    : `Edit ${profile.name}`;
  editor.querySelector("#promptstudio-delete-llm-profile").hidden = create;
  editor.querySelector("#promptstudio-llm-profile-editor-error").textContent = "";
  state.llmProfileEditorTrigger = trigger || state.panel.ownerDocument.activeElement;
  editor.hidden = false;
  editor.querySelector('[name="name"]')?.focus({ preventScroll: true });
}

function closeLlmProfileEditor({ restoreFocus = true } = {}) {
  const editor = state.panel?.querySelector("#promptstudio-llm-profile-editor");
  if (!editor || editor.hidden) return;
  editor.hidden = true;
  const trigger = state.llmProfileEditorTrigger;
  state.llmProfileEditorTrigger = null;
  state.llmProfileEditorId = null;
  if (restoreFocus) editor.ownerDocument.defaultView?.setTimeout(() => trigger?.focus({ preventScroll: true }));
}

function restoreLlmProfileEditorDefaults() {
  const editor = state.panel?.querySelector("#promptstudio-llm-profile-editor");
  if (!editor) return;
  const defaults = LLM_PROFILE_PRESETS.find((profile) => profile.id === state.llmProfileEditorId)
    || LLM_PROFILE_DEFAULTS;
  Object.entries(defaults).forEach(([name, value]) => {
    if (["id", "name", "thinking_modes"].includes(name)) return;
    const control = editor.querySelector(`[name="${name}"]`);
    if (control) control.value = String(value ?? "");
  });
  setLlmProfileEditorThinkingModes(defaults.thinking_modes);
  editor.querySelector("#promptstudio-llm-profile-editor-error").textContent = "";
}

function submitLlmProfileEditor(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = form.querySelector("#promptstudio-llm-profile-editor-error");
  const data = Object.fromEntries(new FormData(form));
  data.thinking_modes = [...form.querySelectorAll('[name="thinking_modes"]:checked')]
    .map((control) => control.value);
  const name = String(data.name || "").trim();
  if (!name) {
    error.textContent = "Profile name is required.";
    form.elements.name.focus();
    return;
  }
  if (!data.thinking_modes.length) {
    error.textContent = "Select at least one available thinking mode.";
    form.querySelector('[name="thinking_modes"]')?.focus();
    return;
  }
  if (state.llmProfiles.some((profile) => (
    profile.id !== state.llmProfileEditorId && profile.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0
  ))) {
    error.textContent = "Profile names must be unique.";
    form.elements.name.focus();
    return;
  }
  const current = selectedLlmProfile();
  const id = state.llmProfileEditorId || `llm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const updated = normalizeLlmProfile({ ...current, ...data, id });
  state.llmProfiles = state.llmProfileEditorId
    ? state.llmProfiles.map((profile) => profile.id === updated.id ? updated : profile)
    : [...state.llmProfiles, updated];
  if (!persistLlmProfiles()) return;
  renderLlmProfileOptions(updated.id);
  syncLlmProfileControls();
  saveSettings();
  markControlsChanged();
  closeLlmProfileEditor();
  setStatus(`${updated.name} LLM profile saved.`, "ready");
}

function deleteLlmProfile() {
  const profile = state.llmProfiles.find((candidate) => candidate.id === state.llmProfileEditorId);
  if (!profile) return;
  if (!state.panel.ownerDocument.defaultView?.confirm(`Delete the “${profile.name}” LLM profile?`)) return;
  state.llmProfiles = state.llmProfiles.filter((candidate) => candidate.id !== profile.id);
  if (!persistLlmProfiles()) return;
  renderLlmProfileOptions();
  syncLlmProfileControls();
  saveSettings();
  markControlsChanged();
  closeLlmProfileEditor();
  setStatus(state.llmProfiles.length
    ? `${profile.name} deleted.`
    : `${profile.name} deleted. The immutable Default profile is now active.`, "ready");
}

function applyRememberedLlmConnection(settings) {
  let remembered = {};
  try {
    remembered = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch (_) {
    return settings;
  }
  if (!remembered || typeof remembered !== "object" || Array.isArray(remembered)
      || !Object.hasOwn(remembered, "llm_provider")) return settings;
  remembered = migrateLlamacppConfigLocation(remembered);
  settings = migrateLlamacppConfigLocation(settings);
  return {
    ...settings,
    llm_provider: normalizeLlmProvider(remembered.llm_provider),
    llm_profile: String(remembered.llm_profile || settings.llm_profile || LLM_PROFILE_DEFAULTS.id),
    kobold_url: String(remembered.kobold_url ?? settings.kobold_url ?? SETTINGS_DEFAULTS.kobold_url),
    ollama_url: String(remembered.ollama_url ?? settings.ollama_url ?? SETTINGS_DEFAULTS.ollama_url),
    ollama_model: String(remembered.ollama_model ?? settings.ollama_model ?? ""),
    llamacpp_url: String(remembered.llamacpp_url ?? settings.llamacpp_url ?? SETTINGS_DEFAULTS.llamacpp_url),
    llamacpp_model: String(remembered.llamacpp_model ?? settings.llamacpp_model ?? ""),
    llamacpp_executable: String(remembered.llamacpp_executable ?? settings.llamacpp_executable ?? ""),
    llamacpp_config_profile: String(remembered.llamacpp_config_profile ?? settings.llamacpp_config_profile ?? ""),
    llamacpp_generation_settings: remembered.llamacpp_generation_settings
      ?? settings.llamacpp_generation_settings
      ?? null,
    llamacpp_autostart: remembered.llamacpp_autostart == null
      ? Boolean(settings.llamacpp_autostart)
      : Boolean(remembered.llamacpp_autostart),
    keep_models_loaded: remembered.keep_models_loaded == null
      ? Boolean(settings.keep_models_loaded)
      : Boolean(remembered.keep_models_loaded),
  };
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
      llm_profile: value("promptstudio-llm-profile"),
      kobold_url: value("promptstudio-kobold-url"),
      ollama_url: value("promptstudio-ollama-url"),
      ollama_model: value("promptstudio-ollama-model"),
      llamacpp_url: value("promptstudio-llamacpp-url"),
      llamacpp_model: value("promptstudio-llamacpp-model"),
      llamacpp_executable: value("promptstudio-llamacpp-executable"),
      llamacpp_config_profile: value("promptstudio-llamacpp-config-profile"),
      llamacpp_generation_settings: selectedLlamacppGenerationSettings(),
      llamacpp_autostart: checked("promptstudio-llamacpp-autostart"),
      keep_models_loaded: checked("promptstudio-keep-models-loaded"),
      model_profile: value("promptstudio-profile"),
      style_preset: value("promptstudio-style"),
      framing_preset: value("promptstudio-framing"),
      style_modifier: value("promptstudio-style-modifier"),
      framing_modifier: value("promptstudio-framing-modifier"),
      thinking_mode: value("promptstudio-thinking"),
      embellishment_level: value("promptstudio-embellishment"),
      target_output_length: Number(value("promptstudio-output-length") || 35),
      output_length_custom: state.panel.querySelector("#promptstudio-output-length")?.dataset.custom === "true",
      temperature: Number(value("promptstudio-temperature") || 0.7),
      additional_instructions: value("promptstudio-additional-instructions"),
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
  syncActiveChatSettings();
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

function mutationConfigItems(category = state.mutationManagerCategory) {
  const items = state.mutationConfig?.[category];
  return Array.isArray(items) ? items : [];
}

function mutationConfigSummary(category) {
  const items = mutationConfigItems(category);
  if (category === "protected_words") {
    return `${items.length} ${items.length === 1 ? "entry" : "entries"}`;
  }
  const enabled = items.filter((item) => item?.enabled !== false).length;
  const disabled = items.length - enabled;
  if (!disabled) return `${enabled} enabled`;
  return `${enabled} enabled · ${disabled} disabled`;
}

function renderMutationConfigLaunchers() {
  if (!state.panel) return;
  for (const category of Object.keys(MUTATION_CONFIG_CATEGORIES)) {
    const output = state.panel.querySelector(`[data-mutation-count="${category}"]`);
    if (output) output.textContent = state.mutationConfig ? mutationConfigSummary(category) : "Load to view";
  }
}

function setMutationManagerBanner(message = "", kind = "warning", actionLabel = "") {
  const banner = state.panel?.querySelector("#promptstudio-mutation-manager-banner");
  if (!banner) return;
  banner.hidden = !message;
  banner.dataset.kind = kind;
  const copy = banner.querySelector("span");
  const action = banner.querySelector("button");
  if (copy) copy.textContent = message;
  if (action) {
    action.textContent = actionLabel;
    action.hidden = !actionLabel;
  }
}

function mutationEditorIsOpen() {
  const editor = state.panel?.querySelector("#promptstudio-mutation-editor");
  return Boolean(editor && !editor.hidden);
}

async function refreshRuntimeConfigAfterMutation() {
  if (!state.config) return;
  await loadConfig();
  const validStyles = new Set((state.config?.styles || []).map(String));
  const validFramings = new Set((state.config?.framings || []).map(String));
  let changed = false;
  for (const chat of state.chats) {
    if (!validStyles.has(chat.studioSettings?.style_preset)) {
      chat.studioSettings.style_preset = "None";
      changed = true;
    }
    if (!validFramings.has(chat.studioSettings?.framing_preset)) {
      chat.studioSettings.framing_preset = "None";
      changed = true;
    }
  }
  if (changed) {
    const settings = activeChat()?.studioSettings || getSettings();
    setOptions("promptstudio-style", state.config.styles, settings.style_preset);
    setOptions("promptstudio-framing", state.config.framings, settings.framing_preset);
    applyStudioSettings(activeChat());
    saveSettings();
    saveChats();
    setStatus("A removed or disabled active preset was reset to None.", "warning");
  }
}

function applyMutationConfig(data, { external = false } = {}) {
  const previousRevision = state.mutationConfig?.revision || "";
  state.mutationConfig = data;
  state.mutationConfigPending = null;
  setMutationManagerBanner();
  renderMutationConfigLaunchers();
  renderMutationManager();
  if (external && previousRevision !== data.revision) {
    refreshRuntimeConfigAfterMutation().catch((error) => {
      setMutationManagerBanner(error.message || "Prompt controls could not be refreshed.", "warning");
    });
  }
}

async function loadMutationConfig({ conditional = false, external = false } = {}) {
  if (state.mutationConfigLoading) return;
  state.mutationConfigLoading = true;
  const revision = state.mutationConfigPending?.revision || state.mutationConfig?.revision || "";
  const url = conditional && revision
    ? `${MUTATION_CONFIG_ENDPOINT}?revision=${encodeURIComponent(revision)}`
    : MUTATION_CONFIG_ENDPOINT;
  try {
    const response = await api.fetchApi(url, { cache: "no-store" });
    if (response.status === 204) return;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Prompt Mutation Configuration could not be loaded (${response.status}).`);
    if (mutationEditorIsOpen() && state.mutationConfig?.revision !== data.revision) {
      if (state.mutationEditorDirty) {
        state.mutationConfigPending = data;
        setMutationManagerBanner(
          "The configuration files changed outside Prompt Studio. Your unsaved edit is preserved.",
          "warning",
          "Reload files",
        );
        return;
      }
      closeMutationEditor({ restoreFocus: false });
    }
    applyMutationConfig(data, { external });
  } catch (error) {
    if (state.mutationConfig) {
      setMutationManagerBanner(
        `${error.message || "The configuration files could not be read."} Keeping the last valid view and retrying.`,
        "warning",
      );
    } else {
      setMutationManagerBanner(error.message || "Prompt Mutation Configuration could not be loaded.", "error");
    }
  } finally {
    state.mutationConfigLoading = false;
  }
}

function startMutationConfigMonitor() {
  if (state.mutationConfigTimer) window.clearInterval(state.mutationConfigTimer);
  loadMutationConfig({ conditional: Boolean(state.mutationConfig), external: true });
  state.mutationConfigTimer = window.setInterval(() => {
    const settings = state.panel?.querySelector("#promptstudio-studio-settings");
    if (settings && !settings.hidden) loadMutationConfig({ conditional: true, external: true });
  }, MUTATION_CONFIG_POLL_MS);
}

function stopMutationConfigMonitor() {
  if (state.mutationConfigTimer) window.clearInterval(state.mutationConfigTimer);
  state.mutationConfigTimer = null;
}

function openMutationManager(category, trigger = null) {
  const metadata = MUTATION_CONFIG_CATEGORIES[category];
  const manager = state.panel?.querySelector("#promptstudio-mutation-manager");
  if (!metadata || !manager) return;
  state.mutationManagerCategory = category;
  state.mutationDeleteIndex = null;
  state.mutationManagerTrigger = trigger || state.panel.ownerDocument.activeElement;
  manager.hidden = false;
  manager.querySelector("#promptstudio-mutation-manager-title").textContent = metadata.title;
  manager.querySelector("#promptstudio-mutation-manager-description").textContent = metadata.description;
  manager.querySelector("#promptstudio-mutation-search").value = "";
  manager.querySelector("#promptstudio-mutation-add").textContent = `Add ${metadata.itemLabel}`;
  renderMutationManager();
  manager.querySelector("#promptstudio-mutation-search")?.focus({ preventScroll: true });
  loadMutationConfig({ conditional: Boolean(state.mutationConfig), external: true });
}

function closeMutationManager({ restoreFocus = true } = {}) {
  const manager = state.panel?.querySelector("#promptstudio-mutation-manager");
  if (!manager || manager.hidden) return;
  closeMutationEditor({ restoreFocus: false });
  manager.hidden = true;
  state.mutationManagerCategory = "";
  state.mutationDeleteIndex = null;
  setMutationManagerBanner();
  if (restoreFocus) state.mutationManagerTrigger?.focus?.({ preventScroll: true });
  state.mutationManagerTrigger = null;
}

function mutationRowButton(label, action, index, className = "") {
  const button = state.panel.ownerDocument.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.mutationAction = action;
  button.dataset.index = String(index);
  if (className) button.className = className;
  return button;
}

function renderMutationManager() {
  const manager = state.panel?.querySelector("#promptstudio-mutation-manager");
  const list = manager?.querySelector("#promptstudio-mutation-list");
  if (!manager || manager.hidden || !list) return;
  const category = state.mutationManagerCategory;
  const metadata = MUTATION_CONFIG_CATEGORIES[category];
  if (!metadata) return;
  manager.querySelector("#promptstudio-mutation-add").disabled = !state.mutationConfig;
  const query = manager.querySelector("#promptstudio-mutation-search")?.value.trim().toLocaleLowerCase() || "";
  list.replaceChildren();
  const items = mutationConfigItems(category);
  const matches = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      if (!query) return true;
      const haystack = category === "protected_words"
        ? String(item)
        : `${item?.name || ""}\n${item?.[metadata.textField] || ""}`;
      return haystack.toLocaleLowerCase().includes(query);
    });
  manager.querySelector("#promptstudio-mutation-manager-count").textContent = mutationConfigSummary(category);
  if (!state.mutationConfig) {
    const empty = state.panel.ownerDocument.createElement("div");
    empty.className = "promptstudio-mutation-empty";
    empty.textContent = "Loading configuration…";
    list.appendChild(empty);
    return;
  }
  if (!matches.length) {
    const empty = state.panel.ownerDocument.createElement("div");
    empty.className = "promptstudio-mutation-empty";
    empty.textContent = query ? "No matching entries." : `No ${metadata.itemLabel}s yet.`;
    list.appendChild(empty);
    return;
  }
  for (const { item, index } of matches) {
    const row = state.panel.ownerDocument.createElement("article");
    row.className = "promptstudio-mutation-row";
    if (category !== "protected_words" && item.enabled === false) row.classList.add("is-disabled");
    const copy = state.panel.ownerDocument.createElement("div");
    copy.className = "promptstudio-mutation-row-copy";
    const title = state.panel.ownerDocument.createElement("strong");
    title.textContent = category === "protected_words" ? String(item) : item.name;
    copy.appendChild(title);
    if (category !== "protected_words") {
      const preview = state.panel.ownerDocument.createElement("span");
      preview.textContent = item[metadata.textField];
      copy.appendChild(preview);
    }
    row.appendChild(copy);
    const controls = state.panel.ownerDocument.createElement("div");
    controls.className = "promptstudio-mutation-row-controls";
    if (category !== "protected_words") {
      const toggleLabel = state.panel.ownerDocument.createElement("label");
      toggleLabel.className = "promptstudio-mutation-enabled";
      const toggle = state.panel.ownerDocument.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = item.enabled !== false;
      toggle.dataset.mutationAction = "toggle";
      toggle.dataset.index = String(index);
      toggle.setAttribute("aria-label", `${toggle.checked ? "Disable" : "Enable"} ${item.name}`);
      const toggleCopy = state.panel.ownerDocument.createElement("span");
      toggleCopy.textContent = toggle.checked ? "Enabled" : "Disabled";
      toggleLabel.append(toggle, toggleCopy);
      controls.appendChild(toggleLabel);
    }
    if (state.mutationDeleteIndex === index) {
      const confirmation = state.panel.ownerDocument.createElement("span");
      confirmation.className = "promptstudio-mutation-delete-confirmation";
      confirmation.textContent = "Delete this entry?";
      controls.append(
        confirmation,
        mutationRowButton("Cancel", "cancel-delete", index),
        mutationRowButton("Delete", "confirm-delete", index, "promptstudio-danger-button"),
      );
    } else {
      controls.append(
        mutationRowButton("Edit", "edit", index),
        mutationRowButton("Delete", "delete", index, "promptstudio-danger-link"),
      );
    }
    row.appendChild(controls);
    list.appendChild(row);
  }
}

function openMutationEditor(index = null) {
  const category = state.mutationManagerCategory;
  const metadata = MUTATION_CONFIG_CATEGORIES[category];
  const editor = state.panel?.querySelector("#promptstudio-mutation-editor");
  if (!metadata || !editor) return;
  const item = index === null ? null : mutationConfigItems(category)[index];
  state.mutationEditorIndex = index;
  state.mutationEditorDirty = false;
  editor.querySelector("#promptstudio-mutation-editor-title").textContent = `${item ? "Edit" : "Add"} ${metadata.itemLabel}`;
  editor.querySelector("#promptstudio-mutation-editor-help").textContent = metadata.help;
  const nameRow = editor.querySelector("#promptstudio-mutation-editor-name-row");
  const nameLabel = editor.querySelector("#promptstudio-mutation-editor-name-label");
  const nameInput = editor.querySelector("#promptstudio-mutation-editor-name");
  nameLabel.textContent = category === "protected_words" ? "Word or phrase" : "Name";
  nameInput.value = category === "protected_words" ? String(item || "") : String(item?.name || "");
  nameInput.maxLength = category === "protected_words" ? 256 : 200;
  nameRow.hidden = false;
  const textRow = editor.querySelector("#promptstudio-mutation-editor-text-row");
  textRow.hidden = !metadata.textField;
  editor.querySelector("#promptstudio-mutation-editor-text-label").textContent = metadata.textLabel || "";
  editor.querySelector("#promptstudio-mutation-editor-text").value = metadata.textField
    ? String(item?.[metadata.textField] || "")
    : "";
  const enabledRow = editor.querySelector("#promptstudio-mutation-editor-enabled-row");
  enabledRow.hidden = category === "protected_words";
  editor.querySelector("#promptstudio-mutation-editor-enabled").checked = item?.enabled !== false;
  editor.querySelector("#promptstudio-mutation-editor-error").textContent = "";
  editor.hidden = false;
  nameInput.focus({ preventScroll: true });
}

function closeMutationEditor({ restoreFocus = true } = {}) {
  const editor = state.panel?.querySelector("#promptstudio-mutation-editor");
  if (!editor || editor.hidden) return;
  editor.hidden = true;
  state.mutationEditorIndex = null;
  state.mutationEditorDirty = false;
  if (state.mutationConfigPending) {
    const pending = state.mutationConfigPending;
    applyMutationConfig(pending, { external: true });
  } else {
    setMutationManagerBanner();
  }
  if (restoreFocus) state.panel.querySelector("#promptstudio-mutation-add")?.focus({ preventScroll: true });
}

async function saveMutationCategory(category, items, successMessage) {
  const manager = state.panel?.querySelector("#promptstudio-mutation-manager");
  if (!state.mutationConfig?.revision || !manager) return false;
  manager.setAttribute("aria-busy", "true");
  manager.querySelectorAll("button, input, textarea").forEach((control) => { control.disabled = true; });
  try {
    const response = await api.fetchApi(MUTATION_CONFIG_ENDPOINT, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: state.mutationConfig.revision, category, items }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Configuration could not be saved (${response.status}).`);
    applyMutationConfig(data);
    refreshRuntimeConfigAfterMutation().catch((error) => {
      setMutationManagerBanner(error.message || "Prompt controls could not be refreshed.", "warning");
    });
    setStatus(successMessage, "ready");
    return true;
  } catch (error) {
    const errorElement = state.panel.querySelector("#promptstudio-mutation-editor-error");
    if (mutationEditorIsOpen() && errorElement) errorElement.textContent = error.message || String(error);
    else setMutationManagerBanner(error.message || "Configuration could not be saved.", "error", "Reload files");
    if (String(error.message || "").includes("another window")) {
      loadMutationConfig({ conditional: false, external: true });
    }
    return false;
  } finally {
    manager.removeAttribute("aria-busy");
    manager.querySelectorAll("button, input, textarea").forEach((control) => { control.disabled = false; });
  }
}

async function submitMutationEditor(event) {
  event.preventDefault();
  const category = state.mutationManagerCategory;
  const metadata = MUTATION_CONFIG_CATEGORIES[category];
  if (!metadata) return;
  const name = state.panel.querySelector("#promptstudio-mutation-editor-name").value.trim();
  const items = structuredClone(mutationConfigItems(category));
  let nextItem = name;
  if (category !== "protected_words") {
    nextItem = {
      name,
      [metadata.textField]: state.panel.querySelector("#promptstudio-mutation-editor-text").value.trim(),
      enabled: state.panel.querySelector("#promptstudio-mutation-editor-enabled").checked,
    };
  }
  if (state.mutationEditorIndex === null) items.push(nextItem);
  else items[state.mutationEditorIndex] = nextItem;
  const saved = await saveMutationCategory(category, items, `${metadata.title} saved.`);
  if (saved) closeMutationEditor();
}

async function handleMutationListAction(event) {
  const control = event.target.closest?.("[data-mutation-action]");
  if (!control) return;
  const category = state.mutationManagerCategory;
  const metadata = MUTATION_CONFIG_CATEGORIES[category];
  const index = Number(control.dataset.index);
  if (!metadata || !Number.isInteger(index)) return;
  const action = control.dataset.mutationAction;
  if (action === "edit") return openMutationEditor(index);
  if (action === "delete") {
    state.mutationDeleteIndex = index;
    return renderMutationManager();
  }
  if (action === "cancel-delete") {
    state.mutationDeleteIndex = null;
    return renderMutationManager();
  }
  const items = structuredClone(mutationConfigItems(category));
  if (action === "toggle") {
    items[index].enabled = control.checked;
    const saved = await saveMutationCategory(category, items, `${items[index].name} ${control.checked ? "enabled" : "disabled"}.`);
    if (!saved) control.checked = !control.checked;
    return;
  }
  if (action === "confirm-delete") {
    const removed = items.splice(index, 1)[0];
    const label = category === "protected_words" ? removed : removed?.name;
    if (await saveMutationCategory(category, items, `${label} deleted.`)) {
      state.mutationDeleteIndex = null;
      renderMutationManager();
    }
  }
}

function toggleStudioSettings(force) {
  const popover = state.panel?.querySelector("#promptstudio-studio-settings");
  const button = state.panel?.querySelector("#promptstudio-toggle-studio-settings");
  if (!popover || !button) return;
  const show = force ?? popover.hidden;
  if (show) toggleConsult(false);
  popover.hidden = !show;
  button.setAttribute("aria-expanded", show ? "true" : "false");
  if (show) {
    closeSystemStatus();
    startMutationConfigMonitor();
    popover.ownerDocument.defaultView?.setTimeout(() => {
      if (!popover.hidden && !openPromptStudioDialog()) {
        popover.querySelector("#promptstudio-close-studio-settings")?.focus({ preventScroll: true });
      }
    }, 0);
  }
  else {
    stopMutationConfigMonitor();
    closeBackendSettings({ restoreFocus: false });
    closeMutationManager({ restoreFocus: false });
    closeLlmProfileEditor({ restoreFocus: false });
  }
}

function openBackendSettings() {
  const dialog = state.panel?.querySelector("#promptstudio-backend-settings-dialog");
  if (!dialog) return;
  dialog.hidden = false;
  syncLlmProviderControls();
  const provider = selectedLlmProvider();
  if (provider === "ollama") loadOllamaModels({ announce: false });
  if (provider === "llamacpp") {
    loadLlamacppAutostartPreference().then(() => {
      loadLlamacppModels({ announce: false });
      loadLlamacppConfigProfiles({
        announce: false,
        preferred: state.panel?.querySelector("#promptstudio-llamacpp-config-profile")?.value || "",
      });
    });
  }
  dialog.querySelector("#promptstudio-close-backend-settings")?.focus({ preventScroll: true });
}

function closeBackendSettings({ restoreFocus = true } = {}) {
  const dialog = state.panel?.querySelector("#promptstudio-backend-settings-dialog");
  if (!dialog || dialog.hidden) return;
  dialog.hidden = true;
  saveSettings();
  if (restoreFocus) state.panel?.querySelector("#promptstudio-open-backend-settings")?.focus({ preventScroll: true });
}

function getConsultSettings() {
  const defaults = {
    thinking_mode: "Disabled",
    max_response_tokens: 800,
    temperature: 0.7,
    top_p: 0.9,
    top_k: 100,
    min_p: 0,
    presence_penalty: 0,
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
    thinking_mode: ["Disabled", "Minimal", "Low", "Medium", "High", "XHigh"].includes(source.thinking_mode)
      ? source.thinking_mode
      : defaults.thinking_mode,
    max_response_tokens: Math.round(number("max_response_tokens", 1, 8192)),
    temperature: number("temperature", 0, 5),
    top_p: number("top_p", 0, 1),
    top_k: Math.round(number("top_k", 0, 200)),
    min_p: number("min_p", 0, 1),
    presence_penalty: number("presence_penalty", -2, 2),
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
      presence_penalty: Number(value("promptstudio-consult-presence-penalty") || 0),
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
  const history = overlay.querySelector("#promptstudio-consult-history");
  if (!show && history) state.consultHistoryWasNearEnd = historyIsNearEnd(history);
  overlay.hidden = !show;
  if (show) {
    toggleStudioSettings(false);
    closePanelDrawers();
    renderConsultHistory({ forceEnd: state.consultHistoryWasNearEnd });
    renderConsultAttachments();
    refreshConsultVisionCapability();
  }
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

function closeConsultSubpanels() {
  const attachments = state.panel?.querySelector("#promptstudio-consult-attachments");
  const generation = state.panel?.querySelector("#promptstudio-consult-generation-settings");
  if (attachments) attachments.hidden = true;
  if (generation) generation.hidden = true;
  state.panel?.querySelector("#promptstudio-consult-toggle-attachments")
    ?.setAttribute("aria-expanded", "false");
  state.panel?.querySelector("#promptstudio-consult-toggle-generation-settings")
    ?.setAttribute("aria-expanded", "false");
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

function saveSidebarGroupOrder(deck) {
  const order = [...deck.querySelectorAll(":scope > details[data-promptstudio-sidebar-group]")]
    .map((group) => group.dataset.promptstudioSidebarGroup);
  try {
    localStorage.setItem(SIDEBAR_GROUP_ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch (error) {
    setStatus(error.message || "Sidebar group order could not be saved.", "warning");
  }
}

function installSidebarGroupReordering(panel) {
  const deck = panel.querySelector(".promptstudio-control-deck");
  if (!deck) return;
  const groups = [...deck.querySelectorAll(":scope > details[data-promptstudio-sidebar-group]")];
  const groupsByKey = new Map(groups.map((group) => [group.dataset.promptstudioSidebarGroup, group]));
  let storedOrder = [];
  try {
    const stored = JSON.parse(localStorage.getItem(SIDEBAR_GROUP_ORDER_STORAGE_KEY) || "[]");
    if (Array.isArray(stored)) storedOrder = stored;
  } catch (_) {
    storedOrder = [];
  }
  const orderedKeys = [...new Set([
    ...storedOrder.filter((key) => typeof key === "string" && groupsByKey.has(key)),
    ...groups.map((group) => group.dataset.promptstudioSidebarGroup),
  ])];
  orderedKeys.forEach((key) => deck.appendChild(groupsByKey.get(key)));

  let draggedGroup = null;
  let dropTarget = null;
  let dropBefore = false;
  const clearDropTarget = () => {
    dropTarget?.classList.remove("promptstudio-sidebar-drop-before", "promptstudio-sidebar-drop-after");
    dropTarget = null;
  };
  const finishDrag = () => {
    clearDropTarget();
    draggedGroup?.classList.remove("promptstudio-sidebar-group-dragging");
    draggedGroup = null;
    deck.classList.remove("promptstudio-sidebar-reordering");
  };
  const visibleGroups = () => [...deck.querySelectorAll(":scope > details[data-promptstudio-sidebar-group]")]
    .filter((group) => !group.hidden);

  groups.forEach((group) => {
    const summary = group.querySelector(":scope > summary");
    if (!summary) return;
    const label = summary.querySelector("span:not(.promptstudio-lora-summary-tools)")?.textContent?.trim()
      || group.dataset.promptstudioSidebarGroup;
    const handle = document.createElement("span");
    handle.className = "promptstudio-sidebar-drag-handle";
    handle.draggable = true;
    handle.tabIndex = 0;
    handle.setAttribute("role", "button");
    handle.setAttribute("aria-label", `Reorder ${label}`);
    handle.title = "Drag to reorder. Use Up or Down while focused.";
    summary.prepend(handle);
    handle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    handle.addEventListener("keydown", (event) => {
      if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const visible = visibleGroups();
      const index = visible.indexOf(group);
      const sibling = visible[index + (event.key === "ArrowUp" ? -1 : 1)];
      if (!sibling) return;
      if (event.key === "ArrowUp") deck.insertBefore(group, sibling);
      else deck.insertBefore(group, sibling.nextSibling);
      saveSidebarGroupOrder(deck);
      handle.focus();
    });
    handle.addEventListener("dragstart", (event) => {
      draggedGroup = group;
      deck.classList.add("promptstudio-sidebar-reordering");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", group.dataset.promptstudioSidebarGroup);
      panel.ownerDocument.defaultView?.requestAnimationFrame(() => {
        group.classList.add("promptstudio-sidebar-group-dragging");
      });
    });
    handle.addEventListener("dragend", finishDrag);
  });

  deck.addEventListener("dragover", (event) => {
    if (!draggedGroup) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    let target = event.target.closest?.("details[data-promptstudio-sidebar-group]");
    if (!target || target === draggedGroup || target.hidden) {
      const candidates = visibleGroups().filter((group) => group !== draggedGroup);
      target = candidates.reduce((nearest, group) => {
        const rect = group.getBoundingClientRect();
        const distance = Math.hypot(event.clientX - (rect.left + rect.width / 2), event.clientY - (rect.top + rect.height / 2));
        return !nearest || distance < nearest.distance ? { group, distance } : nearest;
      }, null)?.group || null;
    }
    if (!target || target === draggedGroup) {
      clearDropTarget();
      return;
    }
    const rect = target.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    if (target === dropTarget && before === dropBefore) return;
    clearDropTarget();
    dropTarget = target;
    dropBefore = before;
    dropTarget.classList.add(before ? "promptstudio-sidebar-drop-before" : "promptstudio-sidebar-drop-after");
  });
  deck.addEventListener("drop", (event) => {
    if (!draggedGroup) return;
    event.preventDefault();
    if (dropTarget) {
      deck.insertBefore(draggedGroup, dropBefore ? dropTarget : dropTarget.nextSibling);
      saveSidebarGroupOrder(deck);
    }
    finishDrag();
  });
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

function closeSystemStatus({ restoreFocus = false } = {}) {
  const control = state.panel?.querySelector("#promptstudio-kobold-control");
  if (!control?.open) return false;
  control.open = false;
  if (restoreFocus) control.querySelector("summary")?.focus({ preventScroll: true });
  return true;
}

function trapDialogFocus(dialog, event) {
  if (event.key !== "Tab") return false;
  const controls = [...dialog.querySelectorAll(
    'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )].filter((control) => !control.disabled && !control.hidden && control.getClientRects().length);
  if (!controls.length) {
    event.preventDefault();
    dialog.focus({ preventScroll: true });
    return true;
  }
  const first = controls[0];
  const last = controls[controls.length - 1];
  const active = dialog.ownerDocument.activeElement;
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault();
    last.focus({ preventScroll: true });
    return true;
  }
  if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault();
    first.focus({ preventScroll: true });
    return true;
  }
  return false;
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
    const statusControl = state.panel.querySelector("#promptstudio-kobold-control");
    if (statusControl?.open && !statusControl.contains(event.target)) closeSystemStatus();

    // Let the active modal handle its own backdrop and controls without
    // dismissing an underlying consultation or settings layer first.
    if (openPromptStudioDialog()) return;

    const target = event.target;
    const consult = state.panel.querySelector("#promptstudio-consult");
    const consultToggles = state.panel.querySelectorAll(".promptstudio-consult-toggle");
    if (
      consult
      && !consult.hidden
      && !consult.contains(target)
      && ![...consultToggles].some((button) => button.contains(target))
    ) {
      toggleConsult(false);
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
    }
  }, { capture: true });
  view.addEventListener("keydown", (event) => {
    const dialog = openPromptStudioDialog();
    if (dialog && trapDialogFocus(dialog, event)) {
      event.stopPropagation();
      return;
    }
    if (
      !event.defaultPrevented
      && event.key === "Escape"
      && state.panel
      && !state.panel.hidden
      && state.panel.ownerDocument === ownerDocument
      && !openPromptStudioDialog()
    ) {
      if (closeSystemStatus({ restoreFocus: true })) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const mutationManager = state.panel.querySelector("#promptstudio-mutation-manager");
      if (mutationManager && !mutationManager.hidden) {
        event.preventDefault();
        event.stopPropagation();
        closeMutationManager();
        return;
      }
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

function mainChatImageDropMode(chat = activeChat()) {
  if (chatAcceptsImageDrop(chat)) return "import";
  if (chat?.initialized) return "reference";
  return "refused";
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

function restoreChatState(chat) {
  state.mainPrompt = chat.mainPrompt;
  state.currentPrompt = chat.finalPrompt;
  state.versions = [...chat.versions];
  state.versionIndex = chat.versionIndex;
  updatePromptEditors(chat.mainPrompt, chat.finalPrompt);
  applyStudioSettings(chat);
  renderStudioDiscussionContext();
}

function captureStudioSettings(chat = activeChat()) {
  const fallback = normalizeStudioSettings(chat?.studioSettings || getSettings());
  if (!state.panel) return fallback;
  const value = (key, id) => {
    const control = state.panel.querySelector(`#${id}`);
    if (!control || (control.tagName === "SELECT" && !control.options.length)) return fallback[key];
    return control.value;
  };
  const checked = (key, id) => {
    const control = state.panel.querySelector(`#${id}`);
    return control ? Boolean(control.checked) : fallback[key];
  };
  return normalizeStudioSettings({
    llm_provider: value("llm_provider", "promptstudio-llm-provider"),
    llm_profile: value("llm_profile", "promptstudio-llm-profile"),
    kobold_url: value("kobold_url", "promptstudio-kobold-url"),
    ollama_url: value("ollama_url", "promptstudio-ollama-url"),
    ollama_model: value("ollama_model", "promptstudio-ollama-model"),
    llamacpp_url: value("llamacpp_url", "promptstudio-llamacpp-url"),
    llamacpp_model: value("llamacpp_model", "promptstudio-llamacpp-model"),
    llamacpp_executable: value("llamacpp_executable", "promptstudio-llamacpp-executable"),
    llamacpp_config_profile: value("llamacpp_config_profile", "promptstudio-llamacpp-config-profile"),
    llamacpp_generation_settings: selectedLlamacppGenerationSettings(),
    llamacpp_autostart: checked("llamacpp_autostart", "promptstudio-llamacpp-autostart"),
    keep_models_loaded: checked("keep_models_loaded", "promptstudio-keep-models-loaded"),
    model_profile: value("model_profile", "promptstudio-profile"),
    style_preset: value("style_preset", "promptstudio-style"),
    framing_preset: value("framing_preset", "promptstudio-framing"),
    style_modifier: value("style_modifier", "promptstudio-style-modifier"),
    framing_modifier: value("framing_modifier", "promptstudio-framing-modifier"),
    thinking_mode: value("thinking_mode", "promptstudio-thinking"),
    embellishment_level: value("embellishment_level", "promptstudio-embellishment"),
    target_output_length: value("target_output_length", "promptstudio-output-length"),
    output_length_custom: state.panel.querySelector("#promptstudio-output-length")?.dataset.custom === "true",
    temperature: value("temperature", "promptstudio-temperature"),
    additional_instructions: value("additional_instructions", "promptstudio-additional-instructions"),
    secondary_instructions: value("secondary_instructions", "promptstudio-secondary-instructions"),
    use_llm_amplification: checked("use_llm_amplification", "promptstudio-use-llm-amplification"),
    use_prompt_upscaling: checked("use_prompt_upscaling", "promptstudio-use-prompt-upscaling"),
    randomize_seed: checked("randomize_seed", "promptstudio-randomize-seed"),
    auto_generate: checked("auto_generate", "promptstudio-auto-generate"),
    auto_advance_source: checked("auto_advance_source", "promptstudio-auto-advance-source"),
    use_latest_image_context: checked("use_latest_image_context", "promptstudio-use-latest-image-context"),
    image_scale: value("image_scale", "promptstudio-image-scale"),
    resolution_aspect_ratio: value("resolution_aspect_ratio", "promptstudio-resolution-aspect-ratio"),
    resolution_megapixels: value("resolution_megapixels", "promptstudio-resolution-megapixels"),
    resolution_multiple: value("resolution_multiple", "promptstudio-resolution-multiple"),
    generation_action: selectedAction(),
    lora_selections: structuredClone(state.loraSelections),
    model_selections: structuredClone(state.modelSelections),
  }, fallback);
}

function applyStudioSettings(chat) {
  if (!chat) return;
  // Provider connection details are application preferences, not session state.
  // Keep the synchronous localStorage copy authoritative when a restored or
  // remotely synchronized chat still contains an older provider selection.
  const settings = normalizeStudioSettings(applyRememberedLlmConnection(
    chat.studioSettings || getSettings(),
  ));
  chat.studioSettings = settings;
  state.loraSelections = structuredClone(settings.lora_selections);
  state.modelSelections = structuredClone(settings.model_selections);
  if (!state.panel) return;

  const setValue = (id, value) => {
    const control = state.panel.querySelector(`#${id}`);
    if (!control) return;
    if (control.tagName === "SELECT" && control.options.length
        && ![...control.options].some((option) => option.value === String(value))) {
      const unavailable = document.createElement("option");
      unavailable.value = String(value ?? "");
      unavailable.textContent = `${String(value || "Saved value")} · unavailable`;
      unavailable.dataset.promptstudioUnavailable = "true";
      control.appendChild(unavailable);
    }
    control.value = String(value ?? "");
  };
  const setChecked = (id, value) => {
    const control = state.panel.querySelector(`#${id}`);
    if (control) control.checked = Boolean(value);
  };
  renderLlmProfileOptions(settings.llm_profile);
  [
    ["promptstudio-llm-provider", settings.llm_provider],
    ["promptstudio-kobold-url", settings.kobold_url],
    ["promptstudio-ollama-url", settings.ollama_url],
    ["promptstudio-llamacpp-url", settings.llamacpp_url],
    ["promptstudio-llamacpp-executable", settings.llamacpp_executable],
    ["promptstudio-llamacpp-config-profile", settings.llamacpp_config_profile],
    ["promptstudio-profile", settings.model_profile],
    ["promptstudio-style", settings.style_preset],
    ["promptstudio-framing", settings.framing_preset],
    ["promptstudio-style-modifier", settings.style_modifier],
    ["promptstudio-framing-modifier", settings.framing_modifier],
    ["promptstudio-thinking", selectedLlmThinkingMode()],
    ["promptstudio-embellishment", settings.embellishment_level],
    ["promptstudio-output-length", settings.target_output_length],
    ["promptstudio-temperature", settings.temperature],
    ["promptstudio-additional-instructions", settings.additional_instructions],
    ["promptstudio-secondary-instructions", settings.secondary_instructions],
    ["promptstudio-image-scale", settings.image_scale],
    ["promptstudio-resolution-aspect-ratio", settings.resolution_aspect_ratio],
    ["promptstudio-resolution-megapixels", settings.resolution_megapixels],
    ["promptstudio-resolution-multiple", settings.resolution_multiple],
  ].forEach(([id, setting]) => setValue(id, setting));
  const ollamaModel = state.panel.querySelector("#promptstudio-ollama-model");
  if (ollamaModel && settings.ollama_model
      && ![...ollamaModel.options].some((option) => option.value === settings.ollama_model)) {
    const option = document.createElement("option");
    option.value = settings.ollama_model;
    option.textContent = settings.ollama_model;
    ollamaModel.appendChild(option);
  }
  setValue("promptstudio-ollama-model", settings.ollama_model);
  const llamacppModel = state.panel.querySelector("#promptstudio-llamacpp-model");
  if (llamacppModel && settings.llamacpp_model
      && ![...llamacppModel.options].some((option) => option.value === settings.llamacpp_model)) {
    const option = document.createElement("option");
    option.value = settings.llamacpp_model;
    option.textContent = settings.llamacpp_model;
    llamacppModel.appendChild(option);
  }
  setValue("promptstudio-llamacpp-model", settings.llamacpp_model);
  [
    ["promptstudio-use-llm-amplification", settings.use_llm_amplification],
    ["promptstudio-use-prompt-upscaling", settings.use_prompt_upscaling],
    ["promptstudio-randomize-seed", settings.randomize_seed],
    ["promptstudio-auto-generate", settings.auto_generate],
    ["promptstudio-auto-advance-source", settings.auto_advance_source],
    ["promptstudio-use-latest-image-context", settings.use_latest_image_context],
    ["promptstudio-keep-models-loaded", settings.keep_models_loaded],
    ["promptstudio-llamacpp-autostart", settings.llamacpp_autostart],
  ].forEach(([id, setting]) => setChecked(id, setting));
  const action = state.panel.querySelector(
    `input[name="promptstudio-generation-action"][value="${settings.generation_action}"]`,
  );
  if (action) action.checked = true;
  const outputLength = state.panel.querySelector("#promptstudio-output-length");
  if (outputLength) outputLength.dataset.custom = String(settings.output_length_custom);
  applyImageScale(settings.image_scale);
  syncOutputLengthControl({ storedSettings: settings });
  syncLlmProfileControls();
  syncLlmProviderControls();
  updateAmplificationMode({ announce: false, persist: false });
  renderAdditionalInstructionTemplateHighlights();
}

function syncActiveChatSettings({ persist = true } = {}) {
  const chat = activeChat();
  if (!chat || !state.chatStoreLoaded) return false;
  const settings = captureStudioSettings(chat);
  if (JSON.stringify(settings) === JSON.stringify(chat.studioSettings)) return false;
  chat.studioSettings = settings;
  chat.updatedAt = Date.now();
  if (persist) saveChats({ immediate: true });
  return true;
}

function syncActiveChat() {
  const chat = activeChat();
  if (!chat) return;
  chat.mainPrompt = state.mainPrompt;
  chat.finalPrompt = state.currentPrompt;
  chat.currentPrompt = state.currentPrompt;
  chat.mainPromptDirty = chat.mainPrompt !== String(chat.renderedMainPrompt ?? "");
  chat.finalPromptManuallyEdited = chat.finalPrompt !== String(chat.renderedFinalPrompt ?? "");
  chat.versions = [...state.versions];
  chat.versionIndex = state.versionIndex;
  chat.initialized = Boolean(chat.initialized);
  chat.createWorkflowId = state.panel?.querySelector("#promptstudio-create-workflow")?.value || "";
  chat.editWorkflowId = state.panel?.querySelector("#promptstudio-edit-workflow")?.value || "";
  chat.upscaleWorkflowId = state.panel?.querySelector("#promptstudio-upscale-workflow")?.value || "";
  chat.editPromptMode = selectedEditPromptMode();
  syncActiveChatSettings({ persist: false });
  chat.updatedAt = Date.now();
  saveChats();
  renderChatList();
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

function controlsFingerprintValues(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return Array.isArray(parsed) && parsed.length === RENDER_CONTROL_IDS.length
      ? parsed.map((item) => String(item ?? ""))
      : null;
  } catch (_) {
    return null;
  }
}

function changedRenderControlLabels(chat = activeChat()) {
  const baseline = controlsFingerprintValues(chat?.controlsFingerprint);
  const current = controlsFingerprintValues(controlsFingerprint());
  if (!baseline || !current) return chat?.initialized ? ["Generation controls"] : [];
  return RENDER_CONTROL_SETTINGS
    .filter((_, index) => baseline[index] !== current[index])
    .map(([, , label]) => label);
}

function useLlmAmplification() {
  return state.panel?.querySelector("#promptstudio-use-llm-amplification")?.checked !== false;
}

function normalizeLlmProvider(value) {
  return ["koboldcpp", "ollama", "llamacpp"].includes(String(value || "").trim().toLowerCase())
    ? String(value).trim().toLowerCase()
    : "ollama";
}

function confirmAdvancedLlmProvider(provider) {
  const normalized = normalizeLlmProvider(provider);
  if (normalized === "ollama") return true;
  try {
    if (localStorage.getItem(ADVANCED_LLM_ACK_STORAGE_KEY) === "acknowledged") return true;
  } catch (_) {
    // Continue with the notice when browser storage is unavailable.
  }
  const view = state.panel?.ownerDocument.defaultView;
  const accepted = Boolean(view?.confirm(
    `${llmProviderDisplayName(normalized)} is an advanced local-server option.\n\n`
    + "You are responsible for installing and configuring the server, model files, endpoint, vision/projector support, and GPU settings. Incorrect settings can prevent LLM processing or exhaust GPU memory. Ollama is the recommended default for most users.\n\n"
    + "Choose OK to continue. This notice will not be shown again.",
  ));
  if (accepted) {
    try {
      localStorage.setItem(ADVANCED_LLM_ACK_STORAGE_KEY, "acknowledged");
    } catch (_) {
      // Selection still works, but the notice cannot be remembered without browser storage.
    }
  }
  return accepted;
}

function handleLlmProviderChange() {
  const select = state.panel?.querySelector("#promptstudio-llm-provider");
  if (!select) return;
  const requested = normalizeLlmProvider(select.value);
  if (!confirmAdvancedLlmProvider(requested)) select.value = "ollama";
  syncLlmProviderControls({ refreshModels: true });
  if (selectedLlmProvider() === "llamacpp") loadLlamacppConfigProfiles({ announce: false });
  markControlsChanged();
  updateComposeMode();
  if (!state.panel.querySelector("#promptstudio-consult").hidden) refreshConsultVisionCapability();
}

function llmProviderDisplayName(provider = selectedLlmProvider()) {
  return { koboldcpp: "KoboldCpp", ollama: "Ollama", llamacpp: "Llama.cpp" }[normalizeLlmProvider(provider)];
}

function selectedLlmProvider() {
  return normalizeLlmProvider(state.panel?.querySelector("#promptstudio-llm-provider")?.value);
}

function llmProviderName() {
  return llmProviderDisplayName();
}

function controlsNeedApply() {
  const chat = activeChat();
  return Boolean(useLlmAmplification() && chat?.initialized && changedRenderControlLabels(chat).length);
}

function mainPromptNeedsRender() {
  const chat = activeChat();
  if (!chat) return false;
  chat.mainPromptDirty = chat.mainPrompt !== String(chat.renderedMainPrompt ?? "");
  return Boolean(useLlmAmplification() && chat.initialized && chat.mainPromptDirty);
}

function promptNeedsRender() {
  return mainPromptNeedsRender() || controlsNeedApply();
}

function activeStudioOperationStatus(chat = activeChat()) {
  return [...(chat?.messages || [])].reverse().find((message) => (
    message.operationId && message.operationPhase
    && !["complete", "error", "cancelled"].includes(message.operationPhase)
  ))?.operationStatus || "";
}

function latestStudioOperationFailure(chat = activeChat()) {
  const failure = [...(chat?.messages || [])].reverse().find((message) => message.operationPhase === "error");
  return failure && Number(failure.updatedAt || 0) >= Number(chat?.updatedAt || 0) ? failure : null;
}

function currentStudioStatus() {
  if (!state.apiConnected) return { text: "ComfyUI disconnected — Prompt Studio is frozen.", kind: "error" };
  const chat = activeChat();
  const operationStatus = activeStudioOperationStatus(chat);
  if (operationStatus) return { text: operationStatus, kind: "working" };
  const operationFailure = latestStudioOperationFailure(chat);
  if (operationFailure) {
    return { text: operationFailure.text || operationFailure.operationStatus || "Operation failed.", kind: "error" };
  }
  if (state.studioTurnBusyChatIds.has(state.activeChatId)) {
    return { text: `Understanding your request with ${llmProviderName()}…`, kind: "working" };
  }
  const action = selectedAction();
  const profile = selectedWorkflowProfile(action);
  const role = action === "edit" ? "editing" : "creation";
  const verb = action === "edit" ? "Edit" : "Create";
  if (!profile) return { text: `No compatible [PS] ${role} workflow is available.`, kind: "warning" };
  if (!useLlmAmplification()) {
    return { text: `Direct prompt mode. ${llmProviderName()} will not be used.`, kind: "ready" };
  }
  if (!chat?.initialized) {
    return state.mainPastedImage
      ? { text: "Reference image attached. Add a description or send to create the first prompt.", kind: "ready" }
      : { text: "Describe an image to create the first prompt.", kind: "ready" };
  }
  if (!chat.mainPrompt.trim()) return { text: "The main prompt is empty.", kind: "warning" };
  if (!chat.finalPrompt.trim()) return { text: "The final prompt is empty.", kind: "warning" };
  if (mainPromptNeedsRender()) {
    return { text: `Main prompt changed. ${llmProviderName()} will rebuild the final prompt before generation.`, kind: "warning" };
  }
  const changedControls = changedRenderControlLabels(chat);
  if (changedControls.length) {
    const summary = changedControls.length <= 2
      ? changedControls.join(" and ")
      : `${changedControls.slice(0, 2).join(", ")} and ${changedControls.length - 2} more controls`;
    return { text: `${summary} changed. ${llmProviderName()} will rebuild the final prompt before generation.`, kind: "warning" };
  }
  if (chat.finalPromptManuallyEdited) {
    return { text: `Final prompt edited manually. ComfyUI will use it directly without ${llmProviderName()}.`, kind: "ready" };
  }
  const discussion = activeStudioDiscussion(chat);
  if (discussion?.pendingProposal?.status === "ready") {
    return { text: "Suggestion ready to apply.", kind: "ready" };
  }
  if (state.mainPastedImage) return { text: "Reference image attached to the next request.", kind: "ready" };
  if (profile.stale) {
    return { text: `“${profile.name}” is invalid in ComfyUI. Prompt Studio will use its last working cache.`, kind: "warning" };
  }
  return { text: `${verb} is ready with “${profile.name}”.`, kind: "ready" };
}

function refreshStudioStatus() {
  if (!state.panel) return;
  const status = currentStudioStatus();
  setStatus(status.text, status.kind);
}

function markControlsChanged() {
  saveSettings();
  refreshStudioStatus();
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
  const properMessageTime = (message) => {
    if (!["user", "assistant"].includes(message?.role)) return 0;
    const createdAt = Number(message.createdAt);
    return Number.isFinite(createdAt) ? createdAt : 0;
  };
  return [...(chat.messages || []), ...(chat.consultMessages || [])].reduce(
    (newest, message) => Math.max(newest, properMessageTime(message)),
    Number(chat.createdAt) || 0,
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
    const agent = activeConsultAgent(chat);
    const generationCount = chat.messages.filter((message) => (
      message.promptId && ["queued", "generating"].includes(message.generationState)
    )).length;
    const operationCount = chat.messages.filter((message) => (
      message.operationId && !message.promptId
      && !["complete", "error", "cancelled"].includes(message.operationPhase)
    )).length;
    const preparationCount = [...state.studioPreparations.values()]
      .filter((preparation) => preparation.chatId === chat.id).length;
    const consultationPending = Boolean(chat.consultPendingJob);
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
    date.textContent = `${chat.messages.length} message${chat.messages.length === 1 ? "" : "s"}`
      + (preparationCount ? ` · ${preparationCount} preparing` : "")
      + (generationCount ? ` · ${generationCount} in queue` : "")
      + (agent ? ` · Agent: ${promptAgentStatusLabel(agent)}` : "");
    button.append(title, date);
    button.addEventListener("click", () => activateChat(chat.id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "promptstudio-chat-delete";
    remove.dataset.disableBusy = "";
    remove.disabled = state.busy || preparationCount > 0 || generationCount > 0 || operationCount > 0 || consultationPending || agent?.active;
    remove.textContent = "Delete";
    remove.title = preparationCount || generationCount || operationCount || consultationPending || agent?.active
      ? "Wait for this chat's pending Studio or Prompt Agent work to finish before deleting it."
      : `Delete chat from ${chatTitle(chat.createdAt)}`;
    remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", () => deleteChat(chat.id));
    row.append(button, remove);
    list.appendChild(row);
  }
}

function scrollElementToEnd(history, { instant = false, revisionKey = "historyScrollRevision" } = {}) {
  if (!history) return;
  const revision = ++state[revisionKey];
  const scroll = ({ onlyIfNearEnd = false } = {}) => {
    if (revision !== state[revisionKey] || !history.isConnected) return;
    if (onlyIfNearEnd && !historyShouldStickToEnd(history)) return;
    setHistoryShouldStickToEnd(history, true);
    if (instant) history.classList.add("promptstudio-instant-scroll");
    history.scrollTop = history.scrollHeight;
    if (instant) history.classList.remove("promptstudio-instant-scroll");
  };
  scroll();
  const view = history.ownerDocument.defaultView;
  view?.requestAnimationFrame(() => view.requestAnimationFrame(() => scroll({ onlyIfNearEnd: true })));
  for (const image of history.querySelectorAll("img")) {
    if (!image.complete) {
      image.addEventListener("load", () => {
        if (image.isConnected) scroll({ onlyIfNearEnd: true });
      }, { once: true });
    }
  }
}

function scrollHistoryToEnd({ instant = false } = {}) {
  scrollElementToEnd(state.panel?.querySelector("#promptstudio-history"), { instant });
}

function historyIsNearEnd(history, threshold = CHAT_SCROLL_STICK_THRESHOLD) {
  return history.scrollHeight - history.clientHeight - history.scrollTop <= threshold;
}

function historyShouldStickToEnd(history) {
  if (history?.id === "promptstudio-history") return state.historyWasNearEnd;
  if (history?.id === "promptstudio-consult-history") return state.consultHistoryWasNearEnd;
  return history ? historyIsNearEnd(history) : false;
}

function setHistoryShouldStickToEnd(history, value) {
  if (history?.id === "promptstudio-history") state.historyWasNearEnd = Boolean(value);
  if (history?.id === "promptstudio-consult-history") state.consultHistoryWasNearEnd = Boolean(value);
}

function placeHistoryAtEnd(history, { revisionKey = "historyScrollRevision" } = {}) {
  state[revisionKey] += 1;
  setHistoryShouldStickToEnd(history, true);
  history.classList.add("promptstudio-instant-scroll");
  history.scrollTop = history.scrollHeight;
  history.classList.remove("promptstudio-instant-scroll");
}

function keepHistoryViewportStable(
  history,
  wasNearEnd,
  previousScrollTop,
  { revisionKey = "historyScrollRevision" } = {},
) {
  if (wasNearEnd) {
    scrollElementToEnd(history, { instant: true, revisionKey });
    return;
  }
  setHistoryShouldStickToEnd(history, false);
  state[revisionKey] += 1;
  history.classList.add("promptstudio-instant-scroll");
  history.scrollTop = previousScrollTop;
  history.classList.remove("promptstudio-instant-scroll");
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

function renderChatHistory({ forceEnd = false } = {}) {
  const history = state.panel?.querySelector("#promptstudio-history");
  if (!history) return;
  const wasNearEnd = forceEnd || historyShouldStickToEnd(history);
  const previousScrollTop = history.scrollTop;
  history.replaceChildren();
  for (const message of activeChat()?.messages || []) renderMessage(message, { scroll: false });
  refreshEmptyImageDropZone();
  renderStudioDiscussionContext();
  if (forceEnd) placeHistoryAtEnd(history);
  else keepHistoryViewportStable(history, wasNearEnd, previousScrollTop);
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
  const queueingGeneration = hasPendingStudioGenerations();
  const turnBusy = state.studioTurnBusyChatIds.has(state.activeChatId);
  const reroll = state.panel.querySelector("#promptstudio-reroll");
  if (reroll) reroll.textContent = queueingGeneration ? "Queue reroll" : "Reroll";
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
    if (send) send.textContent = queueingGeneration
      ? (action === "edit" ? "Queue edit" : "Queue create new")
      : (action === "edit" ? "Edit selected image" : "Create new image");
    if (send) send.disabled = state.busy || turnBusy;
    if (editor) editor.readOnly = false;
    return;
  }
  const discussion = activeStudioDiscussion();
  if (heading) heading.textContent = creating ? "Describe or ask" : "Ask about the image or describe a change";
  if (hint) hint.textContent = discussion
    ? "Continue discussing, accept the suggestion, or request a direct change"
    : creating
      ? `${llmProviderName()} will decide whether to answer or create`
      : "Leave empty to create from the current prompt";
  if (input) input.placeholder = creating
    ? "A portrait of an astronaut… or ask for prompt advice"
    : "Make the dress casual… or ask what would work better";
  if (send) {
    if (hasRevision) send.textContent = turnBusy ? "Thinking…" : "Send";
    else if (!autoGenerate) send.textContent = creating ? "Create prompt" : "Revise prompt";
    else {
      const label = action === "edit"
        ? (hasRevision ? "Revise & edit selected" : "Edit selected")
        : (hasRevision ? "Revise & create new" : "Create new");
      send.textContent = queueingGeneration ? `Queue ${label.toLowerCase()}` : label;
    }
    send.disabled = state.busy || turnBusy;
  }
  if (editor) editor.readOnly = creating;
  renderStudioDiscussionContext();
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
  if (chat) {
    chat.initialized = Boolean(value.trim());
    chat.renderedMainPrompt = value;
    chat.renderedFinalPrompt = value;
    chat.mainPromptDirty = false;
    chat.finalPromptManuallyEdited = false;
  }
  updatePromptEditors(value, value);
  syncActiveChat();
  refreshEmptyImageDropZone();
  refreshStudioStatus();
}

function createChat() {
  if (state.busy) return;
  if (isEmptyChat(activeChat())) return;
  commitPromptEditorVersion();
  syncActiveChat();
  clearMainPastedImage();
  const createAction = state.panel?.querySelector('input[name="promptstudio-generation-action"][value="create"]');
  if (createAction) createAction.checked = true;
  const reusable = state.chats.find(isEmptyChat);
  if (reusable) {
    const promotedAt = Math.max(Date.now(), ...state.chats.map(chatActivityAt)) + 1;
    reusable.createdAt = promotedAt;
    reusable.updatedAt = promotedAt;
    activateChat(reusable.id);
    return;
  }
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
    studioSettings: newChatStudioSettings(captureStudioSettings()),
    messages: [],
    consultMessages: [],
    consultAgent: null,
    consultAgentMode: false,
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
  if (chat.consultPendingJob) return;
  const view = state.panel?.ownerDocument.defaultView;
  if (!view?.confirm(`Delete the chat from ${chatTitle(chat.createdAt)}? This cannot be undone.`)) return;
  const wasActive = chat.id === state.activeChatId;
  state.chats.splice(index, 1);
  if (!state.chats.length) {
    const replacement = normalizeChat({ studioSettings: newChatStudioSettings(captureStudioSettings()) });
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
  if (switchingChats) {
    commitPromptEditorVersion();
    syncActiveChat();
  }
  const chat = state.chats.find((item) => item.id === chatId);
  if (!chat) return;
  state.activeChatId = chat.id;
  state.consultSelectedImages.clear();
  state.consultUploadedImages = [];
  state.historyWasNearEnd = true;
  state.consultHistoryWasNearEnd = true;
  if (switchingChats) showMainPastedImageForChat(chat.id);
  restoreChatState(chat);
  refreshWorkflowControls();
  renderChatHistory({ forceEnd: true });
  renderConsultHistory({ forceEnd: true });
  renderChatList();
  closePanelDrawers();
  refreshSecondaryInstructionsControl();
  refreshStudioStatus();
  const undo = state.panel?.querySelector("#promptstudio-undo");
  if (undo) undo.disabled = state.versionIndex <= 0 || state.busy;
  setPanelDrawer("chats", false);
  saveChats({ immediate: switchingChats });
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
  syncActiveChatSettings();
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
  syncActiveChatSettings();
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
      + ".promptstudio-additional-details textarea, .promptstudio-secondary-details textarea, "
      + ".promptstudio-toggles input, #promptstudio-kobold-url",
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
  if (action === selectedAction()) {
    refreshStudioStatus();
    return;
  }
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
    unavailable.value = remembered;
    unavailable.textContent = remembered
      ? `${workflowNameFromPath(remembered)} · unavailable`
      : `No compatible ${kind === "upscale" ? "upscaling" : kind === "edit" ? "editing" : "creation"} workflows`;
    select.appendChild(unavailable);
    select.disabled = true;
    return;
  }
  if (remembered && ![...select.options].some((option) => option.value === remembered)) {
    const unavailable = document.createElement("option");
    unavailable.value = remembered;
    unavailable.textContent = `${workflowNameFromPath(remembered)} · unavailable`;
    unavailable.dataset.promptstudioUnavailable = "true";
    select.appendChild(unavailable);
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
  refreshModelSection();
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
  if (control?.dataset?.promptstudioAllowDisconnected === "true") return true;
  if (!control?.closest?.('[role="dialog"]')) return false;
  const label = String(control.getAttribute?.("aria-label") || control.title || control.textContent || "").trim();
  return /^(close|cancel|done)\b/i.test(label);
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
  const reconnectedAfterRestart = connected && !state.apiConnected && state.comfyRestartBusy;
  const reconnectedAfterUpdate = connected && !state.apiConnected
    && (state.comfyUpdateNeedsRestart || state.comfyUpdateError);
  state.apiConnected = connected;
  if (reconnectedAfterRestart) state.comfyRestartBusy = false;
  if (reconnectedAfterRestart || reconnectedAfterUpdate) {
    state.comfyUpdateError = false;
    state.comfyUpdateMessage = "";
    state.comfyUpdateNeedsRestart = false;
  }
  if (connected) {
    if (state.disconnectedGenerationTimer) clearTimeout(state.disconnectedGenerationTimer);
    state.disconnectedGenerationTimer = null;
  }
  const panel = state.panel;
  if (!panel) return;
  const banner = panel.querySelector("#promptstudio-api-connection");
  panel.dataset.apiConnected = connected ? "true" : "false";
  if (banner) banner.hidden = connected;
  renderSystemStatusSummary();

  if (!connected) {
    freezeDisconnectedControls();
    const activeElement = panel.ownerDocument?.activeElement;
    if (activeElement && panel.contains(activeElement) && !isDisconnectedAllowedControl(activeElement)) {
      activeElement.blur();
    }
    setStatus("ComfyUI disconnected — Prompt Studio is frozen.", "error");
    setConsultStatus("ComfyUI disconnected — messages are paused.", "error");
    refreshVideoHandoffActions();
    return;
  }
  refreshVideoHandoffActions();

  for (const [control, wasDisabled] of state.disconnectedControls) {
    if (control.isConnected) control.disabled = wasDisabled;
  }
  state.disconnectedControls.clear();
  if (announce) {
    refreshStudioStatus();
    if (!state.consultBusy) setConsultStatus("Ready", "ready");
  }
}

function setupApiConnectionState() {
  api.addEventListener("reconnecting", () => setApiConnected(false));
  api.addEventListener("reconnected", () => setApiConnected(true));
  api.addEventListener("status", (event) => {
    const queueRemaining = Number(event.detail?.exec_info?.queue_remaining);
    if (Number.isFinite(queueRemaining)) state.comfyQueueRemaining = Math.max(0, queueRemaining);
    setApiConnected(event.detail !== null);
    renderSystemStatusSummary();
  });

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
  refreshVideoHandoffActions();
  state.panel?.querySelectorAll(".promptstudio-mode-control input, .promptstudio-generation-action input, .promptstudio-workflow-routing select, .promptstudio-settings input, .promptstudio-settings select, .promptstudio-settings textarea, .promptstudio-resolution-details input, .promptstudio-resolution-details select, .promptstudio-current-details textarea, .promptstudio-additional-details textarea, .promptstudio-secondary-details textarea, #promptstudio-kobold-url")
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
  updateComposeMode();
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
  setStatus("Retrying generation...", "working");
  try {
    await queueGeneration({
      ...options,
      originChatId: options.originChatId || activeChat()?.id || null,
      independent: true,
      releaseBusy: false,
    });
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
  const trigger = dialog._upscaleTrigger;
  dialog._upscaleTrigger = null;
  dialog.ownerDocument.defaultView?.setTimeout(() => trigger?.focus({ preventScroll: true }));
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
  dialog._upscaleTrigger = dialog.ownerDocument.activeElement;
  factor.value = "2";
  dialog.hidden = false;
  factor.focus({ preventScroll: true });
  factor.select();
}

function imageReferenceKey(reference) {
  const value = normalizeImageReference(reference);
  return value ? `${value.type}\u0000${value.subfolder}\u0000${value.filename}` : "";
}

function imageReferenceUrl(reference, version = "") {
  const value = storedImageReference(reference);
  if (!value) return "";
  if (value.type === "promptstudio") {
    return `/promptstudio/prompt-studio/image?filename=${encodeURIComponent(value.filename)}`;
  }
  const params = new URLSearchParams(value);
  if (version) params.set("promptstudio_version", String(version));
  return `/view?${params}`;
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
  return latestGeneratedContext(chat)?.image || null;
}

function latestGeneratedContext(chat = activeChat()) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message?.generationState !== "complete") continue;
    const images = Array.isArray(message.images) ? message.images : [];
    for (let imageIndex = images.length - 1; imageIndex >= 0; imageIndex -= 1) {
      const reference = normalizeImageReference(images[imageIndex]);
      if (reference) return { message, image: reference };
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

function editingSource(sourceImage = null, chat = activeChat()) {
  return normalizeImageReference(sourceImage)
    || normalizeImageReference(chat?.selectedSource)
    || latestConversationImage(chat);
}

function restoreStoredCanonicalPrompt(data) {
  const finalPrompt = String(data?.canonicalPrompt || "");
  if (!finalPrompt.trim()) return false;
  const mainPrompt = String(data?.mainPrompt || finalPrompt);
  const previousVersion = state.versions[state.versionIndex];
  const chat = activeChat();
  if (chat) {
    chat.initialized = true;
    chat.controlsFingerprint = data.llmAmplified
      ? normalizeStoredControlsFingerprint(data.controlsFingerprint, chat.studioSettings)
      : "";
    chat.renderedMainPrompt = mainPrompt;
    chat.renderedFinalPrompt = finalPrompt;
    chat.mainPromptDirty = false;
    chat.finalPromptManuallyEdited = false;
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
  if (changed) {
    saveLoraSelections();
    syncActiveChatSettings();
  }
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
  if (changed) {
    saveModelSelections();
    syncActiveChatSettings();
  }
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
    const url = imageReferenceUrl(reference, generationData?.promptId || generationData?.id);
    const image = document.createElement("img");
    image.src = url;
    image.alt = item.filename || "Generated image";
    image.loading = "lazy";
    image.decoding = "async";
    if (reference.width && reference.height) {
      image.width = reference.width;
      image.height = reference.height;
      preview.style.aspectRatio = `${reference.width} / ${reference.height}`;
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

function directVideoStudioTarget() {
  try {
    const host = globalThis.__promptstudioVideoStudioHost;
    const status = host?.status?.();
    if (host?.handoffImage && status?.open && status?.activeProjectId) {
      return { direct: true, host, ...status };
    }
  } catch (_) {
    // A detached same-origin host can disappear between availability checks.
  }
  return null;
}

function directVideoStudioStatus() {
  try {
    const host = globalThis.__promptstudioVideoStudioHost;
    if (!host) return null;
    state.videoStudioInstalled = true;
    return host.status?.() || { open: false, activeProjectId: "" };
  } catch (_) {
    return null;
  }
}

function activeVideoStudioTarget() {
  const direct = directVideoStudioTarget();
  if (direct) return direct;
  const now = Date.now();
  const broadcastTarget = [...state.videoStudioPresence.values()]
    .filter(item => item.open && item.activeProjectId && now - item.seenAt < VIDEO_STUDIO_PRESENCE_TIMEOUT_MS)
    .sort((left, right) => Number(right.openedAt || 0) - Number(left.openedAt || 0))[0];
  if (broadcastTarget) return broadcastTarget;
  const serverTarget = [...state.videoStudioServerPresence.values()]
    .filter(item => item.open && item.activeProjectId && now - item.seenAt < VIDEO_STUDIO_PRESENCE_TIMEOUT_MS)
    .sort((left, right) => Number(right.openedAt || 0) - Number(left.openedAt || 0))[0];
  return serverTarget ? { ...serverTarget, serverRelay: true } : null;
}

function videoHandoffAvailability() {
  const target = activeVideoStudioTarget();
  const now = Date.now();
  const directStatus = directVideoStudioStatus();
  const recentPresence = [
    ...state.videoStudioPresence.values(),
    ...state.videoStudioServerPresence.values(),
  ]
    .filter(item => now - item.seenAt < VIDEO_STUDIO_PRESENCE_TIMEOUT_MS);
  const installed = state.videoStudioInstalled === true || Boolean(directStatus) || recentPresence.length > 0;
  const open = Boolean(directStatus?.open || recentPresence.some(item => item.open));
  if (!installed) {
    return {
      available: false,
      reason: state.videoStudioInstalled === null
        ? "Checking whether Video Studio is installed…"
        : "Video Studio is not installed or is unavailable.",
    };
  }
  if (!open) return { available: false, reason: "Video Studio is installed, but it is not open." };
  if (!target) return { available: false, reason: "Video Studio is open, but no project is selected." };
  if (!state.apiConnected) return { available: false, reason: "ComfyUI is disconnected; reconnect before handing off the image." };
  if (state.busy) return { available: false, reason: "Wait for the current Prompt Studio operation to finish." };
  return {
    available: true,
    target,
    reason: `Send this image to Video Studio project “${target.projectName || "Untitled video"}”.`,
  };
}

function updateVideoHandoffAction(button, availability = videoHandoffAvailability()) {
  button.hidden = false;
  button.dataset.available = availability.available ? "true" : "false";
  button.setAttribute("aria-disabled", availability.available ? "false" : "true");
  button.title = availability.reason;
  button.setAttribute("aria-label", availability.reason);
  button.closest(".promptstudio-message")?.classList.add("promptstudio-has-video-handoff");
}

function refreshVideoHandoffActions() {
  const availability = videoHandoffAvailability();
  for (const button of state.panel?.querySelectorAll(".promptstudio-video-handoff") || []) {
    updateVideoHandoffAction(button, availability);
  }
}

function settleVideoHandoffChoice(choice = null) {
  const dialog = state.panel?.querySelector("#promptstudio-video-handoff-dialog");
  if (!dialog || dialog.hidden) return;
  dialog.hidden = true;
  const resolve = dialog._resolveChoice;
  const trigger = dialog._choiceTrigger;
  dialog._resolveChoice = null;
  dialog._choiceTrigger = null;
  resolve?.(choice);
  dialog.ownerDocument.defaultView?.setTimeout(() => trigger?.focus({ preventScroll: true }));
}

function chooseVideoHandoffTarget(target, trigger) {
  if (target?.projectEmpty !== false) return Promise.resolve("current");
  const dialog = state.panel?.querySelector("#promptstudio-video-handoff-dialog");
  if (!dialog) return Promise.resolve("current");
  settleVideoHandoffChoice();
  dialog.querySelector("#promptstudio-video-handoff-project-name").textContent = target.projectName || "Untitled video";
  dialog.hidden = false;
  dialog._choiceTrigger = trigger;
  dialog.querySelector("#promptstudio-video-handoff-current").focus({ preventScroll: true });
  return new Promise(resolve => { dialog._resolveChoice = resolve; });
}

async function handoffImageToVideoStudio(reference, button) {
  const availability = videoHandoffAvailability();
  if (!availability.available) {
    refreshVideoHandoffActions();
    return;
  }
  const target = availability.target;
  const image = normalizeImageReference(reference);
  if (!image) return;
  button.disabled = true;
  try {
    const targetMode = await chooseVideoHandoffTarget(target, button);
    if (!targetMode) return;
    const payload = {
      filename: image.filename,
      width: image.width || 0,
      height: image.height || 0,
      url: imageReferenceUrl(image),
      targetProjectId: target.activeProjectId,
      targetMode,
    };
    let result;
    if (target.direct) {
      result = await target.host.handoffImage(payload);
    } else if (target.serverRelay) {
      const requestId = makeId();
      const response = await api.fetchApi("/promptstudio-video/studio-handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId,
          targetInstanceId: target.instanceId,
          image: payload,
        }),
      });
      const queued = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(queued.error || `Video Studio handoff could not be queued (${response.status}).`);
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        await new Promise(resolve => window.setTimeout(resolve, 300));
        const resultResponse = await api.fetchApi(`/promptstudio-video/studio-handoff/${encodeURIComponent(requestId)}`, {
          cache: "no-store",
        });
        const resultData = await resultResponse.json().catch(() => ({}));
        if (resultResponse.status === 202) continue;
        if (!resultResponse.ok || !resultData.ok) {
          throw new Error(resultData.error || `Video Studio handoff failed (${resultResponse.status}).`);
        }
        result = resultData.result || {};
        break;
      }
      if (!result) throw new Error("Video Studio did not respond to the image handoff.");
    } else {
      const requestId = makeId();
      result = await new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          state.videoHandoffRequests.delete(requestId);
          reject(new Error("Video Studio did not respond to the image handoff."));
        }, 20000);
        state.videoHandoffRequests.set(requestId, { resolve, reject, timeout });
        state.videoStudioChannel?.postMessage({
          type: "handoff-image",
          requestId,
          targetInstanceId: target.instanceId,
          image: payload,
        });
      });
    }
    setStatus(
      `${image.filename} was added to Video Studio project “${result?.projectName || target.projectName || "Untitled video"}”.`,
      "ready",
    );
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    button.disabled = false;
    refreshVideoHandoffActions();
  }
}

function renderVideoHandoffAction(message, data) {
  if (!message || !data?.canonicalPrompt || !data.images?.length || message.querySelector(".promptstudio-video-handoff")) return;
  const reference = normalizeImageReference(data.images[0]);
  if (!reference) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "promptstudio-video-handoff";
  button.dataset.promptstudioAllowDisconnected = "true";
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>';
  button.addEventListener("click", () => handoffImageToVideoStudio(reference, button));
  message.classList.add("promptstudio-has-video-handoff");
  message.appendChild(button);
  updateVideoHandoffAction(button);
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
  const activeOperation = data?.operationId && !["complete", "error", "cancelled"].includes(data.operationPhase);
  if (!["queued", "generating"].includes(data?.generationState) && !activeOperation) return;

  const progress = state.generationProgress.get(String(data.promptId || ""));
  const value = Number(progress?.value);
  const max = Number(progress?.max);
  const determinate = Number.isFinite(value) && Number.isFinite(max) && max > 0;
  const percent = determinate ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : null;
  const phaseLabels = {
    submitted: "Submitted…",
    checking_vision: "Checking image support…",
    llm_processing: "LLM processing…",
    preparing_workflow: "Preparing workflow…",
    queueing: "Queueing workflow…",
  };
  const statusText = data.operationStatus || phaseLabels[data.operationPhase] || (progress?.phase === "queued" || (!progress?.phase && data.generationState === "queued")
    ? "Queued…"
    : progress?.phase === "finalizing"
    ? "Finalizing…"
    : data.generationAction === "upscale"
      ? "Upscaling…"
      : "Generating…");

  const container = document.createElement("div");
  container.className = "promptstudio-generation-progress";
  container.setAttribute("aria-live", "polite");

  const status = document.createElement("div");
  status.className = "promptstudio-generation-progress-status";
  const label = document.createElement("span");
  label.textContent = statusText;
  const amount = document.createElement("span");
  const llmTokenCount = data?.llmTokenCount == null ? null : Number(data.llmTokenCount);
  const hasTokenCount = percent == null
    && llmTokenCount != null
    && Number.isFinite(llmTokenCount)
    && llmTokenCount >= 0;
  if (percent == null) {
    amount.className = "promptstudio-llm-token-count";
    amount.textContent = hasTokenCount ? `${llmTokenCount.toLocaleString()} tokens` : "";
    amount.setAttribute("aria-label", amount.textContent);
  } else {
    amount.className = "promptstudio-generation-progress-amount";
    amount.textContent = `${percent}%`;
  }
  status.appendChild(label);
  if (percent != null) status.appendChild(amount);

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
  if (data.operationId) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "promptstudio-operation-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => cancelStudioOperation(data.id));
    container.appendChild(cancel);
  }
  if (hasTokenCount) container.appendChild(amount);
  message.appendChild(container);
}

function studioControlChangeLabels(changes) {
  const labels = {
    model_profile: "Model profile",
    style_preset: "Style preset",
    framing_preset: "Framing preset",
    style_modifier: "Style modifier",
    framing_modifier: "Framing modifier",
    additional_instructions: "Additional instructions",
    secondary_instructions: "Secondary instructions",
    embellishment_level: "Embellishment",
    target_output_length: "Target length",
    resolution_aspect_ratio: "Aspect ratio",
    resolution_megapixels: "Resolution",
    resolution_multiple: "Resolution multiple",
    randomize_seed: "Seed behavior",
  };
  return Object.keys(normalizeStudioControlChanges(changes)).map((key) => labels[key] || key);
}

function renderStudioProposalCard(message, data) {
  const proposal = normalizeStudioProposal(data?.studioProposal);
  if (!proposal) return;
  const card = document.createElement("div");
  card.className = "promptstudio-studio-proposal";
  card.dataset.status = proposal.status;
  const controlLabels = studioControlChangeLabels(proposal.control_changes);
  const hasPromptChange = Boolean(proposal.revision_instruction);
  const heading = document.createElement("strong");
  heading.textContent = proposal.status !== "ready"
    ? "Choice needed"
    : hasPromptChange && controlLabels.length
      ? "Suggested prompt & control changes"
      : controlLabels.length ? "Suggested control changes" : "Suggested prompt change";
  const summary = document.createElement("span");
  summary.textContent = proposal.summary;
  card.append(heading, summary);
  if (controlLabels.length) {
    const controls = document.createElement("small");
    controls.textContent = `Controls: ${controlLabels.join(", ")}`;
    card.appendChild(controls);
  }
  if (proposal.status === "ready") {
    const activeDiscussion = activeStudioDiscussion();
    const storedDiscussion = normalizeStudioDiscussion(activeChat()?.studioDiscussion);
    const canApply = activeDiscussion?.id === data.studioDiscussionId
      && activeDiscussion.pendingProposal?.id === proposal.id;
    const apply = document.createElement("button");
    apply.type = "button";
    apply.textContent = storedDiscussion?.id === data.studioDiscussionId && storedDiscussion.status === "applied"
      ? "Applied"
      : selectedAction() === "edit" ? "Apply & edit" : "Apply suggestion";
    apply.disabled = !canApply || state.busy || state.studioTurnBusyChatIds.has(state.activeChatId);
    apply.addEventListener("click", () => applyStudioProposalFromMessage(data.id));
    card.appendChild(apply);
  }
  message.appendChild(card);
}

function renderMessage(data, { scroll = true } = {}) {
  const history = state.panel?.querySelector("#promptstudio-history");
  if (!history) return null;
  const wasNearEnd = historyShouldStickToEnd(history);
  const message = document.createElement("div");
  message.className = `promptstudio-message promptstudio-${data.role}`;
  if (data.studioMessageKind === "discussion") message.classList.add("promptstudio-studio-discussion-message");
  message.dataset.messageId = data.id;

  if (data.label) {
    const label = document.createElement("div");
    label.className = "promptstudio-message-label";
    label.textContent = data.label;
    message.appendChild(label);
  }

  if (data.canonicalPrompt && data.workflowName) {
    message.classList.add("promptstudio-has-generation-provenance");
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
  renderVideoHandoffAction(message, data);
  renderStudioProposalCard(message, data);

  history.appendChild(message);
  if (scroll && wasNearEnd) scrollHistoryToEnd({ instant: true });
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
    generationState: ["queued", "generating", "complete", "error", "cancelled"].includes(options.generationState) ? options.generationState : "",
    operationId: String(options.operationId || ""),
    operationPhase: String(options.operationPhase || ""),
    operationStatus: String(options.operationStatus || ""),
    operationKind: String(options.operationKind || ""),
    llmProvider: options.llmProvider ? normalizeLlmProvider(options.llmProvider) : "",
    llmThinkingEnabled: options.llmThinkingEnabled === true,
    llmTokenCount: options.llmTokenCount != null && Number.isFinite(Number(options.llmTokenCount))
      ? Math.max(0, Math.trunc(Number(options.llmTokenCount)))
      : null,
    studioMessageKind: ["discussion", "revision"].includes(options.studioMessageKind)
      ? options.studioMessageKind
      : "",
    studioDiscussionId: String(options.studioDiscussionId || ""),
    studioProposal: normalizeStudioProposal(options.studioProposal),
    createdAt: now,
    updatedAt: now,
  };
  const chat = options.chatId
    ? state.chats.find((item) => item.id === options.chatId)
    : activeChat();
  if (chat) {
    chat.messages.push(data);
    chat.updatedAt = Date.now();
    saveChats();
    renderChatList();
  }
  return chat?.id === state.activeChatId ? renderMessage(data) : null;
}

function studioGenerationRecord(promptId) {
  const id = String(promptId || "");
  if (!id) return null;
  for (const chat of state.chats) {
    const message = chat.messages.find((item) => item.promptId === id);
    if (message) return { chat, message };
  }
  return null;
}

function studioOperationRecord(messageId) {
  const id = String(messageId || "");
  for (const chat of state.chats) {
    const message = chat.messages.find((item) => item.id === id);
    if (message) return { chat, message };
  }
  return null;
}

function updateStudioOperation(messageId, changes = {}) {
  const record = studioOperationRecord(messageId);
  if (!record) return null;
  Object.assign(record.message, changes, { updatedAt: Date.now() });
  if (["cancelled", "error", "complete"].includes(record.message.operationPhase) && record.message.operationId) {
    state.operationControllers.delete(record.message.operationId);
  }
  record.chat.updatedAt = record.message.updatedAt;
  saveChats({ immediate: ["cancelled", "error", "complete"].includes(record.message.operationPhase) });
  renderChatList();
  if (record.chat.id === state.activeChatId) {
    renderChatHistory();
    refreshStudioStatus();
  }
  queueMicrotask(syncBackgroundActivityIndicator);
  return record.message;
}

function createStudioOperation(chat, kind, status = "Submitted…") {
  const operationId = makeId();
  state.operationControllers.set(operationId, new AbortController());
  appendMessage("assistant", "", {
    chatId: chat.id,
    label: "Prompt Studio",
    operationId,
    operationKind: kind,
    operationPhase: "submitted",
    operationStatus: status,
  });
  const message = [...chat.messages].reverse().find((item) => item.operationId === operationId);
  if (chat.id === state.activeChatId) refreshStudioStatus();
  return message || null;
}

async function cancelStudioOperation(messageId) {
  const record = studioOperationRecord(messageId);
  const message = record?.message;
  if (!record || !message?.operationId || ["complete", "error", "cancelled"].includes(message.operationPhase)) return;
  state.operationControllers.get(message.operationId)?.abort();
  state.operationControllers.delete(message.operationId);
  if (message.promptId) {
    state.generationJobs.delete(String(message.promptId));
    await cancelComfyPrompt(message.promptId);
  }
  updateStudioOperation(message.id, {
    generationState: "cancelled",
    operationPhase: "cancelled",
    operationStatus: "Cancelled",
    text: "Cancelled.",
  });
}

function studioGenerationElement(record) {
  return record?.chat.id === state.activeChatId ? messageElement(record.message.id) : null;
}

async function appendGenerationImages(promptId, images) {
  if (!images.length) return;
  const enrichedImages = await Promise.all(images.map(async (image) => {
    try {
      return await imageReferenceWithDimensions(image);
    } catch (_) {
      return normalizeImageReference(image);
    }
  }));
  // Chat synchronization replaces normalized objects. Resolve the live record only after the
  // asynchronous image enrichment so results are never written into a detached message object.
  const record = studioGenerationRecord(promptId);
  if (!record) return;
  const { chat, message: stored } = record;
  stored.images = enrichedImages;
  stored.updatedAt = Date.now();
  const autoAdvanceSource = state.generationJobs.get(String(promptId))?.autoAdvanceSource
    ?? state.panel?.querySelector("#promptstudio-auto-advance-source")?.checked;
  if (enrichedImages[0] && autoAdvanceSource) {
    chat.selectedSource = normalizeImageReference(enrichedImages[0]);
  } else if (!chat.selectedSource && enrichedImages[0]) {
    chat.selectedSource = normalizeImageReference(enrichedImages[0]);
  }
  chat.updatedAt = Date.now();
  saveChats();
  renderChatList();
  const element = studioGenerationElement(record);
  if (element) {
    const history = element.closest("#promptstudio-history");
    const wasNearEnd = history ? historyShouldStickToEnd(history) : false;
    const previousScrollTop = history?.scrollTop || 0;
    element.querySelector(".promptstudio-image-grid")?.remove();
    renderImageGallery(element, stored.images, stored);
    renderPromptInfo(element, stored);
    renderVideoHandoffAction(element, stored);
    refreshRenderedImageSources();
    if (history) keepHistoryViewportStable(history, wasNearEnd, previousScrollTop);
  }
}

function updateMainPromptEditor(prompt) {
  state.mainPrompt = prompt;
  const editor = state.panel?.querySelector("#promptstudio-main-prompt");
  if (editor) editor.value = prompt;
  renderKnownReferenceHighlights();
}

function knownReferenceTokenCharacter(value) {
  return Boolean(value && /[\p{L}\p{N}_]/u.test(value));
}

function knownReferenceHighlightRanges(text) {
  const source = String(text || "");
  const names = Array.isArray(state.config?.known_reference_names)
    ? state.config.known_reference_names.map(String).filter(Boolean)
    : [];
  const candidates = [];
  names.forEach((name, referenceIndex) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matcher = new RegExp(escaped, "giu");
    for (const match of source.matchAll(matcher)) {
      const start = match.index;
      const end = start + match[0].length;
      if (
        (!knownReferenceTokenCharacter(name[0]) || !knownReferenceTokenCharacter(source[start - 1]))
        && (!knownReferenceTokenCharacter(name.at(-1)) || !knownReferenceTokenCharacter(source[end]))
      ) {
        candidates.push({ start, end, referenceIndex });
      }
    }
  });
  candidates.sort((left, right) => (
    left.start - right.start
    || (right.end - right.start) - (left.end - left.start)
    || left.referenceIndex - right.referenceIndex
  ));
  const accepted = [];
  for (const candidate of candidates) {
    if (accepted.some((range) => candidate.start < range.end && candidate.end > range.start)) continue;
    accepted.push(candidate);
  }
  return accepted.sort((left, right) => left.start - right.start);
}

function renderKnownReferenceHighlights() {
  const editor = state.panel?.querySelector("#promptstudio-main-prompt");
  const layer = state.panel?.querySelector("#promptstudio-main-prompt-highlights");
  const content = state.panel?.querySelector("#promptstudio-main-prompt-highlight-content");
  if (!editor || !layer || !content) return;
  const text = editor.value;
  const ranges = knownReferenceHighlightRanges(text);
  const fragment = document.createDocumentFragment();
  let offset = 0;
  for (const range of ranges) {
    fragment.append(document.createTextNode(text.slice(offset, range.start)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(range.start, range.end);
    fragment.append(mark);
    offset = range.end;
  }
  fragment.append(document.createTextNode(`${text.slice(offset)}\n`));
  content.replaceChildren(fragment);
  layer.style.width = `${editor.clientWidth}px`;
  layer.style.height = `${editor.clientHeight}px`;
  content.style.width = `${editor.clientWidth}px`;
  content.style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
  editor.closest(".promptstudio-main-prompt-editor")?.toggleAttribute("data-has-highlights", ranges.length > 0);
}

function additionalInstructionTemplateHighlightRanges(text) {
  const source = String(text || "");
  const trimmed = source.trim();
  if (!trimmed) return [];
  const names = Array.isArray(state.config?.additional_instruction_template_names)
    ? state.config.additional_instruction_template_names.map(String).filter(Boolean)
    : [];
  const templateIndex = names.findIndex((name) => {
    const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped}$`, "iu").test(trimmed);
  });
  if (templateIndex < 0) return [];
  const start = source.search(/\S/u);
  return [{ start, end: start + trimmed.length, templateIndex }];
}

function renderAdditionalInstructionTemplateHighlights() {
  const editor = state.panel?.querySelector("#promptstudio-additional-instructions");
  const layer = state.panel?.querySelector("#promptstudio-additional-instruction-highlights");
  const content = state.panel?.querySelector("#promptstudio-additional-instruction-highlight-content");
  if (!editor || !layer || !content) return;
  const text = editor.value;
  const ranges = additionalInstructionTemplateHighlightRanges(text);
  const fragment = document.createDocumentFragment();
  let offset = 0;
  for (const range of ranges) {
    fragment.append(document.createTextNode(text.slice(offset, range.start)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(range.start, range.end);
    fragment.append(mark);
    offset = range.end;
  }
  fragment.append(document.createTextNode(`${text.slice(offset)}\n`));
  content.replaceChildren(fragment);
  layer.style.width = `${editor.clientWidth}px`;
  layer.style.height = `${editor.clientHeight}px`;
  content.style.width = `${editor.clientWidth}px`;
  content.style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
  editor.closest(".promptstudio-additional-instructions-editor")
    ?.toggleAttribute("data-has-highlights", ranges.length > 0);
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
    chat.mainPromptDirty = prompt !== String(chat.renderedMainPrompt ?? "");
    chat.pendingGeneration = null;
  }
  chat.updatedAt = Date.now();
  saveChats();
  refreshEmptyImageDropZone();
  if (userEdit) refreshStudioStatus();
}

function syncCanonicalEditor(prompt, { userEdit = false } = {}) {
  updatePromptEditor(prompt);
  const chat = activeChat();
  if (!chat) return;
  chat.finalPrompt = prompt;
  chat.currentPrompt = prompt;
  chat.initialized = Boolean(prompt.trim());
  if (userEdit) {
    chat.renderedMainPrompt = chat.mainPrompt;
    chat.mainPromptDirty = false;
    chat.finalPromptManuallyEdited = prompt !== String(chat.renderedFinalPrompt ?? "");
    chat.controlsFingerprint = controlsFingerprint();
    chat.pendingGeneration = null;
  }
  chat.updatedAt = Date.now();
  saveChats();
  updateComposeMode();
  if (userEdit) refreshStudioStatus();
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

function outputLengthSpec() {
  const profile = state.panel?.querySelector("#promptstudio-profile")?.value || "General Natural Language";
  const configured = state.config?.output_length_profiles?.[profile];
  if (configured) return configured;
  if (profile.startsWith("Tag-Based ")) {
    return {
      unit: "tags",
      min: 5,
      max: 40,
      step: 1,
      defaults: {
        none: 5,
        minimal: 7,
        clean: 10,
        detailed: 12,
        rich: 20,
        maximum: 24,
        "ultra maximum": 32,
      },
    };
  }
  return {
    unit: "words",
    min: 20,
    max: 200,
    step: 5,
    defaults: {
      none: 20,
      minimal: 25,
      clean: 35,
      detailed: 50,
      rich: 65,
      maximum: 70,
      "ultra maximum": 140,
    },
  };
}

function syncOutputLengthControl({ resetToDefault = false, storedSettings = null } = {}) {
  const input = state.panel?.querySelector("#promptstudio-output-length");
  if (!input) return;
  const spec = outputLengthSpec();
  const level = (state.panel.querySelector("#promptstudio-embellishment")?.value || "Clean").trim().toLowerCase();
  const minimum = Number(spec.min) || 20;
  const maximum = Number(spec.max) || 200;
  const step = Math.max(1, Number(spec.step) || 1);
  const defaultValue = Math.max(minimum, Math.min(maximum, Number(spec.defaults?.[level]) || minimum));
  const wasCustom = storedSettings
    ? Boolean(storedSettings.output_length_custom)
    : input.dataset.custom === "true";
  const custom = resetToDefault ? false : wasCustom;
  const requested = storedSettings ? Number(storedSettings.target_output_length) : Number(input.value);
  const unclamped = custom && Number.isFinite(requested) ? requested : defaultValue;
  const value = Math.max(minimum, Math.min(maximum, minimum + Math.round((unclamped - minimum) / step) * step));
  const unit = spec.unit === "tags" ? "tags" : "words";

  input.min = String(minimum);
  input.max = String(maximum);
  input.step = String(step);
  input.value = String(value);
  input.dataset.custom = String(custom);
  input.setAttribute("aria-valuetext", `About ${value} ${unit}`);

  const valueLabel = state.panel.querySelector("#promptstudio-output-length-value");
  if (valueLabel) valueLabel.textContent = `~${value} ${unit}`;
  const help = state.panel.querySelector("#promptstudio-output-length-help");
  if (help) help.textContent = custom
    ? `Custom · default ${defaultValue} ${unit}`
    : `Default for ${state.panel.querySelector("#promptstudio-embellishment")?.value || "Clean"}`;
  const track = state.panel.querySelector("#promptstudio-output-length-track");
  if (track) {
    const position = maximum === minimum ? 0 : ((defaultValue - minimum) / (maximum - minimum)) * 100;
    track.style.setProperty("--promptstudio-output-default-position", `${position}%`);
    track.title = `Default for the current profile and embellishment: ${defaultValue} ${unit}`;
  }
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

async function loadLlamacppModels({ announce = false } = {}) {
  const select = state.panel?.querySelector("#promptstudio-llamacpp-model");
  const button = state.panel?.querySelector("#promptstudio-refresh-llamacpp-models");
  const endpoint = state.panel?.querySelector("#promptstudio-llamacpp-url")?.value.trim();
  if (!select || !endpoint) return;
  const selected = select.value || getSettings().llamacpp_model;
  if (button) button.disabled = true;
  try {
    const response = await api.fetchApi("/promptstudio/prompt-studio/llamacpp-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llamacpp_url: endpoint }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Could not load Llama.cpp models (${response.status}).`);
    const models = Array.isArray(data.models) ? data.models.map(String).filter(Boolean) : [];
    setOptions("promptstudio-llamacpp-model", models, selected);
    if (!models.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No models reported";
      select.appendChild(option);
    } else if (!models.includes(selected)) {
      select.value = models[0];
    }
    saveSettings();
    if (announce) setStatus(`Loaded ${models.length} Llama.cpp model${models.length === 1 ? "" : "s"}.`, models.length ? "ready" : "warning");
  } catch (error) {
    if (announce) setStatus(error.message || String(error), "warning");
  } finally {
    if (button) button.disabled = false;
  }
}

async function loadLlamacppConfigProfiles({ announce = false, preferred = "" } = {}) {
  const select = state.panel?.querySelector("#promptstudio-llamacpp-config-profile");
  const button = state.panel?.querySelector("#promptstudio-refresh-llamacpp-configs");
  if (!select) return;
  const selected = preferred || select.value || getSettings().llamacpp_config_profile;
  select.disabled = true;
  if (button) button.disabled = true;
  try {
    const response = await api.fetchApi(LLAMACPP_CONFIG_PROFILES_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llamacpp_config_profile: selected }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Could not load Llama.cpp config profiles (${response.status}).`);
    const profiles = Array.isArray(data.profiles) ? data.profiles.map(String).filter(Boolean) : [];
    setOptions("promptstudio-llamacpp-config-profile", profiles, selected);
    if (!profiles.length) {
      select.appendChild(new Option("No JSON profiles found", ""));
    } else if (!profiles.includes(selected)) {
      select.value = profiles[0];
    }
    const selectedProfile = String(data.selected_profile || select.value || "");
    if (selectedProfile && data.llm_profile && typeof data.llm_profile === "object") {
      state.llamacppConfigLlmProfiles.set(selectedProfile, normalizeLlmProfile({
        ...data.llm_profile,
        id: `llamacpp:${selectedProfile}`,
        name: selectedProfile.replace(/\.json$/i, ""),
      }));
      select.value = selectedProfile;
      renderLlmThinkingModeOptions();
      syncLlmProfileControls();
      syncLlmProviderControls();
    }
    saveSettings();
    refreshLlmStatus();
    if (announce) {
      setStatus(
        `Loaded ${profiles.length} Llama.cpp config profile${profiles.length === 1 ? "" : "s"}.`,
        profiles.length ? "ready" : "warning",
      );
    }
  } catch (error) {
    select.replaceChildren(new Option("Config folder unavailable", ""));
    if (announce) setStatus(error.message || String(error), "warning");
  } finally {
    select.disabled = false;
    if (button) button.disabled = false;
  }
}

function applyLlamacppAutostartStatus(data) {
  const enabled = data?.enabled === true;
  const checkbox = state.panel?.querySelector("#promptstudio-llamacpp-autostart");
  const executable = state.panel?.querySelector("#promptstudio-llamacpp-executable");
  const profile = state.panel?.querySelector("#promptstudio-llamacpp-config-profile");
  state.llamacppAutostartEnabled = enabled;
  if (checkbox) checkbox.checked = enabled;
  if (enabled && executable && data.llamacpp_executable) {
    executable.value = String(data.llamacpp_executable);
  }
  if (enabled && profile && data.llamacpp_config_profile) {
    const selected = String(data.llamacpp_config_profile);
    if (![...profile.options].some((option) => option.value === selected)) {
      profile.appendChild(new Option(selected, selected));
    }
    profile.value = selected;
  }
  saveSettings();
}

async function loadLlamacppAutostartPreference({ announce = false } = {}) {
  if (state.llamacppAutostartBusy) return;
  state.llamacppAutostartBusy = true;
  const checkbox = state.panel?.querySelector("#promptstudio-llamacpp-autostart");
  if (checkbox) checkbox.disabled = true;
  try {
    const response = await api.fetchApi(LLAMACPP_AUTOSTART_ENDPOINT);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Could not load Llama.cpp autostart (${response.status}).`);
    applyLlamacppAutostartStatus(data);
    if (announce) {
      setStatus(data.enabled ? "Llama.cpp will start with ComfyUI." : "Llama.cpp autostart is off.", "ready");
    }
  } catch (error) {
    if (announce) setStatus(error.message || String(error), "warning");
  } finally {
    state.llamacppAutostartBusy = false;
    if (checkbox) checkbox.disabled = false;
  }
}

async function saveLlamacppAutostartPreference({ announce = false } = {}) {
  if (state.llamacppAutostartBusy) return;
  const checkbox = state.panel?.querySelector("#promptstudio-llamacpp-autostart");
  if (!checkbox) return;
  state.llamacppAutostartBusy = true;
  checkbox.disabled = true;
  try {
    const response = await api.fetchApi(LLAMACPP_AUTOSTART_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: checkbox.checked,
        llamacpp_executable: state.panel?.querySelector("#promptstudio-llamacpp-executable")?.value.trim() || "",
        llamacpp_config_profile: state.panel?.querySelector("#promptstudio-llamacpp-config-profile")?.value || "",
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Could not save Llama.cpp autostart (${response.status}).`);
    applyLlamacppAutostartStatus(data);
    if (announce) {
      setStatus(data.enabled ? "Llama.cpp will start with ComfyUI." : "Llama.cpp autostart disabled.", "ready");
    }
  } catch (error) {
    setStatus(error.message || String(error), "warning");
    state.llamacppAutostartBusy = false;
    await loadLlamacppAutostartPreference();
    return;
  } finally {
    state.llamacppAutostartBusy = false;
    checkbox.disabled = false;
  }
}

function syncLlmProviderControls({ refreshModels = false } = {}) {
  const provider = selectedLlmProvider();
  state.panel?.querySelectorAll("[data-llm-provider]").forEach((element) => {
    element.hidden = element.dataset.llmProvider !== provider;
  });
  const help = state.panel?.querySelector("#promptstudio-llm-amplification-help");
  if (help) help.textContent = `Rewrite prompts through ${llmProviderName()}`;
  const profileControl = state.panel?.querySelector(".promptstudio-llm-profile-control");
  if (profileControl) profileControl.hidden = provider === "llamacpp";
  const consultProfileEdit = state.panel?.querySelector("#promptstudio-consult-edit-llm-profile");
  if (consultProfileEdit) {
    consultProfileEdit.textContent = provider === "llamacpp" ? "Edit config" : "Edit profile";
    consultProfileEdit.title = provider === "llamacpp"
      ? "Edit sampler and request settings in the selected Llama.cpp config"
      : "Edit the active LLM profile";
  }
  if (provider === "llamacpp") closeLlmProfileEditor({ restoreFocus: false });
  const thinking = state.panel?.querySelector("#promptstudio-thinking-control");
  if (thinking) {
    const profile = selectedLlmProfile();
    const providerHelp = provider === "ollama"
      ? "Ollama receives the selected native reasoning effort."
      : `${llmProviderName()} receives the selected reasoning_effort through Chat Completions.`;
    thinking.title = `${profile.name} modes: ${profile.thinking_modes.join(", ")}. ${providerHelp}`;
  }
  if (refreshModels && provider === "ollama") loadOllamaModels({ announce: true });
  if (refreshModels && provider === "llamacpp") loadLlamacppModels({ announce: true });
  if (state.llmStatusTimer) refreshLlmStatus();
}

async function loadConfig() {
  const response = await api.fetchApi("/promptstudio/prompt-studio/config");
  if (!response.ok) throw new Error(`Could not load Prompt Studio configuration (${response.status}).`);
  state.config = await response.json();
  const settings = normalizeStudioSettings(activeChat()?.studioSettings || getSettings());
  setOptions("promptstudio-profile", state.config.profiles, settings.model_profile);
  setOptions("promptstudio-style", state.config.styles, settings.style_preset);
  setOptions("promptstudio-framing", state.config.framings, settings.framing_preset);
  renderLlmThinkingModeOptions(settings.thinking_mode);
  setOptions("promptstudio-embellishment", state.config.embellishment_levels, settings.embellishment_level);
  syncOutputLengthControl({ storedSettings: settings });
  applyStudioSettings(activeChat());
  renderKnownReferenceHighlights();
  renderAdditionalInstructionTemplateHighlights();
  if (selectedLlmProvider() === "ollama") await loadOllamaModels({ announce: false });
  if (selectedLlmProvider() === "llamacpp") {
    await loadLlamacppConfigProfiles({ announce: false, preferred: settings.llamacpp_config_profile });
    await loadLlamacppModels({ announce: false });
  }
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
    llamacpp_url: value("promptstudio-llamacpp-url"),
    llamacpp_model: value("promptstudio-llamacpp-model"),
    llamacpp_executable: value("promptstudio-llamacpp-executable"),
    llamacpp_config_profile: value("promptstudio-llamacpp-config-profile"),
    keep_models_loaded: Boolean(state.panel.querySelector("#promptstudio-keep-models-loaded")?.checked),
    ...llmProfileGenerationSettings(),
    model_profile: value("promptstudio-profile"),
    style_preset: value("promptstudio-style"),
    framing_preset: value("promptstudio-framing"),
    style_modifier: value("promptstudio-style-modifier"),
    framing_modifier: value("promptstudio-framing-modifier"),
    additional_instructions: value("promptstudio-additional-instructions"),
    embellishment_level: value("promptstudio-embellishment"),
    target_output_length: Number(value("promptstudio-output-length") || 35),
  };
  const storedContextImage = storedImageReference(contextImage);
  if (storedContextImage) payload.context_image = storedContextImage;
  return payload;
}

function captureGenerationQueueSettings(action, chat = activeChat()) {
  const profile = selectedWorkflowProfile(action);
  return {
    originChatId: chat?.id || null,
    workflowProfileId: profile?.id || null,
    loraState: structuredClone(generationLoraState(profile)),
    modelState: structuredClone(generationModelState(profile)),
    sourceImage: action === "create" ? null : editingSource(null, chat),
    randomizeSeed: state.panel?.querySelector("#promptstudio-randomize-seed")?.checked === true,
    secondaryInstructionsOverride: state.panel?.querySelector("#promptstudio-secondary-instructions")?.value || "",
    resolutionOverride: structuredClone(resolutionSettings()),
    controlsFingerprintOverride: controlsFingerprint(),
    llmAmplifiedOverride: useLlmAmplification(),
    autoAdvanceSource: state.panel?.querySelector("#promptstudio-auto-advance-source")?.checked !== false,
    preserveUiSelections: true,
  };
}

function randomizeSnapshotSeeds(snapshot) {
  for (const node of Object.values(snapshot?.output || {})) {
    for (const name of Object.keys(node?.inputs || {})) {
      if (/^(seed|noise_seed)$/i.test(name)) node.inputs[name] = Math.floor(Math.random() * 0x100000000);
    }
  }
}

function generationMatchesLatestQueuedPrompt(
  chat = activeChat(),
  mainPrompt = state.mainPrompt,
  finalPrompt = state.currentPrompt,
  fingerprint = String(chat?.controlsFingerprint || ""),
) {
  const latestGeneration = [...(chat?.messages || [])]
    .reverse()
    .find((message) => Boolean(message.canonicalPrompt));
  if (!latestGeneration) return false;
  return latestGeneration.mainPrompt === mainPrompt
    && latestGeneration.canonicalPrompt === finalPrompt
    && latestGeneration.controlsFingerprint === fingerprint;
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

  return executionFailureMessage(eventName, details);
}

function executionFailureMessage(eventName, details = null) {
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

function rememberGenerationFailure(promptId, message) {
  const id = String(promptId || "");
  if (!id) return;
  state.generationFailures.set(id, message);
  while (state.generationFailures.size > 50) {
    state.generationFailures.delete(state.generationFailures.keys().next().value);
  }
}

function failTrackedGeneration(promptId, message) {
  const id = String(promptId || "");
  if (!id) return false;
  const failure = compactErrorText(message) || "Generation failed because ComfyUI stopped processing it.";
  let handled = false;

  const record = studioGenerationRecord(id);
  if (record && ["queued", "generating"].includes(record.message.generationState)) {
    updateStudioGenerationText(id, failure);
    setStudioGenerationState(id, "error");
    handled = true;
  }

  const consultTarget = state.consultGenerationTarget;
  if (String(consultTarget?.promptId || "") === id) {
    const chat = consultTarget.chatId
      ? state.chats.find((entry) => entry.id === consultTarget.chatId)
      : activeChat();
    const consultMessage = chat?.consultMessages.find((entry) => entry.id === consultTarget.messageId);
    const variant = consultMessage?.variants?.find((entry) => entry.id === consultTarget.variantId);
    const generation = normalizeConsultExperimentGeneration(variant?.generation) || {};
    setConsultExperimentGeneration(consultTarget.messageId, consultTarget.variantId, {
      ...generation,
      generationState: "error",
      text: failure,
      updatedAt: Date.now(),
    }, consultTarget.chatId);
    state.consultGenerationTarget = null;
    state.generating = false;
    setConsultBusy(false);
    setConsultStatus(failure, "error");
    handled = true;
  }

  const agentTarget = state.consultAgentGenerationTarget;
  if (String(agentTarget?.promptId || "") === id) {
    const agentChat = agentTarget.chatId
      ? state.chats.find((entry) => entry.id === agentTarget.chatId)
      : activeChat();
    const agent = activeConsultAgent(agentChat);
    const iteration = promptAgentIteration(agent, agentTarget.iterationId);
    const generation = normalizeConsultExperimentGeneration(iteration?.generation) || {};
    setConsultAgentGeneration(agentTarget.iterationId, {
      ...generation,
      generationState: "error",
      text: failure,
      updatedAt: Date.now(),
    }, "error", agentTarget.chatId, agentTarget.agentId);
    state.consultAgentGenerationTarget = null;
    state.generating = false;
    setConsultStatus(failure, "error");
    handled = true;
  }

  rememberGenerationFailure(id, failure);
  if (!handled) return false;
  state.generationProgress.delete(id);
  state.generationJobs.delete(id);
  if (state.activeGenerationPromptId === id) state.activeGenerationPromptId = "";
  queueMicrotask(syncBackgroundActivityIndicator);
  return true;
}

async function promptWorkerStopped() {
  const now = Date.now();
  if (state.promptWorkerHealthRequest) return state.promptWorkerHealthRequest;
  if (now - state.promptWorkerHealthCheckedAt < 3000) return false;
  state.promptWorkerHealthCheckedAt = now;
  state.promptWorkerHealthRequest = (async () => {
    try {
      const response = await api.fetchApi("/promptstudio/prompt-studio/runtime-health", { cache: "no-store" });
      if (!response.ok) return false;
      const health = await response.json();
      if (health?.prompt_worker_alive === true) {
        state.promptWorkerSeenAlive = true;
        return false;
      }
      return state.promptWorkerSeenAlive && health?.prompt_worker_alive === false;
    } catch (_) {
      return false;
    } finally {
      state.promptWorkerHealthRequest = null;
    }
  })();
  return state.promptWorkerHealthRequest;
}

function messageElement(messageId) {
  return [...(state.panel?.querySelectorAll(".promptstudio-message") || [])]
    .find((message) => message.dataset.messageId === messageId) || null;
}

function updateGenerationProgress(promptId, progress = {}) {
  const record = studioGenerationRecord(promptId);
  const stored = record?.message;
  if (!stored || !["queued", "generating"].includes(stored.generationState)) return;
  const id = String(promptId);
  const current = state.generationProgress.get(id) || {};
  state.generationProgress.set(id, { ...current, ...progress });
  if (stored.generationState === "queued" && ["generating", "finalizing"].includes(progress.phase)) {
    setStudioGenerationState(id, "generating");
    return;
  }
  const element = studioGenerationElement(record);
  if (element) renderGenerationProgress(element, stored);
}

function updateStudioGenerationText(promptId, text) {
  const record = studioGenerationRecord(promptId);
  if (!record) return;
  record.message.text = String(text || "");
  record.message.updatedAt = Date.now();
  record.chat.updatedAt = record.message.updatedAt;
  saveChats();
  renderChatList();
  const element = studioGenerationElement(record);
  const history = element?.closest("#promptstudio-history");
  const wasNearEnd = history ? historyShouldStickToEnd(history) : false;
  const previousScrollTop = history?.scrollTop || 0;
  const body = element?.querySelector(".promptstudio-message-text");
  if (record.message.text) {
    if (body) body.textContent = record.message.text;
    else {
      const next = document.createElement("div");
      next.className = "promptstudio-message-text";
      next.textContent = record.message.text;
      element?.querySelector(".promptstudio-generation-progress")?.before(next);
      if (element && !next.isConnected) element.appendChild(next);
    }
  } else {
    body?.remove();
  }
  if (history) keepHistoryViewportStable(history, wasNearEnd, previousScrollTop);
}

function setStudioGenerationState(promptId, generationState) {
  const record = studioGenerationRecord(promptId);
  if (!record) return;
  record.message.generationState = generationState;
  record.message.operationPhase = generationState;
  record.message.operationStatus = generationState === "complete"
    ? "Complete"
    : generationState === "error"
      ? "Failed"
      : generationState === "cancelled"
        ? "Cancelled"
        : generationState === "generating" ? "Generating" : "Queued";
  if (!["queued", "generating"].includes(generationState)) {
    state.generationProgress.delete(String(promptId));
    state.generationJobs.delete(String(promptId));
    if (state.activeGenerationPromptId === String(promptId)) state.activeGenerationPromptId = "";
    if (record.message.operationId) state.operationControllers.delete(record.message.operationId);
  }
  record.message.updatedAt = Date.now();
  record.chat.updatedAt = record.message.updatedAt;
  saveChats();
  renderChatList();
  const element = studioGenerationElement(record);
  if (element) {
    const history = element.closest("#promptstudio-history");
    const wasNearEnd = history ? historyShouldStickToEnd(history) : false;
    const previousScrollTop = history?.scrollTop || 0;
    renderGenerationProgress(element, record.message);
    if (history) keepHistoryViewportStable(history, wasNearEnd, previousScrollTop);
  }
  updateComposeMode();
  if (record.chat.id === state.activeChatId) refreshStudioStatus();
  queueMicrotask(syncBackgroundActivityIndicator);
}

function setupGenerationProgressEvents() {
  const eventPromptId = (event) => String(
    event?.detail?.prompt_id || event?.detail?.promptId || state.activeGenerationPromptId || "",
  );
  api.addEventListener("execution_start", (event) => {
    const promptId = eventPromptId(event);
    if (studioGenerationRecord(promptId)) {
      state.activeGenerationPromptId = promptId;
      setStudioGenerationState(promptId, "generating");
    }
    updateGenerationProgress(promptId, { phase: "generating" });
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
  for (const eventName of ["execution_error", "execution_interrupted"]) {
    api.addEventListener(eventName, (event) => {
      const promptId = eventPromptId(event);
      failTrackedGeneration(promptId, executionFailureMessage(eventName, event?.detail));
    });
  }
}

function setConsultExperimentGeneration(messageId, variantId, generation, chatId = null) {
  const chat = chatId ? state.chats.find((item) => item.id === chatId) : activeChat();
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
  if (chat.id === state.activeChatId) renderConsultHistory();
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

function promptAgentConversationSnapshot(chat) {
  return normalizePromptAgentConversationContext(
    (chat?.consultMessages || [])
      .filter((message) => !message.requestFailed && !String(message.experimentId || ""))
      .map((message) => ({
        role: message.role,
        text: message.text,
        context: message.context,
      })),
  );
}

function promptAgentStartReferences(chat) {
  const references = [];
  const seen = new Set();
  const add = (image, purpose) => {
    const normalized = normalizeImageReference(image);
    if (!normalized) return;
    const key = imageReferenceKey(normalized);
    if (!key || seen.has(key) || references.length >= 4) return;
    seen.add(key);
    references.push({
      image: normalized,
      purpose: String(purpose || "general reference").slice(0, 200),
    });
  };
  for (const item of state.consultSelectedImages.values()) {
    add(item.reference, item.purpose);
  }
  const messages = [...(chat?.consultMessages || []).slice(-PROMPT_AGENT_MAX_CONTEXT_MESSAGES)].reverse();
  for (const message of messages) {
    if (references.length >= 4) break;
    if (message.role !== "user" || message.requestFailed || String(message.experimentId || "")) continue;
    const description = String(message.text || "").trim().replace(/\s+/g, " ");
    const purpose = description
      ? `conversation image discussed with: ${description.slice(0, 150)}`
      : "image from the recent conversation";
    for (const image of [...(message.images || [])].reverse()) add(image, purpose);
  }
  return references;
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

function promptAgentGenerationPromptId(agent) {
  const iteration = promptAgentIteration(agent, agent?.currentIterationId);
  const generation = normalizeConsultExperimentGeneration(iteration?.generation);
  return generation?.promptId && ["queued", "generating"].includes(generation.generationState)
    ? generation.promptId
    : "";
}

function consultAgentChat(agentId) {
  const id = String(agentId || "");
  return state.chats.find((chat) => activeConsultAgent(chat)?.id === id) || null;
}

function updateConsultAgent(mutator, { immediate = false, chatId = null, agentId = null } = {}) {
  const chat = chatId
    ? state.chats.find((item) => item.id === chatId)
    : agentId ? consultAgentChat(agentId) : activeChat();
  const agent = activeConsultAgent(chat);
  if (!chat || !agent) return null;
  mutator(agent);
  agent.updatedAt = Date.now();
  chat.consultAgent = normalizeConsultAgent(agent);
  chat.updatedAt = agent.updatedAt;
  saveChats({ immediate });
  renderChatList();
  if (chat.id === state.activeChatId) {
    renderConsultHistory();
    updateConsultExperimentUi();
  }
  return chat.consultAgent;
}

function setConsultAgentGeneration(
  iterationId,
  generation,
  status = "generating",
  chatId = null,
  agentId = null,
) {
  const chat = chatId ? state.chats.find((item) => item.id === chatId) : activeChat();
  const activeAgent = activeConsultAgent(chat);
  if (
    !activeAgent?.active
    || (agentId && activeAgent.id !== String(agentId))
    || !promptAgentIteration(activeAgent, iterationId)
  ) return null;
  return updateConsultAgent((agent) => {
    const iteration = promptAgentIteration(agent, iterationId);
    if (!iteration) return;
    iteration.generation = normalizeConsultExperimentGeneration(generation);
    iteration.status = status;
    iteration.updatedAt = Date.now();
    agent.currentIterationId = iteration.id;
    agent.status = status === "generating" ? (iteration.validation ? "validating" : "generating") : agent.status;
  }, { immediate: true, chatId });
}

async function waitForConsultAgentResult(
  promptId,
  agentTarget,
  token,
  resultNodeIds = [],
  resultFields = ["images", "gifs"],
) {
  const id = String(promptId);
  while (token === state.pollToken) {
    const reportedFailure = state.generationFailures.get(id);
    if (reportedFailure) {
      state.generationFailures.delete(id);
      failTrackedGeneration(id, reportedFailure);
      state.generationFailures.delete(id);
      throw new Error(reportedFailure);
    }
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
          const agentChat = agentTarget.chatId
            ? state.chats.find((item) => item.id === agentTarget.chatId)
            : activeChat();
          const agent = activeConsultAgent(agentChat);
          if (!agent?.active || agent.id !== String(agentTarget.agentId || "")) return null;
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
            agentTarget.chatId,
            agentTarget.agentId,
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
    if (await promptWorkerStopped()) {
      const message = "Generation failed: ComfyUI's prompt worker stopped during processing, usually after an unrecovered execution or CUDA out-of-memory error.";
      failTrackedGeneration(id, message);
      state.generationFailures.delete(id);
      throw new Error(message);
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
  const id = String(promptId);
  while (token === state.pollToken) {
    const reportedFailure = state.generationFailures.get(id);
    if (reportedFailure) {
      state.generationFailures.delete(id);
      failTrackedGeneration(id, reportedFailure);
      state.generationFailures.delete(id);
      return;
    }
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
          const chat = consultTarget.chatId
            ? state.chats.find((entry) => entry.id === consultTarget.chatId)
            : activeChat();
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
          setConsultExperimentGeneration(consultTarget.messageId, consultTarget.variantId, generation, consultTarget.chatId);
          state.generationProgress.delete(String(promptId));
          if (state.activeGenerationPromptId === String(promptId)) state.activeGenerationPromptId = "";
          state.generating = false;
          state.consultGenerationTarget = null;
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
    if (await promptWorkerStopped()) {
      const message = "Generation failed: ComfyUI's prompt worker stopped during processing, usually after an unrecovered execution or CUDA out-of-memory error.";
      failTrackedGeneration(id, message);
      state.generationFailures.delete(id);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  if (token === state.pollToken) {
    const chat = consultTarget.chatId
      ? state.chats.find((entry) => entry.id === consultTarget.chatId)
      : activeChat();
    const message = chat?.consultMessages.find((entry) => entry.id === consultTarget.messageId);
    const variant = message?.variants?.find((entry) => entry.id === consultTarget.variantId);
    const current = normalizeConsultExperimentGeneration(variant?.generation) || {};
    setConsultExperimentGeneration(consultTarget.messageId, consultTarget.variantId, {
      ...current,
      generationState: "error",
      text: "Stopped waiting for the experimental generation result.",
      updatedAt: Date.now(),
    }, consultTarget.chatId);
    state.generating = false;
    state.consultGenerationTarget = null;
    setConsultBusy(false);
    setConsultStatus("Stopped waiting for the experimental generation result.", "error");
  }
}

async function followConsultExperimentGeneration(target, storedGeneration) {
  const promptId = String(storedGeneration.promptId);
  while (state.consultGenerationJobs.has(promptId)) {
    try {
      const response = await api.fetchApi(`/history/${encodeURIComponent(promptId)}`);
      if (response.ok) {
        const history = await response.json();
        const item = history?.[promptId];
        if (item) {
          const images = historyImages(item, storedGeneration.resultNodeIds, storedGeneration.resultFields);
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
            const generation = {
              ...storedGeneration,
              generationState: failure || !enrichedImages.length ? "error" : "complete",
              text: failure || (!enrichedImages.length ? "Generation completed without an image output." : ""),
              images: enrichedImages,
              updatedAt: Date.now(),
            };
            setConsultExperimentGeneration(target.messageId, target.variantId, generation, target.chatId);
            state.consultGenerationJobs.delete(promptId);
            state.generationProgress.delete(promptId);
            return;
          }
        }
      }
    } catch (_) {
      // The persisted job remains authoritative while ComfyUI reconnects.
    }
    if (await promptWorkerStopped()) {
      const generation = {
        ...storedGeneration,
        generationState: "error",
        text: "Generation failed because ComfyUI's prompt worker stopped.",
        updatedAt: Date.now(),
      };
      setConsultExperimentGeneration(target.messageId, target.variantId, generation, target.chatId);
      state.consultGenerationJobs.delete(promptId);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
}

function resumeAllConsultExperimentGenerations() {
  for (const chat of state.chats) {
    for (const message of chat.consultMessages || []) {
      for (const variant of message?.variants || []) {
        const generation = normalizeConsultExperimentGeneration(variant?.generation);
        if (!generation?.promptId || !["queued", "generating"].includes(generation.generationState)) continue;
        const promptId = String(generation.promptId);
        if (String(state.consultGenerationTarget?.promptId || "") === promptId) continue;
        if (state.consultGenerationJobs.has(promptId)) continue;
        const target = { chatId: chat.id, messageId: message.id, variantId: variant.id, promptId };
        state.consultGenerationJobs.set(promptId, target);
        followConsultExperimentGeneration(target, generation).catch((error) => {
          if (!state.consultGenerationJobs.has(promptId)) return;
          setConsultExperimentGeneration(message.id, variant.id, {
            ...generation, generationState: "error", text: error.message || String(error), updatedAt: Date.now(),
          }, chat.id);
          state.consultGenerationJobs.delete(promptId);
        });
      }
    }
  }
}

function resumeAllStudioGenerations() {
  if (!state.panel) return;
  for (const chat of state.chats) {
    for (const pending of chat.messages || []) {
      if (!["queued", "generating"].includes(pending.generationState) || !pending.promptId) continue;
      const promptId = String(pending.promptId);
      if (state.generationJobs.has(promptId)) continue;
      const retryOptions = generationRetryOptionsFromMessage(pending);
      state.generationJobs.set(promptId, { chatId: chat.id, retryOptions });
      waitForResult(
        promptId, null, 0, pending.resultNodeIds, pending.resultFields, retryOptions,
      ).catch((error) => {
        if (!state.generationJobs.has(promptId)) return;
        const message = error.message || String(error);
        updateStudioGenerationText(promptId, message);
        setStudioGenerationState(promptId, "error");
      });
    }
  }
}

function resumeSyncedGeneration() {
  resumeAllStudioGenerations();
  resumeAllConsultExperimentGenerations();
  if (state.busy || state.generating || !state.panel) return;
  const agentChat = state.chats.find((chat) => {
    const candidate = activeConsultAgent(chat);
    return candidate?.active && candidate.status !== "paused";
  });
  const agent = activeConsultAgent(agentChat);
  if (agent?.active && agent.status !== "paused") {
    if (!state.workflowStoreLoaded) return;
    runConsultAgent(agent.id);
    return;
  }
  const pending = [...(activeChat()?.messages || [])]
    .reverse()
    .find((message) => ["queued", "generating"].includes(message.generationState) && message.promptId);
  if (pending && state.generationJobs.has(String(pending.promptId))) return;
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
      if (state.consultGenerationJobs.has(String(generation.promptId))) return;
      const target = {
        chatId: activeChat()?.id || "",
        messageId: message.id,
        variantId: variant.id,
        promptId: generation.promptId,
      };
      state.generating = true;
      state.activeGenerationPromptId = generation.promptId;
      state.consultGenerationTarget = target;
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
        }, target.chatId);
        state.generating = false;
        state.consultGenerationTarget = null;
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
  state.generationJobs.set(String(pending.promptId), { chatId: activeChat()?.id || "" });
  const retryOptions = generationRetryOptionsFromMessage(pending);
  waitForResult(pending.promptId, targetMessage, 0, pending.resultNodeIds, pending.resultFields, retryOptions).catch((error) => {
    if (!state.generationJobs.has(String(pending.promptId))) return;
    const message = error.message || String(error);
    updateStudioGenerationText(pending.promptId, message);
    setStudioGenerationState(pending.promptId, "error");
  });
}

async function waitForResult(
  promptId,
  _targetMessage,
  _token,
  resultNodeIds = [],
  resultFields = ["images", "gifs"],
  retryOptions = null,
) {
  const id = String(promptId);
  while (state.generationJobs.has(id)) {
    const reportedFailure = state.generationFailures.get(id);
    if (reportedFailure) {
      state.generationFailures.delete(id);
      failTrackedGeneration(id, reportedFailure);
      state.generationFailures.delete(id);
      return;
    }
    const response = await api.fetchApi(`/history/${encodeURIComponent(promptId)}`);
    if (!state.generationJobs.has(id)) return;
    if (response.ok) {
      const history = await response.json();
      if (!state.generationJobs.has(id)) return;
      const item = history?.[promptId];
      if (item) {
        const images = historyImages(item, resultNodeIds, resultFields);
        const completed = Boolean(item.status?.completed);
        const failureMessage = generationFailureMessage(item);
        if (failureMessage || images.length || completed) {
          await appendGenerationImages(promptId, images);
          if (failureMessage) {
            updateStudioGenerationText(promptId, failureMessage);
            setStudioGenerationState(promptId, "error");
          } else if (images.length) {
            updateStudioGenerationText(promptId, "");
            setStudioGenerationState(promptId, "complete");
          } else {
            const message = "Generation completed without an image output.";
            updateStudioGenerationText(promptId, message);
            setStudioGenerationState(promptId, "error");
          }
          return;
        }
      }
    }
    if (await promptWorkerStopped()) {
      const message = "Generation failed: ComfyUI's prompt worker stopped during processing, usually after an unrecovered execution or CUDA out-of-memory error.";
      failTrackedGeneration(id, message);
      state.generationFailures.delete(id);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  if (state.generationJobs.has(id)) {
    const message = "Stopped waiting for the generation result.";
    updateStudioGenerationText(promptId, message);
    setStudioGenerationState(promptId, "error");
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

async function cancelComfyPrompt(promptId) {
  const id = String(promptId || "");
  if (!id) return;
  try {
    await api.fetchApi("/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [id] }),
    });
  } catch (_) {
    // It may already be running; item-scoped cancellation deliberately does not
    // use ComfyUI's global interrupt endpoint.
  }
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
  originChatId = null,
  randomizeSeed = null,
  secondaryInstructionsOverride = null,
  resolutionOverride = null,
  controlsFingerprintOverride = null,
  llmAmplifiedOverride = null,
  autoAdvanceSource = null,
  independent = false,
  releaseBusy = true,
  preserveUiSelections = false,
  cancellationCheck = null,
  operationMessageId = null,
} = {}) {
  if (!state.apiConnected) throw new Error("ComfyUI is disconnected. Wait for it to reconnect before generating.");
  const chat = originChatId
    ? state.chats.find((item) => item.id === originChatId)
    : activeChat();
  if (!chat && !consultTarget && !agentTarget) throw new Error("The originating chat no longer exists.");
  let operationMessage = operationMessageId ? studioOperationRecord(operationMessageId)?.message : null;
  if (chat && !consultTarget && !agentTarget && !operationMessage) {
    operationMessage = createStudioOperation(chat, action, "Preparing workflow…");
  }
  if (operationMessage?.operationId && !state.operationControllers.has(operationMessage.operationId)) {
    state.operationControllers.set(operationMessage.operationId, new AbortController());
  }
  if (operationMessage) {
    updateStudioOperation(operationMessage.id, {
      generationAction: action,
      operationPhase: "preparing_workflow",
      operationStatus: "Preparing workflow…",
    });
  }
  const operationToken = independent ? null : state.operationToken;
  const operationCancelled = () => (
    (operationToken !== null && operationToken !== state.operationToken)
    || operationMessage?.operationPhase === "cancelled"
    || Boolean(operationMessage?.operationId && state.operationControllers.get(operationMessage.operationId)?.signal.aborted)
    || (typeof cancellationCheck === "function" && cancellationCheck())
  );
  let source = action === "create" ? null : editingSource(sourceImage, chat);
  if (action !== "create" && !source) throw new Error(`There is no image in this conversation to ${action}.`);
  const context = await workflowQueueContext(action, workflowProfileId);
  if (operationCancelled()) return false;
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
  if (operationCancelled()) return false;
  const shouldRandomizeSeed = randomizeSeed == null
    ? Boolean(state.panel.querySelector("#promptstudio-randomize-seed")?.checked)
    : Boolean(randomizeSeed);
  const useNewSeed = alwaysNewSeed || (
    (forceNewSeed || (!preserveSeed && generationMatchesLatestQueuedPrompt(
      chat,
      mainPrompt,
      finalPrompt,
      controlsFingerprintOverride ?? String(chat?.controlsFingerprint || ""),
    )))
    && shouldRandomizeSeed
  );
  if (!replayExactGeneration && useNewSeed) randomizeSnapshotSeeds(context.snapshot);

  const secondaryInstructions = secondaryInstructionsOverride == null
    ? state.panel.querySelector("#promptstudio-secondary-instructions")?.value || ""
    : String(secondaryInstructionsOverride);
  if (!replayExactGeneration && action !== "upscale") {
    const apiNode = context.snapshot.output?.[String(context.promptNodeId)];
    if (!apiNode || ![SLOT_TYPE, AMPLIFY_TYPE].includes(apiNode.class_type)) {
      throw new Error("The configured prompt node was not included in the executable workflow.");
    }
    const resolution = {
      ...(resolutionOverride || resolutionSettings()),
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
      if (!preserveUiSelections && selectionForModelNode(context.profile.id, descriptor) !== canonical.name) {
        setSelectionForModelNode(context.profile.id, descriptor.id, canonical.name);
      }
    }
    modelNode.inputs ||= {};
    modelNode.inputs.unet_name = storedState.modelName;
  }

  if (operationCancelled()) return false;
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
    originChatId: chat?.id || null,
    randomizeSeed: shouldRandomizeSeed,
    secondaryInstructionsOverride: secondaryInstructions,
    resolutionOverride: resolutionOverride || resolutionSettings(),
    controlsFingerprintOverride: controlsFingerprintOverride ?? chat?.controlsFingerprint ?? "",
    llmAmplifiedOverride: llmAmplifiedOverride,
    autoAdvanceSource,
  };

  let queued;
  let llmHandoffToken = "";
  state.queueing = true;
  try {
    llmHandoffToken = await releaseLlmBeforeGeneration();
    if (operationCancelled()) return false;
    if (operationMessage) updateStudioOperation(operationMessage.id, {
      operationPhase: "queueing",
      operationStatus: "Queueing workflow…",
    });
    queued = await api.queuePrompt(-1, context.snapshot);
  } finally {
    await completeLlmHandoff(llmHandoffToken);
    state.queueing = false;
  }
  const promptId = queued?.prompt_id;
  if (!promptId) throw new Error("ComfyUI did not return a prompt ID.");
  if (operationCancelled()) {
    await cancelComfyPrompt(promptId);
    if (operationMessage) updateStudioOperation(operationMessage.id, {
      generationState: "cancelled",
      operationPhase: "cancelled",
      operationStatus: "Cancelled",
      text: "Cancelled.",
    });
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
    const storedAgent = setConsultAgentGeneration(
      agentTarget.iterationId,
      generation,
      "generating",
      agentTarget.chatId,
      agentTarget.agentId,
    );
    if (!storedAgent) {
      await cancelComfyPrompt(promptId);
      return false;
    }
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
    setConsultExperimentGeneration(
      consultTarget.messageId,
      consultTarget.variantId,
      generation,
      consultTarget.chatId,
    );
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
      setConsultExperimentGeneration(
        consultTarget.messageId,
        consultTarget.variantId,
        failed,
        consultTarget.chatId,
      );
      state.generating = false;
      state.consultGenerationTarget = null;
      setConsultBusy(false);
      setConsultStatus(failed.text, "error");
    });
    return true;
  }
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
  state.generationProgress.set(promptId, { phase: "queued" });
  const resultData = {
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
    generationState: "queued",
    controlsFingerprint: controlsFingerprintOverride ?? chat?.controlsFingerprint ?? "",
    llmAmplified: llmAmplifiedOverride == null ? useLlmAmplification() : Boolean(llmAmplifiedOverride),
    operationPhase: "queued",
    operationStatus: "Queued",
  };
  if (operationMessage) {
    updateStudioOperation(operationMessage.id, resultData);
    operationMessage = studioOperationRecord(operationMessage.id)?.message || operationMessage;
  } else {
    appendMessage("assistant", "", { chatId: chat?.id, ...resultData });
  }
  state.generationJobs.set(String(promptId), {
    chatId: chat?.id || "",
    retryOptions,
    autoAdvanceSource: autoAdvanceSource == null
      ? state.panel?.querySelector("#promptstudio-auto-advance-source")?.checked !== false
      : Boolean(autoAdvanceSource),
  });
  if (releaseBusy) setBusy(false);
  updateComposeMode();
  waitForResult(promptId, null, 0, queuedResultNodeIds, queuedResultFields, retryOptions).catch((error) => {
    if (!state.generationJobs.has(String(promptId))) return;
    const message = error.message || String(error);
    updateStudioGenerationText(promptId, message);
    setStudioGenerationState(promptId, "error");
  });
  return true;
}

async function queueUpscale(source, generationData = null, factor = null, workflowProfileId = null) {
  if (state.busy) return;
  const chat = activeChat();
  if (!chat) return;
  const usePrompt = state.panel?.querySelector("#promptstudio-use-prompt-upscaling")?.checked !== false;
  const executionPrompt = usePrompt
    ? String(generationData?.canonicalPrompt || state.currentPrompt || "")
    : "";
  const queueSettings = captureGenerationQueueSettings("upscale", activeChat());
  const operation = createStudioOperation(chat, "upscale", "Preparing upscale…");
  try {
    await queueGeneration({
      ...queueSettings,
      action: "upscale",
      executionPrompt,
      mainPrompt: String(generationData?.mainPrompt || state.mainPrompt || ""),
      finalPrompt: String(generationData?.canonicalPrompt || state.currentPrompt || ""),
      workflowProfileId,
      sourceImage: source,
      upscaleFactor: factor,
      independent: true,
      releaseBusy: false,
      operationMessageId: operation.id,
    });
  } catch (error) {
    const message = error.message || String(error);
    updateStudioOperation(operation.id, {
      generationState: "error",
      operationPhase: "error",
      operationStatus: "Failed",
      text: message,
    });
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
    chat.renderedMainPrompt = prompt;
    chat.renderedFinalPrompt = prompt;
    chat.mainPromptDirty = false;
    chat.finalPromptManuallyEdited = false;
  }
  input.value = prompt;
  updatePromptEditors(prompt, prompt);
  if (promptChanged) pushVersion();
  else syncActiveChat();
  saveSettings();
  const queueSettings = captureGenerationQueueSettings(action, chat);
  const operation = createStudioOperation(chat, action, "Preparing workflow…");
  try {
    await queueGeneration({
      ...queueSettings,
      action,
      executionPrompt: prompt,
      mainPrompt: prompt,
      finalPrompt: prompt,
      preserveSeed: promptChanged,
      independent: true,
      releaseBusy: false,
      operationMessageId: operation.id,
    });
  } catch (error) {
    const message = error.message || String(error);
    updateStudioOperation(operation.id, {
      generationState: "error",
      operationPhase: "error",
      operationStatus: "Failed",
      text: message,
    });
    showGenerationFailure(message, () => generateDirectPrompt(action));
  }
}

async function requestPromptRevision(payload, actionLabel, warningSink = null, signal = null) {
  if (!state.apiConnected) throw new Error("ComfyUI is disconnected. Wait for it to reconnect before sending.");
  const response = await api.fetchApi("/promptstudio/prompt-studio/revise", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${actionLabel} failed (${response.status}).`);
  const prompt = String(data.prompt || "").trim();
  if (!prompt) throw new Error(`${llmProviderName()} returned an empty prompt.`);
  const warning = String(data.warning || "").trim();
  if (warning && Array.isArray(warningSink) && !warningSink.includes(warning)) {
    warningSink.push(warning);
  }
  return prompt;
}

async function releaseLlmBeforeGeneration() {
  const connection = llmConnectionPayload();
  if (connection.keep_models_loaded) {
    updateLlmHandoffStatus();
    return "";
  }
  const response = await api.fetchApi(LLM_RELEASE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(connection),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error || `The local LLM could not release its model (${response.status}).`;
    updateLlmHandoffStatus(message);
    throw new Error(message);
  }
  updateLlmHandoffStatus();
  return String(data.handoff_token || "");
}

async function completeLlmHandoff(handoffToken) {
  if (!handoffToken) return;
  try {
    await api.fetchApi(LLM_HANDOFF_COMPLETE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handoff_token: handoffToken }),
    });
  } catch (error) {
    console.warn("Prompt Studio could not acknowledge the ComfyUI queue handoff.", error);
  }
}

function llmConnectionPayload() {
  const value = (id) => state.panel.querySelector(`#${id}`)?.value;
  return {
    llm_provider: value("promptstudio-llm-provider"),
    kobold_url: value("promptstudio-kobold-url"),
    ollama_url: value("promptstudio-ollama-url"),
    ollama_model: value("promptstudio-ollama-model"),
    llamacpp_url: value("promptstudio-llamacpp-url"),
    llamacpp_model: value("promptstudio-llamacpp-model"),
    llamacpp_executable: value("promptstudio-llamacpp-executable"),
    llamacpp_config_profile: value("promptstudio-llamacpp-config-profile"),
    keep_models_loaded: Boolean(state.panel.querySelector("#promptstudio-keep-models-loaded")?.checked),
  };
}

function llamacppLauncherConfigured(payload = llmConnectionPayload()) {
  return Boolean(
    String(payload.llamacpp_executable || "").trim()
    && String(payload.llamacpp_config_profile || "").trim()
  );
}

function comfyUiIsProcessing() {
  return state.comfyQueueRemaining > 0
    || state.generating
    || state.queueing
    || state.generationJobs.size > 0
    || pendingStudioGenerationCount() > 0;
}

function updateLlmHandoffStatus(message = "") {
  const provider = selectedLlmProvider();
  const current = state.llmStatusSnapshot?.provider === provider
    ? state.llmStatusSnapshot
    : { provider };
  renderLlmStatus({ ...current, provider, handoff_error: message || undefined });
}

function renderSystemStatusSummary() {
  const control = state.panel?.querySelector("#promptstudio-kobold-control");
  const label = control?.querySelector("#promptstudio-kobold-status-label");
  const comfyDetail = control?.querySelector("#promptstudio-comfy-status-detail");
  const updateProgress = control?.querySelector("#promptstudio-comfy-update-progress");
  const update = control?.querySelector("#promptstudio-comfy-update");
  const restart = control?.querySelector("#promptstudio-comfy-restart");
  if (!control || !label || !comfyDetail || !updateProgress || !update || !restart) return;

  const llm = state.llmStatusSnapshot;
  const provider = normalizeLlmProvider(llm?.provider || selectedLlmProvider());
  const llmUnhealthy = llm?.reachable === false
    || Boolean(llm?.handoff_error)
    || (["ollama", "llamacpp"].includes(provider)
      && llm?.reachable === true && (!llm.model || llm.model_installed === false));
  const checking = !llm || llm.checking === true;
  const comfyProcessing = comfyUiIsProcessing();
  const processing = checking
    || llm?.busy === true
    || comfyProcessing
    || state.busy
    || state.consultBusy
    || state.consultAgentRunning
    || state.comfyRestartBusy
    || state.comfyUpdateBusy
    || state.comfyUpdateNeedsRestart;
  const unhealthy = !state.apiConnected || llmUnhealthy || state.comfyUpdateError;
  const stateName = unhealthy ? "offline" : (processing ? "busy" : "idle");
  control.dataset.state = stateName;
  control.dataset.updateActive = state.comfyUpdateBusy ? "true" : "false";
  control.querySelector("summary").title = stateName === "offline"
    ? "System status: attention needed"
    : (stateName === "busy" ? "System status: processing" : "System status: ready");
  label.textContent = state.comfyUpdateBusy
    ? `Updating ComfyUI${state.comfyUpdateTotalCount > 0 ? `: ${state.comfyUpdateDoneCount}/${state.comfyUpdateTotalCount}` : ""}`
    : (state.comfyUpdateError
      ? "ComfyUI update failed"
      : (state.comfyUpdateNeedsRestart
        ? "ComfyUI update complete; restart required"
        : (state.comfyUpdateMessage
          ? state.comfyUpdateMessage
          : (stateName === "offline" ? "Status: attention needed" : (stateName === "busy" ? "Status: processing" : "Status: ready")))));

  if (!state.apiConnected) {
    comfyDetail.textContent = "Not responding";
    comfyDetail.dataset.state = "offline";
  } else if (state.comfyRestartBusy) {
    comfyDetail.textContent = "Restart requested";
    comfyDetail.dataset.state = "busy";
  } else if (state.comfyUpdateMessage) {
    comfyDetail.textContent = state.comfyUpdateMessage;
    comfyDetail.dataset.state = state.comfyUpdateError
      ? "offline"
      : (state.comfyUpdateBusy || state.comfyUpdateNeedsRestart ? "busy" : "idle");
  } else if (comfyProcessing) {
    const queued = Math.max(0, Number(state.comfyQueueRemaining) || 0);
    comfyDetail.textContent = queued ? `Processing · ${queued} queued` : "Processing";
    comfyDetail.dataset.state = "busy";
  } else {
    comfyDetail.textContent = "Connected and ready";
    comfyDetail.dataset.state = "idle";
  }
  updateProgress.hidden = !state.comfyUpdateBusy;
  if (state.comfyUpdateBusy && state.comfyUpdateTotalCount > 0) {
    updateProgress.max = state.comfyUpdateTotalCount;
    updateProgress.value = Math.min(state.comfyUpdateDoneCount, state.comfyUpdateTotalCount);
    updateProgress.setAttribute("aria-label", `ComfyUI update progress: ${state.comfyUpdateDoneCount} of ${state.comfyUpdateTotalCount}`);
  } else {
    updateProgress.removeAttribute("value");
    updateProgress.setAttribute("aria-label", "ComfyUI update in progress");
  }
  const managerBusy = state.comfyRestartBusy || state.comfyUpdateBusy;
  update.disabled = managerBusy || !state.apiConnected;
  update.textContent = state.comfyUpdateBusy && state.comfyUpdateTotalCount > 0
    ? `Updating ${state.comfyUpdateDoneCount}/${state.comfyUpdateTotalCount}`
    : (state.comfyUpdateBusy ? "Updating…" : "Update ComfyUI");
  restart.disabled = managerBusy || !state.apiConnected;
  restart.textContent = state.comfyRestartBusy ? "Restarting…" : "Restart ComfyUI";
}

function renderLlmStatus(status = {}) {
  const control = state.panel?.querySelector("#promptstudio-kobold-control");
  const label = control?.querySelector("#promptstudio-kobold-status-label");
  const detail = control?.querySelector("#promptstudio-kobold-status-detail");
  const model = control?.querySelector("#promptstudio-kobold-model");
  const vision = control?.querySelector("#promptstudio-kobold-vision");
  const heading = control?.querySelector("#promptstudio-llm-status-heading");
  const stop = control?.querySelector("#promptstudio-kobold-stop");
  const stopHelp = control?.querySelector("#promptstudio-kobold-stop-help");
  const processControls = control?.querySelector("#promptstudio-llamacpp-process-controls");
  const processDetail = control?.querySelector("#promptstudio-llamacpp-process-detail");
  const processStart = control?.querySelector("#promptstudio-llamacpp-start");
  const processStop = control?.querySelector("#promptstudio-llamacpp-server-stop");
  const processRestart = control?.querySelector("#promptstudio-llamacpp-restart");
  if (!control || !label || !detail || !model || !vision || !heading || !stop || !stopHelp) return;
  const provider = normalizeLlmProvider(status.provider || selectedLlmProvider());
  const isOllama = provider === "ollama";
  const isLlamacpp = provider === "llamacpp";
  const providerName = llmProviderDisplayName(provider);
  const reachable = status.reachable === true;
  const busy = !isOllama && reachable && status.busy === true;
  state.llmStatusSnapshot = { ...status, provider };
  control.dataset.provider = provider;
  heading.textContent = providerName;
  const characters = Number(status.generated_characters);
  const generatedTokens = llmGeneratedTokenCount(status);
  const activity = llmActivityLabel(status, thinkingModeEnablesReasoning(selectedLlmThinkingMode()));
  detail.textContent = status.handoff_error || status.message || (busy
    ? `${activity}${generatedTokens != null
      ? ` · ${generatedTokens.toLocaleString()} tokens`
      : (Number.isFinite(characters) && characters > 0 ? ` · ${characters.toLocaleString()} characters` : "")}`
    : (reachable ? "Ready for local requests." : `${providerName} could not be reached.`));
  const modelName = typeof status.model === "string" ? status.model.trim() : "";
  model.textContent = modelName || (reachable ? "Unavailable" : "—");
  model.title = modelName;
  if (isLlamacpp && reachable && modelName) {
    const modelSelect = state.panel?.querySelector("#promptstudio-llamacpp-model");
    if (modelSelect && !modelSelect.value) {
      modelSelect.replaceChildren(new Option(modelName, modelName));
      modelSelect.value = modelName;
      saveSettings();
    }
  }
  vision.textContent = status.vision === true ? "Yes" : (status.vision === false ? "No" : (reachable ? "Unknown" : "—"));
  vision.dataset.state = status.vision === true ? "available" : (status.vision === false ? "unavailable" : "unknown");
  stop.hidden = isOllama;
  stopHelp.hidden = isOllama;
  stop.disabled = !busy || state.koboldAbortBusy;
  stop.textContent = state.koboldAbortBusy ? "Stopping…" : "Force stop processing";
  stopHelp.textContent = isLlamacpp
    ? "Stops Prompt Studio text streams only. The Llama.cpp server stays loaded."
    : "Stops LLM processing only. KoboldCpp stays loaded.";
  if (processControls && processDetail && processStart && processStop && processRestart) {
    processControls.hidden = !isLlamacpp;
    processDetail.hidden = !isLlamacpp;
    const process = status.server_process || {};
    const managedRunning = process.managed === true && process.running === true;
    const launcherConfigured = llamacppLauncherConfigured();
    const selectedProfile = state.panel?.querySelector("#promptstudio-llamacpp-config-profile")?.value || "";
    const activeProfile = String(process.config_profile || "");
    const profileChangePending = managedRunning && (
      process.config_changed === true
      || (activeProfile && selectedProfile && activeProfile.toLowerCase() !== selectedProfile.toLowerCase())
    );
    processDetail.textContent = state.llamacppProcessBusy
      ? "Applying server action…"
      : (managedRunning
        ? (profileChangePending
          ? (activeProfile.toLowerCase() === selectedProfile.toLowerCase()
            ? `Running ${activeProfile} · restart to apply saved edits`
            : `Running ${activeProfile} · restart to apply ${selectedProfile}`)
          : `Managed server running${activeProfile ? ` · ${activeProfile}` : ""}${process.pid ? ` · PID ${process.pid}` : ""}`)
        : (reachable ? "Server running externally" : (launcherConfigured ? "Managed server stopped" : "Complete Backend settings to enable server controls")));
    processStart.disabled = state.llamacppProcessBusy || managedRunning || reachable || !launcherConfigured;
    processStop.disabled = state.llamacppProcessBusy || !managedRunning;
    processRestart.disabled = state.llamacppProcessBusy || !managedRunning || !launcherConfigured;
  }
  renderSystemStatusSummary();
}

async function restartComfyUIFromStatus() {
  if (state.comfyRestartBusy || state.comfyUpdateBusy || !state.apiConnected) return;
  const ownerWindow = state.panel?.ownerDocument?.defaultView || window;
  if (!ownerWindow.confirm("Restart ComfyUI now? Running generations and connected clients will be interrupted.")) return;
  state.comfyRestartBusy = true;
  renderSystemStatusSummary();
  try {
    let response;
    for (const endpoint of COMFY_RESTART_ENDPOINTS) {
      response = await api.fetchApi(endpoint, { method: "POST" });
      if (response.ok || ![404, 405].includes(response.status)) break;
    }
    if (!response.ok) throw new Error(`ComfyUI Manager could not restart the server (${response.status}).`);
    const detail = state.panel?.querySelector("#promptstudio-comfy-status-detail");
    if (detail) detail.textContent = "Restarting; waiting to reconnect…";
  } catch (error) {
    state.comfyRestartBusy = false;
    renderSystemStatusSummary();
    const detail = state.panel?.querySelector("#promptstudio-comfy-status-detail");
    if (detail) {
      detail.textContent = `${error.message || error} Restart ComfyUI manually if Manager is unavailable.`;
      detail.dataset.state = "offline";
    }
  }
}

async function requireManagerResponse(endpoints, options, action) {
  let response;
  for (const endpoint of endpoints) {
    response = await api.fetchApi(endpoint, options);
    if (response.ok) return response;
    if (response.status === 405) {
      response = await api.fetchApi(endpoint);
      if (response.ok) return response;
    }
    if (![404, 405].includes(response.status)) break;
  }
  const detail = (await response.text().catch(() => "")).trim();
  if (response.status === 404) {
    throw new Error("ComfyUI Manager's update API is unavailable in this running ComfyUI instance. Restart ComfyUI and try again.");
  }
  if (response.status === 401) {
    throw new Error("ComfyUI Manager is already processing another task.");
  }
  if (response.status === 403) {
    throw new Error("ComfyUI Manager's security policy blocked Update All. Check Manager security settings.");
  }
  throw new Error(detail || `ComfyUI Manager could not ${action} (${response.status}).`);
}

async function updateComfyUIFromStatus() {
  if (state.comfyUpdateBusy || state.comfyRestartBusy || !state.apiConnected) return;
  const ownerWindow = state.panel?.ownerDocument?.defaultView || window;
  if (!ownerWindow.confirm("Update ComfyUI, its Python packages, and installed custom nodes now? Restart ComfyUI after it finishes to apply the updates.")) return;
  state.comfyUpdateBusy = true;
  state.comfyUpdateError = false;
  state.comfyUpdateMessage = "Updating ComfyUI core and Python packages…";
  state.comfyUpdateNeedsRestart = false;
  state.comfyUpdateDoneCount = 0;
  state.comfyUpdateTotalCount = 0;
  state.comfyUpdateRequestId = `promptstudio-update-${Date.now()}`;
  state.comfyUpdateResults.clear();
  renderSystemStatusSummary();
  try {
    const clientId = String(api.clientId || api.initialClientId || window.name || crypto.randomUUID());
    const updateAllQuery = new URLSearchParams({
      client_id: clientId,
      ui_id: `${state.comfyUpdateRequestId}_nodes`,
      mode: "remote",
    });
    const coreResponse = await api.fetchApi(PROMPTSTUDIO_COMFY_UPDATE_ENDPOINT, { method: "POST" });
    const coreUpdate = await coreResponse.json().catch(() => ({}));
    if (!coreResponse.ok) {
      throw new Error(coreUpdate.error || `Prompt Studio could not update ComfyUI (${coreResponse.status}).`);
    }
    for (const [index, step] of Array.from(coreUpdate.steps || []).entries()) {
      const message = step.success === true
        ? (step.updated === true ? "success" : "skip")
        : (step.error || `An error occurred while updating '${step.label || step.id}'.`);
      state.comfyUpdateResults.set(`${state.comfyUpdateRequestId}_local_${index}`, {
        ui_id: `${state.comfyUpdateRequestId}_local_${index}`,
        kind: "promptstudio-update",
        title: step.label || step.id || "ComfyUI dependency",
        msg: message,
      });
    }
    state.comfyUpdateDoneCount = state.comfyUpdateResults.size;
    state.comfyUpdateTotalCount = state.comfyUpdateResults.size;
    state.comfyUpdateMessage = coreUpdate.success === false
      ? "ComfyUI core update reported errors · continuing with custom nodes…"
      : "ComfyUI core and Python packages checked · finding custom-node updates…";
    renderSystemStatusSummary();
    await requireManagerResponse(MANAGER_UPDATE_ALL_ENDPOINTS.map((endpoint) => endpoint.startsWith("/v2/")
      ? `${endpoint}?${updateAllQuery}`
      : `${endpoint}?mode=default`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "default" }),
    }, "queue Update All");
    state.comfyUpdateMessage = "Updates queued · starting Manager…";
    renderSystemStatusSummary();
    await requireManagerResponse(
      MANAGER_QUEUE_START_ENDPOINTS,
      { method: "POST" },
      "start Update All",
    );
    state.comfyUpdateMessage = "Manager Update All started · waiting for progress…";
    renderSystemStatusSummary();
    setStatus("ComfyUI Manager Update All is running. Progress is shown in System status.", "working");
  } catch (error) {
    state.comfyUpdateBusy = false;
    state.comfyUpdateError = true;
    state.comfyUpdateMessage = error.message || String(error);
    renderSystemStatusSummary();
    setStatus(`ComfyUI update could not start: ${state.comfyUpdateMessage}`, "error");
  }
}

function managerResultSucceeded(result) {
  const message = managerResultMessage(result);
  return typeof message === "string" && message.startsWith("success");
}

function managerResultFailed(result) {
  const message = managerResultMessage(result);
  return typeof message === "string" && message !== "skip" && !message.startsWith("success");
}

function managerResultSkipped(result) {
  const message = managerResultMessage(result);
  return message === "skip";
}

function managerResultMessage(result) {
  if (!result || typeof result !== "object") return result;
  return result.msg ?? result.result ?? result.status?.status_str ?? "";
}

function managerUpdateEventBelongsToRequest(detail) {
  return state.comfyUpdateBusy
    && Boolean(state.comfyUpdateRequestId)
    && String(detail?.ui_id || "").startsWith(state.comfyUpdateRequestId);
}

function managerUpdateCountsFromTaskState(taskState = {}) {
  const matches = (task) => String(task?.ui_id || "").startsWith(state.comfyUpdateRequestId);
  const done = Object.values(taskState.history || {}).filter(matches).length;
  const running = Array.from(taskState.running_queue || []).filter(matches).length;
  const pending = Array.from(taskState.pending_queue || []).filter(matches).length;
  return { done, total: done + running + pending };
}

function managerUpdateTaskLabel(detail = {}) {
  if (detail.title) return String(detail.title);
  if (detail.kind === "update-comfyui") return "ComfyUI core";
  const prefix = `${state.comfyUpdateRequestId}_nodes_`;
  const uiId = String(detail.ui_id || "");
  return uiId.startsWith(prefix) ? uiId.slice(prefix.length) : "custom node";
}

function handleManagerTaskStarted(event) {
  const detail = event.detail || {};
  if (!managerUpdateEventBelongsToRequest(detail)) return;
  const counts = managerUpdateCountsFromTaskState(detail.state);
  state.comfyUpdateDoneCount = counts.done;
  state.comfyUpdateTotalCount = counts.total;
  state.comfyUpdateMessage = `Updating ${managerUpdateTaskLabel(detail)} · ${counts.done}/${counts.total}`;
  renderSystemStatusSummary();
}

function handleManagerTaskCompleted(event) {
  const detail = event.detail || {};
  if (!managerUpdateEventBelongsToRequest(detail)) return;
  state.comfyUpdateResults.set(String(detail.ui_id), detail);
  const counts = managerUpdateCountsFromTaskState(detail.state);
  state.comfyUpdateDoneCount = counts.done;
  state.comfyUpdateTotalCount = counts.total;
  state.comfyUpdateMessage = `Finished ${managerUpdateTaskLabel(detail)} · ${counts.done}/${counts.total}`;
  if (counts.total > 0 && counts.done >= counts.total) {
    finishComfyUpdate(Array.from(state.comfyUpdateResults.values()));
    return;
  }
  renderSystemStatusSummary();
}

function finishComfyUpdate(results) {
  const allResults = [...new Set([...state.comfyUpdateResults.values(), ...results])];
  const updatedCount = allResults.filter(managerResultSucceeded).length;
  const failedCount = allResults.filter(managerResultFailed).length;
  const skippedCount = allResults.filter(managerResultSkipped).length;
  const failedLabels = [...new Set(allResults
    .filter(managerResultFailed)
    .map(managerUpdateTaskLabel))];
  const failedSummary = failedLabels.length
    ? ` · Failed: ${failedLabels.slice(0, 3).join(", ")}${failedLabels.length > 3 ? ` +${failedLabels.length - 3} more` : ""}`
    : "";
  const updated = updatedCount > 0;
  const failed = failedCount > 0;
  state.comfyUpdateBusy = false;
  state.comfyUpdateError = failed;
  state.comfyUpdateNeedsRestart = updated;
  state.comfyUpdateDoneCount = Math.max(state.comfyUpdateDoneCount, allResults.length);
  state.comfyUpdateTotalCount = Math.max(state.comfyUpdateTotalCount, allResults.length);
  state.comfyUpdateMessage = failed
    ? `Update finished · ${updatedCount} updated · ${failedCount} failed${failedSummary}${updated ? " · Restart required" : " · Check the ComfyUI terminal"}`
    : (updated
      ? `Update complete · ${updatedCount} updated${skippedCount ? ` · ${skippedCount} already current` : ""} · Restart required`
      : "Update complete · ComfyUI and custom nodes are already up to date");
  renderSystemStatusSummary();
  setStatus(state.comfyUpdateMessage, failed ? "error" : "ready");
  const control = state.panel?.querySelector("#promptstudio-kobold-control");
  if (control) control.open = true;
  state.comfyUpdateRequestId = "";
}

function handleManagerQueueStatus(event) {
  if (!state.comfyUpdateBusy) return;
  const status = event.detail || {};
  if (status.status === "all-done") {
    finishComfyUpdate(Array.from(state.comfyUpdateResults.values()));
    return;
  }
  if (status.status === "in_progress") {
    const done = Number(status.done_count);
    const total = Number(status.total_count);
    const completed = Number.isFinite(done) && Number.isFinite(total)
      ? Math.min(total, Math.max(0, done + (status.target ? 1 : 0)))
      : 0;
    state.comfyUpdateDoneCount = completed;
    state.comfyUpdateTotalCount = Number.isFinite(total) ? Math.max(0, total) : 0;
    const target = String(status.target || "").trim();
    state.comfyUpdateMessage = state.comfyUpdateTotalCount > 0
      ? `Updating · ${completed}/${state.comfyUpdateTotalCount}${target ? ` · ${target}` : ""}`
      : "Manager Update All is running…";
    renderSystemStatusSummary();
    return;
  }
  if (status.status !== "done") return;
  const results = Object.values(status.nodepack_result || {});
  state.comfyUpdateDoneCount = Number(status.done_count) || results.length;
  state.comfyUpdateTotalCount = Number(status.total_count) || results.length;
  finishComfyUpdate(results);
}

async function refreshLlmStatus() {
  const payload = {
    ...llmConnectionPayload(),
    thinking_mode: selectedLlmThinkingMode(),
  };
  const provider = normalizeLlmProvider(payload.llm_provider);
  if (state.llmStatusRequest && state.llmStatusRequestProvider === provider) return state.llmStatusRequest;
  const control = state.panel?.querySelector("#promptstudio-kobold-control");
  if (!control) return null;
  if (control.dataset.provider !== provider || control.dataset.state === "checking") {
    renderLlmStatus({ provider, checking: true });
  }
  const request = (async () => {
    try {
      const response = await api.fetchApi(LLM_STATUS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `${llmProviderDisplayName(provider)} status failed (${response.status}).`);
      if (selectedLlmProvider() === provider) {
        renderLlmStatus(data);
        updateActiveLlmOperationProgress(data);
      }
      return data;
    } catch (error) {
      if (selectedLlmProvider() === provider) {
        renderLlmStatus({ provider, reachable: false, message: error.message || String(error) });
      }
      return null;
    } finally {
      if (state.llmStatusRequest === request) {
        state.llmStatusRequest = null;
        state.llmStatusRequestProvider = "";
      }
    }
  })();
  state.llmStatusRequest = request;
  state.llmStatusRequestProvider = provider;
  return request;
}

function updateActiveLlmOperationProgress(status = {}) {
  const provider = normalizeLlmProvider(status.provider || selectedLlmProvider());
  let activeChatChanged = false;
  for (const chat of state.chats) {
    for (const message of chat.messages || []) {
      if (message.operationPhase !== "llm_processing") continue;
      if (message.llmProvider && normalizeLlmProvider(message.llmProvider) !== provider) continue;
      const activity = llmActivityLabel(status, message.llmThinkingEnabled === true);
      const tokenCount = llmGeneratedTokenCount(status);
      message.operationStatus = status.busy === true
        ? `${activity}…`
        : `${activity} · waiting…`;
      if (tokenCount != null) message.llmTokenCount = tokenCount;
      activeChatChanged ||= chat.id === state.activeChatId;
    }
  }
  if (activeChatChanged) {
    renderChatHistory();
    refreshStudioStatus();
  }
}

async function stopLlmGeneration() {
  const provider = selectedLlmProvider();
  if (!["koboldcpp", "llamacpp"].includes(provider) || state.koboldAbortBusy) return;
  state.koboldAbortBusy = true;
  renderLlmStatus({ provider, reachable: true, busy: true, message: "Sending force-stop signal…" });
  try {
    const response = await api.fetchApi(LLM_ABORT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(llmConnectionPayload()),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `${llmProviderDisplayName(provider)} stop failed (${response.status}).`);
    renderLlmStatus({
      provider,
      reachable: true,
      busy: data.success !== true,
      message: data.success ? "Stop signal accepted." : `${llmProviderDisplayName(provider)} reported no Prompt Studio processing to stop.`,
    });
  } catch (error) {
    renderLlmStatus({ provider, reachable: false, message: error.message || String(error) });
  } finally {
    state.koboldAbortBusy = false;
    window.setTimeout(refreshLlmStatus, 500);
  }
}

async function controlLlamacppServer(action) {
  if (selectedLlmProvider() !== "llamacpp" || state.llamacppProcessBusy) return;
  const payload = llmConnectionPayload();
  if (["start", "restart"].includes(action) && !llamacppLauncherConfigured(payload)) {
    setStatus("Set the Llama.cpp executable and config profile before starting the server.", "warning");
    return;
  }
  state.llamacppProcessBusy = true;
  renderLlmStatus({ ...(state.llmStatusSnapshot || {}), provider: "llamacpp" });
  try {
    const response = await api.fetchApi(`${LLAMACPP_SERVER_ENDPOINT}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Llama.cpp server ${action} failed (${response.status}).`);
    if (data.url) {
      const endpoint = state.panel?.querySelector("#promptstudio-llamacpp-url");
      if (endpoint) endpoint.value = data.url;
    }
    if (["start", "restart"].includes(action) && !data.external) {
      const modelSelect = state.panel?.querySelector("#promptstudio-llamacpp-model");
      if (modelSelect) modelSelect.replaceChildren(new Option("Waiting for restarted server…", ""));
    }
    saveSettings();
    const appliedRevision = String(data.config_revision || "").slice(0, 8);
    setStatus(data.external
      ? "A Llama.cpp server is already running at the configured endpoint; it remains externally managed."
      : `Llama.cpp server ${action} requested${appliedRevision ? ` · config ${appliedRevision}` : ""}.`, data.external ? "warning" : "ready");
  } catch (error) {
    setStatus(error.message || String(error), "warning");
  } finally {
    state.llamacppProcessBusy = false;
    window.setTimeout(refreshLlmStatus, action === "stop" ? 300 : 1000);
  }
}

async function browseLlamacppPath(kind) {
  const controls = {
    executable: {
      input: "#promptstudio-llamacpp-executable",
      button: "#promptstudio-browse-llamacpp-executable",
      label: "Llama.cpp executable",
    },
  };
  const control = controls[kind];
  if (!control) return;
  const input = state.panel?.querySelector(control.input);
  const button = state.panel?.querySelector(control.button);
  if (!input || !button || button.disabled) return;
  button.disabled = true;
  button.textContent = "Browsing…";
  try {
    const response = await api.fetchApi(LLAMACPP_FILE_PICKER_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, current_path: input.value.trim() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Could not open the ${control.label} picker (${response.status}).`);
    if (!data.path) return;
    input.value = data.path;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    setStatus(`${control.label} selected.`, "ready");
  } catch (error) {
    setStatus(error.message || String(error), "warning");
  } finally {
    button.disabled = false;
    button.textContent = "Browse…";
  }
}

async function openLlamacppConfigBuilder({ createNew = false } = {}) {
  const profile = state.panel?.querySelector("#promptstudio-llamacpp-config-profile");
  const button = state.panel?.querySelector(createNew
    ? "#promptstudio-new-llamacpp-config"
    : "#promptstudio-build-llamacpp-config");
  if (!profile || !button || button.disabled) return;
  let requestedProfile = profile.value.trim();
  if (createNew) {
    const ownerWindow = state.panel?.ownerDocument?.defaultView || window;
    requestedProfile = String(ownerWindow.prompt("Name the new Llama.cpp config profile:", "llamacpp_server.json") || "").trim();
    if (!requestedProfile) return;
    if (!requestedProfile.toLowerCase().endsWith(".json")) requestedProfile += ".json";
  }
  button.disabled = true;
  button.textContent = "Opening…";
  try {
    const response = await api.fetchApi(LLAMACPP_CONFIG_BUILDER_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llamacpp_config_profile: requestedProfile,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Could not open the Llama.cpp config builder (${response.status}).`);
    if (data.config_profile) {
      if (![...profile.options].some((option) => option.value === data.config_profile)) {
        profile.add(new Option(data.config_profile, data.config_profile));
      }
      profile.value = data.config_profile;
    }
    saveSettings();
    if (state.llamacppAutostartEnabled) saveLlamacppAutostartPreference();
    setStatus("Llama.cpp config builder opened. Save there before starting or restarting the server.", "ready");
  } catch (error) {
    setStatus(error.message || String(error), "warning");
  } finally {
    button.disabled = false;
    button.textContent = createNew ? "New…" : "Edit…";
  }
}

function startLlmStatusMonitor() {
  if (state.llmStatusTimer) return;
  refreshLlmStatus();
  state.llmStatusTimer = window.setInterval(refreshLlmStatus, KOBOLD_STATUS_POLL_MS);
}

async function requireVisionCapability(connectionPayload = llmConnectionPayload(), signal = null) {
  const response = await api.fetchApi("/promptstudio/prompt-studio/vision-capability", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify(connectionPayload),
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

function pastedImageFileError(file, source = "pasted") {
  const label = source === "dropped" ? "dropped" : "pasted";
  if (!file || typeof file.arrayBuffer !== "function") return `The ${label} item did not contain a readable image.`;
  if (file.type && !file.type.startsWith("image/")) return `The ${label} item is not an image.`;
  if (file.size <= 0) return `The ${label} image is empty.`;
  if (file.size > MAX_DROPPED_IMAGE_BYTES) return `The ${label} image is larger than the 20 MB import limit.`;
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

function activeStudioDiscussion(chat = activeChat()) {
  const discussion = normalizeStudioDiscussion(chat?.studioDiscussion);
  return discussion?.status === "active" ? discussion : null;
}

function renderStudioDiscussionContext() {
  const context = state.panel?.querySelector("#promptstudio-discussion-context");
  if (!context) return;
  const discussion = activeStudioDiscussion();
  context.hidden = !discussion;
  if (!discussion) {
    context.querySelector("img")?.removeAttribute("src");
    return;
  }
  const image = context.querySelector("img");
  if (discussion.targetImage) {
    image.src = imageReferenceUrl(discussion.targetImage);
    image.alt = discussion.targetImage.filename || "Discussion target image";
  } else {
    image.removeAttribute("src");
    image.alt = "";
  }
  const detail = context.querySelector("small");
  const end = context.querySelector("button");
  if (end) end.disabled = state.studioTurnBusyChatIds.has(state.activeChatId);
  const parts = [];
  if (discussion.targetImage?.filename) parts.push(discussion.targetImage.filename);
  if (discussion.references.length) {
    parts.push(`${discussion.references.length} pinned reference${discussion.references.length === 1 ? "" : "s"}`);
  }
  if (discussion.pendingProposal?.status === "ready") parts.push("suggestion ready");
  if (detail) detail.textContent = parts.join(" · ") || "Prompt and generation context";
}

function cancelStudioDiscussion({ announce = true } = {}) {
  const chat = activeChat();
  const discussion = activeStudioDiscussion(chat);
  if (!chat || !discussion || state.studioTurnBusyChatIds.has(chat.id)) return;
  chat.studioDiscussion = { ...discussion, status: "cancelled", pendingProposal: null, updatedAt: Date.now() };
  chat.updatedAt = Date.now();
  saveChats();
  renderStudioDiscussionContext();
  renderChatHistory();
  if (announce) setStatus("Image discussion ended without changing the prompt.", "ready");
}

function clearMainPastedImage() {
  if (state.activeChatId) state.mainPastedImagesByChat.delete(state.activeChatId);
  state.mainPastedImage = null;
  renderMainPastedImage();
}

function showMainPastedImageForChat(chatId) {
  state.mainPastedImage = normalizeImageReference(state.mainPastedImagesByChat.get(String(chatId || "")));
  renderMainPastedImage();
}

async function pasteMainReference(file, { source = "pasted" } = {}) {
  if (!useLlmAmplification()) {
    const action = source === "dropped" ? "dropping" : "pasting";
    return setStatus(`Enable “Use LLM amplification” before ${action} a reference image.`, "warning");
  }
  const validationError = pastedImageFileError(file, source);
  if (validationError) return setStatus(validationError, "warning");

  const chat = activeChat();
  if (!chat) return;
  const connectionPayload = llmConnectionPayload();
  const providerName = llmProviderDisplayName(connectionPayload.llm_provider);
  const preparationId = makeId();
  state.studioPreparations.set(preparationId, { chatId: chat.id, kind: "reference-import" });
  state.latestStudioPreparationByChat.set(chat.id, preparationId);
  renderChatList();
  updateComposeMode();
  syncBackgroundActivityIndicator();
  setStatus(`Checking ${providerName} vision support…`, "working");
  try {
    await requireVisionCapability(connectionPayload);
    setStatus("Sanitizing and attaching the reference image…", "working");
    const reference = await uploadPromptStudioImage(file);
    if (state.latestStudioPreparationByChat.get(chat.id) !== preparationId) return;
    state.mainPastedImagesByChat.set(chat.id, reference);
    if (chat.id === state.activeChatId) {
      state.mainPastedImage = reference;
      renderMainPastedImage();
    }
    setStatus("Image attached to the next prompt.", "ready");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    state.studioPreparations.delete(preparationId);
    if (state.latestStudioPreparationByChat.get(chat.id) === preparationId) {
      state.latestStudioPreparationByChat.delete(chat.id);
    }
    renderChatList();
    updateComposeMode();
    syncBackgroundActivityIndicator();
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

function dropMainReferenceFiles(fileList) {
  const files = [...(fileList || [])];
  if (files.length !== 1) {
    setStatus(
      files.length
        ? "Drop one reference image at a time in the main chat."
        : "The drop did not contain an image file.",
      "warning",
    );
    return;
  }
  pasteMainReference(files[0], { source: "dropped" });
}

async function requestImageCaption(reference, payloadOverride = null) {
  const payload = {
    ...(payloadOverride || collectRevisionPayload("Caption the image", "render", "", "")),
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
    additional_instructions: value("promptstudio-additional-instructions"),
    embellishment: value("promptstudio-embellishment"),
    resolution: action === "create" ? resolutionSettings() : "source image dimensions",
    randomize_seed: checked("promptstudio-randomize-seed"),
    models: generationModelState(profile),
    loras: generationLoraState(profile),
    secondary_instructions: value("promptstudio-secondary-instructions"),
    local_llm: {
      provider: llmProviderName(),
      model: selectedLlmProvider() === "ollama"
        ? value("promptstudio-ollama-model")
        : (selectedLlmProvider() === "llamacpp"
          ? value("promptstudio-llamacpp-model")
          : "KoboldCpp active model"),
      profile: selectedLlmProfile().name,
      ...llmProfileGenerationSettings(),
      target_output_length: Number(value("promptstudio-output-length") || 35),
      target_output_unit: outputLengthSpec().unit === "tags" ? "tags" : "words",
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
  const consultBusy = consultChatBusy();
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
    start.disabled = Boolean(experiment) || Boolean(agent?.active) || consultBusy || state.busy;
    start.textContent = experiment ? "Experiment active" : "Start prompt experiment";
  }
  if (agentMode) {
    const enabled = promptAgentModeEnabled();
    agentMode.disabled = Boolean(experiment) || Boolean(agent?.active) || consultBusy || state.busy;
    agentMode.setAttribute("aria-pressed", enabled ? "true" : "false");
    agentMode.textContent = enabled ? "Prompt agent on" : "Prompt agent";
  }
  if (send) {
    send.disabled = consultBusy;
    send.textContent = promptAgentModeEnabled() && !agent?.active
      ? (agent ? "Continue agent" : "Start agent")
      : "Send";
  }
  if (input) {
    input.disabled = consultBusy;
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
    forbidden: normalized.forbidden.map((item) => ({
      index: item.index,
      status: item.status,
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

async function monitorPromptAgentPhase(agentId, phase, connectionPayload, requestId, signal) {
  const phaseLabel = {
    compile: "Compiling acceptance rubric",
    architect: "Designing candidate prompt",
    evaluate: "Judging generated pixels",
  }[phase] || "Running Prompt Agent";
  const startedAt = Date.now();
  while (state.consultAgentRequestId === requestId && !signal?.aborted) {
    await new Promise((resolve) => window.setTimeout(resolve, KOBOLD_STATUS_POLL_MS));
    if (state.consultAgentRequestId !== requestId || signal?.aborted) return;
    const chat = consultAgentChat(agentId);
    if (chat?.id !== state.activeChatId) continue;
    if (connectionPayload.llm_provider === "ollama") {
      setConsultStatus(
        `${phaseLabel} · ${Math.max(1, Math.round((Date.now() - startedAt) / 1000))}s elapsed…`,
        "working",
      );
      continue;
    }
    try {
      const response = await api.fetchApi(LLM_STATUS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(connectionPayload),
      });
      const status = await response.json().catch(() => ({}));
      if (
        state.consultAgentRequestId !== requestId
        || signal?.aborted
        || chat.id !== state.activeChatId
      ) return;
      const tokens = llmGeneratedTokenCount(status);
      const characters = Number(status.generated_characters);
      const progress = tokens != null
        ? ` · ${tokens.toLocaleString()} tokens`
        : (Number.isFinite(characters) && characters > 0
          ? ` · ${characters.toLocaleString()} characters`
          : "");
      const activity = llmActivityLabel(
        status,
        thinkingModeEnablesReasoning(connectionPayload.thinking_mode),
      );
      setConsultStatus(
        status.busy
          ? `${phaseLabel} · ${activity}${progress}…`
          : `${phaseLabel} · ${activity.toLowerCase()} · waiting…`,
        "working",
      );
    } catch (_) {
      setConsultStatus(`${phaseLabel} · ${llmActivityLabel({}, thinkingModeEnablesReasoning(connectionPayload.thinking_mode)).toLowerCase()}…`, "working");
    }
  }
}

async function pollPromptAgentRequest(requestId, phase, signal) {
  while (!signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    let response;
    try {
      response = await api.fetchApi(`${PROMPT_AGENT_ENDPOINT}/${encodeURIComponent(requestId)}`, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    const data = await response.json().catch(() => ({}));
    if (response.status === 404) return null;
    if (!response.ok) {
      if (response.status >= 500) continue;
      throw new Error(data.error || `Prompt Agent ${phase} status failed (${response.status}).`);
    }
    if (data.status === "complete") return data.result || {};
    if (["failed", "cancelled"].includes(data.status)) {
      throw new Error(data.error || `Prompt Agent ${phase} ${data.status}.`);
    }
  }
  throw new DOMException("Prompt Agent request was aborted.", "AbortError");
}

async function requestPromptAgentPhase(phase, agent, extra = {}, requestSettings = null, signal = null) {
  const generationSettings = requestSettings?.generationSettings || collectConsultGenerationSettings();
  const connectionPayload = requestSettings?.connectionPayload || llmConnectionPayload();
  const requestId = agent.requestId && agent.requestPhase === phase ? agent.requestId : makeId();
  state.consultAgentRequestId = requestId;
  updateConsultAgent((current) => {
    current.requestId = requestId;
    current.requestPhase = phase;
  }, { immediate: true, agentId: agent.id });
  const progressMonitor = monitorPromptAgentPhase(
    agent.id,
    phase,
    { ...connectionPayload, thinking_mode: generationSettings.thinking_mode },
    requestId,
    signal,
  );
  try {
    const payload = {
        ...connectionPayload,
        ...generationSettings,
        async: true,
        request_id: requestId,
        agent_id: agent.id,
        max_response_tokens: Math.max(1400, Number(generationSettings.max_response_tokens) || 0),
        phase,
        goal: promptAgentEffectiveGoal(agent),
        conversation_context: phase === "compile" ? agent.conversationContext : [],
        references: promptAgentReferencesPayload(agent),
        rubric: agent.rubric,
        target_score: agent.targetScore,
        min_confidence: agent.minConfidence,
        ...extra,
      };
    while (!signal?.aborted) {
      let response;
      try {
        response = await api.fetchApi(PROMPT_AGENT_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body: JSON.stringify(payload),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status >= 500) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }
        throw new Error(data.error || `Prompt Agent ${phase} failed (${response.status}).`);
      }
      const result = response.status === 202
        ? await pollPromptAgentRequest(requestId, phase, signal)
        : data;
      if (result === null) continue;
      return result;
    }
    throw new DOMException("Prompt Agent request was aborted.", "AbortError");
  } finally {
    if (state.consultAgentRequestId === requestId) state.consultAgentRequestId = "";
    const current = activeConsultAgent(consultAgentChat(agent.id));
    if (current?.requestId === requestId) {
      updateConsultAgent((latest) => {
        latest.requestId = "";
        latest.requestPhase = "";
      }, { immediate: true, agentId: agent.id });
    }
    void progressMonitor;
  }
}

async function cancelPromptAgentLlmRequest(requestId = state.consultAgentRequestId, agentId = "") {
  const id = String(requestId || "");
  const ownerId = String(agentId || "");
  if (!id && !ownerId) return;
  try {
    await api.fetchApi(PROMPT_AGENT_CANCEL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: id, agent_id: ownerId }),
    });
  } catch (_) {
    // Run-token checks still prevent a cancelled response from advancing the agent.
  }
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

function createPromptAgentIteration({ validation = false, candidate = null } = {}, chatId = null) {
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
  }, { immediate: true, chatId });
  return id;
}

function finishPromptAgent(status, message = "", chatId = null) {
  updateConsultAgent((agent) => {
    const iteration = promptAgentIteration(agent, agent.currentIterationId);
    if (iteration && !["complete", "error", "stopped"].includes(iteration.status)) {
      iteration.status = status === "error" ? "error" : "stopped";
      iteration.updatedAt = Date.now();
    }
    agent.active = false;
    agent.status = status;
    agent.resumeStatus = "";
    agent.requestId = "";
    agent.error = status === "error" ? message : "";
  }, { immediate: true, chatId });
  state.consultAgentRunning = false;
  state.consultAgentAbortController = null;
  state.consultAgentRequestId = "";
  state.consultAgentGenerationTarget = null;
  state.activeGenerationPromptId = "";
  state.generating = false;
  setConsultBusy(false);
  setConsultStatus(message || (status === "complete" ? "Prompt Agent completed." : "Prompt Agent stopped."), status === "error" ? "error" : "ready");
}

async function runConsultAgent(agentId = activeConsultAgent()?.id, runtimeSettings = null) {
  if (state.consultAgentRunning) return;
  const agentChat = consultAgentChat(agentId) || activeChat();
  const agentChatId = agentChat?.id || "";
  const currentAgent = () => {
    const currentChat = state.chats.find((item) => item.id === agentChatId);
    const current = activeConsultAgent(currentChat);
    return current?.id === agentId ? current : null;
  };
  let agent = currentAgent();
  if (!agent || agent.id !== agentId || !agent.active) return;
  const requestSettings = runtimeSettings?.requestSettings || {
    connectionPayload: llmConnectionPayload(),
    generationSettings: collectConsultGenerationSettings(),
  };
  const queueSettings = runtimeSettings?.queueSettings || captureGenerationQueueSettings("create", agentChat);
  const updateAgent = (mutator, options = {}) => updateConsultAgent(
    mutator,
    { ...options, chatId: agentChatId },
  );
  if (agent.status === "paused") {
    updateAgent((current) => {
      current.status = current.resumeStatus || (current.rubric ? "architecting" : "compiling");
      current.resumeStatus = "";
    }, { immediate: true });
    agent = currentAgent();
  }
  state.consultAgentRunning = true;
  const runToken = ++state.consultAgentRunToken;
  const abortController = new AbortController();
  state.consultAgentAbortController = abortController;
  const runCancelled = () => (
    abortController.signal.aborted
    || runToken !== state.consultAgentRunToken
    || !currentAgent()?.active
  );
  setConsultBusy(true);
  try {
    while (runToken === state.consultAgentRunToken) {
      agent = currentAgent();
      if (!agent || agent.id !== agentId || !agent.active || agent.status === "paused") return;

      if (!agent.rubric) {
        updateAgent((current) => {
          current.status = "compiling";
        }, { immediate: true });
        setConsultStatus("Prompt Agent is compiling the acceptance rubric…", "working");
        const compiled = await requestPromptAgentPhase(
          "compile",
          agent,
          {},
          requestSettings,
          abortController.signal,
        );
        if (runCancelled()) return;
        const rubric = normalizePromptAgentRubric(compiled.rubric);
        if (!rubric) throw new Error("Prompt Agent returned an invalid acceptance rubric.");
        updateAgent((current) => {
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
          createPromptAgentIteration({ validation: true, candidate: last.candidate }, agentChatId);
          continue;
        }
        if (last?.evaluation?.pass && (!agent.validationRequired || last.validation)) {
          finishPromptAgent("complete", `Prompt Agent completed with a score of ${Math.round(last.evaluation.score)}.`, agentChatId);
          return;
        }
        const cycleCompleted = promptAgentCompletedIterations(agent)
          .filter((item) => item.index >= (agent.cycleStartIndex || 1));
        if (cycleCompleted.length >= agent.maxIterations) {
          finishPromptAgent("stopped", `Prompt Agent reached ${agent.maxIterations} iterations without a validated pass; the best result is ready.`, agentChatId);
          return;
        }
        if (promptAgentPlateaued(agent)) {
          finishPromptAgent("stopped", "Prompt Agent stopped after the score plateaued without a validated pass; the best result is ready.", agentChatId);
          return;
        }
        createPromptAgentIteration({}, agentChatId);
        continue;
      }

      if (iteration.status === "architecting") {
        setConsultStatus(`Prompt Agent is designing iteration ${iteration.index}…`, "working");
        const previous = [...agent.iterations]
          .slice(0, Math.max(0, agent.iterations.indexOf(iteration)))
          .reverse()
          .find((item) => item.evaluation);
        const attachedGuidance = {};
        if (agent.initialStyle.name !== "None" || agent.initialStyle.instruction) {
          attachedGuidance.initial_style = agent.initialStyle;
        }
        if (agent.initialFraming.name !== "None" || agent.initialFraming.instruction) {
          attachedGuidance.initial_framing = agent.initialFraming;
        }
        const designed = await requestPromptAgentPhase("architect", agent, {
          iteration: iteration.index,
          ...attachedGuidance,
          previous_candidate: promptAgentCandidatePayload(previous?.candidate),
          previous_evaluation: previous?.index >= (agent.cycleStartIndex || 1)
            ? promptAgentEvaluationPayload(previous.evaluation)
            : null,
        }, requestSettings, abortController.signal);
        if (runCancelled()) return;
        const candidate = normalizePromptAgentCandidate(designed.candidate);
        if (!candidate) throw new Error("Prompt Agent returned an invalid prompt candidate.");
        updateAgent((current) => {
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
            chatId: agentChatId,
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
            ...queueSettings,
            action: "create",
            executionPrompt: iteration.candidate.prompt,
            mainPrompt: promptAgentEffectiveGoal(agent),
            finalPrompt: iteration.candidate.prompt,
            preserveSeed: !iteration.validation,
            alwaysNewSeed: iteration.validation,
            agentTarget: {
              chatId: agentChatId,
              agentId: agent.id,
              iterationId: iteration.id,
            },
            independent: true,
            releaseBusy: false,
            cancellationCheck: runCancelled,
          });
        }
        if (runCancelled() || !generation) return;
        updateAgent((current) => {
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
        }, requestSettings, abortController.signal);
        if (runCancelled()) return;
        const evaluation = normalizePromptAgentEvaluation(judged.evaluation);
        if (!evaluation) throw new Error("Prompt Agent returned an invalid visual evaluation.");
        updateAgent((current) => {
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
    if (runCancelled()) return;
    finishPromptAgent("error", error.message || String(error), agentChatId);
  } finally {
    if (runToken === state.consultAgentRunToken) {
      state.consultAgentRunning = false;
    }
    if (state.consultAgentAbortController === abortController) {
      state.consultAgentAbortController = null;
    }
    const current = currentAgent();
    if (current?.active && current.status === "paused" && !state.generating) {
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
  const conversationContext = promptAgentConversationSnapshot(chat);
  const references = promptAgentStartReferences(chat);
  const attachGenerationSettings = Boolean(
    state.panel?.querySelector("#promptstudio-consult-attach-settings")?.checked,
  );
  const styleName = attachGenerationSettings
    ? state.panel?.querySelector("#promptstudio-style")?.value || "None"
    : "None";
  const framingName = attachGenerationSettings
    ? state.panel?.querySelector("#promptstudio-framing")?.value || "None"
    : "None";
  const maxIterations = requestedPromptAgentIterations();
  const requestSettings = {
    connectionPayload: llmConnectionPayload(),
    generationSettings: collectConsultGenerationSettings(),
  };
  const queueSettings = captureGenerationQueueSettings("create", chat);
  const providerName = llmProviderDisplayName(requestSettings.connectionPayload.llm_provider);
  setConsultStatus(`Checking ${providerName} vision support…`, "working");
  try {
    await requireVisionCapability(requestSettings.connectionPayload);
  } catch (error) {
    setConsultStatus(error.message || String(error), "warning");
    return;
  }
  const now = Date.now();
  chat.consultAgent = normalizeConsultAgent({
    id: makeId(),
    active: true,
    status: "compiling",
    goal,
    conversationContext,
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
  if (chat.id === state.activeChatId) {
    input.value = "";
    state.consultSelectedImages.clear();
    state.consultUploadedImages = [];
    state.panel?.querySelectorAll(".promptstudio-consult-context-options input").forEach((control) => {
      control.checked = false;
    });
  }
  saveChats({ immediate: true });
  state.operationToken += 1;
  if (chat.id === state.activeChatId) {
    renderConsultAttachments();
    closeConsultSubpanels();
    renderConsultHistory();
    updateConsultExperimentUi();
  }
  runConsultAgent(chat.consultAgent.id, { requestSettings, queueSettings });
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
  const selectedReferences = [...state.consultSelectedImages.values()].slice(0, 4).map((item) => ({
    image: item.reference,
    purpose: item.purpose,
  }));
  const recentConversationReferences = promptAgentStartReferences(chat);
  const requestSettings = {
    connectionPayload: llmConnectionPayload(),
    generationSettings: collectConsultGenerationSettings(),
  };
  const queueSettings = captureGenerationQueueSettings("create", chat);
  const providerName = llmProviderDisplayName(requestSettings.connectionPayload.llm_provider);
  setConsultStatus(`Checking ${providerName} vision support…`, "working");
  try {
    await requireVisionCapability(requestSettings.connectionPayload);
  } catch (error) {
    setConsultStatus(error.message || String(error), "warning");
    return;
  }

  const existingKeys = new Set(selectedReferences.map((item) => imageReferenceKey(item.image)));
  const references = [
    ...selectedReferences,
    ...agent.references.filter((item) => {
      const key = imageReferenceKey(item.image);
      if (!key || existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    }),
    ...recentConversationReferences.filter((item) => {
      const key = imageReferenceKey(item.image);
      if (!key || existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    }),
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
    conversationContext: promptAgentConversationSnapshot(chat),
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
  if (chat.id === state.activeChatId) {
    input.value = "";
    state.consultSelectedImages.clear();
    state.consultUploadedImages = [];
  }
  saveChats({ immediate: true });
  state.operationToken += 1;
  if (chat.id === state.activeChatId) {
    renderConsultAttachments();
    renderConsultHistory();
    updateConsultExperimentUi();
  }
  runConsultAgent(chat.consultAgent.id, { requestSettings, queueSettings });
}

function pauseConsultAgent() {
  if (!activeConsultAgent()?.active || !state.consultAgentRunning) return;
  const requestId = state.consultAgentRequestId;
  state.consultAgentRunToken += 1;
  state.consultAgentAbortController?.abort();
  if (requestId) cancelPromptAgentLlmRequest(requestId);
  updateConsultAgent((agent) => {
    agent.resumeStatus = agent.status;
    agent.status = "paused";
  }, { immediate: true });
  state.consultAgentRunning = false;
  if (!state.generating) {
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
  const requestId = state.consultAgentRequestId || agent.requestId;
  const promptId = String(
    state.consultAgentGenerationTarget?.agentId === agent.id
      ? state.consultAgentGenerationTarget.promptId
      : promptAgentGenerationPromptId(agent),
  );
  state.operationToken += 1;
  state.consultAgentRunToken += 1;
  state.pollToken += 1;
  state.consultAgentAbortController?.abort();
  finishPromptAgent("stopped", "Prompt Agent stopped. The best completed result remains available.");
  await Promise.allSettled([
    cancelPromptAgentLlmRequest(requestId, agent.id),
    promptId ? cancelComfyPrompt(promptId) : Promise.resolve(),
  ]);
}

function promotePromptAgentIteration(iterationId) {
  if (state.busy || state.consultBusy) return;
  const agent = activeConsultAgent();
  const iteration = promptAgentIteration(agent, iterationId);
  if (!agent || !iteration?.candidate) return;
  const effectiveGoal = promptAgentEffectiveGoal(agent);
  const exportedControlsFingerprint = controlsFingerprint();
  const previousVersion = promptVersion();
  updateMainPromptEditor(effectiveGoal);
  syncCanonicalEditor(iteration.candidate.prompt, { userEdit: iteration.candidate.prompt !== state.currentPrompt });
  const chat = activeChat();
  if (chat) {
    chat.renderedMainPrompt = effectiveGoal;
    chat.renderedFinalPrompt = iteration.candidate.prompt;
    chat.mainPromptDirty = false;
    chat.finalPromptManuallyEdited = false;
    chat.controlsFingerprint = exportedControlsFingerprint;
    chat.pendingGeneration = null;
  }
  if (!promptVersionsEqual(previousVersion, promptVersion())) pushVersion(iteration.candidate.prompt, effectiveGoal);
  const generation = normalizeConsultExperimentGeneration(iteration.generation);
  if (generation?.images.length) {
    appendMessage("assistant", "", {
      label: `Exported Prompt Agent iteration ${iteration.index}`,
      images: generation.images,
      mainPrompt: effectiveGoal,
      canonicalPrompt: iteration.candidate.prompt,
      executionPrompt: generation.executionPrompt || iteration.candidate.prompt,
      generationAction: "create",
      workflowProfileId: generation.workflowProfileId,
      workflowName: generation.workflowName,
      loraState: generation.loraState,
      modelState: generation.modelState,
      generationSnapshot: generation.generationSnapshot,
      resultNodeIds: generation.resultNodeIds,
      resultFields: generation.resultFields,
      generationState: "complete",
      controlsFingerprint: exportedControlsFingerprint,
      llmAmplified: true,
    });
  }
  syncActiveChat();
  saveChats();
  setStatus(`Prompt Agent iteration ${iteration.index} exported to the main Studio window. Presets and controls were not changed.`, "ready");
  setConsultStatus(`Prompt Agent iteration ${iteration.index} exported to the main Studio window.`, "ready");
}

function exportPromptAgentIterationToNewSession(iterationId) {
  if (state.busy || state.consultBusy) return;
  const agent = activeConsultAgent();
  const iteration = promptAgentIteration(agent, iterationId);
  if (!agent || !iteration?.candidate) return;
  const effectiveGoal = promptAgentEffectiveGoal(agent);
  const generation = normalizeConsultExperimentGeneration(iteration.generation);
  const images = generation?.images || [];
  const chat = normalizeChat({
    initialized: true,
    mainPrompt: effectiveGoal,
    finalPrompt: iteration.candidate.prompt,
    currentPrompt: iteration.candidate.prompt,
    versions: [promptVersion(effectiveGoal, iteration.candidate.prompt)],
    versionIndex: 0,
    controlsFingerprint: controlsFingerprint(),
    createWorkflowId: state.panel?.querySelector("#promptstudio-create-workflow")?.value || "",
    editWorkflowId: state.panel?.querySelector("#promptstudio-edit-workflow")?.value || "",
    upscaleWorkflowId: state.panel?.querySelector("#promptstudio-upscale-workflow")?.value || "",
    editPromptMode: selectedEditPromptMode(),
    selectedSource: images[0] || null,
    lastGeneration: null,
    pendingGeneration: null,
    studioSettings: captureStudioSettings(),
    messages: images.length ? [{
      role: "assistant",
      text: "",
      label: `Exported Prompt Agent iteration ${iteration.index}`,
      images,
      mainPrompt: effectiveGoal,
      canonicalPrompt: iteration.candidate.prompt,
      executionPrompt: generation.executionPrompt || iteration.candidate.prompt,
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
    }] : [],
    consultMessages: [],
    consultAgent: null,
    consultAgentMode: false,
  });
  state.chats.push(chat);
  const createAction = state.panel?.querySelector('input[name="promptstudio-generation-action"][value="create"]');
  if (createAction) createAction.checked = true;
  activateChat(chat.id);
  setStatus(`Prompt Agent iteration ${iteration.index} exported to a new Studio session. Presets and controls were not changed.`, "ready");
}

function promotePromptAgentBest() {
  const best = promptAgentBestIteration(activeConsultAgent());
  if (!best) return;
  promotePromptAgentIteration(best.id);
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

function updateActiveConsultExperiment(message, chat = activeChat()) {
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
    upload.disabled = consultChatBusy();
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
    checkbox.disabled = state.consultVisionAvailable !== true || consultChatBusy();
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
    purpose.disabled = state.consultVisionAvailable !== true || consultChatBusy();
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
  if (!file || consultChatBusy()) return;
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
  if (consultChatBusy()) {
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
  if (!busy) {
    state.consultPendingText = "";
    state.panel?.querySelector("[data-consult-pending]")?.closest(".promptstudio-consult-message")?.remove();
  }
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
    !message.requestFailed && (
      experimentId
        ? String(message.experimentId || "") === experimentId
        : !String(message.experimentId || "")
    )
  ));
  const bounded = scopedMessages.slice(-60);
  while (bounded.length && bounded[0].role === "assistant") bounded.shift();
  const selected = bounded.map((message) => ({
    role: message.role,
    text: message.text,
    context: message.context ? { ...message.context } : message.context,
    images: message.role === "user"
      ? message.images.map(storedImageReference).filter(Boolean)
      : [],
  }));
  let imageBudget = 8;
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const retainedCount = Math.min(selected[index].images.length, imageBudget);
    if (retainedCount < selected[index].images.length) {
      selected[index].images = selected[index].images.slice(0, retainedCount);
    }
    if (Array.isArray(selected[index].context?.attached_images)) {
      selected[index].context.attached_images = selected[index].context.attached_images.slice(0, retainedCount);
    }
    imageBudget -= retainedCount;
  }
  return selected;
}

function collectConsultGenerationSettings() {
  return llmProfileGenerationSettings();
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
  const queueSettings = captureGenerationQueueSettings(action, chat);
  setConsultBusy(true);
  setConsultStatus("ComfyUI is generating inside the prompt experiment…", "working");
  try {
    await queueGeneration({
      ...queueSettings,
      action,
      executionPrompt: proposal.prompt,
      mainPrompt: experiment.baseMainPrompt,
      finalPrompt: proposal.prompt,
      preserveSeed: previousGeneration?.generationState !== "complete",
      forceNewSeed: previousGeneration?.generationState === "complete",
      consultTarget: {
        chatId: chat.id,
        messageId: message.id,
        variantId: variant.id,
      },
      independent: true,
      releaseBusy: false,
    });
  } catch (error) {
    setConsultBusy(false);
    setConsultStatus(error.message || String(error), "error");
  }
}

async function cancelConsultExperimentGeneration(messageId, variantId) {
  const chat = activeChat();
  const message = chat?.consultMessages.find((item) => item.id === messageId);
  const variant = message?.variants?.find((item) => item.id === variantId);
  const generation = normalizeConsultExperimentGeneration(variant?.generation);
  if (!chat || !message || !variant || !generation?.promptId || !["queued", "generating"].includes(generation.generationState)) return;
  state.consultGenerationJobs.delete(String(generation.promptId));
  if (String(state.consultGenerationTarget?.promptId || "") === String(generation.promptId)) {
    state.pollToken += 1;
    state.consultGenerationTarget = null;
  }
  await cancelComfyPrompt(generation.promptId);
  setConsultExperimentGeneration(message.id, variant.id, {
    ...generation,
    generationState: "cancelled",
    text: "Cancelled.",
    updatedAt: Date.now(),
  }, chat.id);
  state.generating = false;
  setConsultBusy(false);
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
        : generation.generationState === "cancelled"
          ? "Cancelled"
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
  if (generation?.promptId && ["queued", "generating"].includes(generation.generationState)) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => cancelConsultExperimentGeneration(message.id, variant.id));
    actions.appendChild(cancel);
  }
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

  if (agent.conversationContext.length) {
    const context = document.createElement("p");
    context.className = "promptstudio-agent-context";
    context.textContent = `Using ${agent.conversationContext.length} earlier conversation message${agent.conversationContext.length === 1 ? "" : "s"} as background context.`;
    card.appendChild(context);
  }

  if (agent.references.length) {
    const references = document.createElement("section");
    references.className = "promptstudio-agent-references";
    const referencesTitle = document.createElement("strong");
    referencesTitle.textContent = "Agent references";
    const gallery = document.createElement("div");
    gallery.className = "promptstudio-consult-message-images";
    agent.references.forEach((item, index) => {
      const label = `Reference ${index + 1}`;
      const purpose = item.purpose || "general reference";
      const figure = document.createElement("figure");
      const image = document.createElement("img");
      image.src = imageReferenceUrl(item.image);
      image.alt = `${label}: ${purpose}`;
      image.tabIndex = 0;
      image.setAttribute("role", "button");
      image.setAttribute("aria-label", `Preview ${label}, ${purpose}`);
      image.addEventListener("click", () => openImageLightbox(image.src, image.alt, image));
      image.addEventListener("keydown", (event) => {
        if (!["Enter", " "].includes(event.key)) return;
        event.preventDefault();
        openImageLightbox(image.src, image.alt, image);
      });
      const caption = document.createElement("figcaption");
      caption.textContent = `${label} · ${purpose}`;
      figure.append(image, caption);
      gallery.appendChild(figure);
    });
    references.append(referencesTitle, gallery);
    card.appendChild(references);
  }

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
      iteration.evaluation.forbidden.forEach((check) => {
        const row = document.createElement("li");
        row.dataset.status = check.status === "clear" ? "pass" : "fail";
        row.textContent = `${check.status} · forbidden: ${check.outcome}${check.evidence ? ` · ${check.evidence}` : ""}`;
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
    const iterationActions = document.createElement("div");
    iterationActions.className = "promptstudio-agent-actions";
    const exportButton = document.createElement("button");
    exportButton.type = "button";
    exportButton.textContent = "Export to main window";
    exportButton.disabled = !iteration.candidate || state.busy || state.consultBusy;
    if (!iteration.candidate) exportButton.title = "This iteration does not have a candidate prompt yet.";
    exportButton.addEventListener("click", () => promotePromptAgentIteration(iteration.id));
    const exportNewButton = document.createElement("button");
    exportNewButton.type = "button";
    exportNewButton.textContent = "Export to new main window";
    exportNewButton.disabled = !iteration.candidate || state.busy || state.consultBusy;
    if (!iteration.candidate) exportNewButton.title = "This iteration does not have a candidate prompt yet.";
    exportNewButton.addEventListener("click", () => exportPromptAgentIterationToNewSession(iteration.id));
    iterationActions.append(exportButton, exportNewButton);
    item.appendChild(iterationActions);
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

function renderConsultHistory({ forceEnd = false } = {}) {
  const history = state.panel?.querySelector("#promptstudio-consult-history");
  if (!history) return;
  const wasNearEnd = forceEnd || historyShouldStickToEnd(history);
  const previousScrollTop = history.scrollTop;
  const settleViewport = () => {
    if (forceEnd) placeHistoryAtEnd(history, { revisionKey: "consultHistoryScrollRevision" });
    else keepHistoryViewportStable(history, wasNearEnd, previousScrollTop, {
      revisionKey: "consultHistoryScrollRevision",
    });
  };
  history.replaceChildren();
  const chat = activeChat();
  const messages = chat?.consultMessages || [];
  const consultBusy = consultChatBusy(chat);
  const agent = activeConsultAgent();
  updateConsultExperimentUi();
  if (agent) renderConsultAgentCard(history, agent);
  if (!messages.length && !agent) {
    const empty = document.createElement("div");
    empty.className = "promptstudio-consult-empty";
    empty.innerHTML = "<strong>Talk with your local model</strong><span>Ask a general question, or attach prompts, settings, generated results, and reference images for comparison.</span>";
    history.appendChild(empty);
    settleViewport();
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
        image.loading = "lazy";
        image.decoding = "async";
        if (reference.width && reference.height) {
          image.width = reference.width;
          image.height = reference.height;
        }
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
        previous.disabled = consultBusy;
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
      const nextLabel = hasNewer ? "Show next answer" : (message.requestFailed ? "Retry request" : "Regenerate answer");
      next.setAttribute("aria-label", nextLabel);
      next.title = nextLabel;
      next.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 6 6 6-6 6"/></svg>';
      next.disabled = consultBusy;
      next.addEventListener("click", () => {
        if (hasNewer) selectConsultResponse(message.id, selectedIndex + 1);
        else regenerateConsultResponse(message.id);
      });
      controls.appendChild(next);
      bubble.appendChild(controls);
    }
    history.appendChild(bubble);
  }
  const pendingProgress = chat?.consultPendingJob?.progress || (state.consultBusy ? state.consultPendingText : "");
  if (consultBusy && pendingProgress) {
    const pendingBubble = document.createElement("article");
    pendingBubble.className = "promptstudio-consult-message promptstudio-consult-message-assistant promptstudio-consult-message-pending";
    const pendingText = document.createElement("div");
    pendingText.className = "promptstudio-consult-message-text";
    pendingText.dataset.consultPending = "true";
    pendingText.setAttribute("role", "status");
    pendingText.setAttribute("aria-live", "polite");
    pendingText.textContent = pendingProgress;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "promptstudio-operation-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => cancelConsultChatJob(chat.id));
    pendingBubble.append(pendingText, cancel);
    const pendingTokenCount = chat?.consultPendingJob?.token_count;
    if (pendingTokenCount != null && Number.isFinite(Number(pendingTokenCount))) {
      const tokens = document.createElement("span");
      tokens.className = "promptstudio-llm-token-count";
      tokens.dataset.consultTokenCount = "true";
      tokens.textContent = `${Math.max(0, Math.trunc(Number(pendingTokenCount))).toLocaleString()} tokens`;
      tokens.setAttribute("aria-label", tokens.textContent);
      pendingBubble.appendChild(tokens);
    }
    history.appendChild(pendingBubble);
  }
  settleViewport();
}

function selectConsultResponse(messageId, variantIndex) {
  if (consultChatBusy()) return;
  const chat = activeChat();
  const message = chat?.consultMessages.find((item) => item.id === messageId);
  if (!chat || message?.role !== "assistant" || !message.variants?.[variantIndex]) return;
  const selectedAt = Date.now();
  message.variantIndex = variantIndex;
  message.text = message.variants[variantIndex].text;
  message.proposal = message.variants[variantIndex].proposal || null;
  message.generation = message.variants[variantIndex].generation || null;
  message.requestFailed = message.variants[variantIndex].requestFailed === true;
  updateActiveConsultExperiment(message);
  message.updatedAt = selectedAt;
  chat.updatedAt = selectedAt;
  saveChats();
  renderConsultHistory();
  setConsultStatus(`Showing answer ${variantIndex + 1} of ${message.variants.length}.`, "ready");
}


function consultChatBusy(chat = activeChat()) {
  return Boolean(chat?.consultPendingJob) || state.consultBusy;
}

function consultRequestPayload(messages, jobId, experimentMode) {
  return {
    ...llmConnectionPayload(),
    ...collectConsultGenerationSettings(),
    async: true,
    job_id: jobId,
    experiment_mode: experimentMode,
    messages: consultRequestMessages(messages),
  };
}

function waitForConsultRetry() {
  return new Promise((resolve) => window.setTimeout(resolve, 1500));
}

function setConsultJobProgress(chatId, text, tokenCount = null) {
  const chat = state.chats.find((item) => item.id === chatId);
  if (chat?.consultPendingJob) {
    chat.consultPendingJob.progress = String(text || "");
    if (tokenCount != null && Number.isFinite(Number(tokenCount))) {
      chat.consultPendingJob.token_count = Math.max(0, Math.trunc(Number(tokenCount)));
    }
  }
  if (chatId !== state.activeChatId) return;
  const pending = state.panel?.querySelector("[data-consult-pending]");
  if (pending) pending.textContent = String(text || "");
  else renderConsultHistory();
  const token = state.panel?.querySelector("[data-consult-token-count]");
  if (token && chat?.consultPendingJob?.token_count != null) {
    token.textContent = `${chat.consultPendingJob.token_count.toLocaleString()} tokens`;
    token.setAttribute("aria-label", token.textContent);
  } else if (!token && chat?.consultPendingJob?.token_count != null) {
    renderConsultHistory();
  }
}

async function requestConsultResponse(pending, chatId) {
  while (true) {
    let response;
    try {
      response = await api.fetchApi(CONSULT_CHAT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pending.request),
      });
    } catch (_) {
      setConsultJobProgress(chatId, "Consultation connection was interrupted; reconnecting...");
      await waitForConsultRetry();
      continue;
    }
    let data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status >= 500) {
        setConsultJobProgress(chatId, "Consultation service is temporarily unavailable; retrying...");
        await waitForConsultRetry();
        continue;
      }
      throw new Error(data.error || `Consultation failed (${response.status}).`);
    }
    if (response.status === 202 && data.job_id) {
      data = await pollConsultJob(data.job_id, chatId);
      if (data === null) continue;
    }
    const answer = String(data.message || "").trim();
    if (!answer) throw new Error("The local language model returned an empty response.");
    return {
      ...parseConsultExperimentAnswer(answer, pending.experiment_mode === true),
      warning: String(data.warning || "").trim(),
    };
  }
}

function consultJobStatusText(job, pending = null) {
  if (job.status === "queued") return "Consultation request is queued…";
  const provider = job.provider_status || {};
  const thinkingEnabled = thinkingModeEnablesReasoning(pending?.request?.thinking_mode);
  const activity = llmActivityLabel(provider, thinkingEnabled);
  if (provider.provider === "ollama") {
    const startedAt = Number(pending?.created_at);
    const elapsed = Number.isFinite(startedAt)
      ? ` · ${Math.max(1, Math.round((Date.now() - startedAt) / 1000))}s`
      : "";
    return `${activity}${elapsed}…`;
  }
  if (provider.reachable === false) {
    return `${activity} · live status temporarily unavailable…`;
  }
  if (provider.busy) {
    return `${activity}…`;
  }
  return `${activity} · waiting…`;
}

async function pollConsultJob(jobId, chatId) {
  let statusFailures = 0;
  while (true) {
    await new Promise((resolve) => window.setTimeout(resolve, CONSULT_JOB_POLL_MS));
    let response;
    try {
      response = await api.fetchApi(`${CONSULT_CHAT_ENDPOINT}/${encodeURIComponent(jobId)}`);
    } catch (_) {
      setConsultJobProgress(chatId, "Consultation is still running; reconnecting to its status...");
      await waitForConsultRetry();
      continue;
    }
    const job = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 404) return null;
      if (response.status >= 500 && statusFailures < CONSULT_STATUS_RETRY_LIMIT) {
        statusFailures += 1;
        setConsultJobProgress(chatId, "Consultation status was temporarily unavailable; retrying…");
        continue;
      }
      throw new Error(job.error || `Consultation status check failed (${response.status}).`);
    }
    statusFailures = 0;
    if (job.status === "complete") return job.result || {};
    if (job.status === "failed") throw new Error(job.error || "Consultation request failed.");
    if (job.status === "cancelled") throw new DOMException("Consultation request was cancelled.", "AbortError");
    const pending = state.chats.find((item) => item.id === chatId)?.consultPendingJob;
    setConsultJobProgress(
      chatId,
      consultJobStatusText(job, pending),
      llmGeneratedTokenCount(job.provider_status || {}),
    );
  }
}

function appendConsultJobFailure(chat, pending, failure) {
  const failedAt = Date.now();
  if (pending.kind === "regenerate") {
    const message = chat.consultMessages.find((item) => item.id === pending.message_id);
    if (!message) return;
    message.variants.push({
      id: makeId(), text: `Consultation request failed: ${failure}`,
      proposal: null, generation: null, requestFailed: true, createdAt: failedAt,
    });
    message.variantIndex = message.variants.length - 1;
    message.text = message.variants.at(-1).text;
    message.proposal = null;
    message.generation = null;
    message.requestFailed = true;
    message.updatedAt = failedAt;
    return;
  }
  chat.consultMessages.push(normalizeConsultMessage({
    id: makeId(), role: "assistant", text: `Consultation request failed: ${failure}`,
    requestFailed: true, experimentId: pending.experiment_id || "",
    createdAt: failedAt, updatedAt: failedAt,
  }));
}

function applyConsultJobResult(chat, pending, answer) {
  const answeredAt = Date.now();
  if (pending.kind === "regenerate") {
    const message = chat.consultMessages.find((item) => item.id === pending.message_id);
    if (!message) return;
    message.variants.push({
      id: makeId(), text: answer.text, proposal: answer.proposal,
      generation: null, requestFailed: false, createdAt: answeredAt,
    });
    message.variantIndex = message.variants.length - 1;
    message.text = answer.text;
    message.proposal = answer.proposal;
    message.generation = null;
    message.requestFailed = false;
    message.updatedAt = answeredAt;
    updateActiveConsultExperiment(message, chat);
  } else {
    const assistantMessage = normalizeConsultMessage({
      id: makeId(), role: "assistant", text: answer.text, proposal: answer.proposal,
      experimentId: pending.experiment_id || "", createdAt: answeredAt, updatedAt: answeredAt,
    });
    chat.consultMessages.push(assistantMessage);
    updateActiveConsultExperiment(assistantMessage, chat);
  }
  chat.consultMessages = chat.consultMessages.slice(-100);
  chat.consultLastWarning = answer.warning || "";
}

function runConsultChatJob(chatId) {
  if (state.consultJobs.has(chatId)) return state.consultJobs.get(chatId);
  const chat = state.chats.find((item) => item.id === chatId);
  const pending = chat?.consultPendingJob;
  if (!pending?.job_id || !pending.request) return null;
  const operation = (async () => {
    try {
      const answer = await requestConsultResponse(pending, chatId);
      const current = state.chats.find((item) => item.id === chatId);
      if (!current || current.consultPendingJob?.job_id !== pending.job_id) return;
      applyConsultJobResult(current, pending, answer);
    } catch (error) {
      const current = state.chats.find((item) => item.id === chatId);
      if (!current || current.consultPendingJob?.job_id !== pending.job_id) return;
      appendConsultJobFailure(current, pending, error.message || String(error));
      current.consultLastWarning = error.message || String(error);
    } finally {
      const current = state.chats.find((item) => item.id === chatId);
      if (current?.consultPendingJob?.job_id === pending.job_id) {
        current.consultPendingJob = null;
        current.updatedAt = Date.now();
        saveChats({ immediate: true });
      }
      state.consultJobs.delete(chatId);
      renderChatList();
      if (chatId === state.activeChatId) {
        renderConsultHistory();
        const warning = current?.consultLastWarning || "";
        setConsultStatus(warning || "Ready", warning ? "warning" : "ready");
      }
    }
  })();
  state.consultJobs.set(chatId, operation);
  if (chatId === state.activeChatId) renderConsultHistory();
  renderChatList();
  return operation;
}

async function cancelConsultChatJob(chatId) {
  const chat = state.chats.find((item) => item.id === chatId);
  const pending = chat?.consultPendingJob;
  if (!chat || !pending?.job_id) return;
  chat.consultPendingJob = null;
  const cancelledAt = Date.now();
  if (pending.kind === "regenerate") {
    const message = chat.consultMessages.find((item) => item.id === pending.message_id);
    if (message) {
      message.variants.push({
        id: makeId(), text: "Cancelled.", proposal: null, generation: null,
        requestFailed: true, createdAt: cancelledAt,
      });
      message.variantIndex = message.variants.length - 1;
      message.text = "Cancelled.";
      message.requestFailed = true;
      message.updatedAt = cancelledAt;
    }
  } else {
    chat.consultMessages.push(normalizeConsultMessage({
      id: makeId(), role: "assistant", text: "Cancelled.", requestFailed: true,
      experimentId: pending.experiment_id || "", createdAt: cancelledAt, updatedAt: cancelledAt,
    }));
  }
  chat.updatedAt = cancelledAt;
  saveChats({ immediate: true });
  renderChatList();
  if (chat.id === state.activeChatId) renderConsultHistory();
  try {
    await api.fetchApi(`${CONSULT_CHAT_ENDPOINT}/${encodeURIComponent(pending.job_id)}/cancel`, { method: "POST" });
  } catch (_) {
    // The local cancelled state remains authoritative while the server reconnects.
  }
}

function resumeConsultJobs() {
  for (const chat of state.chats) {
    if (chat.consultPendingJob?.job_id && chat.consultPendingJob.request) runConsultChatJob(chat.id);
  }
}

function regenerateConsultResponse(messageId) {
  const chat = activeChat();
  if (!chat || consultChatBusy(chat)) return;
  const messageIndex = chat.consultMessages.findIndex((message) => message.id === messageId);
  const message = chat.consultMessages[messageIndex];
  if (
    messageIndex !== chat.consultMessages.length - 1
    || message?.role !== "assistant"
    || chat.consultMessages[messageIndex - 1]?.role !== "user"
  ) return;
  const jobId = globalThis.crypto?.randomUUID?.() || makeId();
  const experimentMode = Boolean(activeConsultExperiment(chat));
  chat.consultPendingJob = {
    job_id: jobId, kind: "regenerate", message_id: message.id,
    experiment_mode: experimentMode, experiment_id: activeConsultExperiment(chat)?.id || "",
    progress: `${llmActivityLabel({}, thinkingModeEnablesReasoning(selectedLlmThinkingMode()))}…`, created_at: Date.now(),
  };
  chat.consultPendingJob.request = consultRequestPayload(
    chat.consultMessages.slice(0, messageIndex), jobId, experimentMode,
  );
  chat.updatedAt = Date.now();
  saveChats({ immediate: true });
  runConsultChatJob(chat.id);
}

function sendConsultMessage() {
  if (!state.apiConnected) return setConsultStatus("ComfyUI is disconnected. Messages are paused.", "error");
  const chat = activeChat();
  const input = state.panel?.querySelector("#promptstudio-consult-input");
  if (!chat || !input || consultChatBusy(chat)) return;
  if (promptAgentModeEnabled(chat)) {
    const agent = activeConsultAgent(chat);
    if (agent?.active) {
      return setConsultStatus("Pause or stop the active Prompt Agent before adding feedback.", "warning");
    }
    return agent ? continueConsultAgent() : startConsultAgent();
  }
  const messageText = input.value.trim();
  const selectedImages = [...state.consultSelectedImages.values()].slice(0, 4);
  const experimentImage = consultExperimentLatestImage(chat);
  if (
    experimentImage && state.consultVisionAvailable === true && selectedImages.length < 4
    && !selectedImages.some((choice) => imageReferenceKey(choice.reference) === imageReferenceKey(experimentImage))
  ) {
    selectedImages.push({
      key: imageReferenceKey(experimentImage), reference: experimentImage,
      purpose: "generated result", uploaded: false,
    });
  }
  const context = consultAttachedContext(selectedImages);
  if (!messageText && !context && !selectedImages.length) {
    return setConsultStatus("Enter a message or attach context.", "warning");
  }
  if (selectedImages.length && state.consultVisionAvailable !== true) {
    return setConsultStatus(state.consultVisionReason || "The connected model cannot accept images.", "warning");
  }
  const now = Date.now();
  const experimentId = activeConsultExperiment(chat)?.id || "";
  chat.consultMessages.push(normalizeConsultMessage({
    id: makeId(), role: "user", text: messageText, context,
    images: selectedImages.map((choice) => choice.reference), experimentId,
    createdAt: now, updatedAt: now,
  }));
  chat.consultMessages = chat.consultMessages.slice(-100);
  const jobId = globalThis.crypto?.randomUUID?.() || makeId();
  const experimentMode = Boolean(activeConsultExperiment(chat));
  chat.consultPendingJob = {
    job_id: jobId, kind: "send", experiment_mode: experimentMode, experiment_id: experimentId,
    progress: `${llmActivityLabel({}, thinkingModeEnablesReasoning(selectedLlmThinkingMode()))}…`, created_at: now,
  };
  chat.consultPendingJob.request = consultRequestPayload(chat.consultMessages, jobId, experimentMode);
  chat.updatedAt = now;
  input.value = "";
  state.consultSelectedImages.clear();
  state.consultUploadedImages = [];
  state.panel.querySelectorAll(".promptstudio-consult-context-options input").forEach((control) => {
    control.checked = false;
  });
  saveChats({ immediate: true });
  renderConsultAttachments();
  runConsultChatJob(chat.id);
}

function clearConsultHistory() {
  const chat = activeChat();
  if (!chat || consultChatBusy(chat)) return;
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

function clearImageImportTemplates() {
  for (const id of ["promptstudio-style", "promptstudio-framing"]) {
    const select = state.panel?.querySelector(`#${id}`);
    if (select && [...select.options].some((option) => option.value === "None")) {
      select.value = "None";
    }
  }
  saveSettings();
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

  const chat = activeChat();
  clearImageImportTemplates();
  const importFingerprint = controlsFingerprint();
  const captionPayload = collectRevisionPayload("Caption the image", "render", "", "");
  const providerName = llmProviderDisplayName(captionPayload.llm_provider);
  const visionPayload = {
    llm_provider: captionPayload.llm_provider,
    kobold_url: captionPayload.kobold_url,
    ollama_url: captionPayload.ollama_url,
    ollama_model: captionPayload.ollama_model,
    llamacpp_url: captionPayload.llamacpp_url,
    llamacpp_model: captionPayload.llamacpp_model,
  };
  const preparationId = makeId();
  state.studioPreparations.set(preparationId, { chatId: chat.id, kind: "image-import" });
  state.latestStudioPreparationByChat.set(chat.id, preparationId);
  renderChatList();
  updateComposeMode();
  syncBackgroundActivityIndicator();
  setStatus(`Checking ${providerName} vision support…`, "working");
  setImageDropFeedback(`Checking ${providerName} vision support…`, "working");
  try {
    await requireVisionCapability(visionPayload);
    setStatus("Sanitizing and storing the image…", "working");
    setImageDropFeedback("Sanitizing and storing the image…", "working");
    const reference = await uploadPromptStudioImage(file);
    setStatus(`${providerName} is reading the image…`, "working");
    setImageDropFeedback(`${providerName} is reading the image…`, "working");
    const mainPrompt = await requestImageCaption(reference, captionPayload);
    setStatus(`${providerName} is applying the selected prompt style…`, "working");
    setImageDropFeedback(`${providerName} is applying the selected prompt style…`, "working");
    const finalPrompt = await requestPromptRevision(
      {
        ...captionPayload,
        revision: mainPrompt,
        mode: "render",
        current_prompt: "",
        current_final_prompt: "",
      },
      "Image-prompt rendering",
    );
    const targetChat = state.chats.find((item) => item.id === chat.id);
    if (!targetChat || !chatAcceptsImageDrop(targetChat)) {
      throw new Error("The originating chat changed before the image caption was ready.");
    }
    targetChat.mainPrompt = mainPrompt;
    targetChat.finalPrompt = finalPrompt;
    targetChat.currentPrompt = finalPrompt;
    targetChat.versions = [promptVersion(mainPrompt, finalPrompt)];
    targetChat.versionIndex = 0;
    targetChat.initialized = true;
    targetChat.renderedMainPrompt = mainPrompt;
    targetChat.renderedFinalPrompt = finalPrompt;
    targetChat.mainPromptDirty = false;
    targetChat.finalPromptManuallyEdited = false;
    targetChat.controlsFingerprint = importFingerprint;
    targetChat.pendingGeneration = null;
    targetChat.selectedSource = reference;
    targetChat.updatedAt = Date.now();
    saveChats();
    appendMessage("assistant", "", {
      chatId: targetChat.id,
      label: "Imported image",
      images: [reference],
      mainPrompt,
      canonicalPrompt: finalPrompt,
      executionPrompt: finalPrompt,
      controlsFingerprint: targetChat.controlsFingerprint,
      llmAmplified: true,
    });
    if (targetChat.id === state.activeChatId) {
      restoreChatState(targetChat);
      renderChatHistory();
      refreshRenderedImageSources();
    }
    setStatus("Image captioned and selected as the editing source.", "ready");
  } catch (error) {
    const message = error.message || String(error);
    setStatus(message, "error");
    setImageDropFeedback(message, "error");
  } finally {
    state.studioPreparations.delete(preparationId);
    if (state.latestStudioPreparationByChat.get(chat.id) === preparationId) {
      state.latestStudioPreparationByChat.delete(chat.id);
    }
    renderChatList();
    updateComposeMode();
    syncBackgroundActivityIndicator();
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

function studioDiscussionHistory(chat, discussionId) {
  const bounded = (chat?.messages || [])
    .filter((message) => (
      message.studioMessageKind === "discussion"
      && message.studioDiscussionId === discussionId
      && ["user", "assistant"].includes(message.role)
      && message.text.trim()
    ))
    .slice(-20);
  while (bounded.length && bounded[0].role === "assistant") bounded.shift();
  return bounded.map((message) => ({ role: message.role, text: message.text }));
}

function compactGenerationContextValue(value, depth = 0) {
  if (depth > 3) return "[nested value]";
  if (typeof value === "string") return value.length > 1200 ? `${value.slice(0, 1200)}…` : value;
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 24).map((item) => compactGenerationContextValue(item, depth + 1));
  if (typeof value !== "object") return String(value);
  return Object.fromEntries(
    Object.entries(value).slice(0, 40).map(([key, item]) => [key, compactGenerationContextValue(item, depth + 1)]),
  );
}

function storedGenerationDiscussionContext(message) {
  if (!message) return null;
  const snapshot = normalizeGenerationSnapshot(message.generationSnapshot);
  const workflowInputs = Object.entries(snapshot?.output || {}).slice(0, 48).map(([nodeId, node]) => ({
    node_id: nodeId,
    title: String(node?._meta?.title || ""),
    class_type: String(node?.class_type || ""),
    inputs: compactGenerationContextValue(node?.inputs || {}),
  }));
  while (workflowInputs.length > 1 && JSON.stringify(workflowInputs).length > 64 * 1024) workflowInputs.pop();
  return {
    action: message.generationAction || "create",
    workflow: message.workflowName || message.workflowProfileId || "",
    source_image: message.sourceImage?.filename || "",
    outputs: (message.images || []).map((image) => ({
      filename: image.filename,
      width: image.width || null,
      height: image.height || null,
    })),
    models: message.modelState || [],
    loras: message.loraState || [],
    workflow_inputs: workflowInputs,
  };
}

function applicableStudioControlValues(chat = activeChat()) {
  const settings = captureStudioSettings(chat);
  return {
    model_profile: settings.model_profile,
    style_preset: settings.style_preset,
    framing_preset: settings.framing_preset,
    style_modifier: settings.style_modifier,
    framing_modifier: settings.framing_modifier,
    additional_instructions: settings.additional_instructions,
    secondary_instructions: settings.secondary_instructions,
    embellishment_level: settings.embellishment_level,
    target_output_length: settings.target_output_length,
    resolution_aspect_ratio: settings.resolution_aspect_ratio,
    resolution_megapixels: settings.resolution_megapixels,
    resolution_multiple: settings.resolution_multiple,
    randomize_seed: settings.randomize_seed,
  };
}

function applicableStudioControlOptions() {
  return {
    model_profile: [...(state.config?.profiles || [])],
    style_preset: [...(state.config?.styles || [])],
    framing_preset: [...(state.config?.framings || [])],
    embellishment_level: [...(state.config?.embellishment_levels || [])],
    resolution_aspect_ratio: [...RESOLUTION_ASPECT_RATIOS],
  };
}

function studioDiscussionTarget(chat, discussion = activeStudioDiscussion(chat)) {
  if (discussion?.targetMessageId) {
    const message = chat?.messages.find((item) => item.id === discussion.targetMessageId);
    const image = normalizeImageReference(discussion.targetImage);
    if (message && image) return { message, image };
  }
  return latestGeneratedContext(chat);
}

function discussionIsStale(chat, discussion) {
  if (!discussion) return false;
  const latest = latestGeneratedContext(chat);
  const targetChanged = Boolean(
    latest
    && (
      latest.message.id !== discussion.targetMessageId
      || imageReferenceKey(latest.image) !== imageReferenceKey(discussion.targetImage)
    )
  );
  const anchoredControls = discussion.anchorApplicableControls || {};
  const applicableControlsChanged = Object.keys(anchoredControls).length > 0
    && JSON.stringify(applicableStudioControlValues(chat)) !== JSON.stringify(anchoredControls);
  return targetChanged
    || chat.mainPrompt !== discussion.anchorMainPrompt
    || chat.finalPrompt !== discussion.anchorFinalPrompt
    || chat.controlsFingerprint !== discussion.anchorControlsFingerprint
    || applicableControlsChanged;
}

function beginOrContinueStudioDiscussion(chat, reference = null) {
  let discussion = activeStudioDiscussion(chat);
  if (discussion && discussionIsStale(chat, discussion)) {
    chat.studioDiscussion = { ...discussion, status: "stale", updatedAt: Date.now() };
    discussion = null;
  }
  const latest = latestGeneratedContext(chat);
  if (!discussion) {
    const now = Date.now();
    discussion = normalizeStudioDiscussion({
      id: makeId(),
      status: "active",
      targetImage: latest?.image || null,
      targetMessageId: latest?.message?.id || "",
      anchorMainPrompt: chat.mainPrompt,
      anchorFinalPrompt: chat.finalPrompt,
      anchorControlsFingerprint: chat.controlsFingerprint,
      anchorApplicableControls: applicableStudioControlValues(chat),
      references: [],
      pendingProposal: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  const attached = normalizeImageReference(reference);
  if (attached) {
    const references = new Map(discussion.references.map((item) => [imageReferenceKey(item), item]));
    references.set(imageReferenceKey(attached), attached);
    discussion.references = [...references.values()].slice(-3);
  }
  discussion.updatedAt = Date.now();
  chat.studioDiscussion = discussion;
  chat.updatedAt = discussion.updatedAt;
  return discussion;
}

async function requestStudioTurnRoute(chat, text, reference) {
  const discussion = activeStudioDiscussion(chat);
  const response = await api.fetchApi(STUDIO_ROUTE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...llmConnectionPayload(),
      user_text: text,
      chat_initialized: chat.initialized === true,
      has_latest_image: Boolean(latestGeneratedImage(chat)),
      has_reference_image: Boolean(reference),
      discussion_active: Boolean(discussion),
      pending_proposal: discussion?.pendingProposal || null,
      discussion_history: discussion ? studioDiscussionHistory(chat, discussion.id) : [],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Turn routing failed (${response.status}).`);
  return {
    route: String(data.route || "clarify"),
    confidence: Number(data.confidence || 0),
    resolvedInstruction: String(data.resolved_instruction || "").trim(),
    warning: String(data.warning || "").trim(),
  };
}

function studioDiscussionRequestMessages(chat, discussion) {
  const target = studioDiscussionTarget(chat, discussion);
  const history = studioDiscussionHistory(chat, discussion.id);
  const images = [target?.image, ...discussion.references]
    .map(storedImageReference)
    .filter(Boolean)
    .slice(0, 4);
  const attachedImages = [];
  if (target?.image) {
    attachedImages.push({ label: "Image A", purpose: "current generated target", filename: target.image.filename });
  }
  discussion.references.slice(0, Math.max(0, 4 - attachedImages.length)).forEach((image) => {
    attachedImages.push({
      label: `Image ${String.fromCharCode(65 + attachedImages.length)}`,
      purpose: "user-supplied visual reference",
      filename: image.filename,
    });
  });
  return history.map((message, index) => {
    if (index !== history.length - 1 || message.role !== "user") return message;
    return {
      ...message,
      images,
      context: {
        main_prompt: target?.message?.mainPrompt || chat.mainPrompt,
        final_prompt: target?.message?.canonicalPrompt || chat.finalPrompt,
        current_generation_settings: {
          target_generation: storedGenerationDiscussionContext(target?.message),
          current_studio_controls: consultCurrentGenerationSettings(),
          applicable_control_values: applicableStudioControlValues(chat),
          allowed_control_options: applicableStudioControlOptions(),
          current_main_prompt: chat.mainPrompt,
          current_final_prompt: chat.finalPrompt,
        },
        attached_images: attachedImages,
      },
    };
  });
}

async function requestStudioDiscussion(chat, discussion) {
  const messages = studioDiscussionRequestMessages(chat, discussion);
  const connection = llmConnectionPayload();
  const hasImages = messages.some((message) => Array.isArray(message.images) && message.images.length);
  if (hasImages) await requireVisionCapability(connection);
  const response = await api.fetchApi(STUDIO_DISCUSS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...connection,
      ...llmProfileGenerationSettings(),
      max_response_tokens: 1200,
      messages,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Image discussion failed (${response.status}).`);
  return {
    message: String(data.message || "").trim(),
    proposal: normalizeStudioProposal(data.proposal ? { ...data.proposal, id: makeId(), createdAt: Date.now() } : null),
    warning: String(data.warning || "").trim(),
  };
}

async function runStudioDiscussion(chat, text, reference = null) {
  const discussion = beginOrContinueStudioDiscussion(chat, reference);
  const now = Date.now();
  discussion.pendingProposal = null;
  appendMessage("user", text, {
    chatId: chat.id,
    label: "Image discussion",
    images: reference ? [reference] : [],
    studioMessageKind: "discussion",
    studioDiscussionId: discussion.id,
  });
  const input = state.panel?.querySelector("#promptstudio-revision");
  if (chat.id === state.activeChatId && input) input.value = "";
  if (reference && chat.id === state.activeChatId) clearMainPastedImage();
  discussion.updatedAt = now;
  chat.updatedAt = now;
  saveChats();
  if (chat.id === state.activeChatId) {
    renderStudioDiscussionContext();
    updateComposeMode();
  }
  setStatus(`Looking at the image with ${llmProviderName()}…`, "working");
  const answer = await requestStudioDiscussion(chat, discussion);
  discussion.pendingProposal = answer.proposal;
  discussion.updatedAt = Date.now();
  chat.studioDiscussion = discussion;
  chat.updatedAt = discussion.updatedAt;
  appendMessage("assistant", answer.message, {
    chatId: chat.id,
    label: "Prompt Studio assistant",
    studioMessageKind: "discussion",
    studioDiscussionId: discussion.id,
    studioProposal: answer.proposal,
  });
  if (answer.warning) {
    appendMessage("system", answer.warning, { chatId: chat.id });
  }
  saveChats();
  if (chat.id === state.activeChatId) {
    renderStudioDiscussionContext();
    renderChatHistory();
    setStatus(
      answer.warning || (answer.proposal?.status === "ready" ? "Suggestion ready to apply." : "Ready to keep discussing."),
      answer.warning ? "warning" : "ready",
    );
  }
}

function applyStudioProposalControlChanges(chat, value) {
  const changes = normalizeStudioControlChanges(value);
  const keys = Object.keys(changes);
  const previousSettings = structuredClone(captureStudioSettings(chat));
  const previousDraft = state.panel?.querySelector("#promptstudio-revision")?.value || "";
  if (!keys.length) {
    return { changedKeys: [], promptShapingChanged: false, generationChanged: false, previousSettings, previousDraft };
  }

  const selectControls = {
    model_profile: "promptstudio-profile",
    style_preset: "promptstudio-style",
    framing_preset: "promptstudio-framing",
    embellishment_level: "promptstudio-embellishment",
  };
  for (const [key, id] of Object.entries(selectControls)) {
    if (!Object.hasOwn(changes, key)) continue;
    const select = state.panel?.querySelector(`#${id}`);
    if (!select || ![...select.options].some((option) => option.value === changes[key])) {
      throw new Error(`The suggested ${studioControlChangeLabels({ [key]: changes[key] })[0]} value is not available.`);
    }
  }
  if (
    Object.hasOwn(changes, "resolution_aspect_ratio")
    && !RESOLUTION_ASPECT_RATIOS.includes(changes.resolution_aspect_ratio)
  ) {
    throw new Error("The suggested aspect ratio is not available.");
  }

  for (const [key, id] of Object.entries(selectControls)) {
    if (Object.hasOwn(changes, key)) state.panel.querySelector(`#${id}`).value = changes[key];
  }
  const textControls = {
    style_modifier: "promptstudio-style-modifier",
    framing_modifier: "promptstudio-framing-modifier",
    additional_instructions: "promptstudio-additional-instructions",
    secondary_instructions: "promptstudio-secondary-instructions",
  };
  for (const [key, id] of Object.entries(textControls)) {
    if (Object.hasOwn(changes, key)) state.panel.querySelector(`#${id}`).value = changes[key];
  }
  if (Object.hasOwn(changes, "additional_instructions")) {
    renderAdditionalInstructionTemplateHighlights();
  }
  const directControls = {
    resolution_aspect_ratio: "promptstudio-resolution-aspect-ratio",
    resolution_megapixels: "promptstudio-resolution-megapixels",
    resolution_multiple: "promptstudio-resolution-multiple",
  };
  for (const [key, id] of Object.entries(directControls)) {
    if (Object.hasOwn(changes, key)) state.panel.querySelector(`#${id}`).value = String(changes[key]);
  }
  if (Object.hasOwn(changes, "randomize_seed")) {
    state.panel.querySelector("#promptstudio-randomize-seed").checked = changes.randomize_seed;
  }

  const shapingSelectionChanged = ["model_profile", "embellishment_level"].some((key) => Object.hasOwn(changes, key));
  if (shapingSelectionChanged && !Object.hasOwn(changes, "target_output_length")) {
    syncOutputLengthControl({ resetToDefault: true });
  }
  if (Object.hasOwn(changes, "target_output_length")) {
    syncOutputLengthControl({
      storedSettings: {
        target_output_length: changes.target_output_length,
        output_length_custom: true,
      },
    });
  }

  saveSettings();
  refreshSecondaryInstructionsControl();
  updateComposeMode();
  const promptShapingKeys = new Set([
    "model_profile", "style_preset", "framing_preset", "style_modifier", "framing_modifier",
    "additional_instructions", "embellishment_level", "target_output_length",
  ]);
  const promptShapingChanged = keys.some((key) => promptShapingKeys.has(key));
  return {
    changedKeys: keys,
    promptShapingChanged,
    generationChanged: keys.some((key) => !promptShapingKeys.has(key)),
    previousSettings,
    previousDraft,
  };
}

function restoreStudioProposalControlChanges(chat, previousSettings, previousDraft = "") {
  if (!chat || !previousSettings) return;
  chat.studioSettings = structuredClone(previousSettings);
  applyStudioSettings(chat);
  const input = state.panel?.querySelector("#promptstudio-revision");
  if (input) input.value = previousDraft;
  saveSettings();
  refreshSecondaryInstructionsControl();
  updateComposeMode();
}

async function applyStudioDiscussionProposal(chat, discussion, proposal, { userText = "" } = {}) {
  if (!chat || !discussion || !proposal || proposal.status !== "ready") return false;
  if (discussionIsStale(chat, discussion)) {
    chat.studioDiscussion = { ...discussion, status: "stale", updatedAt: Date.now() };
    chat.updatedAt = Date.now();
    saveChats();
    renderStudioDiscussionContext();
    setStatus("The prompt or target image changed. Ask again so the suggestion can be grounded in the current result.", "warning");
    return false;
  }
  if (chat.id !== state.activeChatId) {
    appendMessage("system", "The discussed change is ready, but this session must be active before it can be applied.", { chatId: chat.id });
    return false;
  }
  if (userText) {
    appendMessage("user", userText, {
      chatId: chat.id,
      label: "Image discussion",
      studioMessageKind: "discussion",
      studioDiscussionId: discussion.id,
    });
  }
  let controlApplication;
  try {
    controlApplication = applyStudioProposalControlChanges(chat, proposal.control_changes);
  } catch (error) {
    setStatus(error.message || String(error), "error");
    return false;
  }
  let applied = true;
  if (proposal.revision_instruction) {
    applied = await reviseAndMaybeGenerate({
      revisionOverride: proposal.revision_instruction,
      recordRevision: false,
      contextImageOverride: null,
    });
  } else if (chat.initialized && controlApplication.promptShapingChanged) {
    applied = await reviseAndMaybeGenerate({
      controlsOnly: true,
      revisionOverride: "",
      recordRevision: false,
      contextImageOverride: null,
    });
  } else if (
    chat.initialized
    && controlApplication.generationChanged
    && state.panel.querySelector("#promptstudio-auto-generate")?.checked === true
  ) {
    applied = await createNewFromCurrentPrompt({ applyControls: false });
  }
  if (!applied) {
    const promptOrShapingApplied = chat.mainPrompt !== discussion.anchorMainPrompt
      || chat.finalPrompt !== discussion.anchorFinalPrompt
      || chat.controlsFingerprint !== discussion.anchorControlsFingerprint;
    const controlsOnlyApplied = !proposal.revision_instruction && !controlApplication.promptShapingChanged;
    if (!promptOrShapingApplied && !controlsOnlyApplied) {
      restoreStudioProposalControlChanges(chat, controlApplication.previousSettings, controlApplication.previousDraft);
      return false;
    }
  }
  discussion.status = "applied";
  discussion.updatedAt = Date.now();
  chat.studioDiscussion = discussion;
  chat.updatedAt = discussion.updatedAt;
  const controlLabels = studioControlChangeLabels(proposal.control_changes);
  appendMessage("system", `${controlLabels.length ? "Applied controls and discussed change" : "Applied discussed change"}: ${proposal.summary}`, { chatId: chat.id });
  saveChats();
  renderStudioDiscussionContext();
  renderChatHistory();
  return true;
}

async function applyStudioProposalFromMessage(messageId) {
  if (state.busy) return;
  const chat = activeChat();
  const message = chat?.messages.find((item) => item.id === messageId);
  const discussion = activeStudioDiscussion(chat);
  const proposal = normalizeStudioProposal(message?.studioProposal);
  if (
    !chat
    || !discussion
    || message?.studioDiscussionId !== discussion.id
    || !proposal
    || discussion.pendingProposal?.id !== proposal.id
  ) return;
  state.studioTurnBusyChatIds.add(chat.id);
  updateComposeMode();
  try {
    await applyStudioDiscussionProposal(chat, discussion, proposal);
  } finally {
    state.studioTurnBusyChatIds.delete(chat.id);
    updateComposeMode();
    renderChatHistory();
  }
}

async function handleStudioTurn() {
  if (!useLlmAmplification()) return reviseAndMaybeGenerate();
  const chat = activeChat();
  const input = state.panel?.querySelector("#promptstudio-revision");
  if (!chat || !input) return;
  const text = input.value.trim();
  const reference = normalizeImageReference(state.mainPastedImage);
  if (!text) {
    if (reference) return setStatus("Add a question or change instruction for the attached reference.", "warning");
    return reviseAndMaybeGenerate();
  }
  if (state.studioTurnBusyChatIds.has(chat.id)) return;
  state.studioTurnBusyChatIds.add(chat.id);
  updateComposeMode();
  setStatus(`Understanding your request with ${llmProviderName()}…`, "working");
  try {
    const routed = await requestStudioTurnRoute(chat, text, reference);
    if (chat.id !== state.activeChatId) {
      throw new Error("Return to the originating session and send the message again.");
    }
    if (routed.warning) {
      appendMessage("system", routed.warning, { chatId: chat.id });
      saveChats();
      renderChatHistory();
    }
    const unsafeLowConfidence = routed.confidence < 0.55
      && ["mutate_now", "commit_pending"].includes(routed.route);
    const route = unsafeLowConfidence ? "clarify" : routed.route;
    const discussion = activeStudioDiscussion(chat);
    if (route === "discuss") {
      await runStudioDiscussion(chat, text, reference);
    } else if (route === "commit_pending") {
      input.value = "";
      await applyStudioDiscussionProposal(chat, discussion, discussion?.pendingProposal, { userText: text });
    } else if (route === "cancel_pending") {
      if (discussion) {
        appendMessage("user", text, {
          chatId: chat.id,
          label: "Image discussion",
          studioMessageKind: "discussion",
          studioDiscussionId: discussion.id,
        });
        discussion.status = "cancelled";
        discussion.pendingProposal = null;
        discussion.updatedAt = Date.now();
        chat.studioDiscussion = discussion;
      }
      input.value = "";
      if (reference) clearMainPastedImage();
      chat.updatedAt = Date.now();
      saveChats();
      renderChatHistory();
      setStatus("Suggestion cancelled without changing the prompt.", "ready");
    } else if (route === "mutate_now") {
      if (chat.id !== state.activeChatId) throw new Error("Return to the originating session and send the change again.");
      const instruction = routed.resolvedInstruction || text;
      const needsResolvedRecord = instruction !== text;
      if (needsResolvedRecord) {
        appendMessage("user", text, {
          chatId: chat.id,
          images: reference ? [reference] : [],
          studioMessageKind: discussion ? "discussion" : "revision",
          studioDiscussionId: discussion?.id || "",
        });
        input.value = "";
      }
      const applied = await reviseAndMaybeGenerate({
        revisionOverride: instruction,
        recordRevision: !needsResolvedRecord,
      });
      if (applied && discussion) {
        discussion.status = "applied";
        discussion.updatedAt = Date.now();
        chat.studioDiscussion = discussion;
        saveChats();
      }
    } else {
      const active = beginOrContinueStudioDiscussion(chat, reference);
      active.pendingProposal = null;
      chat.studioDiscussion = active;
      appendMessage("user", text, {
        chatId: chat.id,
        label: "Image discussion",
        images: reference ? [reference] : [],
        studioMessageKind: "discussion",
        studioDiscussionId: active.id,
      });
      appendMessage("assistant", "I’m not sure whether you want advice or want me to change the prompt now. Please say “What would work?” to discuss it, or “Change it to…” to apply an edit.", {
        chatId: chat.id,
        label: "Prompt Studio assistant",
        studioMessageKind: "discussion",
        studioDiscussionId: active.id,
      });
      input.value = "";
      if (reference) clearMainPastedImage();
      saveChats();
      renderChatHistory();
      setStatus("Waiting for clarification.", "warning");
    }
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    state.studioTurnBusyChatIds.delete(chat.id);
    updateComposeMode();
    renderChatHistory();
  }
}

async function reviseAndMaybeGenerate({
  controlsOnly = false,
  forceGenerate = false,
  regenerateFinal = false,
  generationAction = selectedAction(),
  revisionOverride = null,
  recordRevision = true,
  contextImageOverride = undefined,
} = {}) {
  if (!state.apiConnected) return setStatus("ComfyUI is disconnected. Prompt Studio is frozen.", "error");
  if (!useLlmAmplification()) return generateDirectPrompt(generationAction);
  const chat = activeChat();
  if (!chat) return;
  const input = state.panel.querySelector("#promptstudio-revision");
  let revision = revisionOverride == null ? input.value.trim() : String(revisionOverride).trim();
  const creating = !chat.initialized;
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
  if (generationAction === "edit" && !editingSource(null, chat)) {
    return setStatus("There is no image in this conversation to edit.", "warning");
  }
  if (creating && !revision) return setStatus("Describe an image to create the first prompt.", "warning");
  if (!creating && !state.currentPrompt.trim()) return setStatus("The final prompt is empty.", "warning");
  if (!creating && !state.mainPrompt.trim()) return setStatus("The main prompt is empty.", "warning");
  const contextImage = contextImageOverride !== undefined
    ? normalizeImageReference(contextImageOverride)
    : pastedContextImage || (
      state.panel.querySelector("#promptstudio-use-latest-image-context")?.checked
        ? latestGeneratedImage(chat)
        : null
    );
  const usesPastedContextImage = contextImageOverride === undefined && Boolean(pastedContextImage);

  const promptNeedsRebuild = !creating && promptNeedsRender();
  controlsOnly = !creating && (controlsOnly || (!revision && promptNeedsRebuild));
  if (!revision && !controlsOnly) return createNewFromCurrentPrompt({ applyControls: false, generationAction });
  if (!creating) commitPromptEditorVersion();
  if (revision && !controlsOnly && recordRevision) {
    appendMessage("user", revision, {
      chatId: chat.id,
      images: pastedContextImage ? [pastedContextImage] : [],
    });
    input.value = "";
    updateComposeMode();
  }
  saveSettings();
  const previousMainPrompt = chat.mainPrompt;
  const previousFinalPrompt = chat.finalPrompt;
  const requestedControlsFingerprint = controlsFingerprint();
  const queueSettings = captureGenerationQueueSettings(generationAction, chat);
  const autoGenerate = forceGenerate || state.panel.querySelector("#promptstudio-auto-generate")?.checked === true;
  const editPromptMode = selectedEditPromptMode();
  const basePayload = collectRevisionPayload("", "render", "", previousFinalPrompt, contextImage);
  const payloadFor = (nextRevision, mode, currentPrompt, currentFinalPrompt) => ({
    ...basePayload,
    revision: nextRevision,
    mode,
    current_prompt: currentPrompt,
    current_final_prompt: currentFinalPrompt,
  });
  const visionPayload = {
    llm_provider: basePayload.llm_provider,
    kobold_url: basePayload.kobold_url,
    ollama_url: basePayload.ollama_url,
    ollama_model: basePayload.ollama_model,
    llamacpp_url: basePayload.llamacpp_url,
    llamacpp_model: basePayload.llamacpp_model,
  };
  const providerName = llmProviderDisplayName(basePayload.llm_provider);
  const operationMessage = createStudioOperation(chat, generationAction, "Submitted…");
  const operationSignal = state.operationControllers.get(operationMessage.operationId)?.signal || null;
  const preparationId = makeId();
  state.studioPreparations.set(preparationId, { chatId: chat.id, kind: "revision" });
  state.latestStudioPreparationByChat.set(chat.id, preparationId);
  renderChatList();
  updateComposeMode();
  syncBackgroundActivityIndicator();
  const revisionStatus = (
    creating
      ? `${providerName} is preparing the initial main and final prompts...`
      : regenerateFinal
        ? `${providerName} is processing the final prompt again...`
        : controlsOnly || promptNeedsRebuild
        ? `${providerName} is rebuilding the final prompt from the main prompt and controls...`
        : `${providerName} is revising the main and final prompts...`
  );
  const llmWarnings = [];
  updateStudioOperation(operationMessage.id, {
    operationPhase: contextImage ? "checking_vision" : "llm_processing",
    operationStatus: contextImage ? "Checking image support…" : revisionStatus,
    llmProvider: normalizeLlmProvider(basePayload.llm_provider),
    llmThinkingEnabled: thinkingModeEnablesReasoning(basePayload.thinking_mode),
    llmTokenCount: null,
  });

  try {
    if (contextImage) {
      await requireVisionCapability(visionPayload, operationSignal);
      updateStudioOperation(operationMessage.id, {
        operationPhase: "llm_processing",
        operationStatus: revisionStatus,
      });
    }
    let mainPrompt;
    let finalPrompt;
    if (creating) {
      mainPrompt = await requestPromptRevision(
        payloadFor(revision, "create_main", "", ""),
        "Initial main-prompt creation",
        llmWarnings,
        operationSignal,
      );
      finalPrompt = await requestPromptRevision(
        payloadFor(mainPrompt, "render", "", ""),
        "Prompt rendering",
        llmWarnings,
        operationSignal,
      );
    } else if (controlsOnly) {
      mainPrompt = previousMainPrompt;
      finalPrompt = await requestPromptRevision(
        payloadFor(mainPrompt, "render", "", previousFinalPrompt),
        "Control update",
        llmWarnings,
        operationSignal,
      );
    } else if (promptNeedsRebuild) {
      mainPrompt = await requestPromptRevision(
        payloadFor(revision, "revise_main", previousMainPrompt, previousFinalPrompt),
        "Main-prompt revision",
        llmWarnings,
        operationSignal,
      );
      finalPrompt = await requestPromptRevision(
        payloadFor(mainPrompt, "render", "", previousFinalPrompt),
        "Final-prompt rendering",
        llmWarnings,
        operationSignal,
      );
    } else {
      [mainPrompt, finalPrompt] = await Promise.all([
        requestPromptRevision(
          payloadFor(revision, "revise_main", previousMainPrompt, previousFinalPrompt),
          "Main-prompt revision",
          llmWarnings,
          operationSignal,
        ),
        requestPromptRevision(
          payloadFor(revision, "revise", previousFinalPrompt, previousFinalPrompt),
          "Final-prompt revision",
          llmWarnings,
          operationSignal,
        ),
      ]);
    }
    const targetChat = state.chats.find((item) => item.id === chat.id);
    if (!targetChat) throw new Error("The originating chat no longer exists.");
    const executionPrompt = generationAction === "edit"
      && editPromptMode === "edit_instruction"
      && revision
      ? revision
      : finalPrompt;
    applyPreparedPromptToChat(
      targetChat,
      preparationId,
      previousMainPrompt,
      previousFinalPrompt,
      mainPrompt,
      finalPrompt,
      generationAction,
      executionPrompt,
      { ...queueSettings, controlsFingerprintOverride: requestedControlsFingerprint },
    );
    if (
      usesPastedContextImage
      && imageReferenceKey(state.mainPastedImage) === imageReferenceKey(pastedContextImage)
    ) {
      if (targetChat.id === state.activeChatId) clearMainPastedImage();
    }
    if (llmWarnings.length) {
      appendMessage("system", llmWarnings.join(" "), { chatId: targetChat.id });
      saveChats();
      renderChatHistory();
    }
    if (autoGenerate) {
      await queueGeneration({
        action: generationAction,
        executionPrompt,
        mainPrompt,
        finalPrompt,
        preserveSeed: true,
        forceNewSeed: regenerateFinal,
        ...queueSettings,
        controlsFingerprintOverride: requestedControlsFingerprint,
        independent: true,
        releaseBusy: false,
        operationMessageId: operationMessage.id,
      });
    } else {
      updateStudioOperation(operationMessage.id, {
        operationPhase: "complete",
        operationStatus: "Prompt updated",
        text: "Prompt updated.",
      });
      state.operationControllers.delete(operationMessage.operationId);
    }
    return true;
  } catch (error) {
    if (operationSignal?.aborted) {
      updateStudioOperation(operationMessage.id, {
        operationPhase: "cancelled",
        operationStatus: "Cancelled",
        generationState: "cancelled",
        text: "Cancelled.",
      });
      return false;
    }
    const message = error.message || String(error);
    updateStudioOperation(operationMessage.id, {
      operationPhase: "error",
      operationStatus: "Failed",
      generationState: "error",
      text: message,
    });
    return false;
  } finally {
    if (["complete", "error", "cancelled"].includes(studioOperationRecord(operationMessage.id)?.message?.operationPhase)) {
      state.operationControllers.delete(operationMessage.operationId);
    }
    state.studioPreparations.delete(preparationId);
    if (state.latestStudioPreparationByChat.get(chat.id) === preparationId) {
      state.latestStudioPreparationByChat.delete(chat.id);
    }
    renderChatList();
    updateComposeMode();
    syncBackgroundActivityIndicator();
  }
}

async function createNewFromCurrentPrompt({ applyControls = true, generationAction = selectedAction() } = {}) {
  if (state.busy) return;
  const chat = activeChat();
  const lastGeneration = chat?.lastGeneration;
  const pendingGeneration = chat?.pendingGeneration;
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
  if (!chat?.initialized) return setStatus("Create the first prompt before creating another image.", "warning");
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
  const queueSettings = captureGenerationQueueSettings(generationAction, chat);
  const generationOptions = {
    ...queueSettings,
    action: generationAction,
    executionPrompt: usePendingGeneration
      ? (pendingGeneration.executionPrompt || state.currentPrompt)
      : repeatLastConfiguration
        ? (lastGeneration.executionPrompt || state.currentPrompt)
        : state.currentPrompt,
    preserveSeed: replayStoredGeneration || promptChanged,
    mainPrompt: state.mainPrompt,
    finalPrompt: state.currentPrompt,
    workflowProfileId: replayStoredGeneration ? pendingGeneration.workflowProfileId : queueSettings.workflowProfileId,
    loraState: replayStoredGeneration ? pendingGeneration.loraState : queueSettings.loraState,
    modelState: replayStoredGeneration ? pendingGeneration.modelState : queueSettings.modelState,
    generationSnapshot: replayStoredGeneration ? pendingGeneration.generationSnapshot : null,
    workflowName: replayStoredGeneration ? pendingGeneration.workflowName : "",
    sourceImage: replayStoredGeneration
      ? pendingGeneration.sourceImage
      : repeatLastConfiguration ? lastGeneration.sourceImage : queueSettings.sourceImage,
    upscaleFactor: replayStoredGeneration ? pendingGeneration.upscaleFactor : null,
    resultNodeIds: replayStoredGeneration ? pendingGeneration.resultNodeIds : null,
    resultFields: replayStoredGeneration ? pendingGeneration.resultFields : null,
    independent: true,
    releaseBusy: false,
  };
  const operation = createStudioOperation(chat, generationAction, "Preparing workflow…");
  generationOptions.operationMessageId = operation.id;
  try {
    await queueGeneration(generationOptions);
    return true;
  } catch (error) {
    const message = error.message || String(error);
    updateStudioOperation(operation.id, {
      generationState: "error",
      operationPhase: "error",
      operationStatus: "Failed",
      text: message,
    });
    showGenerationFailure(message, () => retryGeneration(generationOptions));
    return false;
  }
}

function applyPreparedPromptToChat(
  chat,
  preparationId,
  previousMainPrompt,
  previousFinalPrompt,
  mainPrompt,
  finalPrompt,
  generationAction,
  executionPrompt,
  queueSettings,
) {
  const latest = state.latestStudioPreparationByChat.get(chat.id) === preparationId;
  const promptUnchanged = chat.mainPrompt === previousMainPrompt && chat.finalPrompt === previousFinalPrompt;
  if (!latest || !promptUnchanged) return false;

  const version = promptVersion(mainPrompt, finalPrompt);
  chat.mainPrompt = mainPrompt;
  chat.finalPrompt = finalPrompt;
  chat.currentPrompt = finalPrompt;
  chat.initialized = true;
  chat.renderedMainPrompt = mainPrompt;
  chat.renderedFinalPrompt = finalPrompt;
  chat.mainPromptDirty = false;
  chat.finalPromptManuallyEdited = false;
  chat.controlsFingerprint = queueSettings.controlsFingerprintOverride;
  if (!promptVersionsEqual(chat.versions[chat.versionIndex], version)) {
    chat.versions = chat.versions.slice(0, chat.versionIndex + 1);
    chat.versions.push(version);
    chat.versionIndex = chat.versions.length - 1;
  }
  chat.pendingGeneration = {
    action: generationAction,
    mainPrompt,
    canonicalPrompt: finalPrompt,
    executionPrompt,
    workflowProfileId: queueSettings.workflowProfileId || "",
  };
  chat.updatedAt = Date.now();
  saveChats();
  if (chat.id === state.activeChatId) {
    restoreChatState(chat);
    updateComposeMode();
    const undo = state.panel?.querySelector("#promptstudio-undo");
    if (undo) undo.disabled = state.versionIndex <= 0;
  }
  return true;
}

async function queueBackgroundReroll(generationAction = selectedAction()) {
  if (!state.apiConnected) return setStatus("ComfyUI is disconnected. Prompt Studio is frozen.", "error");
  if (!useLlmAmplification()) return generateDirectPrompt(generationAction);
  const chat = activeChat();
  if (!chat?.initialized) return setStatus("Create the first prompt before rerolling.", "warning");
  const profile = selectedWorkflowProfile(generationAction);
  if (!profile) return setStatus("Select a compatible [PS] workflow first.", "warning");
  const sourceImage = generationAction === "create" ? null : editingSource(null, chat);
  if (generationAction === "edit" && !sourceImage) {
    return setStatus("There is no image in this conversation to edit.", "warning");
  }

  commitPromptEditorVersion();
  const previousMainPrompt = chat.mainPrompt;
  const previousFinalPrompt = chat.finalPrompt;
  const pastedContextImage = normalizeImageReference(state.mainPastedImage);
  const contextImage = pastedContextImage || (
    state.panel.querySelector("#promptstudio-use-latest-image-context")?.checked
      ? latestGeneratedImage(chat)
      : null
  );
  const revisionPayload = collectRevisionPayload(
    previousMainPrompt,
    "render",
    "",
    previousFinalPrompt,
    contextImage,
  );
  const visionPayload = {
    llm_provider: revisionPayload.llm_provider,
    kobold_url: revisionPayload.kobold_url,
    ollama_url: revisionPayload.ollama_url,
    ollama_model: revisionPayload.ollama_model,
    llamacpp_url: revisionPayload.llamacpp_url,
    llamacpp_model: revisionPayload.llamacpp_model,
  };
  const queueSettings = {
    ...captureGenerationQueueSettings(generationAction, chat),
    sourceImage,
  };
  const providerName = llmProviderDisplayName(revisionPayload.llm_provider);
  const preparationId = makeId();
  const operation = createStudioOperation(
    chat,
    generationAction,
    contextImage ? `Checking ${providerName} vision support…` : `${providerName} processing…`,
  );
  const operationController = state.operationControllers.get(operation.operationId);
  state.studioPreparations.set(preparationId, { chatId: chat.id, kind: "reroll" });
  state.latestStudioPreparationByChat.set(chat.id, preparationId);
  renderChatList();
  updateComposeMode();
  syncBackgroundActivityIndicator();

  try {
    if (contextImage) await requireVisionCapability(visionPayload, operationController?.signal);
    updateStudioOperation(operation.id, {
      operationPhase: "llm_processing",
      operationStatus: `${providerName} processing…`,
    });
    const finalPrompt = await requestPromptRevision(
      revisionPayload,
      "Final-prompt reroll",
      null,
      operationController?.signal,
    );
    const targetChat = state.chats.find((item) => item.id === chat.id);
    if (!targetChat) throw new Error("The originating chat no longer exists.");
    applyPreparedPromptToChat(
      targetChat,
      preparationId,
      previousMainPrompt,
      previousFinalPrompt,
      previousMainPrompt,
      finalPrompt,
      generationAction,
      finalPrompt,
      queueSettings,
    );
    if (
      targetChat.id === state.activeChatId
      && pastedContextImage
      && imageReferenceKey(state.mainPastedImage) === imageReferenceKey(pastedContextImage)
    ) {
      clearMainPastedImage();
    }
    await queueGeneration({
      action: generationAction,
      executionPrompt: finalPrompt,
      mainPrompt: previousMainPrompt,
      finalPrompt,
      preserveSeed: true,
      forceNewSeed: true,
      ...queueSettings,
      independent: true,
      releaseBusy: false,
      operationMessageId: operation.id,
    });
  } catch (error) {
    if (operationController?.signal.aborted) {
      updateStudioOperation(operation.id, {
        generationState: "cancelled",
        operationPhase: "cancelled",
        operationStatus: "Cancelled",
        text: "Cancelled.",
      });
      return false;
    }
    const message = error.message || String(error);
    updateStudioOperation(operation.id, {
      generationState: "error",
      operationPhase: "error",
      operationStatus: "Failed",
      text: message,
    });
    return false;
  } finally {
    if (["complete", "error", "cancelled"].includes(studioOperationRecord(operation.id)?.message?.operationPhase)) {
      state.operationControllers.delete(operation.operationId);
    }
    state.studioPreparations.delete(preparationId);
    if (state.latestStudioPreparationByChat.get(chat.id) === preparationId) {
      state.latestStudioPreparationByChat.delete(chat.id);
    }
    renderChatList();
    updateComposeMode();
    syncBackgroundActivityIndicator();
  }
}

async function reroll({ generationAction = selectedAction() } = {}) {
  return queueBackgroundReroll(generationAction);
}

function undoPrompt() {
  if (state.busy || state.versionIndex <= 0) return;
  state.versionIndex -= 1;
  const version = state.versions[state.versionIndex];
  const chat = activeChat();
  if (chat) {
    chat.renderedMainPrompt = version.mainPrompt;
    chat.renderedFinalPrompt = version.finalPrompt;
    chat.mainPromptDirty = false;
    chat.finalPromptManuallyEdited = false;
    chat.pendingGeneration = null;
  }
  updatePromptEditors(version.mainPrompt, version.finalPrompt);
  syncActiveChat();
  updateComposeMode();
  appendMessage("system", `Restored prompt version ${state.versionIndex + 1}.`);
  state.panel.querySelector("#promptstudio-undo").disabled = state.versionIndex <= 0;
  refreshStudioStatus();
}

async function interrupt() {
  if (activeConsultAgent()?.active) return stopConsultAgent();
  const provider = selectedLlmProvider();
  const llmOperationActive = state.busy && !state.generating && !state.queueing;
  state.operationToken += 1;
  state.pollToken += 1;
  state.operationControllers.forEach((controller) => controller.abort());
  const interruptedPromptId = state.activeGenerationPromptId;
  const consultTarget = state.consultGenerationTarget;
  const studioGenerationActive = state.generationJobs.has(String(interruptedPromptId || ""));
  try {
    if (llmOperationActive && ["koboldcpp", "llamacpp"].includes(provider)) {
      await api.fetchApi(LLM_ABORT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(llmConnectionPayload()),
      });
    }
    if (state.generating || state.queueing || studioGenerationActive) {
      if (typeof api.interrupt === "function") await api.interrupt();
      else await api.fetchApi("/interrupt", { method: "POST" });
      if (studioGenerationActive) {
        updateStudioGenerationText(interruptedPromptId, "Generation interrupted.");
        setStudioGenerationState(interruptedPromptId, "error");
      }
      if (consultTarget) {
        const chat = consultTarget.chatId
          ? state.chats.find((item) => item.id === consultTarget.chatId)
          : activeChat();
        const message = chat?.consultMessages.find((entry) => entry.id === consultTarget.messageId);
        const variant = message?.variants?.find((entry) => entry.id === consultTarget.variantId);
        const generation = normalizeConsultExperimentGeneration(variant?.generation) || {};
        setConsultExperimentGeneration(consultTarget.messageId, consultTarget.variantId, {
          ...generation,
          generationState: "error",
          text: "Generation interrupted.",
          updatedAt: Date.now(),
        }, consultTarget.chatId);
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
  state.llmProfiles = loadLlmProfiles();
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
        <div class="promptstudio-mobile-brand">
          <strong>Prompt Studio</strong>
          <div class="promptstudio-studio-switch promptstudio-standalone-only" role="group" aria-label="Studio mode">
            <button type="button" data-promptstudio-studio-mode="image" aria-pressed="true">Image</button>
            <button type="button" data-promptstudio-studio-mode="video" data-available="false" aria-pressed="false">Video</button>
          </div>
        </div>
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
        <textarea id="promptstudio-revision" rows="3" aria-label="Prompt revision" placeholder="Make the background more varied…" title="Paste with Ctrl+V or drop an image into the chat to attach it as a visual reference."></textarea>
        <div id="promptstudio-discussion-context" class="promptstudio-discussion-context" hidden>
          <img alt="" />
          <span><strong>Discussing generated image</strong><small></small></span>
          <button type="button" title="End this image discussion" aria-label="End this image discussion">End</button>
        </div>
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
          <div class="promptstudio-studio-switch promptstudio-standalone-only" role="group" aria-label="Studio mode">
            <button type="button" data-promptstudio-studio-mode="image" aria-pressed="true">Image</button>
            <button type="button" data-promptstudio-studio-mode="video" data-available="false" aria-pressed="false">Video</button>
          </div>
        </div>
        <div class="promptstudio-header-actions">
          <details id="promptstudio-kobold-control" class="promptstudio-kobold-control" data-state="checking">
            <summary title="System status"><span class="promptstudio-kobold-dot" aria-hidden="true"></span><span id="promptstudio-kobold-status-label">Status: checking</span></summary>
            <div class="promptstudio-kobold-popover">
              <strong class="promptstudio-system-status-heading">System status</strong>
              <section class="promptstudio-system-status-section">
                <strong id="promptstudio-llm-status-heading">${llmProviderDisplayName(settings.llm_provider)}</strong>
                <span id="promptstudio-kobold-status-detail" role="status" aria-live="polite">Checking local status…</span>
                <dl class="promptstudio-kobold-metadata">
                  <div><dt>Model</dt><dd id="promptstudio-kobold-model">Checking…</dd></div>
                  <div><dt>Vision</dt><dd id="promptstudio-kobold-vision" data-state="unknown">Checking…</dd></div>
                </dl>
                <button id="promptstudio-kobold-stop" type="button" disabled ${settings.llm_provider === "ollama" ? "hidden" : ""}>Force stop processing</button>
                <small id="promptstudio-kobold-stop-help" ${settings.llm_provider === "ollama" ? "hidden" : ""}>Stops LLM processing only. KoboldCpp stays loaded.</small>
                <div id="promptstudio-llamacpp-process-controls" class="promptstudio-system-status-actions" ${settings.llm_provider === "llamacpp" ? "" : "hidden"}>
                  <button id="promptstudio-llamacpp-start" type="button" title="Start Llama.cpp server" disabled>Start</button>
                  <button id="promptstudio-llamacpp-server-stop" type="button" title="Stop managed Llama.cpp server" disabled>Stop</button>
                  <button id="promptstudio-llamacpp-restart" type="button" title="Restart managed Llama.cpp server" disabled>Restart</button>
                </div>
                <small id="promptstudio-llamacpp-process-detail" ${settings.llm_provider === "llamacpp" ? "" : "hidden"}>Checking managed server…</small>
              </section>
              <section class="promptstudio-system-status-section promptstudio-comfy-status-section">
                <div class="promptstudio-system-status-row"><strong>ComfyUI</strong><span id="promptstudio-comfy-status-detail" data-state="busy" role="status" aria-live="polite">Checking…</span></div>
                <progress id="promptstudio-comfy-update-progress" class="promptstudio-comfy-update-progress" aria-label="ComfyUI update progress" hidden></progress>
                <div class="promptstudio-system-status-actions">
                  <button id="promptstudio-comfy-update" type="button">Update ComfyUI</button>
                  <button id="promptstudio-comfy-restart" type="button" data-promptstudio-allow-disconnected="true">Restart ComfyUI</button>
                </div>
                <small>Requires ComfyUI Manager. Update runs Manager's Update All for ComfyUI and installed custom nodes.</small>
              </section>
            </div>
          </details>
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
          <span><strong>Use LLM amplification</strong><small id="promptstudio-llm-amplification-help">Rewrite prompts through ${llmProviderDisplayName(settings.llm_provider)}</small></span>
        </label>
      </section>
      <section class="promptstudio-control-deck">
        <details class="promptstudio-current-details" data-promptstudio-sidebar-group="main-prompt" open>
          <summary><span>Main prompt</span><small>Editable source intent</small></summary>
          <div class="promptstudio-main-prompt-editor">
            <div id="promptstudio-main-prompt-highlights" class="promptstudio-main-prompt-highlights" aria-hidden="true"><pre id="promptstudio-main-prompt-highlight-content"></pre></div>
            <textarea id="promptstudio-main-prompt" rows="5" aria-label="Main prompt" placeholder="The user's model-neutral image description"></textarea>
          </div>
        </details>
        <details class="promptstudio-current-details" data-promptstudio-sidebar-group="final-prompt" open>
          <summary><span>Final prompt</span><small>Editable; rebuilt when controls change</small></summary>
          <textarea id="promptstudio-current-prompt" rows="8" aria-label="Final prompt" placeholder="The rendered prompt sent to the selected workflow"></textarea>
        </details>
        <details class="promptstudio-settings" data-promptstudio-sidebar-group="generation-controls" open>
          <summary><span>Generation controls</span><small>Model, style and prompt shaping</small></summary>
          <div class="promptstudio-settings-grid">
            <label class="promptstudio-control-wide">Model profile<select id="promptstudio-profile"></select></label>
            <label>Style<select id="promptstudio-style"></select></label>
            <label>Framing<select id="promptstudio-framing"></select></label>
            <label>Embellishment<select id="promptstudio-embellishment"></select></label>
            <label id="promptstudio-thinking-control">Thinking<select id="promptstudio-thinking"></select></label>
            <label class="promptstudio-control-wide" title="Additional guidance applied together with the selected style preset. Select None for modifier-only behavior.">Style modifier<textarea id="promptstudio-style-modifier" rows="2" placeholder="Further style guidance added to the selected preset"></textarea></label>
            <label class="promptstudio-control-wide" title="Additional guidance applied together with the selected framing preset. Select None for modifier-only behavior.">Framing modifier<textarea id="promptstudio-framing-modifier" rows="2" placeholder="Further framing guidance added to the selected preset"></textarea></label>
            <label id="promptstudio-output-length-control" class="promptstudio-control-wide">Target length
              <span id="promptstudio-output-length-value" class="promptstudio-output-length-value">~35 words</span>
              <span id="promptstudio-output-length-track" class="promptstudio-output-length-track">
                <input id="promptstudio-output-length" type="range" min="20" max="200" step="5" value="35" aria-describedby="promptstudio-output-length-help" />
                <span class="promptstudio-output-length-default-marker" aria-hidden="true"></span>
              </span>
              <small id="promptstudio-output-length-help">Default for Clean</small>
            </label>
            <input id="promptstudio-temperature" type="hidden" />
          </div>
        </details>
        <details id="promptstudio-lora-details" class="promptstudio-lora-details" data-promptstudio-sidebar-group="lora" open hidden>
          <summary>
            <span>LoRA</span>
            <span class="promptstudio-lora-summary-tools">
              <small id="promptstudio-lora-summary">0 selected</small>
              <button id="promptstudio-refresh-loras" type="button" title="Refresh LoRAs" aria-label="Refresh LoRAs">↻</button>
            </span>
          </summary>
          <div id="promptstudio-lora-groups" class="promptstudio-lora-groups"></div>
        </details>
        <details id="promptstudio-model-details" class="promptstudio-model-details" data-promptstudio-sidebar-group="model" open hidden>
          <summary>
            <span>Model</span>
            <span class="promptstudio-lora-summary-tools">
              <small id="promptstudio-model-summary">0 loaders</small>
              <button id="promptstudio-refresh-models" type="button" title="Refresh models" aria-label="Refresh models">↻</button>
            </span>
          </summary>
          <div id="promptstudio-model-groups" class="promptstudio-lora-groups"></div>
        </details>
        <details class="promptstudio-resolution-details" data-promptstudio-sidebar-group="resolution" open>
          <summary><span>Resolution</span><small>Create size; Edit preserves source</small></summary>
          <div class="promptstudio-resolution-grid">
            <label>Aspect ratio<select id="promptstudio-resolution-aspect-ratio">${RESOLUTION_ASPECT_RATIOS.map((value) => `<option value="${value}">${value}</option>`).join("")}</select></label>
            <label>Megapixels<input id="promptstudio-resolution-megapixels" type="number" min="0.1" max="16" step="0.1" value="1" /></label>
            <label>Multiple<input id="promptstudio-resolution-multiple" type="number" min="8" max="128" step="4" value="8" /></label>
          </div>
        </details>
        <details class="promptstudio-secondary-details promptstudio-additional-details" data-promptstudio-sidebar-group="additional-instructions" open>
          <summary><span>Additional instructions</span><small>Steering guidance for the LLM</small></summary>
          <div class="promptstudio-main-prompt-editor promptstudio-additional-instructions-editor">
            <div id="promptstudio-additional-instruction-highlights" class="promptstudio-main-prompt-highlights" aria-hidden="true"><pre id="promptstudio-additional-instruction-highlight-content"></pre></div>
            <textarea id="promptstudio-additional-instructions" rows="3" aria-label="Additional instructions" placeholder="Explain intent or give rewrite guidance without changing the selected style or framing"></textarea>
          </div>
        </details>
        <details class="promptstudio-secondary-details" data-promptstudio-sidebar-group="secondary-instructions" open>
          <summary><span>Unmodified part</span><small>Text passed through unchanged</small></summary>
          <textarea id="promptstudio-secondary-instructions" rows="3" aria-label="Unmodified part" placeholder="Phrases that must remain unchanged, such as LoRA trigger words"></textarea>
        </details>
      </section>
    </aside>
    <button class="promptstudio-mobile-scrim" type="button" aria-label="Close open drawer"></button>
    <div id="promptstudio-studio-settings" class="promptstudio-studio-settings" role="dialog" aria-labelledby="promptstudio-studio-settings-title" hidden>
      <header class="promptstudio-studio-settings-header">
        <div><strong id="promptstudio-studio-settings-title">Settings</strong><span>Configure Prompt Studio, local services and ComfyUI workflows.</span></div>
        <div class="promptstudio-studio-settings-header-actions"><span class="promptstudio-studio-settings-context">Prompt Studio</span><button id="promptstudio-close-studio-settings" type="button">Done</button></div>
      </header>
      <div class="promptstudio-studio-settings-layout">
        <section class="promptstudio-studio-settings-card" aria-labelledby="promptstudio-general-settings-title">
          <header class="promptstudio-studio-settings-card-header">
            <div><strong id="promptstudio-general-settings-title">General</strong><span>Backend selection, chat display, and editing behavior</span></div>
          </header>
          <div class="promptstudio-studio-settings-list">
            <div class="promptstudio-studio-setting promptstudio-endpoint-control">
              <span class="promptstudio-studio-setting-copy"><strong>LLM provider</strong><small>Choose the local service used to rewrite prompts.</small></span>
              <span class="promptstudio-backend-selector-field">
                <select id="promptstudio-llm-provider" aria-label="LLM provider">
                  <option value="ollama" ${settings.llm_provider === "ollama" ? "selected" : ""}>Ollama</option>
                  <option value="koboldcpp" ${settings.llm_provider === "koboldcpp" ? "selected" : ""}>KoboldCpp</option>
                  <option value="llamacpp" ${settings.llm_provider === "llamacpp" ? "selected" : ""}>Llama.cpp</option>
                </select>
                <button id="promptstudio-open-backend-settings" type="button">Backend settings</button>
              </span>
            </div>
            <div id="promptstudio-backend-settings-dialog" class="promptstudio-backend-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="promptstudio-backend-settings-title" hidden>
              <section class="promptstudio-backend-settings-card">
                <header class="promptstudio-backend-settings-header">
                  <div><strong id="promptstudio-backend-settings-title">Backend settings</strong><span>Connection, model, memory, and managed-server options</span></div>
                  <button id="promptstudio-close-backend-settings" type="button">Done</button>
                </header>
                <div class="promptstudio-studio-settings-list promptstudio-backend-settings-list">
            <label class="promptstudio-studio-setting promptstudio-studio-setting-toggle">
              <span class="promptstudio-studio-setting-copy"><strong>Keep models loaded</strong><small>Keep ComfyUI and LLM models resident instead of handing GPU memory between them. Enable only when they use separate GPUs; leave off for a shared or single GPU.</small></span>
              <input id="promptstudio-keep-models-loaded" type="checkbox" role="switch" ${settings.keep_models_loaded ? "checked" : ""} />
            </label>
            <div class="promptstudio-studio-setting promptstudio-llm-profile-control" ${settings.llm_provider === "llamacpp" ? "hidden" : ""}>
              <span class="promptstudio-studio-setting-copy"><strong>LLM Profiles</strong><small>Model-specific thinking, sampler and request settings.</small></span>
              <span class="promptstudio-llm-profile-field">
                <select id="promptstudio-llm-profile" aria-label="LLM profile"></select>
                <button id="promptstudio-add-llm-profile" type="button">Add</button>
                <button id="promptstudio-edit-llm-profile" type="button">Edit</button>
              </span>
            </div>
            <label class="promptstudio-studio-setting promptstudio-endpoint-control" data-llm-provider="koboldcpp">
              <span class="promptstudio-studio-setting-copy"><strong>KoboldCpp endpoint</strong><small>Base URL for the local LLM processing server. Shared-GPU handoff requires KoboldCpp Admin Mode and an Admin Directory.</small></span>
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
                <button id="promptstudio-refresh-ollama-models" type="button" title="Refresh Ollama models" aria-label="Refresh Ollama models">↻</button>
              </span>
            </label>
            <label class="promptstudio-studio-setting promptstudio-endpoint-control" data-llm-provider="llamacpp">
              <span class="promptstudio-studio-setting-copy"><strong>Llama.cpp endpoint</strong><small>Prompt Studio connects to llama-server here. The usual local endpoint is http://127.0.0.1:8080.</small></span>
              <input id="promptstudio-llamacpp-url" type="url" inputmode="url" spellcheck="false" aria-label="Llama.cpp endpoint" />
            </label>
            <label class="promptstudio-studio-setting promptstudio-endpoint-control" data-llm-provider="llamacpp">
              <span class="promptstudio-studio-setting-copy"><strong>Llama.cpp model</strong><small>Select the model reported by llama-server. Router mode can expose multiple models.</small></span>
              <span class="promptstudio-ollama-model-field">
                <select id="promptstudio-llamacpp-model" aria-label="Llama.cpp model"></select>
                <button id="promptstudio-refresh-llamacpp-models" type="button" title="Refresh Llama.cpp models" aria-label="Refresh Llama.cpp models">↻</button>
              </span>
            </label>
            <label class="promptstudio-studio-setting promptstudio-endpoint-control" data-llm-provider="llamacpp">
              <span class="promptstudio-studio-setting-copy"><strong>Llama.cpp executable</strong><small>Absolute path to llama.exe or llama-server.exe. Process controls are local-only and manage only servers started by Prompt Studio.</small></span>
              <span class="promptstudio-path-field">
                <input id="promptstudio-llamacpp-executable" type="text" spellcheck="false" placeholder="C:\\path\\to\\llama.exe" aria-label="Llama.cpp executable path" />
                <button id="promptstudio-browse-llamacpp-executable" type="button">Browse…</button>
              </span>
            </label>
            <label class="promptstudio-studio-setting promptstudio-endpoint-control" data-llm-provider="llamacpp">
              <span class="promptstudio-studio-setting-copy"><strong>Llama.cpp config profile</strong><small>Profiles are stored in config/LlamaCPP. Select one, then press Restart in System status to apply it.</small></span>
              <span class="promptstudio-config-profile-field">
                <select id="promptstudio-llamacpp-config-profile" aria-label="Llama.cpp config profile"></select>
                <button id="promptstudio-refresh-llamacpp-configs" type="button" title="Refresh config profiles" aria-label="Refresh Llama.cpp config profiles">↻</button>
                <button id="promptstudio-build-llamacpp-config" type="button" title="Edit the selected profile in the Prompt Studio config builder">Edit…</button>
                <button id="promptstudio-new-llamacpp-config" type="button" title="Create a new profile with the Prompt Studio config builder">New…</button>
              </span>
            </label>
            <label class="promptstudio-studio-setting promptstudio-studio-setting-toggle" data-llm-provider="llamacpp">
              <span class="promptstudio-studio-setting-copy"><strong>Start with ComfyUI</strong><small>Automatically start this managed Llama.cpp executable and config profile when ComfyUI starts. External servers are never replaced.</small></span>
              <input id="promptstudio-llamacpp-autostart" type="checkbox" role="switch" ${settings.llamacpp_autostart ? "checked" : ""} />
            </label>
                </div>
              </section>
            </div>
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
        <section class="promptstudio-studio-settings-card promptstudio-mutation-config-card" aria-labelledby="promptstudio-mutation-settings-title">
          <header class="promptstudio-studio-settings-card-header">
            <div>
              <strong id="promptstudio-mutation-settings-title">Prompt Mutation Configuration</strong>
              <span>Manage the local language rules and personal presets used when Prompt Studio rewrites prompts.</span>
            </div>
          </header>
          <div class="promptstudio-mutation-launchers">
            <button type="button" data-mutation-category="protected_words">
              <span><strong>Protected words</strong><small>Preserve specific words and phrases during prompt rewriting.</small></span>
              <span class="promptstudio-mutation-launcher-meta"><output data-mutation-count="protected_words">Load to view</output><b>Manage ›</b></span>
            </button>
            <button type="button" data-mutation-category="additional_instruction_templates">
              <span><strong>Additional instruction templates</strong><small>Create reusable shortcuts for high-priority instructions.</small></span>
              <span class="promptstudio-mutation-launcher-meta"><output data-mutation-count="additional_instruction_templates">Load to view</output><b>Manage ›</b></span>
            </button>
            <button type="button" data-mutation-category="known_references">
              <span><strong>Known references</strong><small>Define reusable names for people, objects, poses, locations, and other concepts.</small></span>
              <span class="promptstudio-mutation-launcher-meta"><output data-mutation-count="known_references">Load to view</output><b>Manage ›</b></span>
            </button>
            <button type="button" data-mutation-category="additional_style_templates">
              <span><strong>Additional style presets</strong><small>Manage personal style guidance added to the built-in presets.</small></span>
              <span class="promptstudio-mutation-launcher-meta"><output data-mutation-count="additional_style_templates">Load to view</output><b>Manage ›</b></span>
            </button>
            <button type="button" data-mutation-category="additional_framing_templates">
              <span><strong>Additional framing presets</strong><small>Manage personal composition and camera-framing guidance.</small></span>
              <span class="promptstudio-mutation-launcher-meta"><output data-mutation-count="additional_framing_templates">Load to view</output><b>Manage ›</b></span>
            </button>
          </div>
        </section>
      </div>
      <section id="promptstudio-mutation-manager" class="promptstudio-mutation-manager" aria-labelledby="promptstudio-mutation-manager-title" hidden>
        <header class="promptstudio-mutation-manager-header">
          <button id="promptstudio-mutation-back" type="button" class="promptstudio-mutation-back">‹ Settings</button>
          <div><strong id="promptstudio-mutation-manager-title"></strong><span id="promptstudio-mutation-manager-description"></span></div>
          <button id="promptstudio-mutation-add" type="button"></button>
        </header>
        <div id="promptstudio-mutation-manager-banner" class="promptstudio-mutation-manager-banner" role="status" hidden>
          <span></span><button type="button" hidden></button>
        </div>
        <div class="promptstudio-mutation-toolbar">
          <label><span class="promptstudio-sr-only">Search configuration</span><input id="promptstudio-mutation-search" type="search" placeholder="Search" autocomplete="off" /></label>
          <output id="promptstudio-mutation-manager-count"></output>
        </div>
        <div id="promptstudio-mutation-list" class="promptstudio-mutation-list"></div>
        <div id="promptstudio-mutation-editor" class="promptstudio-mutation-editor" role="dialog" aria-modal="true" aria-labelledby="promptstudio-mutation-editor-title" hidden>
          <form class="promptstudio-mutation-editor-card">
            <header><div><strong id="promptstudio-mutation-editor-title"></strong><span>Changes are saved to the corresponding local configuration file.</span></div><button id="promptstudio-mutation-editor-close" type="button" aria-label="Close editor">×</button></header>
            <div class="promptstudio-mutation-editor-fields">
              <p id="promptstudio-mutation-editor-help" class="promptstudio-mutation-editor-help"></p>
              <label id="promptstudio-mutation-editor-name-row"><span id="promptstudio-mutation-editor-name-label">Name</span><input id="promptstudio-mutation-editor-name" type="text" autocomplete="off" required /></label>
              <label id="promptstudio-mutation-editor-text-row"><span id="promptstudio-mutation-editor-text-label"></span><textarea id="promptstudio-mutation-editor-text" rows="8" maxlength="20000" required></textarea></label>
              <label id="promptstudio-mutation-editor-enabled-row" class="promptstudio-mutation-editor-enabled"><span><strong>Enabled</strong><small>Disabled entries remain stored and visible but are not used for prompt mutation.</small></span><input id="promptstudio-mutation-editor-enabled" type="checkbox" role="switch" checked /></label>
              <p id="promptstudio-mutation-editor-error" class="promptstudio-mutation-editor-error" role="alert"></p>
            </div>
            <footer><button id="promptstudio-mutation-editor-cancel" type="button">Cancel</button><button type="submit">Save</button></footer>
          </form>
        </div>
      </section>
      <div id="promptstudio-llm-profile-editor" class="promptstudio-llm-profile-editor" role="dialog" aria-modal="true" aria-labelledby="promptstudio-llm-profile-editor-title" hidden>
        <form class="promptstudio-llm-profile-editor-card">
          <header>
            <div><strong id="promptstudio-llm-profile-editor-title">Edit LLM profile</strong><span>These settings are used for prompt rewriting, local model chat, and Prompt Agent.</span></div>
            <button id="promptstudio-llm-profile-editor-close" type="button" aria-label="Close editor">×</button>
          </header>
          <div class="promptstudio-llm-profile-editor-fields">
            <p class="promptstudio-llm-profile-warning"><strong>Advanced settings</strong><span>Only change these parameters if you understand how they affect your model. Incorrect sampler, token, or timeout values can reduce output quality or cause requests to fail.</span></p>
            <label class="promptstudio-llm-profile-name"><span>Profile name</span><input name="name" type="text" maxlength="80" autocomplete="off" required /></label>
            <section class="promptstudio-llm-profile-parameter-group">
              <div class="promptstudio-llm-profile-parameter-heading"><strong>Request settings</strong><span>Shared by the thinking and non-thinking samplers.</span></div>
              <div class="promptstudio-llm-profile-parameter-grid">
                <label title="Maximum final-answer tokens. Use 0 for the request-specific automatic limit."><span>Response tokens</span><input name="max_response_tokens" type="number" min="0" max="8192" step="1" required /></label>
                <label title="Llama.cpp only. Use 0 for model-controlled reasoning. A positive value forcibly ends thinking after this many tokens and can reduce answer quality."><span>Llama.cpp reasoning cap</span><input name="llamacpp_reasoning_budget_tokens" type="number" min="0" max="262144" step="1" required /></label>
                <label title="Use -1 to let the provider choose a random seed."><span>Sampler seed</span><input name="sampler_seed" type="number" min="-1" max="999999" step="1" required /></label>
                <label><span>Request timeout (seconds)</span><input name="request_timeout" type="number" min="5" max="600" step="1" required /></label>
              </div>
            </section>
            <section class="promptstudio-llm-profile-parameter-group">
              <div class="promptstudio-llm-profile-parameter-heading"><strong>Available thinking modes</strong><span>Only enabled modes appear in Generation controls.</span></div>
              <div class="promptstudio-llm-profile-thinking-modes">
                ${LLM_THINKING_MODE_OPTIONS.map((mode) => `<label><input name="thinking_modes" type="checkbox" value="${mode}" /><span>${mode}</span></label>`).join("")}
              </div>
            </section>
            <section class="promptstudio-llm-profile-parameter-group">
              <div class="promptstudio-llm-profile-parameter-heading"><strong>Non-thinking sampler</strong><span>Used when Thinking is Disabled.</span></div>
              <div class="promptstudio-llm-profile-parameter-grid">
                <label><span>Temperature</span><input name="temperature" type="number" min="0" max="5" step="0.05" required /></label>
                <label><span>Top P</span><input name="top_p" type="number" min="0" max="1" step="0.01" required /></label>
                <label><span>Top K</span><input name="top_k" type="number" min="0" max="200" step="1" required /></label>
                <label><span>Min P</span><input name="min_p" type="number" min="0" max="1" step="0.01" required /></label>
                <label><span>Presence penalty</span><input name="presence_penalty" type="number" min="-2" max="2" step="0.05" required /></label>
                <label><span>Repeat penalty</span><input name="rep_pen" type="number" min="0.5" max="3" step="0.01" required /></label>
                <label><span>Repeat range</span><input name="rep_pen_range" type="number" min="0" max="4096" step="1" required /></label>
              </div>
            </section>
            <section class="promptstudio-llm-profile-parameter-group">
              <div class="promptstudio-llm-profile-parameter-heading"><strong>Thinking sampler</strong><span>Used by every available mode except Disabled.</span></div>
              <div class="promptstudio-llm-profile-parameter-grid">
                <label><span>Temperature</span><input name="thinking_temperature" type="number" min="0" max="5" step="0.05" required /></label>
                <label><span>Top P</span><input name="thinking_top_p" type="number" min="0" max="1" step="0.01" required /></label>
                <label><span>Top K</span><input name="thinking_top_k" type="number" min="0" max="200" step="1" required /></label>
                <label><span>Min P</span><input name="thinking_min_p" type="number" min="0" max="1" step="0.01" required /></label>
                <label><span>Presence penalty</span><input name="thinking_presence_penalty" type="number" min="-2" max="2" step="0.05" required /></label>
                <label><span>Repeat penalty</span><input name="thinking_rep_pen" type="number" min="0.5" max="3" step="0.01" required /></label>
                <label><span>Repeat range</span><input name="thinking_rep_pen_range" type="number" min="0" max="4096" step="1" required /></label>
              </div>
            </section>
            <label class="promptstudio-llm-profile-stop"><span>Custom stop sequences <small>One per line; leave empty for provider defaults.</small></span><textarea name="stop_sequence" rows="3" maxlength="4096"></textarea></label>
            <p id="promptstudio-llm-profile-editor-error" class="promptstudio-llm-profile-editor-error" role="alert"></p>
          </div>
          <footer>
            <button id="promptstudio-delete-llm-profile" class="promptstudio-danger" type="button">Delete profile</button>
            <span></span>
            <button id="promptstudio-restore-llm-profile" type="button">Restore defaults</button>
            <button id="promptstudio-llm-profile-editor-cancel" type="button">Cancel</button>
            <button type="submit">Save</button>
          </footer>
        </form>
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
          <strong>Generation settings</strong>
          <span>Shared by model chat, prompt rewriting, and Prompt Agent</span>
        </div>
        <div class="promptstudio-consult-profile-card">
          <span><strong id="promptstudio-consult-profile-name">Default</strong><small id="promptstudio-consult-profile-summary">Temperature 0.7 · top p 0.9</small></span>
          <button id="promptstudio-consult-edit-llm-profile" type="button">Edit profile</button>
        </div>
        <select id="promptstudio-consult-thinking" aria-hidden="true" hidden><option value="${consultSettings.thinking_mode}">${consultSettings.thinking_mode}</option></select>
        <input id="promptstudio-consult-max-tokens" type="hidden" value="${consultSettings.max_response_tokens}" />
        <input id="promptstudio-consult-temperature" type="hidden" value="${consultSettings.temperature}" />
        <input id="promptstudio-consult-top-p" type="hidden" value="${consultSettings.top_p}" />
        <input id="promptstudio-consult-top-k" type="hidden" value="${consultSettings.top_k}" />
        <input id="promptstudio-consult-min-p" type="hidden" value="${consultSettings.min_p}" />
        <input id="promptstudio-consult-presence-penalty" type="hidden" value="${consultSettings.presence_penalty}" />
        <input id="promptstudio-consult-rep-pen" type="hidden" value="${consultSettings.rep_pen}" />
        <input id="promptstudio-consult-rep-pen-range" type="hidden" value="${consultSettings.rep_pen_range}" />
        <input id="promptstudio-consult-seed" type="hidden" value="${consultSettings.sampler_seed}" />
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
          <textarea id="promptstudio-consult-input" rows="3" aria-label="Local model message" placeholder="Ask your local model… Paste screenshots with Ctrl+V."></textarea>
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
    <div id="promptstudio-video-handoff-dialog" class="promptstudio-video-handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="promptstudio-video-handoff-title" aria-describedby="promptstudio-video-handoff-message" hidden>
      <div class="promptstudio-video-handoff-card">
        <strong id="promptstudio-video-handoff-title">Add image to Video Studio</strong>
        <p id="promptstudio-video-handoff-message">The current session "<span id="promptstudio-video-handoff-project-name"></span>" already contains work. Where should this image go?</p>
        <div class="promptstudio-video-handoff-dialog-actions">
          <button id="promptstudio-video-handoff-cancel" type="button">Cancel</button>
          <button id="promptstudio-video-handoff-new" type="button">Brand new session</button>
          <button id="promptstudio-video-handoff-current" class="promptstudio-primary" type="button">Current session</button>
        </div>
      </div>
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
  installSidebarGroupReordering(panel);
  DISCONNECTED_ALLOWED_CONTROL_IDS.forEach((id) => {
    panel.querySelector(`#${id}`)?.setAttribute("data-promptstudio-allow-disconnected", "true");
  });
  panel.querySelector(".promptstudio-mobile-scrim")?.setAttribute("data-promptstudio-allow-disconnected", "true");
  installTypeAnywhereFocus(panel.ownerDocument);
  const history = panel.querySelector("#promptstudio-history");
  const consultHistory = panel.querySelector("#promptstudio-consult-history");
  history.addEventListener("scroll", () => {
    state.historyWasNearEnd = historyIsNearEnd(history);
  }, { passive: true });
  consultHistory.addEventListener("scroll", () => {
    state.consultHistoryWasNearEnd = historyIsNearEnd(consultHistory);
  }, { passive: true });
  const compose = panel.querySelector(".promptstudio-compose");
  const mainDropTargets = [history, compose];
  const imageImport = panel.querySelector("#promptstudio-image-import");
  const carriesFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
  const showMainChatDropState = () => {
    const mode = mainChatImageDropMode();
    mainDropTargets.forEach((target) => {
      target.dataset.dragActive = mode === "import" ? "true" : mode;
    });
    return mode;
  };
  mainDropTargets.forEach((target) => {
    target.addEventListener("dragenter", (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      state.dragDepth += 1;
      showMainChatDropState();
    });
    target.addEventListener("dragover", (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      const mode = showMainChatDropState();
      if (event.dataTransfer) event.dataTransfer.dropEffect = mode === "refused" ? "none" : "copy";
    });
    target.addEventListener("dragleave", () => {
      if (!state.dragDepth) return;
      state.dragDepth = Math.max(0, state.dragDepth - 1);
      if (!state.dragDepth) {
        mainDropTargets.forEach((dropTarget) => {
          dropTarget.dataset.dragActive = "false";
        });
      }
    });
    target.addEventListener("drop", (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      state.dragDepth = 0;
      mainDropTargets.forEach((dropTarget) => {
        dropTarget.dataset.dragActive = "false";
      });
      const mode = mainChatImageDropMode();
      if (mode === "import") return importSelectedImageFiles(event.dataTransfer?.files);
      if (mode === "reference") return dropMainReferenceFiles(event.dataTransfer?.files);
      setStatus("Start the chat before dropping a visual reference.", "warning");
    });
  });
  imageImport.addEventListener("change", () => {
    importSelectedImageFiles(imageImport.files);
    imageImport.value = "";
  });

  renderLlmProfileOptions(settings.llm_profile);
  syncLlmProfileControls();
  panel.querySelector("#promptstudio-kobold-url").value = settings.kobold_url;
  panel.querySelector("#promptstudio-ollama-url").value = settings.ollama_url;
  panel.querySelector("#promptstudio-llamacpp-url").value = settings.llamacpp_url;
  panel.querySelector("#promptstudio-llamacpp-executable").value = settings.llamacpp_executable;
  if (settings.llamacpp_config_profile) {
    panel.querySelector("#promptstudio-llamacpp-config-profile").appendChild(
      new Option(settings.llamacpp_config_profile, settings.llamacpp_config_profile),
    );
  }
  loadLlamacppConfigProfiles({ announce: false, preferred: settings.llamacpp_config_profile });
  if (settings.ollama_model) {
    const option = document.createElement("option");
    option.value = settings.ollama_model;
    option.textContent = settings.ollama_model;
    panel.querySelector("#promptstudio-ollama-model").appendChild(option);
  }
  if (settings.llamacpp_model) {
    const option = document.createElement("option");
    option.value = settings.llamacpp_model;
    option.textContent = settings.llamacpp_model;
    panel.querySelector("#promptstudio-llamacpp-model").appendChild(option);
  }
  panel.querySelector("#promptstudio-output-length").value = settings.target_output_length;
  panel.querySelector("#promptstudio-output-length").dataset.custom = String(Boolean(settings.output_length_custom));
  panel.querySelector("#promptstudio-temperature").value = settings.temperature;
  panel.querySelector("#promptstudio-style-modifier").value = settings.style_modifier;
  panel.querySelector("#promptstudio-framing-modifier").value = settings.framing_modifier;
  panel.querySelector("#promptstudio-additional-instructions").value = settings.additional_instructions;
  panel.querySelector("#promptstudio-secondary-instructions").value = settings.secondary_instructions;
  panel.querySelector("#promptstudio-resolution-aspect-ratio").value = RESOLUTION_ASPECT_RATIOS.includes(settings.resolution_aspect_ratio)
    ? settings.resolution_aspect_ratio
    : RESOLUTION_ASPECT_RATIOS[0];
  panel.querySelector("#promptstudio-resolution-megapixels").value = String(Math.max(0.1, Math.min(16, Number(settings.resolution_megapixels) || 1)));
  panel.querySelector("#promptstudio-resolution-multiple").value = String(Math.max(8, Math.min(128, Math.round((Number(settings.resolution_multiple) || 8) / 4) * 4)));
  applyImageScale(settings.image_scale);
  syncOutputLengthControl({ storedSettings: settings });
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
  panel.querySelector("#promptstudio-close-studio-settings").addEventListener("click", () => {
    toggleStudioSettings(false);
    panel.querySelector("#promptstudio-toggle-studio-settings")?.focus({ preventScroll: true });
  });
  panel.querySelector("#promptstudio-llm-profile").addEventListener("change", (event) => {
    renderLlmProfileOptions(event.target.value);
    renderLlmThinkingModeOptions(selectedLlmProfile().thinking_mode);
    syncLlmProfileControls();
    syncLlmProviderControls();
    saveSettings();
    markControlsChanged();
  });
  panel.querySelector("#promptstudio-add-llm-profile").addEventListener("click", (event) => {
    openLlmProfileEditor(event.currentTarget, { create: true });
  });
  panel.querySelector("#promptstudio-edit-llm-profile").addEventListener("click", (event) => {
    openLlmProfileEditor(event.currentTarget);
  });
  panel.querySelector("#promptstudio-consult-edit-llm-profile").addEventListener("click", (event) => {
    toggleStudioSettings(true);
    if (selectedLlmProvider() === "llamacpp") {
      openLlamacppConfigBuilder();
    } else {
      openLlmProfileEditor(event.currentTarget);
    }
  });
  panel.querySelector("#promptstudio-llm-profile-editor form").addEventListener("submit", submitLlmProfileEditor);
  panel.querySelector("#promptstudio-llm-profile-editor-close").addEventListener("click", () => closeLlmProfileEditor());
  panel.querySelector("#promptstudio-llm-profile-editor-cancel").addEventListener("click", () => closeLlmProfileEditor());
  panel.querySelector("#promptstudio-restore-llm-profile").addEventListener("click", restoreLlmProfileEditorDefaults);
  panel.querySelector("#promptstudio-delete-llm-profile").addEventListener("click", deleteLlmProfile);
  panel.querySelector("#promptstudio-llm-profile-editor").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeLlmProfileEditor();
  });
  panel.querySelector("#promptstudio-llm-profile-editor").addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeLlmProfileEditor();
    }
  });
  panel.querySelectorAll("[data-mutation-category]").forEach((button) => {
    button.addEventListener("click", () => openMutationManager(button.dataset.mutationCategory, button));
  });
  panel.querySelector("#promptstudio-mutation-back").addEventListener("click", () => closeMutationManager());
  panel.querySelector("#promptstudio-mutation-add").addEventListener("click", () => openMutationEditor());
  panel.querySelector("#promptstudio-mutation-search").addEventListener("input", renderMutationManager);
  panel.querySelector("#promptstudio-mutation-list").addEventListener("click", handleMutationListAction);
  panel.querySelector("#promptstudio-mutation-manager-banner button").addEventListener("click", () => {
    if (state.mutationConfigPending) {
      closeMutationEditor({ restoreFocus: false });
      return;
    }
    loadMutationConfig({ conditional: false, external: true });
  });
  panel.querySelector("#promptstudio-mutation-editor form").addEventListener("submit", submitMutationEditor);
  panel.querySelector("#promptstudio-mutation-editor form").addEventListener("input", () => {
    state.mutationEditorDirty = true;
  });
  panel.querySelector("#promptstudio-mutation-editor-close").addEventListener("click", () => closeMutationEditor());
  panel.querySelector("#promptstudio-mutation-editor-cancel").addEventListener("click", () => closeMutationEditor());
  panel.querySelector("#promptstudio-mutation-editor").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeMutationEditor();
  });
  panel.querySelector("#promptstudio-mutation-editor").addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMutationEditor();
    }
  });
  panel.querySelector("#promptstudio-mutation-manager").addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !mutationEditorIsOpen()) {
      event.preventDefault();
      event.stopPropagation();
      closeMutationManager();
    }
  });
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
  [...panel.querySelectorAll(".promptstudio-consult-generation-settings input, .promptstudio-consult-generation-settings select")]
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
  panel.querySelector("#promptstudio-video-handoff-dialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) settleVideoHandoffChoice();
  });
  panel.querySelector("#promptstudio-video-handoff-dialog").addEventListener("keydown", (event) => {
    if (event.key === "Escape") settleVideoHandoffChoice();
  });
  panel.querySelector("#promptstudio-video-handoff-cancel").addEventListener("click", () => settleVideoHandoffChoice());
  panel.querySelector("#promptstudio-video-handoff-new").addEventListener("click", () => settleVideoHandoffChoice("new"));
  panel.querySelector("#promptstudio-video-handoff-current").addEventListener("click", () => settleVideoHandoffChoice("current"));
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
  panel.querySelector("#promptstudio-kobold-stop").addEventListener("click", stopLlmGeneration);
  panel.querySelector("#promptstudio-llamacpp-start").addEventListener("click", () => controlLlamacppServer("start"));
  panel.querySelector("#promptstudio-llamacpp-server-stop").addEventListener("click", () => controlLlamacppServer("stop"));
  panel.querySelector("#promptstudio-llamacpp-restart").addEventListener("click", () => controlLlamacppServer("restart"));
  panel.querySelector("#promptstudio-comfy-update").addEventListener("click", updateComfyUIFromStatus);
  panel.querySelector("#promptstudio-comfy-restart").addEventListener("click", restartComfyUIFromStatus);
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
  panel.querySelector("#promptstudio-llm-provider").addEventListener("change", handleLlmProviderChange);
  panel.querySelector("#promptstudio-keep-models-loaded").addEventListener("change", () => {
    saveSettings();
    updateLlmHandoffStatus();
    refreshLlmStatus();
  });
  panel.querySelector("#promptstudio-refresh-ollama-models").addEventListener("click", () => loadOllamaModels({ announce: true }));
  panel.querySelector("#promptstudio-ollama-url").addEventListener("change", () => {
    saveSettings();
    if (selectedLlmProvider() === "ollama") loadOllamaModels({ announce: true });
    refreshLlmStatus();
    if (!panel.querySelector("#promptstudio-consult").hidden) refreshConsultVisionCapability();
  });
  panel.querySelector("#promptstudio-ollama-model").addEventListener("change", () => {
    markControlsChanged();
    refreshLlmStatus();
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
  panel.querySelector("#promptstudio-send").addEventListener("click", () => handleStudioTurn());
  panel.querySelector("#promptstudio-reroll").addEventListener("click", () => reroll());
  panel.querySelector("#promptstudio-undo").addEventListener("click", undoPrompt);
  panel.querySelector("#promptstudio-stop").addEventListener("click", interrupt);
  panel.querySelector("#promptstudio-use-llm-amplification").addEventListener("change", () => updateAmplificationMode());
  panel.querySelector("#promptstudio-output-length").addEventListener("input", (event) => {
    event.target.dataset.custom = "true";
    syncOutputLengthControl();
  });
  panel.querySelector("#promptstudio-output-length").addEventListener("change", (event) => {
    event.target.dataset.custom = "true";
    syncOutputLengthControl();
  });
  ["promptstudio-profile", "promptstudio-embellishment"].forEach((id) => {
    panel.querySelector(`#${id}`).addEventListener("change", () => {
      syncOutputLengthControl({ resetToDefault: true });
    });
  });
  panel.querySelector("#promptstudio-secondary-instructions").addEventListener("change", saveSettings);
  panel.querySelector("#promptstudio-additional-instructions").addEventListener("input", renderAdditionalInstructionTemplateHighlights);
  panel.querySelector("#promptstudio-additional-instructions").addEventListener("scroll", renderAdditionalInstructionTemplateHighlights);
  panel.querySelector("#promptstudio-additional-instructions").addEventListener("change", markControlsChanged);
  panel.querySelector("#promptstudio-thinking").addEventListener("change", () => {
    syncLlmProfileControls();
    saveConsultSettings();
  });
  panel.querySelector("#promptstudio-refresh-llamacpp-models").addEventListener("click", () => loadLlamacppModels({ announce: true }));
  panel.querySelector("#promptstudio-llamacpp-url").addEventListener("change", () => {
    saveSettings();
    if (selectedLlmProvider() === "llamacpp") loadLlamacppModels({ announce: true });
    refreshLlmStatus();
    if (!panel.querySelector("#promptstudio-consult").hidden) refreshConsultVisionCapability();
  });
  panel.querySelector("#promptstudio-llamacpp-model").addEventListener("change", () => {
    markControlsChanged();
    refreshLlmStatus();
    if (!panel.querySelector("#promptstudio-consult").hidden) refreshConsultVisionCapability();
  });
  panel.querySelector("#promptstudio-open-backend-settings").addEventListener("click", openBackendSettings);
  panel.querySelector("#promptstudio-close-backend-settings").addEventListener("click", () => closeBackendSettings());
  panel.querySelector("#promptstudio-backend-settings-dialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeBackendSettings();
  });
  panel.querySelector("#promptstudio-backend-settings-dialog").addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeBackendSettings();
  });
  panel.querySelector("#promptstudio-llamacpp-executable").addEventListener("change", () => {
    saveSettings();
    if (state.llamacppAutostartEnabled) saveLlamacppAutostartPreference();
    refreshLlmStatus();
  });
  panel.querySelector("#promptstudio-llamacpp-config-profile").addEventListener("change", (event) => {
    saveSettings();
    if (state.llamacppAutostartEnabled) saveLlamacppAutostartPreference();
    refreshLlmStatus();
    loadLlamacppConfigProfiles({ preferred: event.target.value });
  });
  panel.querySelector("#promptstudio-llamacpp-autostart").addEventListener("change", () => {
    saveSettings();
    saveLlamacppAutostartPreference({ announce: true });
  });
  panel.querySelector("#promptstudio-refresh-llamacpp-configs").addEventListener("click", () => {
    loadLlamacppConfigProfiles({ announce: true });
  });
  panel.querySelector("#promptstudio-browse-llamacpp-executable").addEventListener("click", () => browseLlamacppPath("executable"));
  panel.querySelector("#promptstudio-build-llamacpp-config").addEventListener("click", () => openLlamacppConfigBuilder());
  panel.querySelector("#promptstudio-new-llamacpp-config").addEventListener("click", () => openLlamacppConfigBuilder({ createNew: true }));
  panel.querySelector("#promptstudio-main-prompt").addEventListener("input", (event) => {
    syncMainPromptEditor(event.target.value, { userEdit: true });
  });
  panel.querySelector("#promptstudio-main-prompt").addEventListener("scroll", renderKnownReferenceHighlights);
  if ("ResizeObserver" in window) {
    new ResizeObserver(renderKnownReferenceHighlights).observe(panel.querySelector("#promptstudio-main-prompt"));
    new ResizeObserver(renderAdditionalInstructionTemplateHighlights)
      .observe(panel.querySelector("#promptstudio-additional-instructions"));
  }
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
      handleStudioTurn();
    }
  });
  panel.querySelector("#promptstudio-pasted-image button").addEventListener("click", () => {
    clearMainPastedImage();
    setStatus("Pasted reference removed.", "ready");
  });
  panel.querySelector("#promptstudio-discussion-context button").addEventListener("click", () => {
    cancelStudioDiscussion();
  });
  panel.querySelectorAll(".promptstudio-settings input, .promptstudio-settings select, .promptstudio-settings textarea")
    .forEach((element) => element.addEventListener("change", markControlsChanged));
  RENDER_CONTROL_IDS.forEach((id) => {
    panel.querySelector(`#${id}`)?.addEventListener("input", refreshStudioStatus);
  });
  panel.querySelector("#promptstudio-kobold-url").addEventListener("change", () => {
    markControlsChanged();
    refreshLlmStatus();
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
  toggleStudioSettings(false);
  closeSystemStatus();
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
  const mount = popup.document.querySelector("#promptstudio-image-mount")
    || popup.document.querySelector("#promptstudio-popout-mount");
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
  // beforeunload fires before the browser's leave-page confirmation. Moving the
  // panel there would empty a popup whose navigation is subsequently cancelled.
  popup.addEventListener("pagehide", () => {
    if (!state.dockingPopup && state.popup === popup) {
      dockPanel({ closePopup: false, keepOpen: state.returnToEmbedded });
    }
  }, { once: true });
  await togglePanel(true);
  return true;
}

function setupStandaloneBridge() {
  globalThis.__promptstudioPromptStudioHost = {
    attach: attachStandalone,
    setStandaloneVisibility(visible) {
      if (state.panel?.ownerDocument !== state.popup?.document) return;
      if (!visible) {
        toggleConsult(false);
        toggleStudioSettings(false);
        closeSystemStatus();
        closePanelDrawers();
      }
      state.panel.hidden = !visible;
    },
  };
  if (typeof BroadcastChannel !== "function") return;
  state.standaloneChannel?.close();
  const channel = new BroadcastChannel(STANDALONE_CHANNEL);
  state.standaloneChannel = channel;
  channel.addEventListener("message", async (event) => {
    const data = event.data;
    if (!data?.windowName || !data.requestId) return;
    const popup = state.popup;
    if (!popup || popup.closed) return;
    try {
      if (popup.name !== data.windowName) return;
    } catch (_) {
      return;
    }
    if (data.type === "attach-video") {
      const attached = Boolean(await globalThis.__promptstudioVideoStudioHost?.attach?.(popup, { unified: true }));
      channel.postMessage({ type: "video-attached", requestId: data.requestId, attached });
      return;
    }
    if (data.type !== "connect") return;
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
  const history = state.panel.querySelector("#promptstudio-history");
  if (!show && history) state.historyWasNearEnd = historyIsNearEnd(history);
  if (!show) {
    commitPromptEditorVersion();
    closeImageLightbox();
    toggleConsult(false);
    toggleStudioSettings(false);
    closeSystemStatus();
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
    return;
  }
  refreshStudioStatus();
  if (history && state.historyWasNearEnd) scrollHistoryToEnd({ instant: true });
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
    startLlmStatusMonitor();
    api.addEventListener("cm-queue-status", handleManagerQueueStatus);
    api.addEventListener("cm-task-started", handleManagerTaskStarted);
    api.addEventListener("cm-task-completed", handleManagerTaskCompleted);
    setupApiConnectionState();
    setupGenerationProgressEvents();
    setupWorkflowSync();
    installWorkflowSaveObserver();
    await loadChats();
    setupChatSync();
    resumeConsultJobs();
    resumeSyncedGeneration();
    try {
      await loadWorkflowProfiles();
    } catch (error) {
      setStatus(error.message || String(error), "warning");
    }
    resumeSyncedGeneration();
    buildLauncher();
    refreshWorkflowControls();
    refreshStudioStatus();
    setupStandaloneBridge();
    setupVideoStudioBridge();
  },
});
