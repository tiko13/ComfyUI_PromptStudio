import { normalizeTargeting, normalizeRegion, normalizeEditMask } from "../generation/reference-targeting.js";
import { referenceDetection, requestReferenceRegion } from "../generation/reference-detection.js";

// Manual rectangles work without a detector, provider call, or model download.
export function referenceTargeting({doc, entry, index, sourceImage, imageUrl, save, structure, edit, fetchApi, analysisSettings, maskSupported = false, validContext = () => true, signal}) {
  const el = (tag, text) => {const n = doc.createElement(tag); if (text) n.textContent = text; return n;};
  const root = el("details"); root.className = "ps-reference-targeting";
  root.dataset.guideOptions = `${entry.id}-targeting`;
  root.append(el("summary", "Targeting…"));
  if (edit) {
    const label = el("label"), deep = el("input"); deep.type = "checkbox"; deep.checked = entry.analysis === "deep";
    deep.addEventListener("change", () => save({analysis: deep.checked ? "deep" : "auto"}));
    label.append(deep, doc.createTextNode(" Always use deeper analysis for this reference (with amplification)")); root.append(label);
  }
  root.append(el("small", structure
    ? "Select a reference region to crop before extraction. The source region positions and scales the guide. A wide pose fitted into a narrow region can shrink the person. Use Show guide to check placement. This is not an edit mask; other pixels can still change."
    : "Selections identify the reference detail and the subject to edit. They do not mask or lock pixels. You can also describe the people in the instruction."));
  const targeting = normalizeTargeting(entry.targeting) || {reference: null, target: null};
  const current = () => root.isConnected && validContext();
  if (edit && sourceImage && analysisSettings) {
    const map = el("button", "Resolve donor and recipient"), status = el("small"), preview = el("div"); map.type = "button";
    status.setAttribute("role", "status");
    map.addEventListener("click", async () => {
      const instruction = entry.instruction, identity = JSON.stringify(entry);
      if (!instruction?.trim()) {status.textContent = "Describe the donor and recipient in the reference instruction first."; return;}
      map.disabled = true; preview.replaceChildren(); status.textContent = "Matching detected people to your instruction…";
      try {
        const result = await requestReferenceRegion(fetchApi, "map", {...analysisSettings(), user_text: instruction, source_image: sourceImage, reference_image: entry.image},signal);
        if (!current() || JSON.stringify(entry) !== identity) return;
        status.textContent = result.clarification || result.description;
        const regions = normalizeTargeting(result.targeting);
        if (regions?.reference && regions?.target && !result.clarification) {
          for (const [key, image, title] of [["reference",entry.image,"Donor"],["target",sourceImage,"Recipient"]]) {
            const frame=el("div"), picture=el("img"), rectangle=el("div"); frame.className="ps-target-image";picture.src=imageUrl(image);picture.alt=title;
            rectangle.className="ps-target-rectangle";const r=regions[key];Object.assign(rectangle.style,{left:`${r.x*100}%`,top:`${r.y*100}%`,width:`${r.width*100}%`,height:`${r.height*100}%`});
            frame.append(picture,rectangle);preview.append(el("small",title),frame);
          }
          const apply = el("button","Use these selections");apply.type="button";
          apply.addEventListener("click",()=>{if(current() && JSON.stringify(entry)===identity) save({targeting:{...regions,targetImage:sourceImage},editMask:null},true);});preview.append(apply);
        }
      } catch(error) {if(current())status.textContent=error.message;}
      finally {map.disabled=false;}
    });
    root.append(map,status,preview);
  }
  const add = (key, label, image) => {
    if (!image) return;
    const group = el("fieldset"), legend = el("legend", label);
    const frame = el("div"), picture = el("img"), rectangle = el("div");
    frame.className = "ps-target-image"; picture.src = imageUrl(image); picture.alt = `${label} image for reference ${index + 1}`;
    picture.draggable = false; rectangle.className = "ps-target-rectangle"; rectangle.setAttribute("aria-hidden", "true");
    frame.append(picture, rectangle);
    const hint = el("small", "Drag a rectangle, or use the percentage fields below. Left and right are as viewed in the image.");
    const fields = el("div"); fields.className = "ps-target-fields";
    const inputs = {};
    for (const [name, caption] of [["x", "Left"], ["y", "Top"], ["width", "Width"], ["height", "Height"]]) {
      const wrap = el("label", `${caption} %`), input = el("input"); input.type = "number";
      input.min = name === "width" || name === "height" ? "1" : "0"; input.max = "100"; input.step = "1";
      input.setAttribute("aria-label", `${label} ${caption.toLowerCase()} percent for reference ${index + 1}`);
      input.addEventListener("change", () => {
        const region = Object.fromEntries(Object.entries(inputs).map(([k, n]) => [k, Number(n.value) / 100]));
        region.x = Math.max(0, Math.min(.99, region.x)); region.y = Math.max(0, Math.min(.99, region.y));
        region.width = Math.max(.01, Math.min(1 - region.x, region.width));
        region.height = Math.max(.01, Math.min(1 - region.y, region.height));
        if (normalizeRegion(region)) {targeting[key] = region; commit(); render();}
      });
      inputs[name] = input; wrap.append(input); fields.append(wrap);
    }
    const reset = el("button", "Clear selection"); reset.type = "button";
    reset.setAttribute("aria-label", `Clear ${label.toLowerCase()} for reference ${index + 1}`);
    reset.addEventListener("click", () => {targeting[key] = null; commit(); render();});
    let selectionChanged = () => {};
    const commit = () => {
      if (key === "target") targeting.targetImage = targeting.target ? sourceImage : null;
      save({targeting: normalizeTargeting(targeting), ...(key === "target" ? {editMask:null} : {})});
      selectionChanged();
    };
    const render = () => {
      const region = targeting[key]; rectangle.hidden = !region;
      for (const [name, n] of Object.entries(inputs)) n.value = String(Math.round((region?.[name] ?? (name === "width" || name === "height" ? 1 : 0)) * 100));
      if (region) Object.assign(rectangle.style, {left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%`});
      reset.disabled = !region;
    };
    const point = event => {const box = frame.getBoundingClientRect(); return {x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height))};};
    let start = null, before = null;
    frame.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !picture.naturalWidth) return;
      before = targeting[key]; start = point(event); frame.setPointerCapture(event.pointerId); event.preventDefault();
    });
    frame.addEventListener("pointermove", event => {
      if (!start) return;
      const end = point(event), region = {x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y)};
      if (region.width >= .01 && region.height >= .01) {targeting[key] = region; render();}
    });
    frame.addEventListener("pointerup", () => {if (start) {start = null; commit();}});
    frame.addEventListener("pointercancel", () => {if (start) {start = null; targeting[key] = before; render();}});
    const detect = el("button", "Find people"), candidates = el("div"), status = el("small");
    detect.type = "button"; detect.disabled = !fetchApi;
    detect.setAttribute("aria-label", `Find people in ${label.toLowerCase()} for reference ${index + 1}`);
    status.setAttribute("role", "status"); candidates.className = "ps-target-candidates";
    detect.addEventListener("click", async () => {
      detect.disabled = true; candidates.replaceChildren(); status.textContent = "Finding people locally…";
      let result;
      try {result = await referenceDetection(fetchApi, "detect", {image},signal);}
      catch(error) {if(current())status.textContent=error.message;detect.disabled=false;return;}
      if (!current()) return;
      detect.disabled = false;
      status.textContent = result.available ? (result.boxes?.length ? "Choose a candidate, ordered left to right. Adjust the rectangle as needed; detections can miss people." : "No people detected. Draw a selection manually.") : result.reason;
      for (const [i, box] of (result.boxes || []).entries()) {
        const region = normalizeRegion(box.region); if (!region) continue;
        const choose = el("button", `Person ${i + 1} (score ${Number(box.score).toFixed(2)})`); choose.type = "button";
        choose.addEventListener("click", () => {if (root.isConnected) {targeting[key] = region; commit(); render();}});
        candidates.append(choose);
      }
    });
    const query = el("input"), objects = el("button", "Find object"); query.type="text";query.maxLength=120;
    query.placeholder="Object name, e.g. jacket";query.setAttribute("aria-label",`Object to find in ${label.toLowerCase()} for reference ${index+1}`);objects.type="button";
    objects.addEventListener("click",async()=>{
      if(!query.value.trim()){status.textContent="Enter an object name first.";return;}
      const selection=JSON.stringify(targeting[key]);objects.disabled=true;candidates.replaceChildren();status.textContent="Finding object locally…";
      try {
        const result=await requestReferenceRegion(fetchApi,"objects",{image,query:query.value.trim(),region:targeting[key]},signal);
        if(!current() || JSON.stringify(targeting[key])!==selection)return;
        status.textContent=result.boxes?.length ? "Choose an object candidate; the current selection limits the search." : "No object found. Adjust the selection or object name.";
        for(const [i,box] of (result.boxes||[]).entries()){
          const r=normalizeRegion(box.region);if(!r)continue;
          const choose=el("button",`${box.label} ${i+1} (score ${Number(box.score).toFixed(2)})`);choose.type="button";
          choose.addEventListener("click",()=>{if(current()){targeting[key]=r;commit();render();}});candidates.append(choose);
        }
      }catch(error){if(current())status.textContent=error.message;}finally{objects.disabled=false;}
    });
    group.append(legend,frame,hint,detect,query,objects,status,candidates,fields,reset);
    if(key==="target" && maskSupported){
      const make=el("button","Create edit mask"), preview=el("img"), enableLabel=el("label"), enable=el("input"), clear=el("button","Remove edit mask");
      make.type=clear.type="button";enable.type="checkbox";preview.alt="Edit mask: white pixels are replaced, black pixels are preserved";preview.className="ps-guide-preview";
      let mask=normalizeEditMask(entry.editMask);
      const display=()=>{preview.hidden=enableLabel.hidden=clear.hidden=!mask;if(mask){preview.src=imageUrl(mask.image);enable.checked=mask.enabled;}};
      enableLabel.append(enable,doc.createTextNode(" Preserve source pixels outside this mask"));
      enable.addEventListener("change",()=>{if(mask){mask={...mask,enabled:enable.checked};save({editMask:mask});}});
      clear.addEventListener("click",()=>{mask=null;save({editMask:null});display();});
      make.addEventListener("click",async()=>{
        if(!targeting.target){status.textContent="Select the region to edit first.";return;}
        const region={...targeting.target};make.disabled=true;status.textContent="Segmenting the selected region on CPU…";
        try{
          const result=await requestReferenceRegion(fetchApi,"mask",{image,region},signal);
          if(!current() || JSON.stringify(region)!==JSON.stringify(targeting.target))return;
          mask=normalizeEditMask({image:result.mask,sourceImage:image,sourceDigest:result.source_digest,region,enabled:false});
          if(!mask)throw Error("Invalid edit mask result");save({editMask:mask});display();status.textContent="Review the white edit area, then enable preservation. Output keeps source dimensions.";
        }catch(error){if(current())status.textContent=error.message;}finally{make.disabled=false;}
      });
      group.append(make,preview,enableLabel,clear,el("small","Masks constrain the final composite, not generation. Tight masks can clip new clothing or moved limbs; seams may remain. Masked edits keep source dimensions and use lossless saving."));display();
      selectionChanged=()=>{mask=null;display();};
    }
    root.append(group); render();
  };
  add("reference", "Use from reference", entry.image);
  if (edit) add("target", "Apply to source", sourceImage);
  return root;
}
