import { api } from "/scripts/api.js";

import {
  VIDEO_STUDIO_CHANNEL,
  VIDEO_STUDIO_PRESENCE_TIMEOUT_MS,
} from "../core/constants.js";
import { state } from "../core/state.js";

export function createVideoStudioBridge({ refreshVideoHandoffActions }) {
  if (typeof refreshVideoHandoffActions !== "function") {
    throw new TypeError("Video Studio bridge requires a handoff-action refresher.");
  }

  function refreshVideoStudioServerPresence() {
    if (state.videoStudioCapabilityRequest) return state.videoStudioCapabilityRequest;
    state.videoStudioCapabilityRequest = api.fetchApi("/promptstudio-video/capabilities", { cache: "no-store" })
      .then(async response => {
        state.videoStudioInstalled = response.ok;
        if (!response.ok) {
          state.videoStudioServerPresence.clear();
          return;
        }
        const data = await response.json().catch(() => ({}));
        const seenAt = Date.now();
        state.videoStudioServerPresence = new Map(
          (Array.isArray(data.studio_instances) ? data.studio_instances : [])
            .filter(item => item?.instanceId)
            .map(item => [item.instanceId, { ...item, seenAt }]),
        );
      })
      .catch(() => {
        if (state.videoStudioInstalled === null) {
          state.videoStudioInstalled = Boolean(globalThis.__promptstudioVideoStudioHost);
        }
        state.videoStudioServerPresence.clear();
      })
      .finally(() => {
        state.videoStudioCapabilityRequest = null;
        refreshVideoHandoffActions();
      });
    return state.videoStudioCapabilityRequest;
  }

  function setupVideoStudioBridge() {
    refreshVideoStudioServerPresence();
    if (state.videoStudioPresenceTimer) window.clearInterval(state.videoStudioPresenceTimer);
    if (typeof BroadcastChannel !== "function") {
      refreshVideoHandoffActions();
      state.videoStudioPresenceTimer = window.setInterval(() => {
        refreshVideoStudioServerPresence();
        refreshVideoHandoffActions();
      }, 3000);
      return;
    }
    state.videoStudioChannel?.close();
    const channel = new BroadcastChannel(VIDEO_STUDIO_CHANNEL);
    state.videoStudioChannel = channel;
    channel.addEventListener("message", (event) => {
      const data = event.data;
      if (data?.type === "studio-presence" && data.instanceId) {
        state.videoStudioInstalled = true;
        state.videoStudioPresence.set(data.instanceId, { ...data, seenAt: Date.now() });
        refreshVideoHandoffActions();
        return;
      }
      if (data?.type !== "handoff-result" || !data.requestId) return;
      const pending = state.videoHandoffRequests.get(data.requestId);
      if (!pending) return;
      window.clearTimeout(pending.timeout);
      state.videoHandoffRequests.delete(data.requestId);
      if (data.ok) pending.resolve(data.result || {});
      else pending.reject(new Error(data.error || "Video Studio could not import the image."));
    });
    const probe = () => {
      const now = Date.now();
      for (const [instanceId, presence] of state.videoStudioPresence) {
        if (now - presence.seenAt >= VIDEO_STUDIO_PRESENCE_TIMEOUT_MS) state.videoStudioPresence.delete(instanceId);
      }
      channel.postMessage({ type: "studio-probe" });
      refreshVideoStudioServerPresence();
      refreshVideoHandoffActions();
    };
    probe();
    state.videoStudioPresenceTimer = window.setInterval(probe, 3000);
  }

  return { setupVideoStudioBridge };
}
