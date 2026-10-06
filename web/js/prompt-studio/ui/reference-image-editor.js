// Reference preparation is baked into a new PNG before analysis and generation.
// The original upload is never changed. No detector or image model is needed.
export function paintReference(doc, image, width, height, strokes, visible = true) {
  const layer = doc.createElement("canvas"); layer.width = width; layer.height = height;
  const ctx = layer.getContext("2d"), mask = doc.createElement("canvas"); mask.width = width; mask.height = height;
  const m = mask.getContext("2d");
  if (visible) {m.fillStyle = "white"; m.fillRect(0, 0, width, height);}
  for (const stroke of strokes) {
    m.globalCompositeOperation = stroke.keep ? "source-over" : "destination-out";
    m.strokeStyle = m.fillStyle = "white"; m.lineCap = m.lineJoin = "round";
    m.lineWidth = stroke.size * Math.min(width, height);
    const [first, ...rest] = stroke.points;
    m.beginPath(); m.arc(first.x * width, first.y * height, m.lineWidth / 2, 0, Math.PI * 2); m.fill();
    if (rest.length) {m.beginPath(); m.moveTo(first.x * width, first.y * height); for (const p of rest) m.lineTo(p.x * width, p.y * height); m.stroke();}
  }
  ctx.drawImage(image, 0, 0, width, height); ctx.globalCompositeOperation = "destination-in"; ctx.drawImage(mask, 0, 0);
  ctx.globalCompositeOperation = "destination-over"; ctx.fillStyle = "#808080"; ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = "source-over";
  return layer;
}

export function referenceImageEditor({doc, image, imageUrl, label, apply, valid = () => true}) {
  const el = (tag, text) => {const n = doc.createElement(tag); if (text) n.textContent = text; return n;};
  const root = el("details"); root.className = "ps-reference-preparation";
  root.append(el("summary", "Crop / mask…"));
  const canvas = el("canvas"), status = el("small"), controls = el("div"), fields = el("div");
  const preview = el("div"), brushCircle = el("div"); preview.className = "ps-reference-brush-preview";
  brushCircle.className = "ps-reference-brush-circle"; brushCircle.setAttribute("aria-hidden", "true"); brushCircle.hidden = true; preview.append(canvas, brushCircle);
  canvas.tabIndex = 0; canvas.setAttribute("aria-label", `Crop and mask preview for ${label}`);
  status.setAttribute("role", "status"); controls.className = "ps-reference-preparation-tools"; fields.className = "ps-target-fields";
  const picture = el("img"), inputs = {}, buttons = {};
  let crop = {x: 0, y: 0, width: 1, height: 1}, strokes = [], visible = true, mode = "crop", loaded = false, busy = false;
  let drag = null, cursor = {x: .5, y: .5}, history = [], hovering = false;
  const remember = () => {history.push({crop: {...crop}, strokes: structuredClone(strokes), visible}); if (history.length > 20) history.shift();};
  const button = (text, action) => {const b = el("button", text); b.type = "button"; b.addEventListener("click", action); controls.append(b); return b;};
  for (const [id, text] of [["crop", "Crop rectangle"], ["hide", "Hide brush"], ["keep", "Restore brush"]]) {
    buttons[id] = button(text, () => {mode = id; render();});
  }
  const brushLabel = el("label", "Brush size "), brush = el("input"); brush.type = "range"; brush.min = "1"; brush.max = "40"; brush.value = "10";
  const brushSize = el("output");
  brush.setAttribute("aria-label", `Brush size for ${label}`); brushLabel.append(brush, brushSize); controls.append(brushLabel);
  function renderBrush() {
    const sizing = doc.activeElement === brush && !hovering;
    brushSize.value = loaded ? `${Math.round(Number(brush.value) / 100 * Math.min(picture.naturalWidth, picture.naturalHeight))} px` : `${brush.value}%`;
    brushCircle.hidden = !loaded || busy || mode === "crop" || !(hovering || sizing || doc.activeElement === canvas);
    canvas.style.cursor = mode === "crop" ? "crosshair" : "none";
    if (brushCircle.hidden) return;
    const center = sizing ? {x: .5, y: .5} : cursor;
    const diameter = Number(brush.value) / 100 * Math.min(canvas.width, canvas.height);
    Object.assign(brushCircle.style, {left: `${center.x * 100}%`, top: `${center.y * 100}%`, width: `${diameter / canvas.width * 100}%`, height: `${diameter / canvas.height * 100}%`});
  }
  brush.addEventListener("input", renderBrush);
  brush.addEventListener("focus", renderBrush); brush.addEventListener("blur", renderBrush);
  const undo = button("Undo", () => {const previous = history.pop(); if (previous) {({crop, strokes, visible} = previous); render();}});
  button("Hide all", () => {remember(); strokes = []; visible = false; mode = "keep"; render();});
  button("Show all", () => {remember(); strokes = []; visible = true; render();});
  button("Reset changes", () => {remember(); crop = {x: 0, y: 0, width: 1, height: 1}; strokes = []; visible = true; render();});
  for (const [key, text] of [["x", "Left"], ["y", "Top"], ["width", "Width"], ["height", "Height"]]) {
    const wrap = el("label", `${text} %`), input = el("input"); input.type = "number"; input.min = key === "x" || key === "y" ? "0" : "1"; input.max = "100"; input.step = "1";
    input.setAttribute("aria-label", `Crop ${text.toLowerCase()} percent for ${label}`);
    input.addEventListener("change", () => {
      const value = Number(input.value) / 100; if (!Number.isFinite(value)) return;
      remember(); crop[key] = Math.max(key === "x" || key === "y" ? 0 : .01, Math.min(1, value));
      crop.x = Math.min(.99, crop.x); crop.y = Math.min(.99, crop.y);
      crop.width = Math.min(crop.width, 1 - crop.x); crop.height = Math.min(crop.height, 1 - crop.y); render();
    }); inputs[key] = input; wrap.append(input); fields.append(wrap);
  }
  function render() {
    for (const b of controls.querySelectorAll("button,input")) b.disabled = busy || !loaded;
    for (const [key, input] of Object.entries(inputs)) {input.value = String(Math.round(crop[key] * 100)); input.disabled = busy || !loaded;}
    for (const [key, b] of Object.entries(buttons)) b.setAttribute("aria-pressed", String(key === mode));
    undo.disabled = busy || !history.length; use.disabled = busy || !loaded;
    renderBrush();
    if (!loaded) return;
    const ctx = canvas.getContext("2d"); ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(paintReference(doc, picture, canvas.width, canvas.height, strokes, visible), 0, 0);
    ctx.strokeStyle = "#ffca28"; ctx.lineWidth = 2; ctx.strokeRect(crop.x * canvas.width, crop.y * canvas.height, crop.width * canvas.width, crop.height * canvas.height);
  }
  const point = event => {const r = canvas.getBoundingClientRect(); return {x: Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (event.clientY - r.top) / r.height))};};
  const stroke = p => ({keep: mode === "keep", size: Number(brush.value) / 100, points: [p]});
  canvas.addEventListener("pointerdown", event => {
    if (!loaded || busy || event.button !== 0) return;
    event.preventDefault(); canvas.focus(); remember(); const p = point(event); cursor = p; drag = {start: p, mode}; canvas.setPointerCapture(event.pointerId);
    if (mode !== "crop") strokes.push(stroke(p)); render();
  });
  canvas.addEventListener("pointermove", event => {
    const p = point(event); cursor = p; hovering = true;
    if (!drag) {renderBrush(); return;}
    if (drag.mode === "crop") {const start = drag.start; crop = {x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), width: Math.max(.01, Math.abs(p.x - start.x)), height: Math.max(.01, Math.abs(p.y - start.y))}; crop.x = Math.min(crop.x, 1-crop.width); crop.y = Math.min(crop.y, 1-crop.height);}
    else if (strokes.at(-1).points.length < 2000) strokes.at(-1).points.push(p);
    render();
  });
  canvas.addEventListener("pointerenter", event => {hovering = true; cursor = point(event); renderBrush();});
  canvas.addEventListener("pointerleave", () => {hovering = false; renderBrush();});
  canvas.addEventListener("pointerup", () => {drag = null;});
  canvas.addEventListener("pointercancel", () => {if (drag) {drag = null; ({crop, strokes, visible} = history.pop()); render();}});
  canvas.addEventListener("keydown", event => {
    if (!loaded || busy || mode === "crop") return;
    const directions = {ArrowLeft: [-.02, 0], ArrowRight: [.02, 0], ArrowUp: [0, -.02], ArrowDown: [0, .02]};
    if (directions[event.key]) {event.preventDefault(); const [x, y] = directions[event.key]; cursor = {x: Math.max(0, Math.min(1, cursor.x + x)), y: Math.max(0, Math.min(1, cursor.y + y))}; render();}
    else if (event.key === " " || event.key === "Enter") {event.preventDefault(); remember(); strokes.push(stroke(cursor)); render();}
  });
  canvas.addEventListener("focus", renderBrush); canvas.addEventListener("blur", renderBrush);
  const use = el("button", "Use prepared reference"); use.type = "button";
  use.addEventListener("click", async () => {
    if (!loaded || busy || !valid()) return;
    busy = true; render(); status.textContent = "Saving a separate reference copy…";
    try {
      const layer = paintReference(doc, picture, picture.naturalWidth, picture.naturalHeight, strokes, visible);
      const output = el("canvas"), x = Math.floor(crop.x * layer.width), y = Math.floor(crop.y * layer.height);
      output.width = Math.max(1, Math.min(layer.width-x, Math.round(crop.width*layer.width)));
      output.height = Math.max(1, Math.min(layer.height-y, Math.round(crop.height*layer.height)));
      output.getContext("2d").drawImage(layer, x, y, output.width, output.height, 0, 0, output.width, output.height);
      const blob = await new Promise(resolve => output.toBlob(resolve, "image/png"));
      if (!blob || !blob.size || blob.size > 20*1024*1024) throw Error("Prepared reference exceeds the 20 MB upload limit. Crop a smaller area.");
      if (!root.isConnected || !valid()) return;
      await apply(new File([blob], "prepared-reference.png", {type: "image/png"}));
    } catch (error) {status.textContent = error.message;}
    finally {busy = false; render();}
  });
  root.append(el("small", "Drag a crop or hide unwanted reference pixels. Hidden areas become neutral gray. This prepares the reference; it does not mask the generated result."), controls, preview, fields,
    el("small", "Brush keyboard: focus the preview, use arrow keys to move and Space to paint. Use Hide all then Restore brush to keep only a detail. Undo or Reset changes before applying."), use, status);
  root.addEventListener("toggle", () => {if (root.open && !picture.src) {status.textContent = "Loading reference…"; picture.src = imageUrl(image);}});
  picture.onload = () => {
    if (picture.naturalWidth * picture.naturalHeight > 32*1024*1024) {status.textContent = "This quick editor supports images up to 32 megapixels."; return;}
    const scale = Math.min(1, 1024 / Math.max(picture.naturalWidth, picture.naturalHeight));
    canvas.width = Math.max(1, Math.round(picture.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(picture.naturalHeight * scale));
    loaded = true; status.textContent = "The original file stays unchanged. Apply to use this preview for analysis and generation."; render();
  };
  picture.onerror = () => {status.textContent = "Could not load this reference.";}; render();
  return root;
}
