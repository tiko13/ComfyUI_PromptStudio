import { normalizeImageReference } from "../chat/image-reference.js";

/** Only a confirmed missing file is called expired; disconnects are not cache cleanup. */
export function watchIntermediatePreview(image, reference, {container = image.parentElement, intermediate = false, unavailable = () => {}} = {}) {
  const ref = normalizeImageReference(reference);
  if (ref?.type !== "temp" || !(intermediate || ref.intermediate || /^StudioChoice_temp_/.test(ref.filename))) return;
  let handled = false;
  image.addEventListener("error", async () => {
    if (handled) return;
    handled = true;
    let expired = false;
    try {
      const response = await image.ownerDocument.defaultView.fetch(image.currentSrc || image.src,
        {method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(15000)});
      expired = response.status === 404 || response.status === 410;
    } catch { /* Offline: retain the thumbnail without claiming the file was purged. */ }
    if (!container?.isConnected || !container.contains(image)) return;
    const doc = image.ownerDocument, placeholder = doc.createElement("div");
    placeholder.className = "studio-intermediate-unavailable";
    placeholder.setAttribute("role", "status");
    placeholder.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px;max-width:240px;box-sizing:border-box;text-align:center;font:inherit;white-space:normal";
    if (ref.previewThumbnail) {
      const thumbnail = doc.createElement("img");
      thumbnail.src = ref.previewThumbnail; thumbnail.alt = "Thumbnail of the unsaved intermediate";
      thumbnail.style.cssText = "position:static;width:96px;height:96px;max-width:100%;object-fit:contain";
      placeholder.append(thumbnail);
    } else {
      const icon = doc.createElement("span"); icon.textContent = "▧";
      icon.setAttribute("aria-hidden", "true"); icon.style.cssText = "font-size:40px;line-height:1.2;opacity:.6";
      placeholder.append(icon);
    }
    const title = doc.createElement("strong"), text = doc.createElement("span");
    title.textContent = expired ? "Unsaved intermediate expired" : "Intermediate preview unavailable";
    text.textContent = expired
      ? "The full-size image was removed from the temporary cache. Enable Save intermediate to keep future images."
      : "The full-size preview could not be loaded. Reconnect and reload to try again.";
    text.style.cssText = "font-size:12px;line-height:1.4;opacity:.8";
    placeholder.append(title, text);
    container.replaceChildren(placeholder);
    container.style.aspectRatio = "auto";
    container.style.minHeight = "160px";
    if (container.tagName === "BUTTON") {
      container.disabled = true;
      container.title = title.textContent;
      container.setAttribute("aria-label", title.textContent);
    }
    unavailable({expired});
  });
}
