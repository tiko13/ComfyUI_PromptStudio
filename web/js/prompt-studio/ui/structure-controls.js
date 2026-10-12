import { GUIDE_TYPES, normalizeGuide, isStructureReference, structureAdapter, controlnetStatus, previewStructureGuide } from "../generation/structure-guide.js";
import { qwenReferenceAdapter } from "../generation/qwen-references.js";
import { poseInpaintAdapter } from "../generation/workflow-capabilities.js";
import { openInpaintMaskEditor } from "./inpaint-mask-editor.js";
import { poseMaskEstimator } from "../generation/pose-mask.js";

export function structureControls({doc, entry, index, profile, entries, save, fetchApi, imageUrl, report, dimensions, signal, editPose, sourceImage, validContext = () => true}) {
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
    save({use: value, guide: normalizeGuide(entry.guide), ...(entry.pose ? {image: value === "structure" ? entry.pose.image : entry.pose.sourceImage || entry.pose.image} : {})}, true);
  });
  if (!available) use.control.disabled = true;
  if (!qwenReferenceAdapter(profile) || qwenReferenceAdapter(profile)?.guideOnly) for (const option of use.control.options) if (option.value !== "structure") option.disabled = true;
  if (entry.pose && !entry.pose.sourceImage) use.control.disabled = true;
  root.append(use.wrap);
  if (!available) root.append(el("small", isStructureReference(entry) ? "Inactive for this workflow. Your saved guide is kept; select a workflow with a connected Structure Input to use it." : "Structure guidance is unavailable for this workflow."));
  if (!isStructureReference(entry)) return root;
  const guide = normalizeGuide(entry.guide);
  const update = patch => {Object.assign(guide, patch); save({guide: {...guide}}, true);};
  const inpaint = poseInpaintAdapter(profile);
  if (inpaint && guide.type === "pose") {
    const label=el("label"), keep=el("input"), edit=el("button", "Edit background mask"), hint=el("small");
    keep.type="checkbox";keep.checked=guide.preserve_background ?? inpaint.preserveBackground;
    keep.setAttribute("aria-label", `Preserve background for reference ${index + 1}`);
    keep.addEventListener("change",()=>update({preserve_background:keep.checked}));
    label.append(keep,doc.createTextNode(" Preserve background"));edit.type="button";edit.disabled=!sourceImage;
    hint.textContent=keep.checked ? (entry.editMask?.enabled ? "Reviewed mask saved. Check it again after changing the pose or source." : "Open Edit background mask to estimate both body positions, then review and apply it.") : "Background may change. For transparent removal, select a Background Removal workflow.";
    edit.addEventListener("click",async()=>{edit.disabled=true;try{await openInpaintMaskEditor({doc,source:sourceImage,mask:entry.editMask,imageUrl,fetchApi,signal,
      estimate:poseMaskEstimator({entry,source:sourceImage,fetchApi,dimensions,signal}),
      valid:()=>root.isConnected&&validContext(),apply:mask=>save({editMask:mask,guide:{...guide,preserve_background:true}},true)});}catch(error){report(error.message,"error");}finally{if(root.isConnected)edit.disabled=false;}});
    root.append(label,edit,hint);
  }
  const row = el("div"); row.className = "ps-structure-row";
  const type = select("Guide", GUIDE_TYPES, guide.type, type => update({type})); row.append(type.wrap);
  if (entry.pose) type.control.disabled = true;
  if (guide.type === "sketch") root.append(el("small", "Sketch guidance can pull photographic edits toward a drawn style, especially at high strength. Preview and compare the result; try lower strength or Edges for photographs."));
  const strengthLabel = el("label", "Strength"), strength = el("input"), value = el("output", `${Math.round(guide.strength * 100)}%`);
  strength.type = "range"; strength.min = 0; strength.max = 1; strength.step = .05; strength.value = guide.strength;
  strength.setAttribute("aria-label", `Structure strength for reference ${index + 1}`); strength.title = "Loose (0%) to close (100%)";
  strength.addEventListener("input", () => {value.value = `${Math.round(strength.value * 100)}%`; guide.strength = Number(strength.value); save({guide: {...guide}}, false);});
  strengthLabel.append(strength, value); row.append(strengthLabel); root.append(row);
  const more = el("details"), summary = el("summary", "More options"); more.append(summary);
  more.dataset.guideOptions = entry.id;
  const options = el("div"); options.className = "ps-structure-row";
  const input = select("Input", {photo: "Photo · extract guide", prepared: "Prepared guide"}, guide.input, input => update({input}));
  if (entry.pose) input.control.disabled = true;
  options.append(input.wrap,
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
  if (guide.type === "pose" && editPose) {
    const edit = el("button", entry.pose ? "Edit pose" : "Extract & edit pose"); edit.type = "button";
    edit.disabled = !available || (!entry.pose && guide.input === "prepared");
    edit.addEventListener("click", async () => {
      edit.disabled = true; status.textContent = entry.pose ? "Opening pose editor…" : "Extracting editable joints in ComfyUI’s queue…";
      try {await editPose(); if(root.isConnected)status.textContent = "Apply in the editor to save your pose.";}
      catch(error){if(root.isConnected)status.textContent = error.message;}
      finally{if(root.isConnected)edit.disabled = !available;}
    });
    root.insertBefore(edit, preview);
    if (entry.pose) {image.src = imageUrl(entry.pose.image); image.hidden = false;root.append(el("small", "Saved editable pose · generation uses your edited joints."));}
    else if (guide.input === "prepared") root.append(el("small", "This prepared image has no joint data. Use a photo to extract an editable pose, or Add pose."));
  }
  void controlnetStatus(fetchApi).then(capabilities => {
    if (!root.isConnected) return;
    const extraction = guide.input === "prepared" || capabilities.methods?.[guide.type]?.ready;
    const needsQwen = !structureAdapter(profile)?.explicit || Object.values(profile?.snapshot?.output || {}).some(node => node.class_type === "PS_ApplyQwenStructure");
    status.textContent = needsQwen && !capabilities.ready ? "Install ControlNet in Settings → Setup." : !extraction ? `Install ${GUIDE_TYPES[guide.type]} extraction in Settings → Setup, or select Prepared guide.` : "Ready · one structure guide per generation";
    preview.disabled = !available || !extraction;
  }).catch(error => {if(root.isConnected) {status.textContent = error.message; preview.disabled = true;}});
  if (!available) root.querySelectorAll("select,input,button").forEach(control => {control.disabled = true;});
  return root;
}
