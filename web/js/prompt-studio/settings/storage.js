import { SETTINGS_DEFAULTS, STORAGE_KEY } from "../core/constants.js";

export function migrateLlamacppConfigLocation(value) {
  const settings = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  const legacyPath = String(settings.llamacpp_config_path || "").trim();
  if (!settings.llamacpp_config_profile && legacyPath) {
    const separator = Math.max(legacyPath.lastIndexOf("/"), legacyPath.lastIndexOf("\\"));
    settings.llamacpp_config_profile = separator >= 0 ? legacyPath.slice(separator + 1) : legacyPath;
  }
  delete settings.llamacpp_config_directory;
  delete settings.llamacpp_config_path;
  return settings;
}

export function getSettings() {
  try {
    return {
      ...SETTINGS_DEFAULTS,
      ...migrateLlamacppConfigLocation(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")),
    };
  } catch (_) {
    return { ...SETTINGS_DEFAULTS };
  }
}
