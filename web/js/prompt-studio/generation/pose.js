import { normalizeImageReference } from "../chat/image-reference.js";

export const BODY_NAMES = ["Nose", "Neck", "Right shoulder", "Right elbow", "Right wrist", "Left shoulder", "Left elbow", "Left wrist", "Right hip", "Right knee", "Right ankle", "Left hip", "Left knee", "Left ankle", "Right eye", "Left eye", "Right ear", "Left ear"];
export const BODY_EDGES = [[1,2],[1,5],[2,3],[3,4],[5,6],[6,7],[1,8],[8,9],[9,10],[1,11],[11,12],[12,13],[1,0],[0,14],[14,16],[0,15],[15,17]];
export const BODY_COLORS = ["#ff0000","#ff5500","#ffaa00","#ffff00","#aaff00","#55ff00","#00ff00","#00ff55","#00ffaa","#00ffff","#00aaff","#0055ff","#0000ff","#5500ff","#aa00ff","#ff00ff","#ff00aa","#ff0055"];
export const PARTS = {pose_keypoints_2d: "Body", hand_left_keypoints_2d: "Left hand", hand_right_keypoints_2d: "Right hand", face_keypoints_2d: "Face"};
const counts = {pose_keypoints_2d: 18, hand_left_keypoints_2d: 21, hand_right_keypoints_2d: 21, face_keypoints_2d: 70};

// Canonical OpenPose pixel coordinates, including confidence and absent joints.
export function normalizePose(value) {
  if (Array.isArray(value)) value = value[0];
  const width = Number(value?.canvas_width), height = Number(value?.canvas_height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || !Array.isArray(value?.people) || value.people.length > 20) return null;
  const people = value.people.map(person => Object.fromEntries(Object.entries(counts).map(([key, count]) => {
    const source = person?.[key];
    const points = [];
    for (let i = 0; i < count; i++) {
      const x = Number(source?.[i*3]), y = Number(source?.[i*3+1]), c = Number(source?.[i*3+2]);
      points.push(...(Number.isFinite(x) && Number.isFinite(y) && c > 0 && x >= 0 && y >= 0
        ? [Math.min(width, x), Math.min(height, y), Math.min(1, c)] : [0, 0, 0]));
    }
    return [key, points];
  })));
  return {canvas_width: width, canvas_height: height, people};
}

export function defaultPose(width = 768, height = 1024) {
  const body = [[.5,.17],[.5,.27],[.38,.28],[.32,.43],[.28,.58],[.62,.28],[.68,.43],[.72,.58],[.43,.53],[.42,.71],[.40,.90],[.57,.53],[.58,.71],[.60,.90],[.475,.155],[.525,.155],[.445,.175],[.555,.175]];
  const scale = Math.min(width/768,height/1024);
  return normalizePose({canvas_width: width, canvas_height: height, people: [{pose_keypoints_2d: body.flatMap(([x,y]) => [width/2+(x-.5)*768*scale,height/2+(y-.5)*1024*scale,1])}]});
}

export function normalizePoseReference(value) {
  const data = normalizePose(value?.data), original = normalizePose(value?.original), image = normalizeImageReference(value?.image);
  if (!data || !original || !image || data.canvas_width !== original.canvas_width || data.canvas_height !== original.canvas_height) return null;
  const r = value.sourceRegion;
  const sourceRegion = r && [r.x,r.y,r.width,r.height].every(Number.isFinite) && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x+r.width <= 1.000001 && r.y+r.height <= 1.000001 ? {...r} : null;
  return {version: 1, data, original, image, sourceImage: normalizeImageReference(value.sourceImage), sourceRegion};
}

export function posePoints(person, part) {
  const a = person?.[part] || [];
  return Array.from({length: a.length/3}, (_, i) => ({x:a[i*3], y:a[i*3+1], visible:a[i*3+2]>0, index:i}));
}

// Rotation follows anatomical branches, not the undirected drawing edges.
// A shoulder carries its forearm and hand; a neck carries only the head.
export function jointRotation(person, part, index) {
  const pivot = posePoints(person, part)[index];
  if (!pivot?.visible) return null;
  const targets = [];
  const add = (key, indices) => {for (const i of indices) if (person[key]?.[i*3+2] > 0) targets.push({part:key,index:i});};
  const all = key => Array.from({length:(person[key]?.length || 0)/3},(_,i)=>i);
  if (part === "pose_keypoints_2d") {
    const branches = {1:[0,14,15,16,17],2:[3,4],3:[4],4:[],5:[6,7],6:[7],7:[],8:[9,10],9:[10],11:[12,13],12:[13]};
    if (!Object.hasOwn(branches,index)) return null;
    add(part,branches[index]);
    const attachment = index === 1 ? "face_keypoints_2d" : [2,3,4].includes(index) ? "hand_right_keypoints_2d" : [5,6,7].includes(index) ? "hand_left_keypoints_2d" : null;
    if (attachment) add(attachment,all(attachment));
  } else if (part === "hand_left_keypoints_2d" || part === "hand_right_keypoints_2d") {
    const end = index === 0 ? 20 : Math.ceil(index/4)*4;
    add(part,Array.from({length:end-index},(_,i)=>index+i+1));
  } else return null;
  return targets.some(t=>Math.hypot(person[t.part][t.index*3]-pivot.x,person[t.part][t.index*3+1]-pivot.y)>1e-6)
    ? {x:pivot.x,y:pivot.y,targets} : null;
}

export function rotatePoseJoint(pose, personIndex, part, index, angle) {
  const person = pose.people[personIndex], rotation = jointRotation(person,part,index);
  if (!rotation || !Number.isFinite(angle)) return false;
  const c=Math.cos(angle),s=Math.sin(angle);
  const changes=rotation.targets.map(target=>{
    const points=person[target.part],dx=points[target.index*3]-rotation.x,dy=points[target.index*3+1]-rotation.y;
    return {...target,x:rotation.x+dx*c-dy*s,y:rotation.y+dx*s+dy*c};
  });
  // Refuse an out-of-frame step instead of shortening bones by clamping joints.
  if(changes.some(p=>p.x<0||p.y<0||p.x>pose.canvas_width||p.y>pose.canvas_height))return false;
  for(const p of changes){person[p.part][p.index*3]=p.x;person[p.part][p.index*3+1]=p.y;}
  return true;
}

export function renderPose(ctx, pose) {
  ctx.fillStyle = "black"; ctx.fillRect(0,0,pose.canvas_width,pose.canvas_height);
  const size = Math.max(2, Math.min(pose.canvas_width,pose.canvas_height)/192);
  for (const person of pose.people) {
    const body = posePoints(person,"pose_keypoints_2d");
    BODY_EDGES.forEach(([a,b],i) => {
      if (!body[a].visible || !body[b].visible) return;
      ctx.strokeStyle = BODY_COLORS[i]; ctx.globalAlpha = .6; ctx.lineWidth = size*2; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(body[a].x,body[a].y); ctx.lineTo(body[b].x,body[b].y); ctx.stroke();
    });
    ctx.globalAlpha = 1;
    body.forEach((p,i) => {if(p.visible){ctx.fillStyle=BODY_COLORS[i];ctx.beginPath();ctx.arc(p.x,p.y,size,0,Math.PI*2);ctx.fill();}});
    for (const part of ["hand_left_keypoints_2d","hand_right_keypoints_2d"]) {
      const points=posePoints(person,part);
      for(let finger=0;finger<5;finger++) for(let joint=0;joint<4;joint++) {
        const a=points[joint===0?0:1+finger*4+joint-1],b=points[1+finger*4+joint];
        if(!a.visible||!b.visible)continue;
        ctx.strokeStyle=`hsl(${(finger*4+joint)*18} 100% 50%)`;ctx.lineWidth=Math.max(1,size/2);
        ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
      }
      ctx.fillStyle="#0000ff";
      for(const p of points)if(p.visible){ctx.beginPath();ctx.arc(p.x,p.y,Math.max(1,size/2),0,Math.PI*2);ctx.fill();}
    }
    ctx.fillStyle="white";
    for(const p of posePoints(person,"face_keypoints_2d"))if(p.visible){ctx.beginPath();ctx.arc(p.x,p.y,Math.max(1,size/2),0,Math.PI*2);ctx.fill();}
  }
}

export async function poseFile(doc, pose) {
  const canvas=doc.createElement("canvas");canvas.width=pose.canvas_width;canvas.height=pose.canvas_height;
  renderPose(canvas.getContext("2d"),pose);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
  if(!blob || blob.size>20*1024*1024)throw Error("Could not save this pose guide within the image upload limit.");
  return new File([blob],"pose-guide.png",{type:"image/png"});
}
