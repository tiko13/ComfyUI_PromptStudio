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
  const normalize = value => value.toLowerCase().replaceAll("\\", "/");
  const searchText = new Map(items.map(item => [item, normalize(`${item.label} ${item.name}`)]));
  const batchSize = 80;
  let rendered = 0;
  let renderStart = 0;
  let positioned = "";
  let active = -1;
  let positionFrame = 0;
  let positionView = null;
  let stopPositionTracking = () => {};
  input.disabled = !items.length;
  if (!items.length) input.placeholder = emptyText;

  function close() {
    stopPositionTracking();
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
    const geometry = [rect.x, rect.y, rect.width, rect.height, view.innerWidth, view.innerHeight, renderStart, rendered].join(':');
    if (geometry === positioned) return;
    positioned = geometry;
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
    stopPositionTracking();
    const doc = input.ownerDocument;
    positionView = doc.defaultView;
    let queued = false;
    const update = () => {
      if (input.ownerDocument !== doc) { trackPosition(); return; }
      if (queued || list.hidden) return;
      queued = true;
      positionFrame = positionView.requestAnimationFrame(() => { queued = false; if (!list.hidden) positionList(); });
    };
    doc.addEventListener('scroll', update, true);
    positionView.addEventListener('resize', update);
    positionView.visualViewport?.addEventListener('resize', update);
    const resize = new positionView.ResizeObserver(update);
    const mutations = new positionView.MutationObserver(update);
    // Observe layout causes, not every progress tick elsewhere in the panel.
    for (let node = input; node; node = node.parentElement) {
      resize.observe(node);
      mutations.observe(node, {childList:true,attributes:true,attributeFilter:['class','style','hidden','open']});
    }
    stopPositionTracking = () => {
      doc.removeEventListener('scroll', update, true);
      positionView?.removeEventListener('resize', update);
      positionView?.visualViewport?.removeEventListener('resize', update);
      resize.disconnect();mutations.disconnect();
      positionView?.cancelAnimationFrame(positionFrame);
    };
    update();
  }

  function highlight(index) {
    const previous = list.children[active - renderStart];
    previous?.setAttribute("aria-selected", "false");
    active = index;
    if (matches.length && (active < renderStart || active >= rendered + batchSize)) {
      // Wrapping ArrowUp from the first result must not create 10,000 nodes.
      renderStart = Math.max(0, active - batchSize + 1);
      rendered = renderStart;
      list.replaceChildren();appendBatch();
    }
    while (active >= rendered && rendered < matches.length) appendBatch();
    const option = matches.length ? list.children[active - renderStart] : null;
    if (option) {
      option.setAttribute("aria-selected", "true");
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

  function optionElement(item, index) {
    const option = input.ownerDocument.createElement('div');
    option.id = `${list.id}-${index}`;
    option.dataset.index = String(index);
    option.setAttribute('role', 'option');
    option.setAttribute('aria-setsize', String(matches.length));
    option.setAttribute('aria-posinset', String(index + 1));
    option.setAttribute('aria-selected', String(index === active));
    option.textContent = item.label;
    option.title = item.name;
    return option;
  }

  function appendBatch() {
    const fragment = document.createDocumentFragment();
    const end = Math.min(rendered + batchSize, matches.length);
    for (; rendered < end; rendered++) {
      const index = rendered;
      fragment.appendChild(optionElement(matches[index], index));
    }
    list.appendChild(fragment);
  }
  list.addEventListener("pointerdown", event => event.preventDefault());
  list.addEventListener("click", event => {
    const option = event.target.closest('[data-index]');
    if (option) choose(Number(option.dataset.index));
  });
  list.addEventListener("scroll", () => {
    if (list.scrollTop < 40 && renderStart > 0) {
      const height = list.scrollHeight;
      const start = Math.max(0, renderStart - batchSize);
      const fragment = input.ownerDocument.createDocumentFragment();
      for (let index = start; index < renderStart; index++) fragment.appendChild(optionElement(matches[index], index));
      renderStart = start;
      list.prepend(fragment);
      list.scrollTop += list.scrollHeight - height;
    }
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 100) appendBatch();
  }, { passive: true });

  function open(query = "") {
    const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
    matches = items.filter(item => terms.every(term => searchText.get(item).includes(term)));
    list.replaceChildren();
    active = -1;
    rendered = 0;
    renderStart = 0;
    positioned = "";
    appendBatch();
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
    positioned = "";
    positionList();
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
