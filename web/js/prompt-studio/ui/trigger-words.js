import { loadLoraTriggerWords } from "./model-metadata.js";
import { cleanupRemovedLoraTriggers } from "./trigger-word-cleanup.js";

export function removeLoraTriggerWords(options) {
  return cleanupRemovedLoraTriggers({ ...options, loadWords: loadLoraTriggerWords });
}

// Resolve the current document at use time: Studio can adopt its sidebar into a popout.
export function installTriggerWordPicker({ button, editor, getContext }) {
  const menu = button.ownerDocument.createElement("div");
  menu.className = "promptstudio-trigger-menu";
  menu.id = `${button.id}-menu`;
  menu.setAttribute("popover", "auto");
  menu.setAttribute("role", "group");
  menu.setAttribute("aria-label", "LoRA trigger words");
  button.setAttribute("aria-controls", menu.id);
  button.setAttribute("popovertarget", menu.id);
  button.setAttribute("aria-expanded", "false");
  button.closest("details").append(menu);
  let revision = 0;
  menu.addEventListener("beforetoggle", event => {
    button.setAttribute("aria-expanded", String(event.newState === "open"));
    if (event.newState === "closed") {
      revision += 1;
      button.removeAttribute("aria-busy");
    }
  });
  const close = () => { if (menu.matches(":popover-open")) menu.hidePopover(); };
  const place = () => {
    const view = button.ownerDocument.defaultView;
    const bounds = button.getBoundingClientRect();
    menu.style.width = `${Math.min(320, view.innerWidth - 16)}px`;
    menu.style.left = `${Math.max(8, Math.min(bounds.right - menu.offsetWidth, view.innerWidth - menu.offsetWidth - 8))}px`;
    const below = view.innerHeight - bounds.bottom - 12;
    const above = bounds.top - 12;
    const useAbove = below < Math.min(menu.scrollHeight, 240) && above > below;
    menu.style.maxHeight = `${Math.max(60, Math.min(360, useAbove ? above : below))}px`;
    menu.style.top = `${useAbove ? Math.max(8, bounds.top - menu.offsetHeight - 4) : bounds.bottom + 4}px`;
  };
  button.addEventListener("click", async event => {
    event.preventDefault();
    event.stopPropagation();
    if (menu.matches(":popover-open")) { close(); return; }
    if (editor.disabled) return;
    const doc = button.ownerDocument;
    const context = getContext();
    const contextKey = JSON.stringify(context);
    const names = [...new Set(context.names)];
    const token = ++revision;
    const current = () => token === revision && button.isConnected && !editor.disabled
      && contextKey === JSON.stringify(getContext());
    const make = (tag, text) => {
      const element = doc.createElement(tag);
      element.textContent = text;
      return element;
    };
    const append = word => {
      if (!current()) { close(); return; }
      const existing = editor.value.trimEnd();
      editor.value = existing.trim() ? `${existing}${existing.endsWith(",") ? " " : ", "}${word}` : word;
      // Follow the same persistence and change tracking path as a manual edit.
      for (const type of ["input", "change"]) editor.dispatchEvent(new doc.defaultView.Event(type, { bubbles: true }));
    };
    button.closest("details").open = true;
    menu.replaceChildren(make("p", names.length ? "Loading trigger words…" : "Select a LoRA first."));
    menu.showPopover();
    place();
    if (!names.length) return;
    button.setAttribute("aria-busy", "true");
    const groups = await Promise.all(names.map(async name => {
      try { return { name, words: await loadLoraTriggerWords(name) }; }
      catch (error) { return { name, words: [], error: error.message || "Trigger words could not be loaded." }; }
    }));
    if (!current()) { if (token === revision) close(); return; }
    button.removeAttribute("aria-busy");
    if (groups.length === 1 && groups[0].words.length === 1) {
      append(groups[0].words[0]);
      close();
      editor.focus();
      return;
    }
    menu.replaceChildren();
    for (const group of groups) {
      const section = make("section", "");
      section.append(make("h4", group.name));
      if (!group.words.length) section.append(make("p", group.error || "No trigger words available for this LoRA."));
      for (const word of group.words) {
        const choice = make("button", word);
        choice.type = "button";
        choice.addEventListener("click", () => append(word));
        section.append(choice);
      }
      menu.append(section);
    }
    place();
    menu.querySelector("button")?.focus();
  });
}
