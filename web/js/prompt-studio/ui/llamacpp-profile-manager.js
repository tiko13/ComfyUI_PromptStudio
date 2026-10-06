import { api } from "/scripts/api.js";
import { installDialogFocus } from "./dialog-focus.js";

const endpoint = "/promptstudio/prompt-studio/llamacpp/config-profiles";

async function request(action, name) {
  const response = await api.fetchApi(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, llamacpp_config_profile: name }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not manage Llama.cpp profiles.");
  return data;
}

export function openLlamacppProfileManager(container, onDeleted) {
  if (container.querySelector(".promptstudio-profile-manager")) return;
  const doc = container.ownerDocument;
  const trigger = doc.activeElement;
  const el = (tag, text, className = "") => {
    const node = doc.createElement(tag);
    node.textContent = text;
    node.className = className;
    return node;
  };
  const button = (text, action) => {
    const node = el("button", text);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  };
  const dialog = el("dialog", "", "promptstudio-profile-manager");
  dialog.setAttribute("aria-label", "Manage Llama.cpp profiles");
  installDialogFocus(dialog);
  const header = el("header", "");
  const close = button("Done", () => dialog.close());
  const refresh = button("Refresh", () => load());
  header.append(el("h2", "Manage profiles"), refresh, close);
  const message = el("p", "");
  message.setAttribute("role", "status");
  const list = el("div", "", "promptstudio-profile-manager-list");
  dialog.append(header, el("p", "Delete removes the profile only. Model and mmproj files are kept. A running server stays running; deleting its startup profile turns off Start with ComfyUI."), message, list);
  let profiles = [];
  let busy = false;
  const setBusy = (value) => {
    busy = value;
    dialog.querySelectorAll("button").forEach(node => { node.disabled = value; });
  };
  const asset = (label, value, error) => {
    const present = value?.present;
    const status = error ? "Unavailable" : present === true ? "Present"
      : present === false ? "Missing" : "Not configured";
    const mark = present === true ? "✓" : present === false ? "✕" : "—";
    const node = el("div", `${mark} ${label}: ${status}`, "promptstudio-profile-asset");
    node.dataset.status = present === true ? "present" : present === false ? "missing" : "unknown";
    if (value?.path) node.append(el("small", value.path));
    return node;
  };
  const render = () => {
    list.replaceChildren();
    if (!profiles.length) list.append(el("p", "No JSON profiles found."));
    for (const profile of profiles) {
      const row = el("section", "", "promptstudio-profile-manager-row");
      row.setAttribute("aria-label", profile.name);
      const name = el("strong", profile.name);
      const remove = button("Delete", () => {
        const confirmation = el("div", "", "promptstudio-profile-delete-confirmation");
        const cancel = button("Cancel", () => { confirmation.remove(); remove.hidden = false; remove.focus(); });
        const confirm = button("Delete profile", async () => {
          if (busy) return;
          setBusy(true);
          message.textContent = `Deleting ${profile.name}…`;
          try {
            const result = await request("delete", profile.name);
            profiles = profiles.filter(item => item.name !== profile.name);
            render();
            await onDeleted(result, profiles.map(item => item.name));
            message.textContent = `Deleted ${profile.name}.`;
          } catch (error) {
            message.textContent = error.message;
          } finally {
            setBusy(false);
            (dialog.contains(cancel) ? cancel : refresh).focus();
          }
        });
        confirmation.append(el("span", `Delete ${profile.name}?`), cancel, confirm);
        remove.hidden = true;
        row.append(confirmation);
        cancel.focus();
      });
      remove.setAttribute("aria-label", `Delete ${profile.name}`);
      row.append(name, asset("Model", profile.model, profile.error), asset("MMProj", profile.mmproj, profile.error), remove);
      if (profile.error) row.append(el("small", profile.error, "promptstudio-profile-error"));
      list.append(row);
    }
  };
  async function load() {
    if (busy) return;
    setBusy(true);
    message.textContent = "Checking profiles…";
    try {
      const data = await request("inspect");
      if (!Array.isArray(data.profiles) || data.profiles.some(item => !item || typeof item.name !== "string")) {
        throw new Error("Invalid config profile list. Restart ComfyUI to load profile management.");
      }
      profiles = data.profiles;
      render();
      message.textContent = `${profiles.length} profile${profiles.length === 1 ? "" : "s"}`;
    } catch (error) {
      message.textContent = error.message;
    } finally {
      setBusy(false);
      close.focus();
    }
  }
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => { dialog.remove(); trigger?.focus({ preventScroll: true }); });
  container.append(dialog);
  dialog.showModal();
  load();
}
