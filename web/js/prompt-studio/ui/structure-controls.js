import { GUIDE_TYPES, normalizeGuide, isStructureReference, structureAdapter, controlnetStatus, previewStructureGuide } from "../generation/structure-guide.js";
import { qwenReferenceAdapter } from "../generation/qwen-references.js";

export function structureControls({doc, entry, index, profile, entries, save, fetchApi, imageUrl, report, dimensions, signal}) {
  const el = (tag, text) => {const n = doc.createElement(tag); if (text) n.textContent = text; return n;};
  const root = el("div"); root.className = "ps-structure-controls";
  const available = Boolean(structureAdapter(profile));
  const select = (label, options, value, callback) => {
    const wrap = el("label", label), control = el("select");
    control.setAttribute("aria-label", `${label}${label.endsWith("for") ? " " : " for "}reference ${index + 1}`);
    for (const [key, text] of Object.entries(options)) {const option = el("option", text); option.value = key; control.append(option);}
    control.value = value; wrap.append(control); control.addEventListener("change", () => callback(control.value)); return {wrap, control};
  };
  const use = select("Use for", {reference: "Reference", structure: "Structure guide (ControlNet)", both: "Reference + structure"}, entry.use || "reference", value => {
    if (value !== "reference" && entries.some(e => e.id !== entry.id && isStructureReference(e))) {
      use.control.value = entry.use || "reference"; report("Only one structure guide can be active. Change the other guide to Reference first.", "warning"); return;
    }
    save({use: value, guide: normalizeGuide(entry.guide)}, true);
  });
  if (!available) use.control.disabled = true;
  if (!qwenReferenceAdapter(profile)) for (const option of use.control.options) if (option.value !== "structure") option.disabled = true;
  root.append(use.wrap);
  if (!available) root.append(el("small", isStructureReference(entry) ? "Inactive for this workflow. Your saved guide is kept; select a compatible Qwen 2.1 workflow to use it." : "Structure guidance is unavailable for this workflow."));
  if (!isStructureReference(entry)) return root;
  const guide = normalizeGuide(entry.guide);
  const update = patch => {Object.assign(guide, patch); save({guide: {...guide}}, true);};
  const row = el("div"); row.className = "ps-structure-row";
  const type = select("Guide", GUIDE_TYPES, guide.type, type => update({type})); row.append(type.wrap);
  if (guide.type === "sketch") root.append(el("small", "Sketch guidance can pull photographic edits toward a drawn style, especially at high strength. Preview and compare the result; try lower strength or Edges for photographs."));
  const strengthLabel = el("label", "Strength"), strength = el("input"), value = el("output", `${Math.round(guide.strength * 100)}%`);
  strength.type = "range"; strength.min = 0; strength.max = 1; strength.step = .05; strength.value = guide.strength;
  strength.setAttribute("aria-label", `Structure strength for reference ${index + 1}`); strength.title = "Loose (0%) to close (100%)";
  strength.addEventListener("input", () => {value.value = `${Math.round(strength.value * 100)}%`; guide.strength = Number(strength.value); save({guide: {...guide}}, false);});
  strengthLabel.append(strength, value); row.append(strengthLabel); root.append(row);
  const more = el("details"), summary = el("summary", "More options"); more.append(summary);
  more.dataset.guideOptions = entry.id;
  const options = el("div"); options.className = "ps-structure-row";
  options.append(select("Input", {photo: "Photo · extract guide", prepared: "Prepared guide"}, guide.input, input => update({input})).wrap,
    select("Framing", {fit: "Fit · keep whole image", crop: "Crop · fill canvas"}, guide.fit, fit => update({fit})).wrap);
  options.append(select("Apply guide", {auto: "Auto · resolve subjects", whole: "Whole guide · all structure"}, guide.scope || "auto", scope => update({scope})).wrap);
  more.append(options); root.append(more);
  const status = el("small", "Checking ControlNet…"), preview = el("button", "Show guide"), image = el("img");
  preview.type = "button"; image.hidden = true; image.className = "ps-guide-preview"; image.alt = "Extracted structure guide";
  preview.addEventListener("click", async () => {
    preview.disabled = true; status.textContent = "Preparing guide in ComfyUI's queue…";
    try {
      const previewEntry = profile.kind === "create" ? {...entry, targeting: {...entry.targeting, target: null}} : entry;
      const ref = await previewStructureGuide(previewEntry, fetchApi, await dimensions?.(), signal);
      if (!root.isConnected || signal?.aborted) return;
      image.src = imageUrl(ref); image.hidden = false; status.textContent = "Guide preview";
    } catch (error) { if (root.isConnected && !signal?.aborted) status.textContent = error.message; }
    finally { preview.disabled = !available; }
  });
  root.append(preview, status, image);
  void controlnetStatus(fetchApi).then(capabilities => {
    if (!root.isConnected) return;
    const extraction = guide.input === "prepared" || capabilities.methods?.[guide.type]?.ready;
    status.textContent = !capabilities.ready ? "Install ControlNet in Settings → Setup." : !extraction ? `Install ${GUIDE_TYPES[guide.type]} extraction in Settings → Setup, or select Prepared guide.` : "Ready · one structure guide per generation";
    preview.disabled = !available || !extraction;
  }).catch(error => {if(root.isConnected) {status.textContent = error.message; preview.disabled = true;}});
  if (!available) root.querySelectorAll("select,input,button").forEach(control => {control.disabled = true;});
  return root;
}
