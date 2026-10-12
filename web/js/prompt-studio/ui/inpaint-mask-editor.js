import { requestReferenceRegion } from "../generation/reference-detection.js";
import { installDialogFocus } from "./dialog-focus.js";

export async function openInpaintMaskEditor({doc, source, mask, imageUrl, fetchApi, estimate, valid = () => true, signal, apply}) {
  const info = await requestReferenceRegion(fetchApi, "paint-mask", {image: source}, signal);
  if (!valid() || signal?.aborted) return;
  const el = (tag, text) => {const n = doc.createElement(tag); if (text) n.textContent = text; return n;};
  const dialog = el("dialog"), title = el("h2", "Edit background mask");
  const hint = el("p", "Pink areas regenerate; unpainted pixels stay unchanged. Review coverage of both the old and new body positions, especially loose clothing, hair, objects and shadows. Pose estimates are a starting point. Apply mask saves your reviewed result.");
  dialog.className = "ps-inpaint-dialog"; dialog.setAttribute("aria-label", "Edit background mask");
  const toolbar = el("div"), mode = el("select"), size = el("input"), canvas = el("canvas"), status = el("p"), footer = el("div");
  status.setAttribute("role", "status");
  for (const label of ["Paint", "Erase"]) mode.append(el("option", label));
  mode.setAttribute("aria-label", "Mask brush mode");
  size.type="range";size.min=1;size.max=20;size.value=5;size.setAttribute("aria-label", "Mask brush size");
  canvas.width=info.width;canvas.height=info.height;canvas.setAttribute("aria-label", "Background mask canvas");canvas.style.touchAction="none";
  const bitmap=el("canvas"), overlay=el("canvas"), cursor=el("span");
  cursor.className="ps-mask-brush-cursor";cursor.hidden=true;cursor.setAttribute("aria-hidden","true");
  bitmap.width=overlay.width=info.width;bitmap.height=overlay.height=info.height;
  const ctx=bitmap.getContext("2d"), view=canvas.getContext("2d"), tint=overlay.getContext("2d");
  ctx.fillStyle="black";ctx.fillRect(0,0,bitmap.width,bitmap.height);
  const load=async ref=>{const image=el("img");const ready=new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error("Image could not be loaded"));});image.src=imageUrl(ref);await ready;return image;};
  const picture=await load(source);
  if (!valid() || signal?.aborted) return;
  const hasSaved=mask?.image && mask.sourceDigest===info.source_digest;
  if(hasSaved)ctx.drawImage(await load(mask.image),0,0,bitmap.width,bitmap.height);
  if (!valid() || signal?.aborted) return;
  let drawing=false,last=null,busy=false,pointer=null;const history=[],editorAbort=new AbortController();
  const render=()=>{
    view.drawImage(picture,0,0,canvas.width,canvas.height);
    const pixels=ctx.getImageData(0,0,bitmap.width,bitmap.height);
    for(let i=0;i<pixels.data.length;i+=4){const a=pixels.data[i];pixels.data[i]=255;pixels.data[i+1]=30;pixels.data[i+2]=160;pixels.data[i+3]=Math.round(a*.5);}
    tint.putImageData(pixels,0,0);view.drawImage(overlay,0,0);
  };
  const checkpoint=()=>{history.push(ctx.getImageData(0,0,bitmap.width,bitmap.height));if(history.length>Math.max(1,Math.min(8,Math.floor(32*1024*1024/(bitmap.width*bitmap.height*4)))))history.shift();};
  const diameter=()=>Math.min(canvas.width,canvas.height)*Number(size.value)/100;
  const showCursor=()=>{
    const box=canvas.getBoundingClientRect();
    cursor.hidden=busy||!pointer||pointer.x<box.left||pointer.x>box.right||pointer.y<box.top||pointer.y>box.bottom;
    if(cursor.hidden)return;
    Object.assign(cursor.style,{left:`${pointer.x}px`,top:`${pointer.y}px`,width:`${diameter()*box.width/canvas.width}px`,height:`${diameter()*box.height/canvas.height}px`,borderStyle:mode.value==="Erase"?"dashed":"solid"});
  };
  const point=e=>{const r=canvas.getBoundingClientRect();return {x:Math.max(0,Math.min(canvas.width,(e.clientX-r.left)*canvas.width/r.width)),y:Math.max(0,Math.min(canvas.height,(e.clientY-r.top)*canvas.height/r.height))};};
  const stroke=p=>{ctx.strokeStyle=ctx.fillStyle=mode.value==="Erase"?"black":"white";ctx.lineWidth=diameter();ctx.lineCap="round";ctx.beginPath();ctx.moveTo((last||p).x,(last||p).y);ctx.lineTo(p.x,p.y);ctx.stroke();ctx.beginPath();ctx.arc(p.x,p.y,ctx.lineWidth/2,0,Math.PI*2);ctx.fill();last=p;render();};
  const track=e=>{pointer=e.pointerType==="touch"?null:{x:e.clientX,y:e.clientY};showCursor();};
  canvas.addEventListener("pointerdown",e=>{if(busy||e.button!==0)return;e.preventDefault();checkpoint();drawing=true;last=null;canvas.setPointerCapture(e.pointerId);track(e);stroke(point(e));});
  canvas.addEventListener("pointermove",e=>{track(e);if(drawing&&!busy)stroke(point(e));});
  canvas.addEventListener("pointerenter",track);
  canvas.addEventListener("pointerleave",()=>{pointer=null;showCursor();});
  for(const event of ["pointerup","pointercancel","lostpointercapture"])canvas.addEventListener(event,()=>{drawing=false;last=null;});
  size.addEventListener("input",showCursor);mode.addEventListener("change",showCursor);dialog.addEventListener("scroll",showCursor);
  doc.defaultView.addEventListener("resize",showCursor);
  const button=(text,fn)=>{const b=el("button",text);b.type="button";b.addEventListener("click",fn);return b;};
  const setBusy=value=>{busy=value;dialog.querySelectorAll("button,input,select").forEach(n=>n.disabled=value&&n!==cancel);showCursor();};
  toolbar.append(mode,size,button("Undo",()=>{if(history.length){ctx.putImageData(history.pop(),0,0);render();}}),button("Clear mask",()=>{checkpoint();ctx.fillStyle="black";ctx.fillRect(0,0,bitmap.width,bitmap.height);render();}));
  const padding=el("input"),paddingLabel=el("label","Mask padding "),paddingValue=el("output","10%");
  padding.type="range";padding.min=0;padding.max=100;padding.value=10;padding.setAttribute("aria-label","Mask padding");
  padding.addEventListener("input",()=>{paddingValue.value=`${padding.value}%`;});paddingLabel.append(padding,paddingValue);
  const estimateMask=async()=>{
    if(!estimate||busy||!valid())return;setBusy(true);status.textContent="Estimating original and target body coverage in ComfyUI’s queue…";
    try{
      const ref=await estimate({padding:Number(padding.value),width:info.width,height:info.height,signal:editorAbort.signal});
      if(!valid()||signal?.aborted||!dialog.open)return;
      const image=await load(ref);
      if(!valid()||signal?.aborted||!dialog.open)return;
      checkpoint();ctx.drawImage(image,0,0,bitmap.width,bitmap.height);render();
      status.textContent="Estimated both body positions. Review hair, clothing, objects and shadows, then Apply mask. Padding affects the next estimate; Undo restores your previous painting.";
    }catch(error){if(dialog.open)status.textContent=`${error.message} You can still paint the mask manually.`;}
    finally{setBusy(false);}
  };
  if(estimate)toolbar.append(paddingLabel,button("Estimate from poses",estimateMask));
  const close=()=>{editorAbort.abort();dialog.close();};
  const cancel=button("Cancel",close);
  footer.append(cancel,button("Apply mask",async()=>{
    if(busy||!valid())return;setBusy(true);status.textContent="Saving reviewed mask…";
    try{
      const result=await requestReferenceRegion(fetchApi,"paint-mask",{image:source,source_digest:info.source_digest,mask_data:bitmap.toDataURL("image/png")},editorAbort.signal);
      if(!valid()||!dialog.open)return;
      await apply({image:result.mask,sourceImage:source,sourceDigest:result.source_digest,region:{x:0,y:0,width:1,height:1},enabled:true,mode:"painted"});dialog.close();
    }catch(error){if(dialog.open)status.textContent=error.message;}finally{setBusy(false);}
  }));
  const abort=close;signal?.addEventListener("abort",abort,{once:true});
  dialog.addEventListener("cancel",()=>editorAbort.abort());
  dialog.addEventListener("close",()=>{editorAbort.abort();signal?.removeEventListener("abort",abort);doc.defaultView.removeEventListener("resize",showCursor);dialog.remove();});
  dialog.append(title,hint,toolbar,canvas,cursor,status,footer);doc.body.append(dialog);installDialogFocus(dialog);dialog.showModal();render();
  if(estimate&&!hasSaved)void estimateMask();
  return dialog;
}
