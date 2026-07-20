const CHANNEL_NAME = "lllm.promptStudio.standalone.v1";
const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const status = document.querySelector("#lllm-standalone-status");
const embeddedHost = document.querySelector("#lllm-standalone-host");
const windowName = window.name || `lllm-prompt-studio-${requestId}`;
window.name = windowName;

let connected = false;
let connecting = false;
let channel = null;
let hostPoll = null;

function setStatus(message) {
  if (status) status.textContent = message;
}

async function connectToHost(host) {
  if (connected || connecting) return connected;
  connecting = true;
  try {
    if (!host || host.closed || host.location.origin !== window.location.origin) return false;
    const attached = await host.__lllmPromptStudioHost?.attach?.(window);
    if (!attached) return false;
    connected = true;
    channel?.close();
    if (hostPoll) window.clearInterval(hostPoll);
    return true;
  } catch (_) {
    return false;
  } finally {
    connecting = false;
  }
}

if (!await connectToHost(window.opener) && typeof BroadcastChannel === "function") {
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.addEventListener("message", (event) => {
    if (event.data?.requestId !== requestId) return;
    if (event.data.type === "connected") {
      connected = true;
      channel.close();
    } else if (event.data.type === "failed") {
      setStatus("ComfyUI found Prompt Studio, but the standalone window could not be attached.");
    }
  });
  channel.postMessage({ type: "connect", requestId, windowName });
}

async function connectEmbeddedHost() {
  if (!connected) await connectToHost(embeddedHost?.contentWindow);
}

embeddedHost?.addEventListener("load", connectEmbeddedHost);
hostPoll = window.setInterval(connectEmbeddedHost, 250);

window.setTimeout(() => {
  if (!connected) setStatus("Prompt Studio could not start its ComfyUI workflow host. Refresh after ComfyUI has finished loading.");
}, 12000);
