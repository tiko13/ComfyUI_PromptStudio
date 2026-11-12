import {layoutBinding, normalizeSpatialInput, spatialContractKey} from "../generation/spatial-inputs.js";
import {namedStructureInputs} from "../generation/workflow-capabilities.js";
import {bindSpatialCanvas} from "./spatial-editor-canvas.js";

// View state stays local. Only Apply publishes the draft to the chat store.
export function openSpatialEditor({profile, value, defaults, save, upload, imageUrl, aspect = 1, dimensions, ownerDocument = document}) {
  const win = ownerDocument.defaultView;
  if (!ownerDocument.querySelector('link[data-spatial-editor]')) {
    const css = ownerDocument.createElement("link"); css.rel = "stylesheet";
    css.href = new URL("../../../css/spatial-editor.css", import.meta.url).href;
    css.dataset.spatialEditor = "true"; ownerDocument.head.append(css);
  }
  const layout = layoutBinding(profile), slots = namedStructureInputs(profile);
  let draft = normalizeSpatialInput(value), selected = draft.elements[0]?.id || "";
  const initial = JSON.stringify(draft);
  let past = [], future = [], busy = false, mode = layout ? "layout" : "maps", tool = "select";
  let backgroundKey = "", mapKey = slots[0]?.key || "", opacity = .65, zoom = 1, pan = {x: 0, y: 0};
  let expandedField = "", draggedId = "";
  const cleanups = [];
  const opener = ownerDocument.activeElement;
  const studio = opener?.closest?.("#promptstudio-prompt-studio") || ownerDocument.getElementById("promptstudio-prompt-studio");
  const el = (tag, text, parent, className) => {
    const node = ownerDocument.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    parent?.append(node); return node;
  };
  const button = (label, action, parent, key = label) => {
    const b = el("button", label, parent); b.type = "button"; b.dataset.focus = key;
    b.addEventListener("click", action); return b;
  };
  const dialog = el("dialog", "", null, "ps-spatial-editor");
  let overlapMenu = null;
  function closeOverlapMenu(focus = false) {
    overlapMenu?.remove(); overlapMenu = null;
    if (focus) canvas.focus({preventScroll: true});
  }
  function chooseOverlap({elements, clientX, clientY}) {
    closeOverlapMenu();
    if (!elements.length) return;
    overlapMenu = el("div", "", dialog, "ps-spatial-overlap-menu");
    overlapMenu.setAttribute("role", "menu"); overlapMenu.setAttribute("aria-label", "Segments under pointer");
    el("p", "Select segment · foreground first", overlapMenu, "ps-spatial-muted");
    const choices = elements.map(e => {
      const b = button(`${e.type}: ${label(e)}`, () => {closeOverlapMenu(); selectSegment(e.id);}, overlapMenu, `overlap-${e.id}`);
      b.setAttribute("role", "menuitemradio"); b.setAttribute("aria-checked", String(e.id === selected)); return b;
    });
    const bounds = dialog.getBoundingClientRect();
    overlapMenu.style.left = `${Math.max(8, Math.min(clientX - bounds.left + 8, bounds.width - overlapMenu.offsetWidth - 8))}px`;
    overlapMenu.style.top = `${Math.max(8, Math.min(clientY - bounds.top + 8, bounds.height - overlapMenu.offsetHeight - 8))}px`;
    overlapMenu.addEventListener("keydown", event => {
      if (["Escape", "Tab"].includes(event.key)) {event.preventDefault(); event.stopPropagation(); closeOverlapMenu(true);}
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const index = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : (choices.indexOf(ownerDocument.activeElement) + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
        choices[index].focus();
      }
    });
    choices.find(b => b.getAttribute("aria-checked") === "true")?.focus();
    if (!overlapMenu.contains(ownerDocument.activeElement)) choices[0].focus();
  }
  dialog.addEventListener("pointerdown", event => {if (overlapMenu && !overlapMenu.contains(event.target)) closeOverlapMenu();}, true);
  function sizeDialog() {
    const bounds = studio?.getBoundingClientRect();
    const width = win.innerWidth, height = win.innerHeight;
    const visible = bounds && bounds.width > 0 && bounds.height > 0;
    const w = Math.max(1, Math.min(visible ? bounds.width - 48 : 1840, width - 32));
    const h = Math.max(1, Math.min(visible ? bounds.height - 48 : height * .94, height - 32));
    dialog.style.setProperty("--spatial-dialog-width", `${w}px`);
    dialog.style.setProperty("--spatial-dialog-height", `${h}px`);
    dialog.style.setProperty("--spatial-dialog-left", `${visible ? Math.max(w / 2 + 16, Math.min(width - w / 2 - 16, bounds.x + bounds.width / 2)) : width / 2}px`);
    dialog.style.setProperty("--spatial-dialog-top", `${visible ? Math.max(h / 2 + 16, Math.min(height - h / 2 - 16, bounds.y + bounds.height / 2)) : height / 2}px`);
    closeOverlapMenu();
  }
  const header = el("header", "", dialog, "ps-spatial-header"), heading = el("div", "", header);
  const title = el("h2", "Layout and control maps", heading);
  title.id = `spatial-title-${Date.now()}`; dialog.setAttribute("aria-labelledby", title.id);
  el("p", "Arrange your scene, then describe each segment.", heading, "ps-spatial-muted");
  const headerActions = el("div", "", header, "ps-spatial-toolbar");
  const maximize = button("Maximize", () => {
    dialog.classList.toggle("is-maximized");
    maximize.textContent = dialog.classList.contains("is-maximized") ? "Restore size" : "Maximize";
    maximize.setAttribute("aria-pressed", String(dialog.classList.contains("is-maximized")));
  }, headerActions);
  maximize.setAttribute("aria-pressed", "false");
  const more = el("details", "", headerActions, "ps-spatial-more"); el("summary", "More", more);
  const menu = el("div", "", more, "ps-spatial-menu");
  button("Export layout", () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], {type: "application/json"}));
    const a = el("a"); a.href = url; a.download = "studio-layout.json"; a.click();
    win.setTimeout(() => URL.revokeObjectURL(url), 1000); more.open = false;
  }, menu);
  const importInput = el("input", "", menu); importInput.type = "file"; importInput.accept = ".json"; importInput.hidden = true;
  importInput.setAttribute("aria-label", "Import layout");
  button("Import layout", () => importInput.click(), menu);
  importInput.addEventListener("change", async () => {
    const file = importInput.files[0]; if (!file || busy) return;
    setBusy(true, "Importing layout…");
    try {
      if (file.size > 1024 * 1024) throw new Error("Layout file is too large.");
      const next = normalizeSpatialInput(JSON.parse(await file.text()));
      update(() => {draft = next; selected = draft.elements[0]?.id || "";});
      status.textContent = "Layout imported. Apply changes to save.";
    } catch (error) {status.textContent = error.message;}
    finally {setBusy(false); importInput.value = ""; more.open = false;}
  });
  button("Reset to workflow", () => {update(() => {draft = normalizeSpatialInput(defaults); selected = draft.elements[0]?.id || "";}); more.open = false;}, menu);
  el("p", "Canvas: Delete · Ctrl+D · arrows / Shift+arrows. Alt+click cycles overlapping segments; right-click lists them. Undo: Ctrl+Z. Redo: Ctrl+Shift+Z. Space + drag to pan.", menu, "ps-spatial-muted");
  const topbar = el("div", "", dialog, "ps-spatial-topbar");
  const tabs = el("div", "", topbar, "ps-spatial-toolbar"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Editor mode");
  const tabButtons = [];
  for (const [key, name, available] of [["layout", "Layout", layout], ["maps", "Control maps", slots.length]]) {
    if (!available) continue;
    const b = button(name, () => {mode = key; expandedField = ""; render();}, tabs);
    b.setAttribute("role", "tab"); b.id = `${title.id}-${key}`; b.dataset.mode = key; tabButtons.push(b);
    b.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = event.key === "Home" ? 0 : event.key === "End" ? tabButtons.length - 1 : (tabButtons.indexOf(b) + (event.key === "ArrowRight" ? 1 : -1) + tabButtons.length) % tabButtons.length;
      tabButtons[index].click(); tabButtons[index].focus();
    });
  }
  const historyTools = el("div", "", topbar, "ps-spatial-toolbar");
  const undo = button("Undo", () => history(false), historyTools), redo = button("Redo", () => history(true), historyTools);
  const panelTools = el("div", "", topbar, "ps-spatial-toolbar ps-spatial-panel-tools");
  const listToggle = button("Segments", () => togglePanel("list"), panelTools);
  const propertiesToggle = button("Properties", () => togglePanel("properties"), panelTools);
  const work = el("div", "", dialog, "ps-spatial-workspace");
  work.id = `${title.id}-workspace`; work.setAttribute("role", "tabpanel");
  tabButtons.forEach(b => b.setAttribute("aria-controls", work.id));
  const left = el("aside", "", work, "ps-spatial-segments"); left.setAttribute("aria-label", "Segments and maps");
  splitter("list", "Resize segment panel");
  const center = el("section", "", work, "ps-spatial-center");
  const canvasTools = el("div", "", center, "ps-spatial-toolbar ps-spatial-canvas-tools");
  const viewport = el("div", "", center, "ps-spatial-viewport");
  const canvas = el("div", "", viewport, "ps-spatial-canvas");
  canvas.tabIndex = 0; canvas.setAttribute("role", "group");
  canvas.setAttribute("aria-label", "Layout canvas. Select or draw segments; Delete removes selection; arrow keys move selection.");
  const hint = el("p", "", center, "ps-spatial-canvas-hint");
  splitter("properties", "Resize properties panel");
  const inspector = el("aside", "", work, "ps-spatial-inspector"); inspector.setAttribute("aria-label", "Segment properties");
  const footer = el("footer", "", dialog, "ps-spatial-footer");
  const feedback = el("div", "", footer, "ps-spatial-feedback");
  const dirty = el("span", "", feedback), status = el("span", "", feedback); status.setAttribute("role", "status");
  const footerActions = el("div", "", footer, "ps-spatial-toolbar");
  const close = () => {if (!busy) {resizeObserver.disconnect(); studioObserver.disconnect(); win.removeEventListener("resize", sizeDialog); cleanups.forEach(cleanup => cleanup()); unbindCanvas(); dialog.close(); dialog.remove(); opener?.focus?.();}};
  const cancelButton = button("Cancel", close, footerActions);
  const apply = button("Apply changes", () => {
    try {save(normalizeSpatialInput({...draft, contract: spatialContractKey(profile)})); close();}
    catch (error) {status.textContent = error.message;}
  }, footerActions); apply.className = "ps-spatial-primary";

  function snapshot() {return {draft: structuredClone(draft), selected};}
  function checkpoint(before = snapshot()) {past.push(before); if (past.length > 50) past.shift(); future = [];}
  function update(action) {
    const before = snapshot(); action(); draft = normalizeSpatialInput(draft);
    if (JSON.stringify(before.draft) !== JSON.stringify(draft)) checkpoint(before);
    render();
  }
  function history(forward) {
    if (busy) return;
    const source = forward ? future : past, target = forward ? past : future;
    if (!source.length) return;
    target.push(snapshot()); ({draft, selected} = source.pop()); render();
  }
  function label(e) {return (e.type === "text" ? e.text : e.description).trim().slice(0, 80) || `Untitled ${e.type}`;}
  function signature() {return JSON.stringify(draft.elements.map(e => [e.id, e.x, e.y, e.width, e.height]));}
  function sync() {
    undo.disabled = busy || !past.length; redo.disabled = busy || !future.length;
    const stale = Object.values(draft.guides).some(g => g.layoutSignature && g.layoutSignature !== signature());
    dirty.textContent = (JSON.stringify(draft) === initial ? "No unapplied changes" : "Unapplied changes") + (stale ? " · Layout changed: regenerate color map" : "");
    for (const box of canvas.querySelectorAll(".ps-spatial-box")) {
      const e = draft.elements.find(e => e.id === box.dataset.id);
      if (e) {
        const caption = box.querySelector(".ps-spatial-box-label"), text = label(e);
        if (caption.textContent !== text) caption.textContent = text;
        for (const [key, value] of Object.entries({left: `${e.x * 100}%`, top: `${e.y * 100}%`, width: `${e.width * 100}%`, height: `${e.height * 100}%`})) {
          if (box.style[key] !== value) box.style[key] = value;
        }
      }
    }
    for (const row of left.querySelectorAll("[data-segment]")) {
      const e = draft.elements.find(e => e.id === row.dataset.segment);
      if (e) {
        const caption = row.querySelector(".ps-spatial-segment-name"), text = label(e);
        if (caption.textContent !== text) caption.textContent = text;
      }
    }
    const current = draft.elements.find(e => e.id === selected);
    current?.palette.forEach((color, index) => {
      for (const name of [`Color ${index + 1}`, `Hex ${index + 1}`]) {
        const input = inspector.querySelector(`[aria-label="${name}"]`);
        if (input && input !== ownerDocument.activeElement) input.value = color;
      }
    });
  }
  function setBusy(next, message) {
    busy = next; work.inert = next; topbar.inert = next; menu.inert = next;
    work.setAttribute("aria-busy", String(next));
    apply.disabled = next; cancelButton.disabled = next; if (message) status.textContent = message;
    if (next) sync(); else render();
  }
  function togglePanel(name) {
    if (win.matchMedia("(max-width: 760px)").matches) dialog.dataset.sheet = dialog.dataset.sheet === name ? "" : name;
    else {
      const visible = win.getComputedStyle(name === "list" ? left : inspector).display !== "none";
      dialog.classList.toggle(`hide-${name}`, visible); dialog.classList.toggle(`show-${name}`, !visible);
    }
    syncPanels();
    for (const input of inspector.querySelectorAll("textarea")) grow(input);
  }
  function syncPanels() {
    const narrow = win.matchMedia("(max-width: 760px)").matches;
    center.inert = narrow && ["list", "properties"].includes(dialog.dataset.sheet);
    listToggle.setAttribute("aria-pressed", String(narrow ? dialog.dataset.sheet === "list" : win.getComputedStyle(left).display !== "none"));
    propertiesToggle.setAttribute("aria-pressed", String(narrow ? dialog.dataset.sheet === "properties" : win.getComputedStyle(inspector).display !== "none"));
  }
  function splitter(name, labelText) {
    const bar = el("div", "", work, `ps-spatial-splitter ps-spatial-splitter-${name}`);
    bar.tabIndex = 0; bar.setAttribute("role", "separator"); bar.setAttribute("aria-label", labelText); bar.setAttribute("aria-orientation", "vertical");
    const min = name === "list" ? 180 : 300, max = name === "list" ? 340 : 580;
    let width = name === "list" ? 220 : 380, resizeFrame = 0, pendingWidth = width;
    cleanups.push(() => {if (resizeFrame) win.cancelAnimationFrame(resizeFrame);});
    bar.setAttribute("aria-valuemin", String(min)); bar.setAttribute("aria-valuemax", String(max)); bar.setAttribute("aria-valuenow", String(width));
    const resize = next => {width = Math.max(min, Math.min(max, next)); dialog.style.setProperty(`--spatial-${name}-width`, `${width}px`); bar.setAttribute("aria-valuenow", String(width));};
    bar.addEventListener("keydown", event => {if (["ArrowLeft", "ArrowRight"].includes(event.key)) {event.preventDefault(); resize(width + (event.key === "ArrowRight" ? 20 : -20) * (name === "list" ? 1 : -1));}});
    bar.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault(); const start = event.clientX, original = width; bar.setPointerCapture(event.pointerId);
      const paintResize = () => {resizeFrame = 0; resize(pendingWidth);};
      const move = ev => {
        pendingWidth = original + (ev.clientX - start) * (name === "list" ? 1 : -1);
        if (!resizeFrame) resizeFrame = win.requestAnimationFrame(paintResize);
      };
      pendingWidth = width;
      const end = () => {
        if (resizeFrame) {win.cancelAnimationFrame(resizeFrame); paintResize();}
        bar.removeEventListener("pointermove", move); bar.removeEventListener("pointerup", end); bar.removeEventListener("pointercancel", end);
      };
      bar.addEventListener("pointermove", move); bar.addEventListener("pointerup", end); bar.addEventListener("pointercancel", end);
    });
  }
  function field(labelText, type, val, action, parent, live = false) {
    const row = el("label", "", parent, "ps-spatial-field"); el("span", labelText, row);
    const input = el(type === "textarea" ? "textarea" : "input", "", row);
    if (type !== "textarea") input.type = type;
    if (type === "checkbox") input.checked = val; else input.value = val;
    input.setAttribute("aria-label", labelText); input.dataset.focus = labelText;
    if (type === "textarea") {input.rows = 7; input.maxLength = 12000; input.classList.toggle("is-expanded", expandedField === labelText);}
    let editing = false;
    input.addEventListener(live ? "input" : "change", () => {
      const next = type === "checkbox" ? input.checked : type === "number" ? input.valueAsNumber : input.value;
      if (type === "number" && !Number.isFinite(next)) return;
      if (live) {if (!editing) {checkpoint(); editing = true;} action(next); sync(); if (type === "textarea") grow(input);}
      else update(() => action(next));
    });
    input.addEventListener("blur", () => {editing = false;});
    if (type === "textarea") {
      const expand = button(expandedField === labelText ? "Shrink editor" : "Expand editor", () => {
        expandedField = expandedField === labelText ? "" : labelText; input.classList.toggle("is-expanded", expandedField === labelText);
        expand.textContent = expandedField === labelText ? "Shrink editor" : "Expand editor"; grow(input); input.focus();
      }, row, `expand-${labelText}`); expand.className = "ps-spatial-text-action";
    }
    return input;
  }
  function grow(input) {input.style.height = "auto"; input.style.height = `${input.scrollHeight + 2}px`;}
  function select(labelText, options, val, action, parent, viewOnly = false) {
    const row = el("label", "", parent, "ps-spatial-field"); el("span", labelText, row);
    const input = el("select", "", row); input.setAttribute("aria-label", labelText); input.dataset.focus = labelText;
    for (const [value, name] of options) {const option = el("option", name, input); option.value = value;}
    input.value = val;
    input.addEventListener("change", () => viewOnly ? (action(input.value), render()) : update(() => action(input.value)));
    return input;
  }
  function selectSegment(id) {
    selected = id; expandedField = ""; tool = "select";
    if (win.matchMedia("(max-width: 760px)").matches) dialog.dataset.sheet = "properties";
    refreshSelection(); renderCanvasTools(); canvas.dataset.tool = tool; updateCanvasHint(); canvas.focus({preventScroll: true});
  }
  function addHandles(box) {
    for (const edge of ["n", "ne", "e", "se", "s", "sw", "w", "nw"]) {
      const handle = el("span", "", box, `ps-spatial-resize ps-spatial-resize-${edge}`); handle.dataset.edge = edge;
    }
  }
  function refreshSelection() {
    closeOverlapMenu();
    for (const box of canvas.querySelectorAll(".ps-spatial-box")) {
      const active = box.dataset.id === selected;
      box.classList.toggle("selected", active);
      if (!active) box.querySelectorAll(".ps-spatial-resize").forEach(handle => handle.remove());
      else if (draft.enabled && !box.querySelector(".ps-spatial-resize")) addHandles(box);
    }
    for (const row of left.querySelectorAll("[data-segment]")) row.setAttribute("aria-pressed", String(row.dataset.segment === selected));
    renderInspector();
    for (const input of inspector.querySelectorAll("textarea")) grow(input);
    syncPanels();
  }
  function finishGesture(before, changed) {
    if (changed) checkpoint(before);
    // Geometry is already clamped by the gesture handler. Preserve the objects
    // captured by inspector listeners instead of normalizing/replacing the tree.
    const e = draft.elements.find(e => e.id === selected);
    if (e) for (const key of ["x", "y", "width", "height"]) {
      const input = inspector.querySelector(`[aria-label="${key} (%)"]`);
      if (input) input.value = String(Math.round(e[key] * 1000) / 10);
    }
    sync(); canvas.focus({preventScroll: true});
  }
  function add(type) {
    if (!draft.enabled || draft.elements.length >= 64) return;
    update(() => {const e = {id: crypto.randomUUID(), type, x: .1, y: .1, width: .35, height: .2, description: "", text: "", palette: []}; draft.elements.push(e); selected = e.id;});
    if (win.matchMedia("(max-width: 760px)").matches) {dialog.dataset.sheet = "properties"; syncPanels();}
    inspector.querySelector("textarea")?.focus();
  }
  function remove() {
    if (!selected || !draft.enabled) return;
    update(() => {const index = draft.elements.findIndex(e => e.id === selected); draft.elements = draft.elements.filter(e => e.id !== selected); selected = draft.elements[Math.min(index, draft.elements.length - 1)]?.id || "";});
  }
  function duplicate() {
    const e = draft.elements.find(e => e.id === selected);
    if (!e || !draft.enabled || draft.elements.length >= 64) return;
    update(() => {const copy = {...structuredClone(e), id: crypto.randomUUID(), x: Math.min(1 - e.width, e.x + .02), y: Math.min(1 - e.height, e.y + .02)}; draft.elements.push(copy); selected = copy.id;});
  }
  function reorder(id, target) {
    update(() => {const from = draft.elements.findIndex(e => e.id === id); if (from < 0 || target < 0 || target >= draft.elements.length || !draft.enabled) return; const [item] = draft.elements.splice(from, 1); draft.elements.splice(target, 0, item);});
  }

  // Rendering helpers below only replace panels, never a field while typing.
  function renderList() {
    left.replaceChildren(); el("h3", mode === "layout" ? "Segments" : "Map inputs", left);
    if (mode === "maps") {
      for (const slot of slots) {
        const b = button("", () => {
          mapKey = slot.key;
          if (win.matchMedia("(max-width: 760px)").matches) dialog.dataset.sheet = "properties";
          render();
        }, left, `map-${slot.key}`);
        b.className = "ps-spatial-map-row"; b.setAttribute("aria-pressed", String(mapKey === slot.key));
        if (draft.guides[slot.key]) {
          const img = el("img", "", b, "ps-spatial-map-thumb"); img.src = imageUrl(draft.guides[slot.key].image); img.alt = "";
        }
        el("span", `${slot.key} map`, b);
        el("small", draft.guides[slot.key]?.enabled ? "Enabled" : draft.guides[slot.key] ? "Disabled" : "No image", b);
      }
      return;
    }
    field("Use layout", "checkbox", draft.enabled, v => {draft.enabled = v;}, left);
    const addTools = el("div", "", left, "ps-spatial-add-tools");
    for (const type of ["object", "character", "text"]) button(`Add ${type}`, () => add(type), addTools).disabled = !draft.enabled || draft.elements.length >= 64;
    el("p", "Foreground at top · drag to reorder", left, "ps-spatial-muted");
    const list = el("div", "", left, "ps-spatial-segment-list"); list.setAttribute("aria-label", "Segments, foreground first");
    for (const e of [...draft.elements].reverse()) {
      const b = button("", () => selectSegment(e.id), list, `segment-${e.id}`);
      b.className = "ps-spatial-segment"; b.dataset.segment = e.id; b.draggable = draft.enabled; b.setAttribute("aria-pressed", String(selected === e.id));
      el("span", {object: "◇", character: "♙", text: "T"}[e.type], b, "ps-spatial-type-icon").setAttribute("aria-hidden", "true");
      const text = el("span", "", b); el("span", label(e), text, "ps-spatial-segment-name"); el("small", e.type, text);
      b.addEventListener("dragstart", event => {draggedId = e.id; event.dataTransfer.setData("text/plain", e.id); event.dataTransfer.effectAllowed = "move";});
      b.addEventListener("dragover", event => {if (draggedId) {event.preventDefault(); event.dataTransfer.dropEffect = "move";}});
      b.addEventListener("drop", event => {event.preventDefault(); if (draggedId) reorder(draggedId, draft.elements.findIndex(x => x.id === e.id)); draggedId = "";});
      b.addEventListener("dragend", () => {draggedId = "";});
    }
    if (!draft.elements.length) el("p", "Add a segment or choose Draw and drag on the canvas.", list, "ps-spatial-empty");
  }
  function renderInspector() {
    inspector.replaceChildren();
    if (mode === "maps") {renderMapInspector(); return;}
    const e = draft.elements.find(e => e.id === selected); el("h3", "Segment properties", inspector);
    if (!e) {el("p", "Select a segment to describe it, change its colors or set its position.", inspector, "ps-spatial-empty"); return;}
    const quickActions = el("div", "", inspector, "ps-spatial-toolbar ps-spatial-quick-actions");
    button("Duplicate", duplicate, quickActions).disabled = !draft.enabled || draft.elements.length >= 64;
    const del = button("Delete", remove, quickActions); del.className = "ps-spatial-delete"; del.disabled = !draft.enabled;
    select("Element type", [["object", "Object"], ["character", "Character"], ["text", "Exact text"]], e.type, v => {e.type = v;}, inspector);
    if (e.type === "text") field("Exact text", "textarea", e.text, v => {e.text = v;}, inspector, true);
    const description = field("Description", "textarea", e.description, v => {e.description = v;}, inspector, true);
    description.placeholder = e.type === "text" ? "Describe the lettering, material and appearance…" : "Describe this segment’s subject, appearance and details…";
    el("h4", "Position and size", inspector);
    const geometry = el("div", "", inspector, "ps-spatial-geometry");
    for (const name of ["x", "y", "width", "height"]) {
      const input = field(`${name} (%)`, "number", Math.round(e[name] * 1000) / 10, v => {
        const isSize = name === "width" || name === "height";
        const other = {x: "width", y: "height", width: "x", height: "y"}[name];
        e[name] = Math.max(isSize ? .001 : 0, Math.min(1 - e[other], v / 100));
      }, geometry, true);
      input.min = name === "width" || name === "height" ? "0.1" : "0"; input.max = "100"; input.step = "0.1";
      input.addEventListener("blur", () => {input.value = String(Math.round(e[name] * 1000) / 10);});
    }
    const align = el("div", "", inspector, "ps-spatial-toolbar");
    button("Center horizontally", () => update(() => {e.x = (1 - e.width) / 2;}), align);
    button("Center vertically", () => update(() => {e.y = (1 - e.height) / 2;}), align);
    el("h4", "Appearance palette", inspector);
    el("p", "Desired subject colors, separate from control-map region IDs.", inspector, "ps-spatial-muted");
    const palette = el("div", "", inspector, "ps-spatial-palette");
    e.palette.forEach((color, index) => {
      const row = el("div", "", palette, "ps-spatial-color");
      field(`Color ${index + 1}`, "color", color, v => {e.palette[index] = v;}, row, true);
      const hex = field(`Hex ${index + 1}`, "text", color, v => {if (/^#[0-9a-f]{6}$/i.test(v)) {e.palette[index] = v; status.textContent = "";} else status.textContent = "Use a six-digit hex color, such as #3366aa.";}, row, true);
      hex.maxLength = 7;
      button("×", () => update(() => {e.palette.splice(index, 1);}), row, `remove-color-${index}`).setAttribute("aria-label", `Remove color ${index + 1}`);
    });
    button("Add color", () => update(() => {e.palette.push("#7cb8e8");}), palette).disabled = e.palette.length >= 5;
    const actions = el("div", "", inspector, "ps-spatial-toolbar ps-spatial-segment-actions");
    const index = draft.elements.indexOf(e);
    button("Bring forward", () => reorder(e.id, index + 1), actions).disabled = !draft.enabled || index === draft.elements.length - 1;
    button("Send backward", () => reorder(e.id, index - 1), actions).disabled = !draft.enabled || index === 0;
  }
  async function runUpload(file, slot, layoutSignature = "") {
    if (!file || busy) return;
    if (!file.type.startsWith("image/") || !file.size || file.size > 20 * 1024 * 1024) {status.textContent = "Choose an image smaller than 20 MB."; return;}
    setBusy(true, "Uploading control map…");
    try {
      const image = await upload(file);
      update(() => {draft.guides[slot.key] = {image, kind: slot.kinds[0], enabled: true, input: "prepared", fit: draft.alignment, invert: false, ...(layoutSignature ? {layoutSignature} : {})};});
      status.textContent = "Map uploaded. Apply changes to save.";
    } catch (error) {status.textContent = error.message;}
    finally {setBusy(false);}
  }
  async function generateMap(slot) {
    if (busy) return;
    const sourceSignature = signature(), map = el("canvas");
    map.width = dimensions?.width || 1024; map.height = dimensions?.height || Math.max(16, Math.round(1024 / (aspect || 1)));
    const ctx = map.getContext("2d"); ctx.fillStyle = "#000000"; ctx.fillRect(0, 0, map.width, map.height);
    draft.elements.forEach((e, index) => {ctx.fillStyle = `hsl(${index * 137.508 % 360} 85% 55%)`; ctx.fillRect(Math.round(e.x * map.width), Math.round(e.y * map.height), Math.round(e.width * map.width), Math.round(e.height * map.height));});
    setBusy(true, "Creating color map…");
    try {
      const blob = await new Promise(resolve => map.toBlob(resolve, "image/png")); setBusy(false);
      if (!blob) throw new Error("Could not create the color map.");
      await runUpload(new File([blob], "layout-regions.png", {type: "image/png"}), {...slot, kinds: ["color"]}, sourceSignature);
    } catch (error) {setBusy(false); status.textContent = error.message;}
  }
  function renderMapInspector() {
    const slot = slots.find(s => s.key === mapKey) || slots[0]; if (!slot) return;
    mapKey = slot.key; const g = draft.guides[slot.key]; el("h3", `${slot.key} map`, inspector);
    const drop = el("div", "", inspector, "ps-spatial-drop"); el("p", "Drop an image here", drop);
    const input = el("input", "", drop); input.type = "file"; input.accept = "image/png,image/jpeg,image/webp"; input.hidden = true; input.setAttribute("aria-label", `Upload ${slot.key} map`);
    button(g ? "Replace image" : "Choose image", () => input.click(), drop);
    input.addEventListener("change", () => runUpload(input.files[0], slot));
    drop.addEventListener("dragover", event => {event.preventDefault(); drop.classList.add("is-over");});
    drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
    drop.addEventListener("drop", event => {event.preventDefault(); drop.classList.remove("is-over"); runUpload(event.dataTransfer.files[0], slot);});
    if (layout && slot.kinds.includes("color")) {
      button("Create color map from layout", () => generateMap(slot), inspector).disabled = busy || !draft.enabled || !draft.elements.length;
      if (g?.layoutSignature && g.layoutSignature !== signature()) el("p", "Layout changed — regenerate this map to match the boxes.", inspector, "ps-spatial-warning");
    }
    if (g) {
      field(`Use ${slot.key} map`, "checkbox", g.enabled, v => {g.enabled = v;}, inspector);
      if (slot.kinds.length > 1) select(`${slot.key} map type`, slot.kinds.map(k => [k, k]), g.kind, v => {g.kind = v; g.input = "prepared"; g.invert = false; delete g.layoutSignature;}, inspector);
      if (g.kind === "depth") {
        select("Depth source", [["prepared", "Prepared depth map"], ["photo", "Extract from photo"]], g.input, v => {g.input = v;}, inspector);
        field("Invert depth", "checkbox", g.invert, v => {g.invert = v;}, inspector);
      }
      button(`Remove ${slot.key} map`, () => update(() => {delete draft.guides[slot.key];}), inspector);
    }
    select("Map alignment", [["fit", "Fit with padding"], ["crop", "Center crop"], ["stretch", "Stretch to canvas"]], draft.alignment, v => {draft.alignment = v; for (const guide of Object.values(draft.guides)) guide.fit = v;}, inspector);
    el("p", "Alignment applies to all maps. Match their framing. Color maps identify regions; depth uses near-white, far-black.", inspector, "ps-spatial-muted");
    if (g?.input === "photo") el("p", "Showing the source photo. Depth is extracted during generation using the optional depth extractor.", inspector, "ps-spatial-muted");
  }
  function renderCanvas() {
    canvas.replaceChildren();
    const background = draft.guides[mode === "maps" ? mapKey : backgroundKey];
    if (background) {
      const img = el("img", "", canvas, "ps-spatial-background"); img.src = imageUrl(background.image); img.alt = mode === "maps" ? `${mapKey} map preview` : ""; img.draggable = false;
      img.style.objectFit = draft.alignment === "crop" ? "cover" : draft.alignment === "stretch" ? "fill" : "contain";
      img.style.opacity = String(mode === "maps" ? 1 : opacity);
      if (background.kind === "depth" && background.invert && background.input !== "photo") img.style.filter = "invert(1)";
    }
    if (mode === "layout") for (const e of draft.elements) {
      const box = el("div", "", canvas, "ps-spatial-box"); box.dataset.id = e.id; box.classList.toggle("selected", e.id === selected); box.classList.toggle("is-disabled", !draft.enabled);
      Object.assign(box.style, {left: `${e.x * 100}%`, top: `${e.y * 100}%`, width: `${e.width * 100}%`, height: `${e.height * 100}%`});
      el("span", label(e), box, "ps-spatial-box-label");
      if (e.id === selected && draft.enabled) addHandles(box);
    }
    canvas.dataset.tool = mode === "maps" ? "pan" : tool;
    if (mode === "maps" && !background) el("div", "Choose an image to preview this control map", canvas, "ps-spatial-canvas-empty");
    updateCanvasHint();
    sizeCanvas();
  }
  function updateCanvasHint() {
    hint.textContent = mode === "maps" ? "Preview uses the output framing. Disabled maps are not used for generation." : !draft.enabled ? "Layout is disabled. Enable it to use these segments." : tool === "draw" ? "Drag to draw an object. Choose its type and describe it in Properties." : "Overlapping segments: right-click to choose · Alt+click to cycle · drag selection to move · Delete to remove";
  }
  function sizeCanvas() {
    const width = Math.max(1, viewport.clientWidth - 48), height = Math.max(1, viewport.clientHeight - 48), ratio = aspect > 0 ? aspect : 1;
    const w = Math.min(width, height * ratio); canvas.style.width = `${w}px`; canvas.style.height = `${w / ratio}px`;
    positionCanvas();
  }
  function positionCanvas() {canvas.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;}
  function renderCanvasTools() {
    canvasTools.replaceChildren();
    if (mode === "layout") {
      for (const [key, name] of [["select", "Select"], ["draw", "Draw"], ["pan", "Pan"]]) {
        const b = button(name, () => {tool = key; render(); canvas.focus();}, canvasTools);
        b.setAttribute("aria-pressed", String(tool === key)); b.disabled = !draft.enabled && key === "draw";
      }
      select("Canvas background", [["", "Grid"], ...Object.entries(draft.guides).filter(([, g]) => g.image).map(([key]) => [key, `${key} map`])], backgroundKey, key => {backgroundKey = key;}, canvasTools, true);
      if (draft.guides[backgroundKey]) {
        const row = el("label", "Opacity", canvasTools, "ps-spatial-field"), slider = el("input", "", row);
        slider.type = "range"; slider.min = "0"; slider.max = "1"; slider.step = ".05"; slider.value = String(opacity); slider.setAttribute("aria-label", "Opacity");
        slider.addEventListener("input", () => {opacity = Number(slider.value); const img = canvas.querySelector("img"); if (img) img.style.opacity = String(opacity);});
      }
    }
    const zoomTools = el("div", "", canvasTools, "ps-spatial-toolbar ps-spatial-zoom");
    button("−", () => changeZoom(zoom / 1.25), zoomTools, "zoom-out").setAttribute("aria-label", "Zoom out");
    el("span", `${Math.round(zoom * 100)}%`, zoomTools);
    button("+", () => changeZoom(zoom * 1.25), zoomTools, "zoom-in").setAttribute("aria-label", "Zoom in");
    button("Fit canvas", () => {zoom = 1; pan = {x: 0, y: 0}; sizeCanvas(); renderCanvasTools();}, zoomTools);
  }
  function changeZoom(next) {zoom = Math.max(.25, Math.min(4, next)); sizeCanvas(); renderCanvasTools();}
  function render() {
    closeOverlapMenu();
    const active = ownerDocument.activeElement, focus = active?.dataset?.focus;
    const scrollLeft = left.scrollTop, scrollRight = inspector.scrollTop;
    if (selected && !draft.elements.some(e => e.id === selected)) selected = "";
    for (const b of tabButtons) {b.setAttribute("aria-selected", String(b.dataset.mode === mode)); b.tabIndex = b.dataset.mode === mode ? 0 : -1;}
    work.setAttribute("aria-labelledby", `${title.id}-${mode}`); listToggle.textContent = mode === "layout" ? "Segments" : "Maps";
    renderList(); renderInspector(); renderCanvasTools(); renderCanvas(); sync(); syncPanels();
    for (const input of inspector.querySelectorAll("textarea")) grow(input);
    left.scrollTop = scrollLeft; inspector.scrollTop = scrollRight;
    if (focus && active !== ownerDocument.activeElement) [...dialog.querySelectorAll("[data-focus]")].find(n => n.dataset.focus === focus)?.focus({preventScroll: true});
  }
  const unbindCanvas = bindSpatialCanvas({canvas, viewport, ownerDocument,
    getState: () => ({draft, selected, mode, tool, busy, pan}), snapshot,
    select: id => {selected = id;}, refreshSelection, render, chooseOverlap,
    finish: finishGesture,
    cancel: before => {({draft, selected} = before); render();}, pan: next => {pan = next; positionCanvas();},
  });
  dialog.addEventListener("keydown", event => {
    if (busy || event.isComposing || event.defaultPrevented || event.target.closest("input, textarea, select, [contenteditable=true]")) return;
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === "z") {event.preventDefault(); history(event.shiftKey); return;}
    if (mode !== "layout" || !draft.enabled || !(event.target === canvas || event.target.closest(".ps-spatial-segment-list"))) return;
    if (event.key === "Delete" || event.key === "Backspace") {event.preventDefault(); remove(); canvas.focus();}
    else if (command && event.key.toLowerCase() === "d") {event.preventDefault(); duplicate(); canvas.focus();}
    else {
      const e = draft.elements.find(e => e.id === selected), dx = {ArrowLeft: -1, ArrowRight: 1}[event.key] || 0, dy = {ArrowUp: -1, ArrowDown: 1}[event.key] || 0;
      if (e && (dx || dy)) {
        event.preventDefault(); const before = snapshot(), x = e.x, y = e.y;
        e.x = Math.max(0, Math.min(1 - e.width, e.x + dx * (event.shiftKey ? .05 : .005)));
        e.y = Math.max(0, Math.min(1 - e.height, e.y + dy * (event.shiftKey ? .05 : .005)));
        finishGesture(before, x !== e.x || y !== e.y);
      }
    }
  });
  dialog.addEventListener("cancel", event => {event.preventDefault(); close();});
  const resizeObserver = new win.ResizeObserver(() => {
    sizeCanvas(); syncPanels();
    for (const input of inspector.querySelectorAll("textarea")) grow(input);
  }); resizeObserver.observe(viewport);
  const studioObserver = new win.ResizeObserver(sizeDialog);
  if (studio) studioObserver.observe(studio);
  win.addEventListener("resize", sizeDialog);
  sizeDialog(); ownerDocument.body.append(dialog); dialog.showModal(); render();
  return dialog;
}
