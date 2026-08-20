import { ACTIVITY_ICON_URL } from "../core/constants.js";
import { state } from "../core/state.js";

function backgroundActivityLabel() {
  const selector = state.consultBusy ? "#promptstudio-consult-status" : "#promptstudio-status";
  return state.panel?.querySelector(selector)?.textContent?.trim() || "Prompt Studio is working";
}

export function pendingStudioGenerationCount() {
  return state.chats.reduce((count, chat) => count + chat.messages.filter((message) => (
    message.promptId && ["queued", "generating"].includes(message.generationState)
  )).length, 0);
}

export function hasPendingStudioGenerations() {
  return pendingStudioGenerationCount() > 0
    || state.studioPreparations.size > 0
    || state.chats.some((chat) => chat.messages.some((message) => (
      message.operationId && !["complete", "error", "cancelled"].includes(message.operationPhase)
    )))
    || state.chats.some((chat) => Boolean(chat.consultPendingJob));
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

export function syncBackgroundActivityIndicator() {
  const doc = state.panel?.ownerDocument || null;
  const active = state.busy || state.consultBusy || hasPendingStudioGenerations();
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
