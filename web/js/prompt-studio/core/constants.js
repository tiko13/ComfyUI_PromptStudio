export const EXTENSION_NAME = "ComfyUI_PromptStudio.PromptStudio";
export const ICON_URL = new URL("../../../prompt-studio-icon.svg", import.meta.url).href;
export const ACTIVITY_ICON_URL = new URL("../../../prompt-studio-activity-icon.svg", import.meta.url).href;

export const SLOT_TYPE = "KCPP_PromptSlot";
export const AMPLIFY_TYPE = "KCPP_PromptAmplify";
export const IMAGE_SOURCE_TYPE = "KCPP_ChatImageInput";
export const UPSCALE_TYPE = "KCPP_PromptStudioUpscale";
export const LORA_LOADER_TYPE = "KCPP_PromptStudioLoraLoader";
export const MODEL_LOADER_TYPE = "KCPP_PromptStudioModelLoader";
export const SAMPLER_CONTROL_TYPE = "KCPP_PromptStudioSampler";

export const STORAGE_KEY = "promptstudio.promptStudio.settings.v1";
export const LORA_STORAGE_KEY = "promptstudio.promptStudio.loras.v1";
export const MODEL_STORAGE_KEY = "promptstudio.promptStudio.models.v1";
export const CONSULT_STORAGE_KEY = "promptstudio.promptStudio.consult.settings.v1";
export const LLM_PROFILE_STORAGE_KEY = "promptstudio.promptStudio.llmProfiles.v1";
export const SIDEBAR_GROUP_ORDER_STORAGE_KEY = "promptstudio.promptStudio.sidebarGroupOrder.v1";
export const ADVANCED_LLM_ACK_STORAGE_KEY = "promptstudio.promptStudio.advancedLlmAcknowledged.v1";

export const STANDALONE_CHANNEL = "promptstudio.promptStudio.standalone.v1";
export const VIDEO_STUDIO_CHANNEL = "promptstudio.video.standalone.v1";
export const WORKFLOW_SYNC_CHANNEL = "promptstudio.promptStudio.workflows.v1";
export const CHAT_SYNC_CHANNEL = "promptstudio.promptStudio.chats.v1";

export const STUDIO_SETTINGS_VERSION = 3;
export const STUDIO_ROUTE_ENDPOINT = "/promptstudio/prompt-studio/route-turn";
export const STUDIO_DISCUSS_ENDPOINT = "/promptstudio/prompt-studio/discuss";
export const CONSULT_CHAT_ENDPOINT = "/promptstudio/prompt-studio/chat";
export const LLM_RELEASE_ENDPOINT = "/promptstudio/prompt-studio/llm/release";
export const LLM_HANDOFF_COMPLETE_ENDPOINT = "/promptstudio/prompt-studio/llm/handoff-complete";
export const PROMPT_AGENT_ENDPOINT = "/promptstudio/prompt-studio/agent";
export const PROMPT_AGENT_CANCEL_ENDPOINT = "/promptstudio/prompt-studio/agent/cancel";
export const LLM_STATUS_ENDPOINT = "/promptstudio/prompt-studio/llm/status";
export const LLM_ABORT_ENDPOINT = "/promptstudio/prompt-studio/llm/abort";
export const LLAMACPP_SERVER_ENDPOINT = "/promptstudio/prompt-studio/llamacpp/server";
export const LLAMACPP_AUTOSTART_ENDPOINT = "/promptstudio/prompt-studio/llamacpp/autostart";
export const LLAMACPP_FILE_PICKER_ENDPOINT = "/promptstudio/prompt-studio/llamacpp/pick-file";
export const LLAMACPP_CONFIG_BUILDER_ENDPOINT = "/promptstudio/prompt-studio/llamacpp/config-builder";
export const LLAMACPP_CONFIG_PROFILES_ENDPOINT = "/promptstudio/prompt-studio/llamacpp/config-profiles";
export const MUTATION_CONFIG_ENDPOINT = "/promptstudio/prompt-studio/mutation-config";
export const COMFY_RESTART_ENDPOINTS = ["/v2/manager/reboot", "/manager/reboot"];
export const PROMPTSTUDIO_COMFY_UPDATE_ENDPOINT = "/promptstudio/prompt-studio/update-comfyui";
export const MANAGER_UPDATE_ALL_ENDPOINTS = ["/v2/manager/queue/update_all", "/manager/queue/update_all"];
export const MANAGER_QUEUE_START_ENDPOINTS = ["/v2/manager/queue/start", "/manager/queue/start"];

export const CONSULT_JOB_POLL_MS = 1000;
export const CONSULT_STATUS_RETRY_LIMIT = 3;
export const KOBOLD_STATUS_POLL_MS = 3000;
export const MUTATION_CONFIG_POLL_MS = 2500;
export const CHAT_SCROLL_STICK_THRESHOLD = 450;
export const MAX_DROPPED_IMAGE_BYTES = 20 * 1024 * 1024;
// History is retained until an explicit clear/delete. Request context remains bounded separately.
export const CONSULT_RETENTION_MS = Number.POSITIVE_INFINITY;
export const CONSULT_EXPERIMENT_MARKER = "PROMPT_STUDIO_EXPERIMENT";
export const MAX_CONSULT_EXPERIMENT_PROMPT_CHARS = 64 * 1024;
export const MAX_CONSULT_EXPERIMENT_GUIDANCE_CHARS = 16 * 1024;
export const PROMPT_AGENT_DEFAULT_MAX_ITERATIONS = 5;
export const PROMPT_AGENT_MAX_ITERATIONS = 10;
export const PROMPT_AGENT_MAX_SAVED_ITERATIONS = 50;
export const PROMPT_AGENT_MAX_GOAL_CHARS = 32 * 1024;
export const PROMPT_AGENT_MAX_CONTEXT_MESSAGES = 40;
export const PROMPT_AGENT_MAX_CONTEXT_CHARS = 24 * 1024;
export const PROMPT_AGENT_TARGET_SCORE = 85;
export const PROMPT_AGENT_MIN_CONFIDENCE = 0.7;
export const VIDEO_STUDIO_PRESENCE_TIMEOUT_MS = 7000;

export const WORKFLOW_OBSERVER_KEY = Symbol.for("ComfyUI_PromptStudio.PromptStudio.WorkflowObserver");
export const TYPE_ANYWHERE_WINDOWS = new WeakSet();

export const RESOLUTION_ASPECT_RATIOS = [
  "1:1 (Square)",
  "2:3 (Portrait Photo)",
  "3:2 (Photo)",
  "3:4 (Portrait Standard)",
  "4:3 (Standard)",
  "9:16 (Portrait Widescreen)",
  "16:9 (Widescreen)",
  "21:9 (Ultrawide)",
];

export const SETTINGS_DEFAULTS = Object.freeze({
  llm_provider: "ollama",
  kobold_url: "http://localhost:5001",
  ollama_url: "http://localhost:11434",
  ollama_model: "",
  llamacpp_url: "http://127.0.0.1:8080",
  llamacpp_model: "",
  llamacpp_executable: "",
  llamacpp_config_profile: "",
  llamacpp_generation_settings: null,
  llamacpp_autostart: false,
  keep_models_loaded: false,
  llm_profile: "qwen3.5",
  model_profile: "General Natural Language",
  style_preset: "None",
  framing_preset: "None",
  style_modifier: "",
  framing_modifier: "",
  thinking_mode: "Disabled",
  embellishment_level: "Clean",
  target_output_length: 35,
  output_length_custom: false,
  temperature: 0.7,
  additional_instructions: "",
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
});

export const LLM_THINKING_MODE_OPTIONS = Object.freeze([
  "Disabled",
  "Minimal",
  "Low",
  "Medium",
  "High",
  "XHigh",
]);
export const DEFAULT_LLM_THINKING_MODES = Object.freeze(["Disabled", "Minimal", "Low", "Medium", "High"]);
export const LLM_PROFILE_DEFAULTS = Object.freeze({
  id: "qwen3.5",
  name: "Default",
  thinking_mode: "Disabled",
  thinking_modes: DEFAULT_LLM_THINKING_MODES,
  max_response_tokens: 800,
  llamacpp_reasoning_budget_tokens: 0,
  temperature: 0.7,
  top_p: 0.9,
  top_k: 100,
  min_p: 0,
  presence_penalty: 0,
  rep_pen: 1.05,
  rep_pen_range: 360,
  thinking_temperature: 0.7,
  thinking_top_p: 0.9,
  thinking_top_k: 100,
  thinking_min_p: 0,
  thinking_presence_penalty: 0,
  thinking_rep_pen: 1.05,
  thinking_rep_pen_range: 360,
  sampler_seed: -1,
  request_timeout: 120,
  stop_sequence: "",
});
export const QWEN38_27B_PROFILE_DEFAULTS = Object.freeze({
  ...LLM_PROFILE_DEFAULTS,
  id: "qwen3.8-27b",
  name: "Qwen 3.8 (27B)",
  thinking_mode: "XHigh",
  thinking_modes: Object.freeze(["XHigh", "Medium", "Low", "Disabled"]),
  temperature: 0.7,
  top_p: 0.8,
  top_k: 20,
  min_p: 0,
  presence_penalty: 1.5,
  rep_pen: 1.0,
  thinking_temperature: 1.0,
  thinking_top_p: 0.95,
  thinking_top_k: 20,
  thinking_min_p: 0,
  thinking_presence_penalty: 0,
  thinking_rep_pen: 1.0,
});
export const LLM_PROFILE_PRESETS = Object.freeze([
  LLM_PROFILE_DEFAULTS,
  QWEN38_27B_PROFILE_DEFAULTS,
]);
export const LLM_PROFILE_STORAGE_VERSION = 6;

export const RENDER_CONTROL_IDS = [
  "promptstudio-profile",
  "promptstudio-style",
  "promptstudio-framing",
  "promptstudio-style-modifier",
  "promptstudio-framing-modifier",
  "promptstudio-additional-instructions",
  "promptstudio-embellishment",
  "promptstudio-output-length",
];
export const RENDER_CONTROL_SETTINGS = Object.freeze([
  ["promptstudio-profile", "model_profile", "Model profile"],
  ["promptstudio-style", "style_preset", "Style"],
  ["promptstudio-framing", "framing_preset", "Framing"],
  ["promptstudio-style-modifier", "style_modifier", "Style modifier"],
  ["promptstudio-framing-modifier", "framing_modifier", "Framing modifier"],
  ["promptstudio-additional-instructions", "additional_instructions", "Additional instructions"],
  ["promptstudio-embellishment", "embellishment_level", "Embellishment"],
  ["promptstudio-output-length", "target_output_length", "Target length"],
]);
export const DISCONNECTED_CONTROL_SELECTOR = "input, textarea, select, button";
export const DISCONNECTED_ALLOWED_CONTROL_IDS = [
  "promptstudio-close",
  "promptstudio-mobile-close",
  "promptstudio-close-chats",
  "promptstudio-close-inspector",
  "promptstudio-consult-close",
  "promptstudio-lightbox-close",
  "promptstudio-upscale-cancel",
  "promptstudio-generation-failure-cancel",
];

export const MUTATION_CONFIG_CATEGORIES = Object.freeze({
  protected_words: {
    title: "Protected words",
    description: "Preserve specific words and phrases during prompt rewriting.",
    itemLabel: "word or phrase",
    textField: null,
    help: "Matching ignores case and uses token boundaries for word-like entries.",
  },
  additional_instruction_templates: {
    title: "Additional instruction templates",
    description: "Create reusable shortcuts for high-priority instructions.",
    itemLabel: "instruction template",
    textField: "instruction",
    textLabel: "Instruction",
    help: "The name expands only when it exactly matches the complete Additional instructions value, ignoring case and surrounding spaces.",
  },
  known_references: {
    title: "Known references",
    description: "Define reusable names for people, objects, poses, locations, and other concepts.",
    itemLabel: "known reference",
    textField: "definition",
    textLabel: "Definition",
    help: "Reference names match case-insensitively inside prompts; longer overlapping names take priority.",
  },
  additional_style_templates: {
    title: "Additional style presets",
    description: "Manage personal style guidance added to the built-in presets.",
    itemLabel: "style preset",
    textField: "instruction",
    textLabel: "Style instruction",
    help: "Additional preset names must not duplicate a built-in or another personal style name.",
  },
  additional_framing_templates: {
    title: "Additional framing presets",
    description: "Manage personal composition and camera-framing guidance.",
    itemLabel: "framing preset",
    textField: "instruction",
    textLabel: "Framing instruction",
    help: "Additional preset names must not duplicate a built-in or another personal framing name.",
  },
});
