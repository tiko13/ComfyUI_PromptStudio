import {layoutBinding, normalizeSpatialInput, spatialContractKey} from "../generation/spatial-inputs.js";
import {namedStructureInputs} from "../generation/workflow-capabilities.js";

// The editor owns a draft. Only Apply publishes it to the chat's existing store.
export function openSpatialEditor({profile, value, defaults, save, upload, imageUrl, aspect = 1, dimensions, ownerDocument = document}) {
  if (!ownerDocument.querySelector('link[data-spatial-editor]')) {
    const css = ownerDocument.createElement("link"); css.rel = "stylesheet"; css.href = new URL("../../../css/spatial-editor.css", import.meta.url).href;
    css.dataset.spatialEditor = "true"; ownerDocument.head.append(css);
  }
  let draft = normalizeSpatialInput(value), selected = draft.elements[0]?.id, past = [], future = [], busy = false, backgroundKey = "";
  const dialog = ownerDocument.createElement("dialog"); dialog.className = "ps-spatial-editor";
  dialog.setAttribute("aria-label", "Layout and control maps");
  const el = (tag, text, parent) => {const n = ownerDocument.createElement(tag); if (text) n.textContent = text; parent?.append(n); return n;};
  const title = el("h2", "Layout and control maps", dialog);
  title.id = `spatial-title-${Date.now()}`; dialog.setAttribute("aria-labelledby", title.id);
  const status = el("p", "", dialog); status.setAttribute("role", "status");
  const body = el("div", "", dialog), footer = el("div", "", dialog); footer.className = "ps-spatial-toolbar ps-spatial-footer";
  const button = (label, action, parent = footer) => {const b = el("button", label, parent); b.type = "button"; b.addEventListener("click", action); return b;};
  const close = () => {if (!busy) {dialog.close(); dialog.remove();}};
  button("Cancel", close);
  const apply = button("Apply", () => {try {save(normalizeSpatialInput({...draft,contract:spatialContractKey(profile)})); close();} catch(e) {status.textContent = e.message;}});
  const checkpoint = () => {past.push(structuredClone(draft)); if(past.length > 50)past.shift(); future = [];};
  const update = action => {checkpoint(); action(); draft = normalizeSpatialInput(draft); render();};
  const field = (label, type, val, action, parent) => {
    const row = el("label", label, parent), input = el(type === "textarea" ? "textarea" : "input", "", row);
    if (type !== "textarea") input.type = type;
    if(type === "checkbox")input.checked = val; else input.value = val;
    input.setAttribute("aria-label", label);
    input.addEventListener("change", () => update(() => action(type === "checkbox" ? input.checked : type === "number" ? Number(input.value) : input.value)));
    return input;
  };
  const select = (label, options, val, action, parent) => {
    const row = el("label", label, parent), input = el("select", "", row); input.setAttribute("aria-label", label);
    for(const [value, name] of options) {const o = el("option", name, input); o.value = value;}
    input.value = val; input.addEventListener("change", () => update(() => action(input.value))); return input;
  };
  const runUpload = async (file, slot) => {
    if(!file || busy)return;
    if (!file.type.startsWith("image/") || !file.size || file.size > 20*1024*1024) {status.textContent = "Choose an image smaller than 20 MB."; return;}
    busy = true; apply.disabled = true; status.textContent = "Uploading control map…";
    try {const image = await upload(file); update(() => {draft.guides[slot.key] = {image, kind: slot.kinds[0], enabled: true, input: "prepared", fit: draft.alignment, invert: false};}); status.textContent = "Map uploaded. Apply to save.";}
    catch(e){status.textContent = e.message;}
    finally{busy = false; apply.disabled = false; render();}
  };
  function render() {
    body.replaceChildren();
    const layout = layoutBinding(profile);
    const tools = el("div", "", body); tools.className = "ps-spatial-toolbar";
    button("Undo", () => {if(past.length){future.push(structuredClone(draft));draft = past.pop();render();}}, tools).disabled = !past.length;
    button("Redo", () => {if(future.length){past.push(structuredClone(draft));draft = future.pop();render();}}, tools).disabled = !future.length;
    button("Reset to workflow", () => update(() => {draft = structuredClone(defaults);}), tools);
    button("Export layout", () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], {type:"application/json"}));
      const a = ownerDocument.createElement("a"); a.href = url; a.download = "studio-layout.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, tools);
    const imp = el("input", "", tools); imp.type = "file"; imp.accept = ".json"; imp.setAttribute("aria-label", "Import layout");
    imp.addEventListener("change", async () => {try {if(imp.files[0].size > 1024 * 1024)throw new Error("Layout file is too large."); const next = normalizeSpatialInput(JSON.parse(await imp.files[0].text()));update(() => {draft = next;});} catch(e){status.textContent = e.message;}});
    if(layout) {
      field("Use layout", "checkbox", draft.enabled, v => {draft.enabled = v;}, body);
      const backgrounds = Object.entries(draft.guides).filter(([,g])=>g.image).map(([key])=>[key,`${key} map`]);
      if (backgrounds.length) select("Canvas background", [["","Grid"],...backgrounds], backgroundKey, key=>{backgroundKey=key;},body);
      const grid = el("div", "", body); grid.className = "ps-spatial-grid";
      const canvas = el("div", "", grid); canvas.className = "ps-spatial-canvas"; canvas.style.aspectRatio = String(aspect || 1);
      canvas.tabIndex = 0; canvas.setAttribute("role", "group"); canvas.setAttribute("aria-label", "Layout canvas. Drag empty space to draw; drag a box to move; use arrow keys to move selection.");
      const background = draft.guides[backgroundKey];
      if (background) {
        const img = el("img", "", canvas); img.src = imageUrl(background.image); img.alt = ""; img.className = "ps-spatial-background";
        img.style.objectFit = draft.alignment === "crop" ? "cover" : draft.alignment === "stretch" ? "fill" : "contain";
        if (background.kind === "depth" && background.invert) img.style.filter = "invert(1)";
      }
      const inspector = el("div", "", grid); inspector.className = "ps-spatial-inspector";
      const list = select("Selected element", draft.elements.map((e,i) => [e.id, `${i+1}. ${e.type}: ${e.text || e.description || "Untitled"}`]), selected,
        id => {selected = id;}, inspector);
      if(!draft.elements.some(e => e.id === selected)) selected = draft.elements[0]?.id;
      list.value = selected || "";
      for(const type of ["object", "character", "text"]) button(`Add ${type}`, () => update(() => {
        const e = {id: crypto.randomUUID(), type, x:.1,y:.1,width:.35,height:.2,description:"",text:"",palette:[]};draft.elements.push(e);selected=e.id;
      }), tools).disabled = draft.elements.length >= 64;
      for(const [index,e] of draft.elements.entries()) {
        const box = el("div", `${index+1}. ${e.text || e.description || e.type}`, canvas); box.className = "ps-spatial-box";box.dataset.id = e.id;
        box.classList.toggle("selected", e.id === selected); Object.assign(box.style,{left:`${e.x*100}%`,top:`${e.y*100}%`,width:`${e.width*100}%`,height:`${e.height*100}%`});
        const handle = el("span", "↘", box);handle.className="ps-spatial-resize";
      }
      const e = draft.elements.find(e => e.id === selected);
      if(e) {
        select("Element type", ["object","character","text"].map(x=>[x,x]), e.type, v=>{e.type=v;}, inspector);
        field("Description", "textarea", e.description, v=>{e.description=v;}, inspector);
        if(e.type === "text")field("Exact text", "textarea", e.text, v=>{e.text=v;}, inspector);
        for(const name of ["x","y","width","height"]) {const input=field(`${name} (%)`,"number",Math.round(e[name]*1000)/10,v=>{e[name]=v/100;},inspector);input.min="0";input.max="100";input.step="0.1";}
        field("Palette (hex colors, comma separated)","text",e.palette.join(", "),v=>{e.palette=v.split(",").map(x=>x.trim());},inspector);
        const actions=el("div","",inspector);actions.className="ps-spatial-toolbar";
        button("Duplicate",()=>update(()=>{const copy={...structuredClone(e),id:crypto.randomUUID()};draft.elements.push(copy);selected=copy.id;}),actions).disabled=draft.elements.length>=64;
        button("Delete",()=>update(()=>{draft.elements=draft.elements.filter(x=>x.id!==e.id);}),actions);
        for(const [label,delta] of [["Move earlier",-1],["Move later",1]])button(label,()=>update(()=>{const i=draft.elements.indexOf(e),j=i+delta;if(j>=0&&j<draft.elements.length)[draft.elements[i],draft.elements[j]]=[draft.elements[j],draft.elements[i]];}),actions);
        button("Center horizontally",()=>update(()=>{e.x=(1-e.width)/2;}),actions);
        button("Center vertically",()=>update(()=>{e.y=(1-e.height)/2;}),actions);
      }
      canvas.addEventListener("keydown", event => {
        if (!e || !draft.enabled) return;
        const dx = {ArrowLeft:-1, ArrowRight:1}[event.key] || 0, dy = {ArrowUp:-1, ArrowDown:1}[event.key] || 0;
        if (dx || dy) {
          event.preventDefault();
          update(() => {
            e.x = Math.max(0, Math.min(1-e.width, e.x + dx*(event.shiftKey ? .05 : .005)));
            e.y = Math.max(0, Math.min(1-e.height, e.y + dy*(event.shiftKey ? .05 : .005)));
          });
          body.querySelector(".ps-spatial-canvas")?.focus();
        }
      });
      canvas.addEventListener("pointerdown", event => {
        if(event.button !== 0 || !draft.enabled)return;
        const rect=canvas.getBoundingClientRect(),point=ev=>({x:Math.max(0,Math.min(1,(ev.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(ev.clientY-rect.top)/rect.height))});
        const start=point(event),hit=event.target.closest(".ps-spatial-box"),resize=event.target.classList.contains("ps-spatial-resize");
        if(!hit&&draft.elements.length>=64)return;
        checkpoint();let item=hit?draft.elements.find(x=>x.id===hit.dataset.id):{id:crypto.randomUUID(),type:"object",x:start.x,y:start.y,width:.01,height:.01,description:"",text:"",palette:[]};
        if(!hit)draft.elements.push(item);selected=item.id;const original={...item};
        const box=hit||el("div","New object",canvas);box.className="ps-spatial-box selected";
        canvas.setPointerCapture(event.pointerId);
        const move=ev=>{const p=point(ev),dx=p.x-start.x,dy=p.y-start.y;
          if(!hit){item.x=Math.min(start.x,p.x);item.y=Math.min(start.y,p.y);item.width=Math.abs(dx);item.height=Math.abs(dy);}
          else if(resize){item.width=Math.max(.005,Math.min(1-item.x,original.width+dx));item.height=Math.max(.005,Math.min(1-item.y,original.height+dy));}
          else{item.x=Math.max(0,Math.min(1-item.width,original.x+dx));item.y=Math.max(0,Math.min(1-item.height,original.y+dy));}
          Object.assign(box.style,{left:`${item.x*100}%`,top:`${item.y*100}%`,width:`${item.width*100}%`,height:`${item.height*100}%`});};
        const end=()=>{canvas.removeEventListener("pointermove",move);canvas.removeEventListener("pointerup",end);canvas.removeEventListener("pointercancel",end);draft=normalizeSpatialInput(draft);render();};
        canvas.addEventListener("pointermove",move);canvas.addEventListener("pointerup",end);canvas.addEventListener("pointercancel",end);
      });
      el("p","Boxes guide composition; text rendering and exact placement still depend on the model. Palette colors describe appearance, not control-region IDs.",body);
    }
    const slots=namedStructureInputs(profile);
    if(slots.length) {
      select("Map alignment", [["fit","Fit with padding"],["crop","Center crop"],["stretch","Stretch to canvas"]], draft.alignment, v=>{draft.alignment=v;for(const g of Object.values(draft.guides))g.fit=v;},body);
      el("p","Use maps with matching framing. Color maps contain flat region IDs; depth is grayscale with near objects white. Applying maps does not preserve original pixels.",body);
      for(const slot of slots) {
        const card=el("fieldset","",body);el("legend",`${slot.key} map`,card);const g=draft.guides[slot.key];
        if (layout && slot.kinds.includes("color")) button("Create color map from layout", async () => {
          const map = ownerDocument.createElement("canvas"); map.width = dimensions?.width || 1024; map.height = dimensions?.height || Math.max(16,Math.round(1024/(aspect||1)));
          const ctx = map.getContext("2d"); ctx.fillStyle = "#000000"; ctx.fillRect(0,0,map.width,map.height);
          draft.elements.forEach((e,index)=>{ctx.fillStyle=`hsl(${index*137.508%360} 85% 55%)`;ctx.fillRect(Math.round(e.x*map.width),Math.round(e.y*map.height),Math.round(e.width*map.width),Math.round(e.height*map.height));});
          const blob = await new Promise(resolve=>map.toBlob(resolve,"image/png"));
          if (blob) await runUpload(new File([blob],"layout-regions.png",{type:"image/png"}),slot);
        },card).disabled = busy || !draft.enabled || !draft.elements.length;
        const input=el("input","",card);input.type="file";input.accept="image/png,image/jpeg,image/webp";input.setAttribute("aria-label",`Upload ${slot.key} map`);input.addEventListener("change",()=>runUpload(input.files[0],slot));
        if(g) {
          const img=el("img","",card);img.src=imageUrl(g.image);img.alt=`${slot.key} map preview`;img.className="ps-spatial-map-preview";
          if (g.kind === "depth" && g.invert) img.style.filter = "invert(1)";
          field(`Use ${slot.key} map`,"checkbox",g.enabled,v=>{g.enabled=v;},card);
          if (slot.kinds.length > 1) select(`${slot.key} map type`,slot.kinds.map(k=>[k,k]),g.kind,v=>{g.kind=v;g.input="prepared";g.invert=false;},card);
          if(g.kind === "depth") {
            select("Depth source",[["prepared","Prepared depth map"],["photo","Extract from photo"]],g.input,v=>{g.input=v;},card);
            field("Invert depth", "checkbox",g.invert,v=>{g.invert=v;},card);
          }
          button(`Remove ${slot.key} map`,()=>update(()=>{delete draft.guides[slot.key];}),card);
        }
      }
    }
  }
  dialog.addEventListener("cancel", event=>{event.preventDefault();close();});
  ownerDocument.body.append(dialog);render();dialog.showModal();
  return dialog;
}
