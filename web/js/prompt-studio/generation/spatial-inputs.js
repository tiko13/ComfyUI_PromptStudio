import {dependsOn, namedStructureInputs} from "./workflow-capabilities.js";
import {serializedWorkflowNodes} from "./prompt-studio-input.js";

const MAX_ELEMENTS = 64;
const text = value => String(value ?? "").slice(0, 12000);
export function normalizeSpatialInput(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
  const elements = (Array.isArray(value.elements) ? value.elements : []).slice(0, MAX_ELEMENTS).map((e, index) => {
    const finite = (n, fallback) => Number.isFinite(Number(n)) ? Number(n) : fallback;
    const x = Math.min(.999, Math.max(0, finite(e.x, .1))), y = Math.min(.999, Math.max(0, finite(e.y, .1)));
    return {id: text(e.id || `element-${index}`), type: ["object", "character", "text"].includes(e.type) ? e.type : "object",
      x, y, width: Math.max(.001, Math.min(1 - x, finite(e.width, .3))), height: Math.max(.001, Math.min(1 - y, finite(e.height, .2))),
      description: text(e.description), text: text(e.text), palette: (Array.isArray(e.palette) ? e.palette : []).filter(c => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 5)};
  });
  if (new Set(elements.map(e => e.id)).size !== elements.length) throw new Error("Layout element IDs must be unique.");
  const guides = {};
  for (const [key, g] of Object.entries(value.guides || {}).slice(0, 16)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || !g?.image?.filename) continue;
    guides[key] = {image: {filename: text(g.image.filename), subfolder: text(g.image.subfolder), type: g.image.type === "output" ? "output" : "input",
      width: Number(g.image.width) || 0, height: Number(g.image.height) || 0},
      enabled: g.enabled !== false, kind: g.kind === "color" ? "color" : "depth", input: g.input === "photo" ? "photo" : "prepared",
      fit: ["crop", "stretch"].includes(g.fit) ? g.fit : "fit", invert: g.invert === true};
  }
  return {version: 1, contract: text(value.contract), alignment: ["crop", "stretch"].includes(value.alignment) ? value.alignment : "fit", enabled: value.enabled !== false, elements, guides};
}

export function normalizeSpatialStore(value) {
  const result = {};
  for (const [key, entry] of Object.entries(value || {}).slice(0, 64)) {
    try {result[key] = normalizeSpatialInput(entry);} catch { /* Retain other valid workflow records. */ }
  }
  return result;
}

export function layoutBinding(profile) {
  const output = profile?.snapshot?.output || {};
  const layouts = Object.entries(output).filter(([id, n]) => n.class_type === "MOSSImageLayoutPrompt"
    && (profile.resultNodeIds || []).some(result => dependsOn(output, [result, 0], id)));
  if (!layouts.length) return null;
  if (layouts.length !== 1) throw new Error("Use one connected layout compiler per Studio workflow.");
  const [id, node] = layouts[0], link = node.inputs.element;
  if (!Array.isArray(link) || link[1] !== 2 || output[link[0]]?.class_type !== "CreateBoundingBoxes") throw new Error("Connect Create Bounding Boxes elements to the layout compiler.");
  if (!dependsOn(output, node.inputs.prompt, profile.promptNodeId)) throw new Error("The layout must consume the Studio prompt.");
  const boxes = output[link[0]];
  for (const n of [node, boxes]) for (const [field, slot] of [["width", 2], ["height", 3]]) {
    const size = n.inputs[field];
    if (!Array.isArray(size) || String(size[0]) !== String(profile.promptNodeId) || size[1] !== slot) throw new Error("Layout dimensions must come from Studio Prompt Slot.");
  }
  return {id, boxesId: String(link[0])};
}

export function spatialDefaults(profile) {
  const binding = layoutBinding(profile), output = profile?.snapshot?.output || {};
  if (!binding) return normalizeSpatialInput();
  const boxes = output[binding.boxesId].inputs;
  const editorState = boxes.editor_state?.__value__ ?? boxes.editor_state;
  // Canvas-authored defaults are pixel boxes. Bundled workflows start empty.
  const {width, height} = spatialDimensions(output[profile.promptNodeId]?.inputs);
  const chars = new Set(String(output[binding.id].inputs.character_boxes || "").match(/\d+/g) || []);
  let incoming = boxes.bboxes;
  if (typeof incoming === "string") {try {incoming = JSON.parse(incoming);} catch {incoming = null;}}
  const elements = Array.isArray(incoming) && incoming.length ? incoming.map((e,i) => ({id:`canvas-${i}`,x:e.bbox?.[1]/1000,y:e.bbox?.[0]/1000,
    width:(e.bbox?.[3]-e.bbox?.[1])/1000,height:(e.bbox?.[2]-e.bbox?.[0])/1000,type:e.type === "text" ? "text" : chars.has(String(i+1)) ? "character" : "object",
    description:e.desc,text:e.text,palette:e.color_palette})) : (Array.isArray(editorState) ? editorState : []).map((b, i) => ({id: `canvas-${i}`, x: b.x / width, y: b.y / height,
    width: b.width / width, height: b.height / height, type: b.metadata?.type === "text" ? "text" : chars.has(String(i + 1)) ? "character" : "object",
    description: b.metadata?.desc, text: b.metadata?.text, palette: b.metadata?.palette}));
  return normalizeSpatialInput({contract: spatialContractKey(profile), elements});
}

export function spatialDimensions(inputs = {}) {
  if (inputs.resolution_width > 0 && inputs.resolution_height > 0) return {width: inputs.resolution_width, height: inputs.resolution_height};
  const ratio = String(inputs.aspect_ratio || "1:1").match(/(\d+):(\d+)/), w = Number(ratio?.[1] || 1), h = Number(ratio?.[2] || 1);
  const multiple = Number(inputs.multiple || 32), scale = Math.sqrt(Number(inputs.megapixels || 1) * 1024 * 1024 / (w*h));
  // Python round uses ties-to-even; match Prompt Slot's dimension contract.
  const round = n => n % 1 === .5 ? 2 * Math.round(n / 2) : Math.round(n);
  return {width: round(w*scale/multiple)*multiple, height: round(h*scale/multiple)*multiple};
}

export function spatialContractKey(profile) {
  return JSON.stringify({layout:layoutBinding(profile), slots:namedStructureInputs(profile)});
}

export function spatialValue(chat, profile) {
  const value = normalizeSpatialInput(chat?.spatialInputs?.[profile?.id] ?? spatialDefaults(profile));
  value.contract ||= spatialContractKey(profile);
  return value;
}

// Repair pre-fix saved submissions without rebuilding their captured layout.
export function normalizeSpatialSnapshot(snapshot) {
  for (const node of Object.values(snapshot.output || {})) {
    if (node.class_type !== "CreateBoundingBoxes") continue;
    for (const key of ["editor_state", "last_incoming"]) {
      const value = node.inputs?.[key];
      if (!Array.isArray(value)) continue;
      if (value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]) && snapshot.output[value[0]]) continue;
      node.inputs[key] = {__value__: value};
    }
  }
}

export function applySpatialInputs(snapshot, profile, value) {
  const current = {...profile, snapshot}, binding = layoutBinding(current), slots = namedStructureInputs(current);
  if (!binding && !slots.length) return;
  const normalized = normalizeSpatialInput(value);
  if (normalized.contract && normalized.contract !== spatialContractKey(current)) throw new Error("Layout/map connections changed. Review and Apply the layout and control maps again.");
  const dimensions = spatialDimensions(snapshot.output[profile.promptNodeId]?.inputs);
  if (binding && (dimensions.width % 16 || dimensions.height % 16)) throw new Error("MOSS layout dimensions must be multiples of 16. Adjust the resolution rounding setting.");
  const images = slots.map(s=>normalized.guides[s.key]).filter(g=>g?.enabled && g.image.width > 0 && g.image.height > 0).map(g=>g.image);
  if (images.some(img=>Math.abs(img.width/img.height-images[0].width/images[0].height) > .001)) throw new Error("Color and depth maps must have matching aspect ratios and framing. Crop the source maps to match before applying them.");
  const records = serializedWorkflowNodes(snapshot.workflow || {});
  if (binding) {
    const elements = normalized.enabled ? normalized.elements : [];
    const boxes = snapshot.output[binding.boxesId].inputs;
    // API input arrays denote node links. Native list widgets require a value
    // wrapper, even when empty; keep raw arrays only in the canvas metadata.
    boxes.editor_state = {__value__: []}; boxes.last_incoming = {__value__: []};
    boxes.bboxes = JSON.stringify(elements.map(e => ({type: e.type === "text" ? "text" : "obj", text: e.text, desc: e.description,
      color_palette: e.palette, bbox: [e.y, e.x, e.y + e.height, e.x + e.width].map(n => Math.round(n * 1000))})));
    snapshot.output[binding.id].inputs.character_boxes = elements.map((e, i) => e.type === "character" ? i + 1 : null).filter(Boolean).join(",");
    // Keep saved ComfyUI canvas metadata usable independently of Studio.
    const savedBoxes = records.find(n=>n.id===binding.boxesId)?.node;
    if (savedBoxes) {
      const pixels = elements.map(e=>({x:e.x*dimensions.width,y:e.y*dimensions.height,width:e.width*dimensions.width,height:e.height*dimensions.height,
        metadata:{type:e.type === "text" ? "text" : "obj",desc:e.description,text:e.text,palette:e.palette}}));
      savedBoxes.widgets_values_named = {...savedBoxes.widgets_values_named, width:dimensions.width,height:dimensions.height,editor_state:pixels,last_incoming:[]};
      savedBoxes.widgets_values = [dimensions.width,dimensions.height,pixels,[]];
    }
    const savedLayout = records.find(n=>n.id===binding.id)?.node;
    if (savedLayout) {
      savedLayout.widgets_values_named = {...savedLayout.widgets_values_named,character_boxes:snapshot.output[binding.id].inputs.character_boxes};
      savedLayout.widgets_values[3] = snapshot.output[binding.id].inputs.character_boxes;
    }
  }
  for (const slot of slots) {
    const guide = normalized.guides[slot.key];
    if (guide?.enabled && !slot.kinds.includes(guide.kind)) throw new Error(`Unsupported map type for ${slot.key}.`);
    snapshot.output[slot.id].inputs.reference_json = guide?.enabled ? JSON.stringify({image: guide.image,
      guide: {type: guide.kind, input: guide.input, fit: normalized.alignment, invert: guide.invert, strength: 1}}) : "";
    const saved = records.find(r=>r.id===slot.id)?.node;
    if (saved) {
      saved.widgets_values_named = {...saved.widgets_values_named,reference_json:snapshot.output[slot.id].inputs.reference_json};
      if (Array.isArray(saved.widgets_values)) saved.widgets_values[2] = snapshot.output[slot.id].inputs.reference_json;
    }
  }
}
