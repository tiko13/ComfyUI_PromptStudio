import { normalizeReferenceGrounding, normalizeReferenceClarification } from "../generation/reference-grounding.js";
import {
  AMPLIFY_TYPE,
  RENDER_CONTROL_SETTINGS,
  RESOLUTION_ASPECT_RATIOS,
  SETTINGS_DEFAULTS,
  SLOT_TYPE,
  STUDIO_SETTINGS_VERSION,
} from "../core/constants.js";
import { makeId } from "../core/id.js";
import {
  normalizeGenerationLoraState,
  normalizeGenerationModelState,
  normalizeGenerationSnapshot,
  normalizeLastGeneration,
  normalizeLoraStack,
  normalizePendingGeneration,
} from "./generation-state.js";
import { cleanModelName } from "../generation/model-name.js";
import { normalizeImageReference } from "./image-reference.js";
import {
  consultMessagesAfterClear,
  normalizeConsultAgent,
  normalizeConsultExperiment,
  normalizeConsultMessage,
  retainedConsultMessages,
} from "../consult/model.js";
import { getSettings } from "../settings/storage.js";
import { normalizePromptStudioInputSelections } from "../generation/prompt-studio-input.js";
import { normalizeIntentProvenance } from "./intent-provenance.js";

export function createChatModel({
  getDefaultLoraSelections,
  getDefaultModelSelections,
  loraSelectionKey,
  modelSelectionKey,
  normalizeLlmProvider,
  normalizePromptVersion,
  promptVersion,
}) {
function normalizeSessionLoraSelections(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, selections]) => [String(key), normalizeLoraStack(selections)])
      .filter(([key, selections]) => key && selections.length),
  );
}

function normalizeSessionModelSelections(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, modelName]) => [String(key), cleanModelName(modelName)])
      .filter(([key, modelName]) => key && modelName),
  );
}

function normalizeStudioSettings(value, fallback = getSettings()) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const base = { ...SETTINGS_DEFAULTS, ...(fallback || {}) };
  const text = (key) => String(source[key] ?? base[key] ?? "");
  const requiredText = (key) => (
    String(source[key] ?? "").trim()
    || String(base[key] ?? "").trim()
    || String(SETTINGS_DEFAULTS[key] ?? "")
  );
  const checked = (key) => source[key] == null ? Boolean(base[key]) : Boolean(source[key]);
  const object = (key) => {
    const requested = source[key] ?? base[key];
    return requested && typeof requested === "object" && !Array.isArray(requested)
      ? { ...requested, thinking_modes: Array.isArray(requested.thinking_modes) ? [...requested.thinking_modes] : undefined }
      : null;
  };
  const numeric = (key, minimum, maximum) => {
    const requested = Number(source[key] ?? base[key]);
    const fallbackValue = Number(SETTINGS_DEFAULTS[key]);
    return Math.max(minimum, Math.min(maximum, Number.isFinite(requested) ? requested : fallbackValue));
  };
  return {
    version: STUDIO_SETTINGS_VERSION,
    llm_provider: normalizeLlmProvider(text("llm_provider")),
    llm_profile: requiredText("llm_profile"),
    kobold_url: text("kobold_url"),
    ollama_url: text("ollama_url"),
    ollama_model: text("ollama_model"),
    llamacpp_url: text("llamacpp_url"),
    llamacpp_model: text("llamacpp_model"),
    llamacpp_executable: text("llamacpp_executable"),
    llamacpp_config_profile: text("llamacpp_config_profile"),
    llamacpp_generation_settings: object("llamacpp_generation_settings"),
    llamacpp_autostart: checked("llamacpp_autostart"),
    keep_models_loaded: checked("keep_models_loaded"),
    model_profile: requiredText("model_profile"),
    style_preset: requiredText("style_preset"),
    framing_preset: requiredText("framing_preset"),
    style_modifier: text("style_modifier"),
    framing_modifier: text("framing_modifier"),
    thinking_mode: requiredText("thinking_mode"),
    embellishment_level: requiredText("embellishment_level"),
    target_output_length: numeric("target_output_length", 1, 10000),
    output_length_custom: checked("output_length_custom"),
    temperature: numeric("temperature", 0, 5),
    additional_instructions: text("additional_instructions"),
    secondary_instructions: text("secondary_instructions"),
    use_llm_amplification: checked("use_llm_amplification"),
    use_prompt_upscaling: checked("use_prompt_upscaling"),
    randomize_seed: checked("randomize_seed"),
    auto_generate: checked("auto_generate"),
    auto_advance_source: checked("auto_advance_source"),
    use_latest_image_context: checked("use_latest_image_context"),
    image_scale: numeric("image_scale", 10, 100),
    resolution_aspect_ratio: RESOLUTION_ASPECT_RATIOS.includes(text("resolution_aspect_ratio"))
      ? text("resolution_aspect_ratio")
      : SETTINGS_DEFAULTS.resolution_aspect_ratio,
    resolution_megapixels: numeric("resolution_megapixels", 0.1, 16),
    resolution_multiple: numeric("resolution_multiple", 8, 128),
    generation_action: source.generation_action === "edit" ? "edit" : "create",
    lora_selections: normalizeSessionLoraSelections(source.lora_selections),
    model_selections: normalizeSessionModelSelections(source.model_selections),
    additional_input_selections: normalizePromptStudioInputSelections(source.additional_input_selections),
  };
}

function newChatStudioSettings(value = getSettings()) {
  const previous = normalizeStudioSettings(value);
  return normalizeStudioSettings({
    ...SETTINGS_DEFAULTS,
    // Keep application-level preferences across chats, but start prompt and
    // generation shaping from a clean slate. Thinking and embellishment are
    // the only generation controls intentionally carried into a new chat.
    llm_provider: previous.llm_provider,
    llm_profile: previous.llm_profile,
    kobold_url: previous.kobold_url,
    ollama_url: previous.ollama_url,
    ollama_model: previous.ollama_model,
    llamacpp_url: previous.llamacpp_url,
    llamacpp_model: previous.llamacpp_model,
    llamacpp_executable: previous.llamacpp_executable,
    llamacpp_config_profile: previous.llamacpp_config_profile,
    llamacpp_generation_settings: previous.llamacpp_generation_settings,
    llamacpp_autostart: previous.llamacpp_autostart,
    keep_models_loaded: previous.keep_models_loaded,
    thinking_mode: previous.thinking_mode,
    embellishment_level: previous.embellishment_level,
    use_llm_amplification: previous.use_llm_amplification,
    use_prompt_upscaling: previous.use_prompt_upscaling,
    randomize_seed: previous.randomize_seed,
    auto_generate: previous.auto_generate,
    auto_advance_source: previous.auto_advance_source,
    use_latest_image_context: previous.use_latest_image_context,
    image_scale: previous.image_scale,
    generation_action: "create",
    lora_selections: previous.lora_selections,
    model_selections: previous.model_selections,
    additional_input_selections: previous.additional_input_selections,
  }, SETTINGS_DEFAULTS);
}

function isEmptyChat(chat) {
  if (!chat || chat.initialized) return false;
  if (chat.sessionMode === "plot" || chat.plotId) return false;
  const prompts = [
    chat.mainPrompt,
    chat.renderedMainPrompt,
    chat.finalPrompt,
    chat.renderedFinalPrompt,
    chat.currentPrompt,
  ];
  if (prompts.some((value) => String(value || "").trim())) return false;
  if ((chat.versions || []).some((version) => (
    String(version?.mainPrompt || "").trim()
    || String(version?.finalPrompt || "").trim()
  ))) return false;
  return !(chat.messages || []).length
    && !(chat.consultMessages || []).length
    && !Number(chat.consultClearedAt || 0)
    && !chat.selectedSource
    && !chat.editReferenceImage
    && !chat.lastGeneration
    && !chat.pendingGeneration
    && !chat.consultPendingJob
    && !chat.consultExperiment
    && !chat.consultAgent
    && !chat.studioDiscussion;
}

function deduplicateEmptyChats(chats, preferredChatId = "") {
  const emptyChats = chats.filter(isEmptyChat);
  if (emptyChats.length <= 1) return chats;
  const retained = emptyChats.find((chat) => chat.id === preferredChatId)
    || [...emptyChats].sort((left, right) => (
      Number(right.createdAt || 0) - Number(left.createdAt || 0)
      || String(left.id).localeCompare(String(right.id))
    ))[0];
  return chats.filter((chat) => !isEmptyChat(chat) || chat.id === retained.id);
}

function studioSettingsFromControlsFingerprint(value) {
  let fingerprint;
  try {
    fingerprint = JSON.parse(String(value || ""));
  } catch (_) {
    return { schema: "", values: {} };
  }
  if (!Array.isArray(fingerprint)) return { schema: "", values: {} };

  const values = {};
  const copyText = (key, index) => {
    if (fingerprint[index] != null) values[key] = String(fingerprint[index]);
  };
  const copyNumber = (key, index) => {
    const number = Number(fingerprint[index]);
    if (Number.isFinite(number) && number > 0) values[key] = number;
  };
  const legacy = fingerprint.length >= 10 && /^https?:\/\//i.test(String(fingerprint[0] || ""));
  if (legacy) {
    copyText("kobold_url", 0);
    copyText("model_profile", 1);
    copyText("style_preset", 2);
    copyText("framing_preset", 3);
    copyText("style_modifier", 4);
    copyText("framing_modifier", 5);
    copyText("thinking_mode", 6);
    copyText("embellishment_level", 7);
    copyNumber("temperature", 9);
    return { schema: "legacy-10", values };
  }

  copyText("model_profile", 0);
  copyText("style_preset", 1);
  copyText("framing_preset", 2);
  copyText("style_modifier", 3);
  copyText("framing_modifier", 4);
  if (fingerprint.length >= 8) {
    copyText("additional_instructions", 5);
    copyText("embellishment_level", 6);
    copyNumber("target_output_length", 7);
    return { schema: "current-8", values };
  }
  if (fingerprint.length === 7) {
    copyText("embellishment_level", 5);
    copyNumber("target_output_length", 6);
    return { schema: "transitional-7", values };
  }
  if (fingerprint.length >= 6) {
    copyText("embellishment_level", 5);
    return { schema: "pre-length-6", values };
  }
  return { schema: "", values: {} };
}

function controlsFingerprintFromSettings(settings, overrides = {}) {
  const source = { ...normalizeStudioSettings(settings), ...overrides };
  return JSON.stringify(RENDER_CONTROL_SETTINGS.map(([, key]) => String(source[key] ?? "")));
}

function normalizeStoredControlsFingerprint(value, settings) {
  if (!String(value || "").trim()) return "";
  const parsed = studioSettingsFromControlsFingerprint(value);
  if (!parsed.schema) return controlsFingerprintFromSettings(settings);
  return controlsFingerprintFromSettings(settings, parsed.values);
}

function migratedStudioSettings(chat, messages) {
  const hasStoredSettings = chat?.studioSettings && typeof chat.studioSettings === "object"
    && !Array.isArray(chat.studioSettings);
  const source = hasStoredSettings ? structuredClone(chat.studioSettings) : {};
  const latestGeneration = [...messages].reverse().find((message) => message.canonicalPrompt.trim());
  const fingerprint = studioSettingsFromControlsFingerprint(
    chat?.controlsFingerprint || latestGeneration?.controlsFingerprint || "",
  );
  if (!hasStoredSettings) {
    if (fingerprint.schema) {
      Object.assign(source, fingerprint.values);
      source.output_length_custom = true;
    }
    if (latestGeneration) {
      source.generation_action = latestGeneration.generationAction;
      source.use_llm_amplification = latestGeneration.llmAmplified;
      const promptNode = Object.values(latestGeneration.generationSnapshot?.output || {})
        .find((node) => [SLOT_TYPE, AMPLIFY_TYPE].includes(node?.class_type));
      if (typeof promptNode?.inputs?.secondary_instructions === "string") {
        source.secondary_instructions = promptNode.inputs.secondary_instructions;
      }
    }
    const loraSelections = {};
    const modelSelections = {};
    for (const message of messages) {
      const profileId = String(message.workflowProfileId || "");
      if (!profileId) continue;
      for (const entry of message.loraState || []) {
        const key = loraSelectionKey(profileId, entry.nodeId);
        if (entry.selections.length) loraSelections[key] = entry.selections;
        else delete loraSelections[key];
      }
      for (const entry of message.modelState || []) {
        if (entry.modelName) modelSelections[modelSelectionKey(profileId, entry.nodeId)] = entry.modelName;
      }
    }
    source.lora_selections = Object.keys(loraSelections).length
      ? loraSelections
      : (messages.length ? {} : getDefaultLoraSelections());
    source.model_selections = Object.keys(modelSelections).length
      ? modelSelections
      : (messages.length ? {} : getDefaultModelSelections());
  } else {
    const storedVersion = Number(chat.studioSettings?.version || 0);
    const legacyShifted = storedVersion < STUDIO_SETTINGS_VERSION
      && fingerprint.schema === "legacy-10"
      && /^https?:\/\//i.test(String(source.model_profile || ""));
    const oldLengthShifted = storedVersion < STUDIO_SETTINGS_VERSION
      && ["pre-length-6", "transitional-7"].includes(fingerprint.schema)
      && String(source.additional_instructions || "") === String(fingerprint.values.embellishment_level || "");
    const configControlsLost = [
      "model_profile", "style_preset", "framing_preset", "thinking_mode", "embellishment_level",
    ].filter((key) => !String(source[key] || "").trim()).length >= 3;
    if (legacyShifted || oldLengthShifted || configControlsLost) {
      Object.assign(source, fingerprint.values);
      if (oldLengthShifted) source.additional_instructions = "";
      if (Object.hasOwn(fingerprint.values, "target_output_length")) source.output_length_custom = true;
    } else {
      for (const key of ["model_profile", "style_preset", "framing_preset", "embellishment_level"]) {
        if (!String(source[key] || "").trim() && String(fingerprint.values[key] || "").trim()) {
          source[key] = fingerprint.values[key];
        }
      }
    }
  }
  return normalizeStudioSettings(source);
}

function normalizeStudioControlChanges(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const textFields = new Set([
    "model_profile", "style_preset", "framing_preset", "style_modifier", "framing_modifier",
    "additional_instructions", "secondary_instructions", "embellishment_level", "resolution_aspect_ratio",
  ]);
  const normalized = {};
  for (const [key, raw] of Object.entries(value)) {
    if (textFields.has(key)) {
      normalized[key] = String(raw ?? "").slice(0, 16 * 1024);
    } else if (key === "target_output_length" && Number.isFinite(Number(raw))) {
      normalized[key] = Math.max(1, Math.min(10000, Number(raw)));
    } else if (key === "resolution_megapixels" && Number.isFinite(Number(raw))) {
      normalized[key] = Math.max(0.1, Math.min(16, Number(raw)));
    } else if (key === "resolution_multiple" && Number.isFinite(Number(raw))) {
      normalized[key] = Math.max(8, Math.min(128, Math.round(Number(raw) / 4) * 4));
    } else if (key === "randomize_seed" && typeof raw === "boolean") {
      normalized[key] = raw;
    }
  }
  return normalized;
}

function normalizeStudioProposal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = value.status === "ready" ? "ready" : value.status === "needs_choice" ? "needs_choice" : "";
  const summary = String(value.summary || "").trim().slice(0, 4000);
  const revisionInstruction = String(value.revision_instruction || value.revisionInstruction || "").trim().slice(0, 8000);
  const controlChanges = normalizeStudioControlChanges(value.control_changes || value.controlChanges);
  if (!status || !summary || (!revisionInstruction && !Object.keys(controlChanges).length)) return null;
  return {
    id: String(value.id || makeId()),
    status,
    summary,
    revision_instruction: revisionInstruction,
    control_changes: controlChanges,
    createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : Date.now(),
  };
}

function normalizeStudioDiscussion(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = ["active", "applied", "cancelled", "stale"].includes(value.status)
    ? value.status
    : "active";
  const createdAt = Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : Date.now();
  return {
    id: String(value.id || makeId()),
    status,
    targetImage: normalizeImageReference(value.targetImage),
    targetMessageId: String(value.targetMessageId || ""),
    anchorMainPrompt: String(value.anchorMainPrompt || ""),
    anchorFinalPrompt: String(value.anchorFinalPrompt || ""),
    anchorControlsFingerprint: String(value.anchorControlsFingerprint || ""),
    anchorApplicableControls: normalizeStudioControlChanges(value.anchorApplicableControls),
    editContext: value.editContext ? {sourceImage: normalizeImageReference(value.editContext.sourceImage), referenceImage: normalizeImageReference(value.editContext.referenceImage)} : null,
    references: Array.isArray(value.references)
      ? value.references.map(normalizeImageReference).filter(Boolean).slice(0, 3)
      : [],
    pendingProposal: normalizeStudioProposal(value.pendingProposal),
    createdAt,
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : createdAt,
  };
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
        intentProvenance: normalizeIntentProvenance(message?.intentProvenance),
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
        referenceImage: normalizeImageReference(message?.referenceImage),
        referenceGrounding: normalizeReferenceGrounding(message?.referenceGrounding),
        upscaleFactor: message?.upscaleFactor != null && Number.isFinite(Number(message.upscaleFactor))
          ? Number(message.upscaleFactor)
          : null,
        resultNodeIds: Array.isArray(message?.resultNodeIds) ? message.resultNodeIds.map(String) : [],
        resultFields: Array.isArray(message?.resultFields) && message.resultFields.length ? message.resultFields.map(String) : ["images", "gifs"],
        promptId: String(message?.promptId || ""),
        generationState: ["queued", "generating", "complete", "error", "cancelled"].includes(message?.generationState) ? message.generationState : "",
        operationId: String(message?.operationId || ""),
        operationPhase: String(message?.operationPhase || ""),
        operationStatus: String(message?.operationStatus || ""),
        operationKind: String(message?.operationKind || ""),
        llmProvider: message?.llmProvider ? normalizeLlmProvider(message.llmProvider) : "",
        llmThinkingEnabled: message?.llmThinkingEnabled === true,
        llmTokenCount: message?.llmTokenCount != null && Number.isFinite(Number(message.llmTokenCount))
          ? Math.max(0, Math.trunc(Number(message.llmTokenCount)))
          : null,
        studioMessageKind: ["discussion", "revision"].includes(message?.studioMessageKind)
          ? message.studioMessageKind
          : "",
        studioDiscussionId: String(message?.studioDiscussionId || ""),
        studioProposal: normalizeStudioProposal(message?.studioProposal),
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
    ? chat.versions.map((value) => ({ ...normalizePromptVersion(value, storedMainPrompt, storedFinalPrompt), intentProvenance: normalizeIntentProvenance(value?.intentProvenance) }))
    : [{ ...promptVersion(storedMainPrompt, storedFinalPrompt), intentProvenance: normalizeIntentProvenance(chat?.intentProvenance) }];
  const latestGeneration = [...messages]
    .reverse()
    .find((message) => message.canonicalPrompt.trim());
  const recoverGeneratedPrompt = !storedFinalPrompt.trim()
    && !storedVersions.some((version) => version.finalPrompt.trim())
    && Boolean(latestGeneration?.canonicalPrompt.trim());
  const mainPrompt = recoverGeneratedPrompt ? latestGeneration.mainPrompt : storedMainPrompt;
  const finalPrompt = recoverGeneratedPrompt ? latestGeneration.canonicalPrompt : storedFinalPrompt;
  const versions = recoverGeneratedPrompt
    ? [{ ...promptVersion(mainPrompt, finalPrompt), intentProvenance: normalizeIntentProvenance(latestGeneration?.intentProvenance) }]
    : storedVersions;
  const requestedIndex = Number(recoverGeneratedPrompt ? versions.length - 1 : chat?.versionIndex ?? versions.length - 1);
  const versionIndex = Number.isFinite(requestedIndex)
    ? Math.max(0, Math.min(requestedIndex, versions.length - 1))
    : versions.length - 1;
  const studioSettings = migratedStudioSettings(chat, messages);
  const storedControlsFingerprint = String(chat?.controlsFingerprint || latestGeneration?.controlsFingerprint || "");
  const controlsFingerprint = normalizeStoredControlsFingerprint(storedControlsFingerprint, studioSettings);
  const renderedMainPrompt = String(
    chat?.renderedMainPrompt
    ?? (chat?.mainPromptDirty ? latestGeneration?.mainPrompt ?? "" : mainPrompt),
  );
  const renderedFinalPrompt = String(
    chat?.renderedFinalPrompt
    ?? (chat?.finalPromptManuallyEdited ? latestGeneration?.canonicalPrompt ?? "" : finalPrompt),
  );
  const pendingGeneration = normalizePendingGeneration(chat?.pendingGeneration);
  const lastGeneration = normalizeLastGeneration(chat?.lastGeneration);
  return {
    id: String(chat?.id || makeId()),
    createdAt,
    updatedAt,
    initialized: recoverGeneratedPrompt || (chat?.initialized == null ? Boolean(finalPrompt) : Boolean(chat.initialized)),
    sessionMode: chat?.sessionMode === "plot" || chat?.plotId ? "plot" : "chat",
    plotId: String(chat?.plotId || ""),
    plotSummary: chat?.plotSummary && typeof chat.plotSummary === "object" && !Array.isArray(chat.plotSummary)
      ? structuredClone(chat.plotSummary)
      : null,
    plotDraft: chat?.plotDraft && typeof chat.plotDraft === "object" && !Array.isArray(chat.plotDraft)
      ? structuredClone(chat.plotDraft)
      : null,
    mainPrompt,
    intentProvenance: normalizeIntentProvenance(recoverGeneratedPrompt ? latestGeneration?.intentProvenance : chat?.intentProvenance),
    renderedMainPrompt,
    mainPromptDirty: mainPrompt !== renderedMainPrompt,
    finalPrompt,
    renderedFinalPrompt,
    finalPromptManuallyEdited: finalPrompt !== renderedFinalPrompt,
    currentPrompt: finalPrompt,
    versions,
    versionIndex,
    controlsFingerprint,
    createWorkflowId: String(chat?.createWorkflowId || ""),
    editWorkflowId: String(chat?.editWorkflowId || ""),
    upscaleWorkflowId: String(chat?.upscaleWorkflowId || ""),
    editPromptMode: ["edit_instruction", "full_prompt"].includes(chat?.editPromptMode) ? chat.editPromptMode : "",
    selectedSource: normalizeImageReference(chat?.selectedSource),
    autoAdvanceGenerationId: String(chat?.autoAdvanceGenerationId || ""),
    editReferenceImage: normalizeImageReference(chat?.editReferenceImage),
    referenceClarification: normalizeReferenceClarification(chat?.referenceClarification),
    lastGeneration: lastGeneration
      ? { ...lastGeneration, intentProvenance: normalizeIntentProvenance(chat.lastGeneration.intentProvenance) }
      : null,
    pendingGeneration: pendingGeneration
      ? { ...pendingGeneration, intentProvenance: normalizeIntentProvenance(chat.pendingGeneration.intentProvenance) }
      : null,
    studioSettings,
    messages,
    consultClearedAt,
    consultMessages,
    consultPendingJob: chat?.consultPendingJob && typeof chat.consultPendingJob === "object"
      ? structuredClone(chat.consultPendingJob)
      : null,
    consultExperiment,
    consultAgent,
    consultAgentMode,
    studioDiscussion: normalizeStudioDiscussion(chat?.studioDiscussion),
  };
}

  return {
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
  };
}
