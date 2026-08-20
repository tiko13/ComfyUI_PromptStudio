export function normalizeImageReference(value) {
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
