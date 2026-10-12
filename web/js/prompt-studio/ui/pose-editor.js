import { BODY_NAMES, PARTS, defaultPose, normalizePose, posePoints, renderPose, poseFile, jointRotation, rotatePoseJoint } from "../generation/pose.js";
import { installDialogFocus } from "./dialog-focus.js";

// Drafts remain local to the dialog. Only Apply publishes a rendered guide.
export function openPoseEditor({doc, data, original = data, sourceImage = null, sourceRegion = null, imageUrl, apply, valid = () => true, signal}) {
  let pose=normalizePose(data), initial=normalizePose(original);
  if(!pose?.people.length || !initial?.people.length)throw Error("This pose has no editable joint data.");
  const el=(tag,text,cls)=>{const n=doc.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
  const trigger=doc.activeElement;
  const dialog=el("dialog",null,"ps-reference-dialog ps-pose-dialog");dialog.setAttribute("aria-label","Edit pose");
  const header=el("header"),title=el("div"),cancel=el("button","Cancel");
  title.append(el("h2","Edit pose"),el("small",sourceImage ? "Adjust the detected pose" : "Build a pose from scratch"));header.append(title,cancel);
  const tools=el("div",null,"ps-pose-tools"),inspector=el("div",null,"ps-pose-inspector"),stage=el("div",null,"ps-pose-stage"),surface=el("div",null,"ps-pose-surface"),canvas=el("canvas");
  canvas.width=pose.canvas_width;canvas.height=pose.canvas_height;canvas.tabIndex=0;canvas.setAttribute("aria-label","Pose canvas");
  surface.append(canvas);stage.append(surface);
  const hint=el("p","Drag a joint to move it freely. Select a joint and drag its ring to rotate the attached limb. Hold Shift while rotating to snap to 15°.","ps-pose-hint");
  const rotationHint=el("small",null,"ps-pose-rotation-hint");
  const rotationHelp=el("span"),rotationValue=el("span");rotationHint.append(rotationHelp,rotationValue);
  const status=el("small");status.setAttribute("role","status");
  const footer=el("footer"),applyButton=el("button","Apply pose","ps-pose-apply");footer.append(status,applyButton);
  let person=0,part="pose_keypoints_2d",selected=1,mode="joint",history=[],future=[],drag=null,busy=false,zoom=1,viewReady=false;
  const button=(parent,text,action)=>{const b=el("button",text);b.type="button";b.addEventListener("click",action);parent.append(b);return b;};
  const field=(parent,label,control)=>{const l=el("label",label);control.setAttribute("aria-label",label);l.append(control);parent.append(l);return control;};
  const personSelect=field(inspector,"Person",el("select")),partSelect=field(inspector,"Edit",el("select")),jointSelect=field(inspector,"Joint",el("select"));
  for(const [key,label] of Object.entries(PARTS)){const o=el("option",label);o.value=key;partSelect.append(o);}
  const modeButtons={};
  for(const [key,label] of [["joint","Move joint"],["person","Move person"],["part","Move part"],["pan","Pan"]])modeButtons[key]=button(tools,label,()=>{mode=key;draw();});
  const remember=()=>{history.push(structuredClone(pose));if(history.length>60)history.shift();future=[];};
  const undo=button(tools,"Undo",()=>{if(!history.length)return;future.push(pose);pose=history.pop();refresh();});
  const redo=button(tools,"Redo",()=>{if(!future.length)return;history.push(pose);pose=future.pop();refresh();});
  button(tools,"Reset pose",()=>{remember();pose=structuredClone(initial);person=0;refresh();});
  const change=fn=>{if(busy)return;remember();fn();refresh();};
  personSelect.addEventListener("change",()=>{person=Number(personSelect.value);refresh();});
  partSelect.addEventListener("change",()=>{part=partSelect.value;selected=0;refresh();});
  jointSelect.addEventListener("change",()=>{selected=Number(jointSelect.value);draw();});
  const actions=el("div",null,"ps-pose-tools");
  const transform = (angle, factor) => change(() => {
    const keys = part === "pose_keypoints_2d" ? Object.keys(PARTS) : [part];
    const points = posePoints(pose.people[person],part).filter(p=>p.visible);if(!points.length)return;
    const cx=points.reduce((s,p)=>s+p.x,0)/points.length,cy=points.reduce((s,p)=>s+p.y,0)/points.length;
    for(const key of keys){const a=pose.people[person][key];for(let i=0;i<a.length;i+=3)if(a[i+2]>0){const x=(a[i]-cx)*factor,y=(a[i+1]-cy)*factor;a[i]=Math.max(0,Math.min(canvas.width,cx+x*Math.cos(angle)-y*Math.sin(angle)));a[i+1]=Math.max(0,Math.min(canvas.height,cy+x*Math.sin(angle)+y*Math.cos(angle)));}}
  });
  const transforms=el("details",null,"ps-pose-transforms"),transformTools=el("div",null,"ps-pose-tools");transforms.append(el("summary","Rotate / resize"),transformTools);
  button(transformTools,"Rotate left",()=>transform(-Math.PI/18,1));button(transformTools,"Rotate right",()=>transform(Math.PI/18,1));
  button(transformTools,"Smaller",()=>transform(0,.9));button(transformTools,"Larger",()=>transform(0,1.1));
  transformTools.append(el("small","Applies to the selected part. Body transforms the whole person."));
  const addPerson=button(actions,"Add person",()=>change(()=>{pose.people.push(defaultPose(pose.canvas_width,pose.canvas_height).people[0]);person=pose.people.length-1;}));
  const removePerson=button(actions,"Remove person",()=>change(()=>{pose.people.splice(person,1);person=Math.max(0,person-1);}));
  button(actions,"Mirror person",()=>change(()=>{const xs=Object.keys(PARTS).flatMap(key=>posePoints(pose.people[person],key).filter(p=>p.visible).map(p=>p.x));if(!xs.length)return;const sum=Math.min(...xs)+Math.max(...xs);for(const key of Object.keys(PARTS)){const a=pose.people[person][key];for(let i=0;i<a.length;i+=3)if(a[i+2]>0)a[i]=sum-a[i];}}));
  const hide=button(actions,"Hide joint",()=>change(()=>{pose.people[person][part][selected*3+2]=0;}));
  const place=button(actions,"Place joint",()=>{mode="place";status.textContent="Click the canvas to place the selected joint.";draw();});
  const addHand=button(actions,"Add hand",()=>change(()=>{
    const body=pose.people[person].pose_keypoints_2d,wrist=part==="hand_left_keypoints_2d"?7:4;
    if(!body[wrist*3+2])throw Error("Place the wrist on the body first.");
    const x=body[wrist*3],y=body[wrist*3+1],s=Math.min(pose.canvas_width,pose.canvas_height)*.025;
    const points=[x,y,1];for(let f=0;f<5;f++)for(let j=1;j<=4;j++)points.push(Math.max(0,Math.min(pose.canvas_width,x+(f-2)*s*(.5+j*.2))),Math.max(0,y-j*s),1);
    pose.people[person][part]=points;
  }));
  const view=el("div",null,"ps-pose-tools ps-pose-view"),zoomInput=field(view,"Zoom",el("input")),opacity=field(view,"Photo opacity",el("input"));
  const zoomValue=el("output","100%");zoomInput.parentElement.append(zoomValue);
  zoomInput.type=opacity.type="range";zoomInput.min="1";zoomInput.max="12";zoomInput.step=".01";zoomInput.value="1";
  opacity.min="0";opacity.max="1";opacity.step=".05";opacity.value=".35";opacity.parentElement.hidden=!sourceImage;
  function setZoom(value,anchor){
    if(busy||drag)return;
    const next=Math.max(1,Math.min(12,value));if(next===zoom)return;
    zoom=next;zoomInput.value=String(zoom);zoomValue.value=`${Math.round(zoom*100)}%`;layout(anchor);
  }
  zoomInput.addEventListener("input",()=>setZoom(Number(zoomInput.value)));opacity.addEventListener("input",draw);
  button(view,"Fit view",()=>{zoom=1;zoomInput.value="1";zoomValue.value="100%";viewReady=false;layout();});
  view.append(el("small","Scroll to zoom at the pointer. Hold the middle mouse button and drag to pan, or use Pan."));
  stage.addEventListener("wheel",event=>{
    event.preventDefault();
    const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?stage.clientHeight:1);
    setZoom(zoom*Math.exp(-Math.max(-600,Math.min(600,delta))*.002),event);
  },{passive:false});
  const picture=el("img"),layer=el("canvas");layer.width=canvas.width;layer.height=canvas.height;
  if(sourceImage){picture.onload=draw;picture.onerror=()=>{status.textContent="Photo unavailable. You can still edit the saved pose.";};picture.src=imageUrl(sourceImage);}
  function layout(anchor){
    const bounds=stage.getBoundingClientRect(),before=canvas.getBoundingClientRect();
    const x=anchor?.clientX??bounds.left+stage.clientLeft+stage.clientWidth/2;
    const y=anchor?.clientY??bounds.top+stage.clientTop+stage.clientHeight/2;
    const px=viewReady?(x-before.left)/before.width:.5,py=viewReady?(y-before.top)/before.height:.5;
    const scale=Math.min((stage.clientWidth-24)/canvas.width,(stage.clientHeight-24)/canvas.height)*zoom;
    const width=Math.max(1,canvas.width*scale),height=Math.max(1,canvas.height*scale);
    canvas.style.width=`${width}px`;canvas.style.height=`${height}px`;
    // Half a viewport of padding allows even an edge joint to stay under the
    // pointer while the canvas crosses from smaller to larger than the view.
    surface.style.width=`${width+stage.clientWidth}px`;surface.style.height=`${height+stage.clientHeight}px`;
    stage.scrollLeft=stage.clientWidth/2+px*width-(x-bounds.left-stage.clientLeft);
    stage.scrollTop=stage.clientHeight/2+py*height-(y-bounds.top-stage.clientTop);
    viewReady=true;draw();
  }
  function refresh(){
    person=Math.min(person,pose.people.length-1);personSelect.replaceChildren();
    pose.people.forEach((_,i)=>{const o=el("option",`Person ${i+1}`);o.value=String(i);personSelect.append(o);});personSelect.value=String(person);
    jointSelect.replaceChildren();posePoints(pose.people[person],part).forEach((p,i)=>{const name=part==="pose_keypoints_2d"?BODY_NAMES[i]:i===0&&part!=="face_keypoints_2d"?"Wrist":`Point ${i+1}`;const o=el("option",name+(p.visible?"":" · hidden"));o.value=String(i);jointSelect.append(o);});
    jointSelect.value=String(selected);partSelect.value=part;draw();
  }
  function draw(){
    if(!pose.people.length)return;
    renderPose(layer.getContext("2d"),pose);const ctx=canvas.getContext("2d");ctx.fillStyle="#090a10";ctx.fillRect(0,0,canvas.width,canvas.height);
    if(picture.complete&&picture.naturalWidth){const r=sourceRegion||{x:0,y:0,width:1,height:1};ctx.globalAlpha=Number(opacity.value);ctx.drawImage(picture,r.x*picture.naturalWidth,r.y*picture.naturalHeight,r.width*picture.naturalWidth,r.height*picture.naturalHeight,0,0,canvas.width,canvas.height);ctx.globalAlpha=1;}
    ctx.globalCompositeOperation="screen";ctx.drawImage(layer,0,0);ctx.globalCompositeOperation="source-over";
    const scale=canvas.width/(canvas.getBoundingClientRect().width||canvas.width),points=posePoints(pose.people[person],part);
    for(const p of points)if(p.visible){ctx.beginPath();ctx.arc(p.x,p.y,(p.index===selected?7:4)*scale,0,Math.PI*2);ctx.strokeStyle=p.index===selected?"#c6baff":"#ffffffaa";ctx.lineWidth=1.5*scale;ctx.stroke();}
    const rotation=mode==="joint"?jointRotation(pose.people[person],part,selected):null;
    const jointName=jointSelect.selectedOptions[0]?.textContent||"Joint";
    rotationHelp.textContent=rotation ? `${jointName} · drag the ring to rotate; drag the center to move.` : "Arrow keys nudge the selected joint; Shift makes larger steps.";
    // Keep the wrapped instructions in layout while displaying the angle, so
    // the canvas cannot move beneath the pointer in the middle of a gesture.
    rotationHelp.style.visibility=drag?.rotation?"hidden":"";rotationValue.textContent="";
    canvas.dataset.rotationJoint=rotation?String(selected):"";
    if(rotation){
      const radius=32*scale;
      ctx.beginPath();ctx.arc(rotation.x,rotation.y,radius,0,Math.PI*2);ctx.strokeStyle="#b3a0ff";ctx.lineWidth=2*scale;ctx.stroke();
      // Four small handles keep the ring distinct from pose bones and joints.
      for(let i=0;i<4;i++){const a=i*Math.PI/2;ctx.beginPath();ctx.arc(rotation.x+Math.cos(a)*radius,rotation.y+Math.sin(a)*radius,3.5*scale,0,Math.PI*2);ctx.fillStyle="#ded6ff";ctx.fill();}
      if(drag?.rotation){ctx.beginPath();ctx.moveTo(rotation.x,rotation.y);ctx.lineTo(rotation.x+Math.cos(drag.startAngle+drag.angle)*radius,rotation.y+Math.sin(drag.startAngle+drag.angle)*radius);ctx.strokeStyle="#ded6ff99";ctx.lineWidth=scale;ctx.stroke();rotationValue.textContent=`${jointName} · ${Math.round(drag.angle*180/Math.PI)}°${drag.blocked?" · canvas edge reached":""}`;}
    }
    undo.disabled=busy||!history.length;redo.disabled=busy||!future.length;removePerson.disabled=busy||pose.people.length===1;addPerson.disabled=busy||pose.people.length>=20;
    hide.disabled=busy||!points[selected]?.visible;place.disabled=busy;addHand.hidden=!part.startsWith("hand_");addHand.disabled=busy||points.some(p=>p.visible)||!pose.people[person].pose_keypoints_2d[(part==="hand_left_keypoints_2d"?7:4)*3+2];
    for(const [key,b]of Object.entries(modeButtons))b.setAttribute("aria-pressed",String(mode===key));
    stage.style.cursor=drag?.pan?"grabbing":mode==="pan"?"grab":"default";
    canvas.style.cursor=drag?.pan?"grabbing":drag?.rotation?"grabbing":mode==="pan"?"grab":mode==="person"||mode==="part"?"move":"crosshair";
  }
  const point=e=>{const r=canvas.getBoundingClientRect();return {x:Math.max(0,Math.min(canvas.width,(e.clientX-r.left)/r.width*canvas.width)),y:Math.max(0,Math.min(canvas.height,(e.clientY-r.top)/r.height*canvas.height))};};
  function translate(dx,dy){
    const keys=mode==="person"?Object.keys(PARTS):[part],p=pose.people[person];
    for(const key of keys){const a=p[key];for(let i=0;i<a.length;i+=3)if(a[i+2]>0){a[i]=Math.max(0,Math.min(canvas.width,a[i]+dx));a[i+1]=Math.max(0,Math.min(canvas.height,a[i+1]+dy));}}
  }
  // Suppress the browser's middle-click autoscroll anchor throughout the view.
  for(const name of ["mousedown","auxclick"])stage.addEventListener(name,e=>{if(e.button===1)e.preventDefault();});
  stage.addEventListener("pointerdown",e=>{
    if(busy||drag||(e.button!==0&&e.button!==1))return;
    const pan=e.button===1||mode==="pan";
    if(!pan&&e.target!==canvas)return;
    e.preventDefault();canvas.focus({preventScroll:true});const p=point(e);
    if(pan){drag={clientX:e.clientX,clientY:e.clientY,left:stage.scrollLeft,top:stage.scrollTop,pan:true,button:e.button};}
    else if(mode==="place"){change(()=>{pose.people[person][part].splice(selected*3,3,p.x,p.y,1);});mode="joint";status.textContent="Joint placed.";draw();return;}
    else{
      if(mode==="joint"){
        const scale=canvas.width/canvas.getBoundingClientRect().width,radius=16*scale;
        const near=posePoints(pose.people[person],part).filter(p=>p.visible).map(q=>({...q,d:Math.hypot(q.x-p.x,q.y-p.y)})).sort((a,b)=>a.d-b.d)[0];
        const rotation=jointRotation(pose.people[person],part,selected);
        // Direct hits on joints win over the ring, including nearby joints.
        if(rotation&&(!near||near.d>10*scale)&&Math.abs(Math.hypot(p.x-rotation.x,p.y-rotation.y)-32*scale)<=7*scale){
          drag={rotation:true,startAngle:Math.atan2(p.y-rotation.y,p.x-rotation.x),angle:0,point:p,before:structuredClone(pose),future};
          stage.setPointerCapture(e.pointerId);draw();return;
        }
        if(!near||near.d>radius)return;selected=near.index;
      }
      drag={point:p,before:structuredClone(pose),future};
    }
    stage.setPointerCapture(e.pointerId);refresh();
  });
  stage.addEventListener("pointermove",e=>{
    if(!drag){
      if(mode==="joint"){
        const rotation=jointRotation(pose.people[person],part,selected),p=point(e),scale=canvas.width/canvas.getBoundingClientRect().width;
        const overJoint=posePoints(pose.people[person],part).some(q=>q.visible&&Math.hypot(p.x-q.x,p.y-q.y)<=10*scale);
        canvas.style.cursor=rotation&&!overJoint&&Math.abs(Math.hypot(p.x-rotation.x,p.y-rotation.y)-32*scale)<=7*scale?"grab":"crosshair";
      }
      return;
    }
    if(drag.pan){
      if(!(e.buttons&(drag.button===1?4:1))){drag=null;draw();return;}
      stage.scrollLeft=drag.left+drag.clientX-e.clientX;stage.scrollTop=drag.top+drag.clientY-e.clientY;return;
    }
    const p=point(e);
    if(!drag.changed&&Math.hypot(p.x-drag.point.x,p.y-drag.point.y)<2*canvas.width/canvas.getBoundingClientRect().width)return;
    if(drag.rotation){
      const pivot=jointRotation(drag.before.people[person],part,selected);
      let angle=Math.atan2(p.y-pivot.y,p.x-pivot.x)-drag.startAngle;
      angle=Math.atan2(Math.sin(angle),Math.cos(angle));
      if(e.shiftKey)angle=Math.round(angle/(Math.PI/12))*Math.PI/12;
      const next=structuredClone(drag.before);
      drag.blocked=!rotatePoseJoint(next,person,part,selected,angle);
      if(!drag.blocked){if(!drag.changed){remember();drag.changed=true;}pose=next;drag.angle=angle;}
      draw();return;
    }
    if(!drag.changed){remember();drag.changed=true;}
    pose=structuredClone(drag.before);
    if(mode==="joint"){
      const a=pose.people[person][part],dx=p.x-a[selected*3],dy=p.y-a[selected*3+1];a[selected*3]=p.x;a[selected*3+1]=p.y;
      // A moved body wrist carries its fingers along with it.
      if(part==="pose_keypoints_2d"&&(selected===4||selected===7)){const hand=pose.people[person][selected===4?"hand_right_keypoints_2d":"hand_left_keypoints_2d"];for(let i=0;i<hand.length;i+=3)if(hand[i+2]>0){hand[i]=Math.max(0,Math.min(canvas.width,hand[i]+dx));hand[i+1]=Math.max(0,Math.min(canvas.height,hand[i+1]+dy));}}
    }else translate(p.x-drag.point.x,p.y-drag.point.y);
    draw();
  });
  stage.addEventListener("pointerup",()=>{drag=null;refresh();});
  const cancelDrag=()=>{if(drag?.changed){pose=drag.before;history.pop();future=drag.future;}drag=null;refresh();};
  stage.addEventListener("pointercancel",cancelDrag);
  stage.addEventListener("lostpointercapture",()=>{if(drag)cancelDrag();});
  canvas.addEventListener("keydown",e=>{
    const directions={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};if(!directions[e.key]||busy)return;e.preventDefault();
    const a=pose.people[person][part];if(!a[selected*3+2])return;const [dx,dy]=directions[e.key],step=e.shiftKey?10:1;
    change(()=>{a[selected*3]=Math.max(0,Math.min(canvas.width,a[selected*3]+dx*step));a[selected*3+1]=Math.max(0,Math.min(canvas.height,a[selected*3+1]+dy*step));});
  });
  dialog.addEventListener("keydown",e=>{if(busy)return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="z"){e.preventDefault();(e.shiftKey?redo:undo).click();}else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="y"){e.preventDefault();redo.click();}});
  cancel.addEventListener("click",()=>dialog.close());
  dialog.addEventListener("cancel",e=>{if(busy)e.preventDefault();});
  applyButton.addEventListener("click",async()=>{
    if(busy||!valid())return;
    if(!pose.people.some(p=>Object.keys(PARTS).some(key=>posePoints(p,key).some(p=>p.visible)))){status.textContent="Place at least one joint before applying.";return;}
    busy=true;dialog.querySelectorAll("button,input,select").forEach(n=>{n.disabled=true;});status.textContent="Saving pose…";
    try{const file=await poseFile(doc,pose);if(!valid()||!dialog.open)return;await apply({file,data:structuredClone(pose),original:structuredClone(initial),sourceImage,sourceRegion});dialog.close();}
    catch(error){status.textContent=error.message;}
    finally{busy=false;dialog.querySelectorAll("button,input,select").forEach(n=>{n.disabled=false;});draw();}
  });
  dialog.append(header,hint,tools,inspector,rotationHint,stage,actions,transforms,view,footer);doc.body.append(dialog);installDialogFocus(dialog);dialog.showModal();
  const observer=new doc.defaultView.ResizeObserver(layout);observer.observe(stage);
  const abort=()=>dialog.close();signal?.addEventListener("abort",abort,{once:true});
  dialog.addEventListener("close",()=>{observer.disconnect();signal?.removeEventListener("abort",abort);dialog.remove();if(trigger?.isConnected&&!trigger.disabled)trigger.focus({preventScroll:true});});
  refresh();layout();return dialog;
}
