if (document.querySelector("#promptstudio-popout-mount")) {
const CHANNEL_NAME = "promptstudio.promptStudio.standalone.v1";
const VIDEO_CAPABILITIES_ENDPOINT = "/promptstudio-video/capabilities";
const VIDEO_REPOSITORY_URL = "https://github.com/tiko13/PromptStudio_Video";
const VIDEO_INSTALL_ENDPOINT = "/customnode/install/git_url";
const COMFY_RESTART_ENDPOINTS = ["/v2/manager/reboot", "/manager/reboot"];
const IMAGE_ICON_URL = new URL("../prompt-studio-icon.svg", import.meta.url).href;
const VIDEO_ICON_URL = "/extensions/PromptStudio_Video/prompt-studio-video-favicon.svg";
const VIDEO_STYLESHEET_URL = "/extensions/PromptStudio_Video/css/promptstudio_video_studio.css?v=6";
const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const status = document.querySelector("#promptstudio-standalone-status");
const embeddedHost = document.querySelector("#promptstudio-standalone-host");
const imageMount = document.querySelector("#promptstudio-image-mount");
const videoMount = document.querySelector("#promptstudio-video-mount");
const installDialog = document.querySelector("#promptstudio-video-install-dialog");
const installTitle = document.querySelector("#promptstudio-video-install-title");
const installMessage = document.querySelector("#promptstudio-video-install-message");
const installStatus = document.querySelector("#promptstudio-video-install-status");
const installButton = document.querySelector("#promptstudio-video-install");
const restartButton = document.querySelector("#promptstudio-video-restart");
const cancelButton = document.querySelector("#promptstudio-video-install-cancel");
const windowName = window.name || `promptstudio-prompt-studio-${requestId}`;
const requestedMode = new URLSearchParams(window.location.search).get("mode") === "video" ? "video" : "image";
window.name = windowName;

let connected = false;
let connecting = false;
let channel = null;
let unifiedChannel = null;
let hostPoll = null;
let fallbackTimer = null;
let failureTimer = null;
let capabilityPoll = null;
let workflowHost = null;
let imageHost = null;
let videoHost = null;
let videoAttached = false;
let activeMode = "image";
let videoAvailability = "checking";
let installBusy = false;

function setStatus(message) {
  if (status) status.textContent = message;
}

function studioModeButtons() {
  return document.querySelectorAll("[data-promptstudio-studio-mode]");
}

function availabilityMessage() {
  if (videoAvailability === "ready") return "Switch to Video Studio";
  if (videoAvailability === "incompatible") return "Video Studio needs an update before it can share this tab.";
  if (videoAvailability === "checking") return "Checking whether Video Studio is installed…";
  return "Video Studio is not installed. Click to install.";
}

function updateModeControls() {
  const message = availabilityMessage();
  for (const button of studioModeButtons()) {
    const mode = button.dataset.promptstudioStudioMode;
    const selected = mode === activeMode;
    button.setAttribute("aria-pressed", selected ? "true" : "false");
    button.dataset.available = mode === "image" || videoAvailability === "ready" ? "true" : "false";
    if (mode === "video") {
      button.title = message;
      button.setAttribute("aria-label", message);
      button.setAttribute("aria-disabled", videoAvailability === "ready" ? "false" : "true");
    }
  }
}

function setFavicon(href) {
  let favicon = document.querySelector('link[rel~="icon"]');
  if (!favicon) {
    favicon = document.createElement("link");
    favicon.rel = "icon";
    favicon.type = "image/svg+xml";
    document.head.append(favicon);
  }
  favicon.href = href;
}

function applyMode(mode) {
  activeMode = mode === "video" ? "video" : "image";
  imageMount.hidden = activeMode !== "image";
  videoMount.hidden = activeMode !== "video";
  const imagePanel = imageMount.querySelector("#promptstudio-prompt-studio");
  const videoPanel = videoMount.querySelector(".psvstudio-app");
  if (imagePanel) imagePanel.hidden = activeMode !== "image";
  if (videoPanel) videoPanel.hidden = activeMode !== "video";
  imageHost?.setStandaloneVisibility?.(activeMode === "image");
  videoHost?.setStandaloneVisibility?.(activeMode === "video");
  document.body.dataset.studioMode = activeMode;
  document.title = activeMode === "video" ? "Prompt Studio Video" : "Prompt Studio";
  setFavicon(activeMode === "video" ? VIDEO_ICON_URL : IMAGE_ICON_URL);
  updateModeControls();
}

function showVideoDialog(message = availabilityMessage()) {
  installTitle.textContent = videoAvailability === "incompatible"
    ? "Video Studio needs an update"
    : videoAvailability === "checking" ? "Checking Video Studio" : "Video Studio is not installed";
  installMessage.textContent = message;
  installStatus.textContent = "";
  installStatus.dataset.kind = "";
  installButton.hidden = videoAvailability !== "missing";
  restartButton.hidden = true;
  if (!installDialog.open) installDialog.showModal();
}

function ensureVideoStylesheet() {
  let stylesheet = document.querySelector('link[data-promptstudio-video-styles]');
  if (stylesheet) return Promise.resolve();
  stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = VIDEO_STYLESHEET_URL;
  stylesheet.dataset.promptstudioVideoStyles = "";
  document.head.append(stylesheet);
  return new Promise(resolve => {
    stylesheet.addEventListener("load", resolve, { once: true });
    stylesheet.addEventListener("error", resolve, { once: true });
  });
}

async function attachVideoStudio() {
  if (videoAttached) return true;
  const host = workflowHost?.__promptstudioVideoStudioHost;
  if (!host?.attach) return false;
  await ensureVideoStylesheet();
  videoHost = host;
  videoAttached = Boolean(await host.attach(window, { unified: true }));
  if (videoAttached) host.setStandaloneVisibility?.(activeMode === "video");
  return videoAttached;
}

function requestRemoteVideoAttach() {
  if (!unifiedChannel) return;
  unifiedChannel.postMessage({ type: "attach-video", requestId, windowName });
}

function setupUnifiedChannel() {
  if (typeof BroadcastChannel !== "function" || unifiedChannel) return;
  unifiedChannel = new BroadcastChannel(CHANNEL_NAME);
  unifiedChannel.addEventListener("message", async (event) => {
    const data = event.data;
    if (data?.type !== "video-attached" || data.requestId !== requestId) return;
    if (!data.attached) return;
    await ensureVideoStylesheet();
    videoAttached = true;
    videoAvailability = "ready";
    updateModeControls();
    if (requestedMode === "video") {
      applyMode("video");
      if (installDialog.open) installDialog.close();
    }
  });
  requestRemoteVideoAttach();
}

async function refreshVideoAvailability() {
  let capabilities = null;
  try {
    const response = await fetch(VIDEO_CAPABILITIES_ENDPOINT, { cache: "no-store" });
    if (response.ok) capabilities = await response.json().catch(() => ({}));
  } catch (_) {
    // A missing companion route is the normal not-installed state.
  }
  const directHost = workflowHost?.__promptstudioVideoStudioHost;
  const features = Array.isArray(capabilities?.features) ? capabilities.features : [];
  if (directHost?.attach && (features.includes("unified_studio_shell") || directHost.setStandaloneVisibility)) {
    videoAvailability = "ready";
    await attachVideoStudio();
  } else if (features.includes("unified_studio_shell")) {
    videoAvailability = "checking";
    requestRemoteVideoAttach();
  } else if (capabilities) {
    videoAvailability = "incompatible";
  } else {
    videoAvailability = "missing";
  }
  updateModeControls();
  if (requestedMode === "video" && activeMode === "image" && videoAvailability === "ready") {
    applyMode("video");
    if (installDialog.open) installDialog.close();
  }
  return videoAvailability;
}

async function selectMode(mode) {
  if (mode !== "video") {
    applyMode("image");
    return;
  }
  await refreshVideoAvailability();
  if (videoAvailability !== "ready" || !await attachVideoStudio()) {
    showVideoDialog();
    return;
  }
  applyMode("video");
}

async function installVideoStudio() {
  if (installBusy) return;
  installBusy = true;
  installButton.disabled = true;
  cancelButton.disabled = true;
  installStatus.dataset.kind = "working";
  installStatus.textContent = "ComfyUI Manager is installing Video Studio…";
  try {
    const response = await fetch(VIDEO_INSTALL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: VIDEO_REPOSITORY_URL,
    });
    const detail = (await response.text()).trim();
    if (!response.ok) throw new Error(detail || `ComfyUI Manager rejected the installation (${response.status}).`);
    installStatus.dataset.kind = "ready";
    installStatus.textContent = "Video Studio was installed. Restart ComfyUI to load it.";
    installButton.hidden = true;
    restartButton.hidden = false;
    cancelButton.disabled = false;
  } catch (error) {
    installStatus.dataset.kind = "error";
    installStatus.textContent = `${error.message || error} Open the manual install page if ComfyUI Manager is unavailable or blocks Git URL installs.`;
    installButton.disabled = false;
    cancelButton.disabled = false;
  } finally {
    installBusy = false;
  }
}

async function restartComfyUI() {
  if (!window.confirm("Restart ComfyUI now? Running generations and connected clients will be interrupted.")) return;
  restartButton.disabled = true;
  cancelButton.disabled = true;
  installStatus.dataset.kind = "working";
  installStatus.textContent = "Restarting ComfyUI… this page will reconnect automatically.";
  try {
    let response;
    for (const endpoint of COMFY_RESTART_ENDPOINTS) {
      response = await fetch(endpoint, { method: "POST" });
      if (response.ok || ![404, 405].includes(response.status)) break;
    }
    if (!response.ok) throw new Error(`ComfyUI Manager could not restart the server (${response.status}).`);
    window.setTimeout(() => window.location.reload(), 7000);
  } catch (error) {
    installStatus.dataset.kind = "error";
    installStatus.textContent = `${error.message || error} Restart ComfyUI manually, then refresh this page.`;
    restartButton.disabled = false;
    cancelButton.disabled = false;
  }
}

function finishConnection() {
  connected = true;
  channel?.close();
  channel = null;
  if (hostPoll) window.clearInterval(hostPoll);
  hostPoll = null;
  if (fallbackTimer) window.clearTimeout(fallbackTimer);
  fallbackTimer = null;
  if (failureTimer) window.clearTimeout(failureTimer);
  failureTimer = null;
}

async function connectToHost(host) {
  if (connected || connecting) return connected;
  connecting = true;
  try {
    if (!host || host.closed || host.location.origin !== window.location.origin) return false;
    imageHost = host.__promptstudioPromptStudioHost;
    const attached = await imageHost?.attach?.(window);
    if (!attached) return false;
    workflowHost = host;
    finishConnection();
    await refreshVideoAvailability();
    applyMode(requestedMode === "video" && videoAvailability === "ready" ? "video" : "image");
    if (requestedMode === "video" && videoAvailability !== "ready") showVideoDialog();
    return true;
  } catch (_) {
    return false;
  } finally {
    connecting = false;
  }
}

async function connectEmbeddedHost() {
  if (!connected) await connectToHost(embeddedHost?.contentWindow);
}

function startEmbeddedHost() {
  if (connected || !embeddedHost || embeddedHost.hasAttribute("src")) return;
  setStatus("Starting a private ComfyUI workflow host…");
  embeddedHost.src = "/";
  hostPoll = window.setInterval(connectEmbeddedHost, 500);
}

globalThis.__promptstudioUnifiedStudio = {
  get mode() { return activeMode; },
  refreshVideoAvailability,
  setMode: selectMode,
};

document.addEventListener("click", (event) => {
  const modeButton = event.target.closest?.("[data-promptstudio-studio-mode]");
  if (modeButton) selectMode(modeButton.dataset.promptstudioStudioMode);
});
installButton?.addEventListener("click", installVideoStudio);
restartButton?.addEventListener("click", restartComfyUI);
cancelButton?.addEventListener("click", () => installDialog.close());
installDialog?.addEventListener("cancel", (event) => {
  if (installBusy) event.preventDefault();
});

if (!await connectToHost(window.opener)) {
  if (typeof BroadcastChannel === "function") {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener("message", (event) => {
      if (event.data?.requestId !== requestId) return;
      if (event.data.type === "connected") {
        finishConnection();
        setupUnifiedChannel();
        refreshVideoAvailability().then(() => {
          applyMode(requestedMode === "video" && videoAvailability === "ready" ? "video" : "image");
          if (requestedMode === "video" && videoAvailability !== "ready") showVideoDialog();
        });
      }
      else if (event.data.type === "failed") startEmbeddedHost();
    });
    channel.postMessage({ type: "connect", requestId, windowName });
  }
  fallbackTimer = window.setTimeout(startEmbeddedHost, 1500);
}

embeddedHost?.addEventListener("load", connectEmbeddedHost);
failureTimer = window.setTimeout(() => {
  if (connected) return;
  if (hostPoll) window.clearInterval(hostPoll);
  hostPoll = null;
  setStatus("Prompt Studio could not start its ComfyUI workflow host. Refresh after ComfyUI has finished loading.");
}, 30000);
capabilityPoll = window.setInterval(() => {
  if (connected && videoAvailability !== "ready") refreshVideoAvailability();
}, 5000);

window.addEventListener("pagehide", () => {
  channel?.close();
  unifiedChannel?.close();
  if (hostPoll) window.clearInterval(hostPoll);
  if (fallbackTimer) window.clearTimeout(fallbackTimer);
  if (failureTimer) window.clearTimeout(failureTimer);
  if (capabilityPoll) window.clearInterval(capabilityPoll);
}, { once: true });
}
