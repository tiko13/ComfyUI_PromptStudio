import { createPollingScope } from "./polling.js";

// Shared by Image and Video; the server remains authoritative for admission.
export function watchExternalGeneration(onChange, fetchApi = fetch, view = globalThis) {
  let previous = "";
  const scope = createPollingScope({ view });
  scope.add(async () => {
    const response = await fetchApi("/promptstudio/lora-studio/generation", {
      cache: "no-store", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok && response.status !== 404) return;
    const data = response.ok ? await response.json() : {};
    const status = {
      reserved: data.reserved === true,
      active: data.active === true,
      label: data.reserved ? (data.active ? "Generating in LoRA studio" : "LoRA studio waiting for current work") : "",
    };
    const serialized = JSON.stringify(status);
    if (serialized !== previous) {
      previous = serialized;
      onChange(status);
    }
  }, { interval: 1000, hiddenInterval: 5000 });
  return () => scope.dispose();
}
