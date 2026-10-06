// Installation, backend readiness and UI attachment are separate evidence.
export function createVideoAvailabilityReader({ fetch: fetcher = globalThis.fetch, timeoutMs = 4000 } = {}) {
  let pending = null;
  let knownInstalled = false;
  async function json(path) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetcher(path, { cache: "no-store", signal: controller.signal });
          if (!response.ok) return null;
          return await response.json();
        })(),
        new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs); }),
      ]);
    } catch (_) { return null; }
    finally { clearTimeout(timer); }
  }
  return function read() {
    if (pending) return pending;
    pending = (async () => {
      const capabilities = await json("/promptstudio-video/capabilities");
      if (capabilities && Array.isArray(capabilities.features)) {
        knownInstalled = true;
        return { installed: true, state: "loaded", capabilities };
      }
      const status = await json("/promptstudio/prompt-studio/video-status");
      if (status?.installed === true) knownInstalled = true;
      // Prior positive evidence survives failed requests and transient route loss.
      if (knownInstalled) return { installed: true, state: status?.state === "not_loaded" ? "not_loaded" : "unavailable" };
      if (status?.installed === false && status.state === "missing") return { installed: false, state: "missing" };
      return { installed: null, state: "unavailable" };
    })().finally(() => { pending = null; });
    return pending;
  };
}

export function videoAvailabilityMessage(state) {
  return {
    ready: "Switch to Video Studio",
    checking: "Video Studio is installed; waiting for its interface to connect…",
    incompatible: "Video Studio needs an update before it can share this tab.",
    not_loaded: "Video Studio is installed, but ComfyUI has not loaded it. If it was just installed, restart ComfyUI. Otherwise check that the extension is enabled and inspect startup errors.",
    unavailable: "Video Studio could not be reached. Checking again automatically; verify the ComfyUI connection.",
    missing: "Video Studio is not installed. Click to install.",
  }[state] || "Checking Video Studio…";
}
