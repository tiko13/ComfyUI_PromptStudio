// Keep pointer capture on the stable viewport while the selection UI changes.
export function bindSpatialCanvas({canvas, viewport, ownerDocument, getState, snapshot, select, refreshSelection, render, finish, cancel, pan, chooseOverlap}) {
  const win = ownerDocument.defaultView;
  let space = false, gesture = null, frame = 0;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const editable = target => target.closest("input, textarea, select, [contenteditable=true]");
  const hits = (state, point) => [...state.draft.elements].reverse().filter(e => point.x >= e.x && point.x <= e.x + e.width && point.y >= e.y && point.y <= e.y + e.height);
  const keydown = event => {
    if (event.code === "Space" && !editable(event.target) && event.target === canvas) {space = true; event.preventDefault();}
    if (event.key === "Escape" && gesture) {event.preventDefault(); event.stopPropagation(); end(true);}
    else if (gesture && (event.ctrlKey || event.metaKey || /^(Arrow|Delete|Backspace)/.test(event.key))) {event.preventDefault(); event.stopPropagation();}
  };
  const keyup = event => {if (event.code === "Space") space = false;};
  const blur = () => {space = false; if (gesture) end(true);};
  function down(event) {
    const state = getState();
    if (state.busy || gesture || ![0, 1].includes(event.button)) return;
    const panning = space || event.button === 1 || state.tool === "pan" || state.mode === "maps";
    if (!panning && (!state.draft.enabled || !canvas.contains(event.target))) return;
    event.preventDefault(); canvas.focus({preventScroll: true});
    const rect = canvas.getBoundingClientRect();
    const start = {x: clamp((event.clientX - rect.left) / rect.width, 0, 1), y: clamp((event.clientY - rect.top) / rect.height, 0, 1)};
    const hit = event.target.closest(".ps-spatial-box"), edge = event.target.dataset.edge || "";
    const before = panning ? null : snapshot();
    const drawing = !panning && state.tool === "draw" && !edge;
    let item = hit && !drawing ? state.draft.elements.find(e => e.id === hit.dataset.id) : null;
    if (!panning && !drawing && !edge) {
      const underPointer = hits(state, start), index = underPointer.findIndex(e => e.id === state.selected);
      // Retain a chosen lower layer for dragging; Alt-click deliberately cycles.
      item = event.altKey ? underPointer[(index + 1) % underPointer.length] : underPointer[index] || underPointer[0];
    }
    if (!panning && !item && !drawing) {select(""); refreshSelection(); return;}
    if (drawing && state.draft.elements.length >= 64) return;
    if (item && !panning && item.id !== state.selected) {select(item.id); refreshSelection();}
    gesture = {before, item, original: item ? {...item} : null, start, rect, edge, drawing, panning,
      box: item ? [...canvas.children].find(b => b.dataset.id === item.id) : null,
      layoutWidth: canvas.clientWidth, layoutHeight: canvas.clientHeight,
      pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, pan: {...state.pan}, nextPan: {...state.pan}, moved: false};
    if (gesture.box && !edge && !panning) gesture.box.style.willChange = "transform";
    viewport.setPointerCapture(event.pointerId);
  }
  function paint() {
    frame = 0;
    const g = gesture; if (!g) return;
    if (g.panning) {pan(g.nextPan); return;}
    if (!g.box) return;
    if (!g.edge && !g.drawing) {
      g.box.style.transform = `translate(${(g.item.x - g.original.x) * g.layoutWidth}px, ${(g.item.y - g.original.y) * g.layoutHeight}px)`;
    } else {
      Object.assign(g.box.style, {left: `${g.item.x * 100}%`, top: `${g.item.y * 100}%`, width: `${g.item.width * 100}%`, height: `${g.item.height * 100}%`});
    }
  }
  function schedulePaint() {if (!frame) frame = win.requestAnimationFrame(paint);}
  function move(event) {
    const g = gesture; if (!g || g.pointerId !== event.pointerId) return;
    const dxPixels = event.clientX - g.clientX, dyPixels = event.clientY - g.clientY;
    if (!g.moved && Math.hypot(dxPixels, dyPixels) < 4) return;
    g.moved = true;
    if (g.panning) {g.nextPan = {x: g.pan.x + dxPixels, y: g.pan.y + dyPixels}; schedulePaint(); return;}
    const x = clamp((event.clientX - g.rect.left) / g.rect.width, 0, 1), y = clamp((event.clientY - g.rect.top) / g.rect.height, 0, 1);
    const dx = x - g.start.x, dy = y - g.start.y;
    if (g.drawing) {
      if (!g.item) {
        g.item = {id: crypto.randomUUID(), type: "object", x: g.start.x, y: g.start.y, width: .01, height: .01, description: "", text: "", palette: []};
        getState().draft.elements.push(g.item); select(g.item.id); render();
        g.box = [...canvas.children].find(b => b.dataset.id === g.item.id);
      }
      Object.assign(g.item, {x: Math.min(g.start.x, x), y: Math.min(g.start.y, y), width: Math.abs(dx), height: Math.abs(dy)});
    } else if (g.edge) {
      const o = g.original, minWidth = Math.min(.005, o.width), minHeight = Math.min(.005, o.height);
      let left = o.x, top = o.y, right = o.x + o.width, bottom = o.y + o.height;
      if (g.edge.includes("w")) left = clamp(o.x + dx, 0, right - minWidth);
      if (g.edge.includes("e")) right = clamp(o.x + o.width + dx, left + minWidth, 1);
      if (g.edge.includes("n")) top = clamp(o.y + dy, 0, bottom - minHeight);
      if (g.edge.includes("s")) bottom = clamp(o.y + o.height + dy, top + minHeight, 1);
      Object.assign(g.item, {x: left, y: top, width: right - left, height: bottom - top});
    } else {
      g.item.x = clamp(g.original.x + dx, 0, 1 - g.item.width);
      g.item.y = clamp(g.original.y + dy, 0, 1 - g.item.height);
    }
    schedulePaint();
  }
  function end(abort = false) {
    const g = gesture; if (!g) return;
    if (frame) {win.cancelAnimationFrame(frame); frame = 0;}
    if (!abort) paint(); // Commit the last event even if pointerup precedes the frame.
    gesture = null;
    if (g.box) {g.box.style.transform = ""; g.box.style.willChange = "";}
    if (viewport.hasPointerCapture(g.pointerId)) viewport.releasePointerCapture(g.pointerId);
    if (g.panning) {if (abort) pan(g.pan); return;}
    if (abort || (g.drawing && (!g.item || g.item.width * g.rect.width < 4 || g.item.height * g.rect.height < 4))) cancel(g.before);
    else finish(g.before, Boolean(g.item && (g.drawing || ["x", "y", "width", "height"].some(key => g.item[key] !== g.original[key]))));
  }
  const up = event => {if (gesture?.pointerId === event.pointerId) end();};
  const cancelled = event => {if (gesture?.pointerId === event.pointerId) end(true);};
  const contextmenu = event => {
    const state = getState(); if (state.busy || gesture || state.mode !== "layout") return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect(), selected = state.draft.elements.find(e => e.id === state.selected);
    const keyboard = event.clientX === 0 && event.clientY === 0;
    const point = keyboard ? {x: selected ? selected.x + selected.width / 2 : .5, y: selected ? selected.y + selected.height / 2 : .5} : {x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height};
    chooseOverlap({elements: hits(state, point), clientX: rect.left + point.x * rect.width, clientY: rect.top + point.y * rect.height});
  };
  canvas.addEventListener("contextmenu", contextmenu);
  viewport.addEventListener("pointerdown", down); viewport.addEventListener("pointermove", move);
  viewport.addEventListener("pointerup", up); viewport.addEventListener("pointercancel", cancelled); viewport.addEventListener("lostpointercapture", cancelled);
  ownerDocument.addEventListener("keydown", keydown, true); ownerDocument.addEventListener("keyup", keyup);
  ownerDocument.defaultView.addEventListener("blur", blur);
  return () => {
    if (frame) win.cancelAnimationFrame(frame);
    gesture = null;
    canvas.removeEventListener("contextmenu", contextmenu);
    viewport.removeEventListener("pointerdown", down); viewport.removeEventListener("pointermove", move);
    viewport.removeEventListener("pointerup", up); viewport.removeEventListener("pointercancel", cancelled); viewport.removeEventListener("lostpointercapture", cancelled);
    ownerDocument.removeEventListener("keydown", keydown, true); ownerDocument.removeEventListener("keyup", keyup);
    ownerDocument.defaultView.removeEventListener("blur", blur);
  };
}
