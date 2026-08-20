export function cleanModelName(value) {
  return String(value || "").trim().replace(/^[/\\]+|[/\\]+$/g, "");
}

export function modelNameKey(value) {
  return cleanModelName(value).replaceAll("\\", "/").toLowerCase();
}
