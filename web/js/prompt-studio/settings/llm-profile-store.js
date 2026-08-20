import {
  DEFAULT_LLM_THINKING_MODES,
  LLM_PROFILE_DEFAULTS,
  LLM_PROFILE_PRESETS,
  LLM_PROFILE_STORAGE_KEY,
  LLM_PROFILE_STORAGE_VERSION,
  LLM_THINKING_MODE_OPTIONS,
  QWEN38_27B_PROFILE_DEFAULTS,
} from "../core/constants.js";

export function normalizeLlmProfile(value, fallback = null) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const presetFallback = LLM_PROFILE_PRESETS.find((profile) => profile.id === source.id) || null;
  const thinkingPresetFallback = source.id === QWEN38_27B_PROFILE_DEFAULTS.id
    ? QWEN38_27B_PROFILE_DEFAULTS
    : null;
  const defaults = fallback || presetFallback || LLM_PROFILE_DEFAULTS;
  const number = (key, minimum, maximum, integer = false) => {
    const requested = Number(source[key]);
    const fallbackValue = Number(defaults[key]);
    const bounded = Math.max(minimum, Math.min(maximum, Number.isFinite(requested) ? requested : fallbackValue));
    return integer ? Math.round(bounded) : bounded;
  };
  const thinkingNumber = (key, standardKey, minimum, maximum, integer = false) => {
    const requested = Number(source[key]);
    const presetValue = Number(thinkingPresetFallback?.[key]);
    const standardValue = Number(source[standardKey]);
    const defaultValue = Number(defaults[key] ?? defaults[standardKey]);
    const fallbackValue = Number.isFinite(presetValue)
      ? presetValue
      : Number.isFinite(standardValue) ? standardValue : defaultValue;
    const bounded = Math.max(minimum, Math.min(maximum, Number.isFinite(requested) ? requested : fallbackValue));
    return integer ? Math.round(bounded) : bounded;
  };
  const fallbackThinkingModes = Array.isArray(defaults.thinking_modes)
    ? defaults.thinking_modes
    : DEFAULT_LLM_THINKING_MODES;
  const requestedThinkingModes = Array.isArray(source.thinking_modes)
    ? source.thinking_modes
    : fallbackThinkingModes;
  const thinkingModes = [...new Set(requestedThinkingModes.map((requestedMode) => (
    LLM_THINKING_MODE_OPTIONS.find((option) => option.toLowerCase() === String(requestedMode).trim().toLowerCase())
  )).filter(Boolean))];
  if (!thinkingModes.length) thinkingModes.push(...fallbackThinkingModes);
  const requestedThinkingMode = LLM_THINKING_MODE_OPTIONS.find((option) => (
    option.toLowerCase() === String(source.thinking_mode ?? defaults.thinking_mode).trim().toLowerCase()
  ));
  return {
    id: String(source.id || defaults.id || LLM_PROFILE_DEFAULTS.id),
    name: String(source.name || defaults.name || LLM_PROFILE_DEFAULTS.name).trim().slice(0, 80)
      || LLM_PROFILE_DEFAULTS.name,
    thinking_mode: thinkingModes.includes(requestedThinkingMode) ? requestedThinkingMode : thinkingModes[0],
    thinking_modes: thinkingModes,
    max_response_tokens: number("max_response_tokens", 0, 8192, true),
    llamacpp_reasoning_budget_tokens: number("llamacpp_reasoning_budget_tokens", 0, 262144, true),
    temperature: number("temperature", 0, 5),
    top_p: number("top_p", 0, 1),
    top_k: number("top_k", 0, 200, true),
    min_p: number("min_p", 0, 1),
    presence_penalty: number("presence_penalty", -2, 2),
    rep_pen: number("rep_pen", 0.5, 3),
    rep_pen_range: number("rep_pen_range", 0, 4096, true),
    thinking_temperature: thinkingNumber("thinking_temperature", "temperature", 0, 5),
    thinking_top_p: thinkingNumber("thinking_top_p", "top_p", 0, 1),
    thinking_top_k: thinkingNumber("thinking_top_k", "top_k", 0, 200, true),
    thinking_min_p: thinkingNumber("thinking_min_p", "min_p", 0, 1),
    thinking_presence_penalty: thinkingNumber("thinking_presence_penalty", "presence_penalty", -2, 2),
    thinking_rep_pen: thinkingNumber("thinking_rep_pen", "rep_pen", 0.5, 3),
    thinking_rep_pen_range: thinkingNumber("thinking_rep_pen_range", "rep_pen_range", 0, 4096, true),
    sampler_seed: number("sampler_seed", -1, 999999, true),
    request_timeout: number("request_timeout", 5, 600, true),
    stop_sequence: String(source.stop_sequence ?? defaults.stop_sequence ?? "").slice(0, 4096),
  };
}

export function loadLlmProfiles() {
  let raw = null;
  try {
    raw = localStorage.getItem(LLM_PROFILE_STORAGE_KEY);
  } catch (_) {
    raw = null;
  }
  if (raw === null) return LLM_PROFILE_PRESETS.map((profile) => normalizeLlmProfile(profile, profile));
  let stored = null;
  try {
    stored = JSON.parse(raw);
  } catch (_) {
    return LLM_PROFILE_PRESETS.map((profile) => normalizeLlmProfile(profile, profile));
  }
  const candidates = Array.isArray(stored) ? stored : stored?.profiles;
  if (!Array.isArray(candidates)) {
    return LLM_PROFILE_PRESETS.map((profile) => normalizeLlmProfile(profile, profile));
  }
  const storageVersion = Array.isArray(stored) ? 0 : Number(stored?.version) || 0;
  const seen = new Set();
  const profiles = candidates
    .map((profile) => {
      let migrated = profile;
      if (storageVersion < 4 && profile?.id === QWEN38_27B_PROFILE_DEFAULTS.id
          && !Array.isArray(profile.thinking_modes)) {
        migrated = { ...migrated, thinking_mode: QWEN38_27B_PROFILE_DEFAULTS.thinking_mode };
      }
      if (storageVersion < 5 && profile?.id === LLM_PROFILE_DEFAULTS.id
          && profile?.name === "Qwen3.5") {
        migrated = { ...migrated, name: LLM_PROFILE_DEFAULTS.name };
      }
      return normalizeLlmProfile(migrated);
    })
    .filter((profile) => profile.id !== "default" && profile.id !== "__default__")
    .filter((profile) => {
      if (seen.has(profile.id)) return false;
      seen.add(profile.id);
      return true;
    });
  if (storageVersion < 2
      && !profiles.some((profile) => profile.id === QWEN38_27B_PROFILE_DEFAULTS.id)) {
    profiles.push(normalizeLlmProfile(QWEN38_27B_PROFILE_DEFAULTS, QWEN38_27B_PROFILE_DEFAULTS));
  }
  if (storageVersion < LLM_PROFILE_STORAGE_VERSION) {
    try {
      localStorage.setItem(LLM_PROFILE_STORAGE_KEY, JSON.stringify({
        version: LLM_PROFILE_STORAGE_VERSION,
        profiles,
      }));
    } catch (_) {
      // The migrated profiles remain usable for this session when storage is unavailable.
    }
  }
  return profiles;
}
