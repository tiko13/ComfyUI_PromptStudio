const compact = view => view.matchMedia('(max-width: 1400px), (any-pointer: coarse)').matches;
const reduced = view => view.matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Owns only a preview's temporary gestures/animations, never its media record. */
export function createTouchImageViewer({ host, image, trigger, dismiss }) {
  const view = image.ownerDocument.defaultView;
  if (!compact(view)) return { dispose() {} };
  const cleanup = [], points = new Map();
  let scale = 1, x = 0, y = 0, start = null, pinch = null, animation = null;
  let dead = false, closing = false, moved = false, lastTap = null, dragging = false;
  const listen = (node, type, fn, options) => {
    node.addEventListener(type, fn, options);
    cleanup.push(() => node.removeEventListener(type, fn, options));
  };
  const cancelAnimation = () => { animation?.cancel(); animation = null; };
  const transform = () => `translate(${x}px, ${y}px) scale(${scale})`;
  const paint = () => { image.style.transform = transform(); };
  const constrain = () => {
    x = clamp(x, -image.clientWidth * (scale - 1) / 2, image.clientWidth * (scale - 1) / 2);
    y = clamp(y, -image.clientHeight * (scale - 1) / 2, image.clientHeight * (scale - 1) / 2);
  };
  const animateTo = (from, to, done) => {
    cancelAnimation();
    if (reduced(view)) { done?.(); return; }
    animation = image.animate([{ transform: from }, { transform: to }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
    animation.onfinish = () => { animation = null; if (!dead) done?.(); };
  };
  const reset = () => {
    const from = image.style.transform;
    scale = 1; x = y = 0; dragging = false; paint();
    host.style.removeProperty('--studio-viewer-dim');
    animateTo(from, transform());
  };
  const distance = () => { const [a,b] = [...points.values()]; return Math.hypot(a.x-b.x, a.y-b.y); };
  const midpoint = () => { const [a,b] = [...points.values()]; return {x:(a.x+b.x)/2,y:(a.y+b.y)/2}; };
  host.classList.add('studio-touch-viewer');
  image.classList.add('studio-touch-image');
  image.draggable = false;
  const hint = image.ownerDocument.createElement('p');
  hint.className = 'studio-touch-viewer-hint';
  hint.textContent = 'Pinch or double-tap to zoom · Swipe down to close';
  host.append(hint);
  const zoom = image.ownerDocument.createElement('button');
  zoom.type = 'button'; zoom.className = 'studio-touch-viewer-zoom';
  zoom.textContent = 'Zoom in';
  zoom.setAttribute('aria-label', 'Zoom image in or reset to fit');
  host.append(zoom);
  const updateZoom = () => {
    zoom.textContent = scale > 1 ? 'Fit image' : 'Zoom in';
    zoom.setAttribute('aria-pressed', String(scale > 1));
    image.style.cursor = scale > 1 ? 'grab' : '';
  };
  const toggleZoom = () => {
    const from = image.style.transform;
    scale = scale > 1 ? 1 : 2.5; x = y = 0; paint(); updateZoom(); animateTo(from, transform());
  };
  listen(zoom, 'click', toggleZoom);
  listen(host, 'keydown', event => {
    if (scale <= 1 || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    x += event.key==='ArrowLeft' ? 48 : event.key==='ArrowRight' ? -48 : 0;
    y += event.key==='ArrowUp' ? 48 : event.key==='ArrowDown' ? -48 : 0;
    constrain(); paint();
  });
  // Keep native scroll/fling recognition out of this custom gesture surface,
  // including browsers that retain fling tap-suppression after pointer capture.
  listen(image, 'touchstart', event => event.preventDefault(), { passive: false });
  listen(image, 'touchmove', event => event.preventDefault(), { passive: false });
  listen(image, 'pointerdown', event => {
    if (closing || (event.pointerType !== 'touch' && !(scale > 1 && event.button === 0))) return;
    event.preventDefault(); // Do not synthesize clicks after manipulating the image.
    cancelAnimation();
    image.setPointerCapture(event.pointerId);
    points.set(event.pointerId, {x:event.clientX,y:event.clientY});
    if (points.size === 1) {
      moved = false; dragging = false;
      start = {x:event.clientX,y:event.clientY,panX:x,panY:y,lastY:event.clientY,time:event.timeStamp,velocity:0};
    } else {
      moved = true; dragging = false;
      host.style.removeProperty('--studio-viewer-dim'); paint();
      pinch = {distance:distance(), scale, x, y, center:midpoint(), rect:image.getBoundingClientRect()};
    }
  });
  listen(image, 'pointermove', event => {
    if (!points.has(event.pointerId) || closing) return;
    points.set(event.pointerId, {x:event.clientX,y:event.clientY});
    if (points.size >= 2 && pinch) {
      const center = midpoint();
      scale = clamp(pinch.scale * distance() / Math.max(1,pinch.distance), 1, 5);
      const ratio = scale / pinch.scale;
      x = pinch.x + center.x-pinch.center.x + (pinch.center.x-(pinch.rect.left+pinch.rect.width/2))*(1-ratio);
      y = pinch.y + center.y-pinch.center.y + (pinch.center.y-(pinch.rect.top+pinch.rect.height/2))*(1-ratio);
      constrain(); paint(); updateZoom(); return;
    }
    if (!start) return;
    const dx = event.clientX-start.x, dy = event.clientY-start.y;
    moved ||= Math.hypot(dx,dy)>8;
    if (scale > 1.01) { x=start.panX+dx; y=start.panY+dy; constrain(); paint(); return; }
    if (dy > 8 && Math.abs(dy)>Math.abs(dx)*1.2) dragging = true;
    if (!dragging) return;
    const travel = Math.max(0,dy), progress = Math.min(1, travel/(view.innerHeight*.6));
    image.style.transform = `translate(${dx*.35}px, ${travel}px) scale(${reduced(view) ? 1 : 1-progress*.14})`;
    host.style.setProperty('--studio-viewer-dim', String(1-progress*.85));
    start.velocity = (event.clientY-start.lastY)/Math.max(1,event.timeStamp-start.time);
    start.lastY=event.clientY; start.time=event.timeStamp;
  });
  const end = event => {
    if (!points.has(event.pointerId)) return;
    const wasPinching = Boolean(pinch);
    points.delete(event.pointerId);
    if (event.type === 'pointercancel') {
      points.clear(); start=pinch=null; reset(); updateZoom(); return;
    }
    if (points.size) { start=null; return; } // A remaining pinch finger cannot become a dismiss gesture.
    pinch=null;
    const dy=start ? event.clientY-start.y : 0;
    const velocity=start && event.timeStamp-start.time<100 ? start.velocity : 0;
    if (!wasPinching && dragging && scale<=1.01 && (dy>Math.min(150,view.innerHeight*.18) || (dy>35 && velocity>.65))) {
      closing=true;
      const from=image.style.transform;
      const to=`translate(0px, ${view.innerHeight}px) scale(${reduced(view) ? 1 : .9})`;
      image.style.transform=to;
      animateTo(from,to,dismiss);
    } else if (dragging) reset();
    else if (event.pointerType === 'touch' && !wasPinching && !moved) {
      const tap={time:event.timeStamp,x:event.clientX,y:event.clientY};
      if (lastTap && tap.time-lastTap.time<320 && Math.hypot(tap.x-lastTap.x,tap.y-lastTap.y)<30) { toggleZoom(); lastTap=null; }
      else lastTap=tap;
    }
    start=null; dragging=false;
  };
  listen(image,'pointerup',end); listen(image,'pointercancel',end);
  listen(view,'resize',()=>{points.clear();start=pinch=null;reset();updateZoom();});
  const reveal = () => {
    if (dead || points.size || !trigger?.isConnected || reduced(view)) return;
    const source=(trigger.querySelector?.('img') || trigger).getBoundingClientRect(), target=image.getBoundingClientRect();
    if (!source.width || !target.width || source.bottom<0 || source.top>view.innerHeight) return;
    const factor=Math.min(source.width/target.width,source.height/target.height);
    animateTo(`translate(${source.x+source.width/2-target.x-target.width/2}px, ${source.y+source.height/2-target.y-target.height/2}px) scale(${factor})`,transform());
  };
  if (image.complete && image.naturalWidth) reveal(); else listen(image,'load',reveal,{once:true});
  return { dispose() {
    dead=true; cancelAnimation(); cleanup.forEach(fn=>fn()); points.clear();
    hint.remove(); zoom.remove(); image.style.removeProperty('transform'); image.style.removeProperty('cursor');
    image.classList.remove('studio-touch-image'); host.classList.remove('studio-touch-viewer');
    host.style.removeProperty('--studio-viewer-dim');
  } };
}

/** Drag the read-only sheet header; scrolling its body never dismisses it. */
export function enableSheetDismiss(dialog, handle, dismiss) {
  const view=dialog.ownerDocument.defaultView;
  let start=null, animation=null;
  const down=event=>{
    if(event.pointerType!=='touch'||event.target.closest('button'))return;
    animation?.cancel(); handle.setPointerCapture(event.pointerId);
    start={id:event.pointerId,y:event.clientY,time:event.timeStamp};
  };
  const move=event=>{if(start?.id===event.pointerId)dialog.style.transform=`translateY(${Math.max(0,event.clientY-start.y)}px)`;};
  const up=event=>{
    if(start?.id!==event.pointerId)return;
    const dy=event.clientY-start.y, speed=dy/Math.max(1,event.timeStamp-start.time), from=dialog.style.transform;
    start=null; dialog.style.removeProperty('transform');
    if(event.type!=='pointercancel'&&(dy>100||(dy>35&&speed>.65))) {dismiss();return;}
    if(!reduced(view))animation=dialog.animate([{transform:from},{transform:'none'}],{duration:180,easing:'ease-out'});
  };
  handle.classList.add('studio-sheet-drag-header');
  handle.addEventListener('pointerdown',down);handle.addEventListener('pointermove',move);
  handle.addEventListener('pointerup',up);handle.addEventListener('pointercancel',up);
  return ()=>{animation?.cancel();handle.removeEventListener('pointerdown',down);handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',up);handle.removeEventListener('pointercancel',up);};
}
