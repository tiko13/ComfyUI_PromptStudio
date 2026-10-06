let nextId = 0;

/** Search labels and registered names, committing only an explicit choice. */
export function createSearchableSelect({ items, label, placeholder, emptyText, onSelect }) {
  const root = document.createElement("div");
  root.className = "promptstudio-searchable-select";
  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = placeholder;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-label", label);
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  const list = document.createElement("div");
  list.id = `promptstudio-searchable-select-${++nextId}`;
  list.className = "promptstudio-searchable-options";
  // The top layer escapes the LoRA card and scrollable sidebar's clipping.
  list.setAttribute("popover", "manual");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", label);
  list.hidden = true;
  input.setAttribute("aria-controls", list.id);
  let matches = items;
  let active = -1;
  let positionFrame = 0;
  let positionView = null;
  input.disabled = !items.length;
  if (!items.length) input.placeholder = emptyText;

  function close() {
    positionView?.cancelAnimationFrame(positionFrame);
    if (list.matches(":popover-open")) list.hidePopover();
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    input.value = "";
  }

  function positionList() {
    if (!input.isConnected || !input.getClientRects().length) {
      close();
      return;
    }
    const rect = input.getBoundingClientRect();
    // Standalone Studio moves controls out of its hidden ComfyUI host frame.
    // Resolve the current document after adoption, not the creation window.
    const view = input.ownerDocument.defaultView;
    const gap = 4;
    const margin = 8;
    const maxHeight = Math.min(480, view.innerHeight * 0.65);
    const below = Math.max(0, view.innerHeight - rect.bottom - gap - margin);
    const above = Math.max(0, rect.top - gap - margin);
    const neededHeight = Math.min(maxHeight, list.scrollHeight + 2);
    const upwards = below < neededHeight && above > below;
    const height = Math.min(maxHeight, upwards ? above : below);
    const width = Math.min(Math.max(rect.width, 280), view.innerWidth - margin * 2);
    list.style.width = `${width}px`;
    list.style.maxHeight = `${height}px`;
    list.style.left = `${Math.max(margin, Math.min(rect.left, view.innerWidth - width - margin))}px`;
    list.style.top = `${upwards ? Math.max(margin, rect.top - gap - list.getBoundingClientRect().height) : rect.bottom + gap}px`;
  }

  function trackPosition() {
    if (list.hidden) return;
    positionList();
    // Also follows sidebar scrolling/reordering and stops after a rerender.
    if (!list.hidden) {
      positionView = input.ownerDocument.defaultView;
      positionFrame = positionView.requestAnimationFrame(trackPosition);
    }
  }

  function highlight(index) {
    active = index;
    [...list.children].forEach((option, i) => {
      option.setAttribute("aria-selected", String(i === active));
    });
    const option = matches.length ? list.children[active] : null;
    if (option) {
      input.setAttribute("aria-activedescendant", option.id);
      // Scroll only the results, never the surrounding sidebar.
      const top = option.offsetTop;
      const bottom = top + option.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    } else input.removeAttribute("aria-activedescendant");
  }

  function choose(index) {
    if (!matches[index]) return;
    const selected = matches[index];
    close();
    onSelect?.(selected.name);
  }

  function open(query = "") {
    const normalize = value => value.toLowerCase().replaceAll("\\", "/");
    const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
    matches = items.filter(item => terms.every(term => normalize(`${item.label} ${item.name}`).includes(term)));
    list.replaceChildren();
    matches.forEach((item, index) => {
      const option = document.createElement("div");
      option.id = `${list.id}-${index}`;
      option.setAttribute("role", "option");
      option.textContent = item.label;
      option.title = item.name;
      option.addEventListener("pointerdown", event => event.preventDefault());
      option.addEventListener("click", () => choose(index));
      list.appendChild(option);
    });
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.setAttribute("role", "status");
      empty.textContent = "No matching LoRAs";
      list.appendChild(empty);
    }
    list.hidden = false;
    positionList();
    if (list.hidden) return;
    if (!list.matches(":popover-open")) list.showPopover();
    positionView?.cancelAnimationFrame(positionFrame);
    trackPosition();
    input.setAttribute("aria-expanded", "true");
    highlight(matches.length ? 0 : -1);
  }

  input.addEventListener("focus", () => { open(); input.select(); });
  input.addEventListener("click", () => { if (list.hidden) { open(); input.select(); } });
  input.addEventListener("input", () => {
    open(input.value);
  });
  input.addEventListener("blur", close);
  input.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.hidden) open();
      else if (matches.length) highlight((active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
    } else if (event.key === "Enter" && !list.hidden) {
      event.preventDefault();
      event.stopPropagation();
      choose(active);
    } else if (event.key === "Escape" && !list.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  root.append(input, list);
  return { element: root };
}
