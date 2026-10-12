// Opt-in live pose comparisons. Uses temporary previews, never modifies chats.
// Run with BROWSER_EXECUTABLE set when the bundled Playwright browser is absent.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {startFixture,root} from './browser/fixture.mjs';
import {normalizePose,defaultPose,rotatePoseJoint} from '../web/js/prompt-studio/generation/pose.js';
const origin=process.env.COMFYUI_ORIGIN||'http://127.0.0.1:8188';
const out=resolve(root,'test-results/pose-matrix');await mkdir(out,{recursive:true});
const session=JSON.parse(await readFile(resolve(process.env.POSE_SESSION||resolve(root,'test-results/pose-leg-debug/session.json')),'utf8'));
const saved=session.messages.at(-1),reference=saved.qwenReferences[0];
const minimal="Change the person's pose to match the supplied pose guide. Preserve their identity, clothing, and the surrounding scene.";
const json=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));
async function api(path,body){const r=await fetch(origin+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const v=await r.json();if(!r.ok)throw Error(JSON.stringify(v));return v;}
async function idle(){const [q,j]=await Promise.all([api('/queue'),api('/promptstudio/jobs')]);assert.equal(q.queue_running.length+q.queue_pending.length,0,'Other work is active');assert.ok(!j.jobs.some(x=>['running','queued'].includes(x.state)),'Studio work is active');}
async function upload(name,bytes){const form=new FormData();form.append('image',new Blob([bytes],{type:'image/png'}),name+'.png');form.append('subfolder','promptstudio-pose-validation');form.append('type','input');const r=await fetch(origin+'/upload/image',{method:'POST',body:form});assert.ok(r.ok);const v=await r.json();return {filename:v.name,subfolder:v.subfolder,type:v.type};}
async function guides(){
 const path=resolve(out,'guides.json');try{return await json(path);}catch{}
 const f=await startFixture();
 try{const page=await f.newPage();const records={};
  for(const [name,data] of Object.entries({original:reference.pose.original,edited:reference.pose.data})){
   const url=await page.evaluate(async data=>{const {poseFile}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/generation/pose.js');const file=await poseFile(document,data);return await new Promise(r=>{const reader=new FileReader();reader.onload=()=>r(reader.result);reader.readAsDataURL(file);});},data);
   const bytes=Buffer.from(url.split(',')[1],'base64');await writeFile(resolve(out,name+'-guide.png'),bytes);records[name]={image:await upload(name,bytes),data};
  }
  await writeFile(path,JSON.stringify(records,null,2));return records;
 }finally{await f.close();}
}
function graph({prompt=minimal,strength=.8,image=reference.pose.image,seed=1470188345,noCache=false}){
 const g=structuredClone(saved.generationSnapshot.output);
 g['4'].inputs.prompt=prompt;g['10'].inputs.seed=seed;
 g.ps_structure_source.inputs.image_ref=JSON.stringify(image);g.ps_structure_apply.inputs.strength=strength;
 if(noCache)g['7'].inputs.device='off';
 g['12']={class_type:'PreviewImage',inputs:{images:g['12'].inputs.images}};
 g.validation_guide={class_type:'PreviewImage',inputs:{images:['ps_structure_guide',0]}};
 g.validation_pose={class_type:'KCPP_QwenStructureGuide',inputs:{image:['11',0],guide_type:'pose',input_mode:'photo',fit:'fit',width:1408,height:800,emit_pose:true}};
 g.validation_pose_preview={class_type:'PreviewImage',inputs:{images:['validation_pose',0]}};
 return g;
}
function score(actual,target){
 const a=normalizePose(actual),t=normalizePose(target);if(!a?.people.length)return {people:0};
 const errors=t.people.map(tp=>a.people.map(ap=>{const v=[];for(let i=0;i<18;i++){if(tp.pose_keypoints_2d[i*3+2]<=0||ap.pose_keypoints_2d[i*3+2]<=0)continue;const dx=ap.pose_keypoints_2d[i*3]/a.canvas_width-tp.pose_keypoints_2d[i*3]/t.canvas_width,dy=ap.pose_keypoints_2d[i*3+1]/a.canvas_height-tp.pose_keypoints_2d[i*3+1]/t.canvas_height;v.push({i,error:Math.hypot(dx,dy)});}const avg=x=>x.length?x.reduce((s,p)=>s+p.error,0)/x.length:null;return {body:avg(v),legs:avg(v.filter(p=>p.i>=8&&p.i<=13)),arms:avg(v.filter(p=>p.i>=2&&p.i<=7)),joints:v};}).sort((x,y)=>x.body-y.body)[0]);
 return {people:a.people.length,errors};
}
function measuredScore(actual,target){
 const result=score(actual,target),t=normalizePose(target),o=normalizePose(reference.pose.original);
 result.metric='Euclidean distance in normalized canvas coordinates; missing joints and appearance need separate review.';
 result.errors?.forEach((error,p)=>{
  const expected=t.people[p].pose_keypoints_2d,previous=o.people[p]?.pose_keypoints_2d||[];
  const visible=Array.from({length:18},(_,i)=>i).filter(i=>expected[i*3+2]>0);
  const changed=visible.filter(i=>previous[i*3+2]>0&&Math.hypot(expected[i*3]/t.canvas_width-previous[i*3]/o.canvas_width,expected[i*3+1]/t.canvas_height-previous[i*3+1]/o.canvas_height)>.005);
  error.missing=visible.filter(i=>!error.joints.some(j=>j.i===i));
  error.changed=changed;
  const measured=error.joints.filter(j=>changed.includes(j.i));
  error.changedMean=measured.length?measured.reduce((n,j)=>n+j.error,0)/measured.length:null;
  error.max=Math.max(...error.joints.map(j=>j.error));
 });
 return result;
}
async function run(label,g,target){
 const digest=createHash('sha256').update(JSON.stringify(g)).digest('hex'),path=resolve(out,label+'.json');
 try{const old=await json(path);if(old.digest===digest){console.log(JSON.stringify({reused:label,score:old.score}));return old;}}catch{}
 const requestPath=resolve(out,label+'-request.json');let request;
 try{request=await json(requestPath);if(request.digest!==digest)request=null;}catch{}
 if(!request){
  await idle();let release;
  if(stage==='current-pipeline')release=await api('/promptstudio/prompt-studio/llm/release',{llm_provider:'llamacpp',llamacpp_url:'http://127.0.0.1:8080',keep_models_loaded:false});
  try{const q=await api('/prompt',{prompt:g,client_id:'promptstudio-pose-validation'});request={digest,prompt_id:q.prompt_id,prompt:g};await writeFile(requestPath,JSON.stringify(request,null,2));}
  finally{if(release?.handoff_token)await api('/promptstudio/prompt-studio/llm/handoff-complete',{handoff_token:release.handoff_token});}
 }
 console.log(JSON.stringify({queued:label,prompt_id:request.prompt_id}));
 const start=Date.now();let h;
 while(Date.now()-start<1200000){h=(await api('/history/'+request.prompt_id))[request.prompt_id];if(h)break;await new Promise(r=>setTimeout(r,2500));}
 assert.equal(h?.status?.status_str,'success',JSON.stringify(h?.status));
 for(const [key,suffix] of [['12',''],['validation_guide','-actual-guide'],['validation_pose_preview','-detected']]){
  const image=h.outputs[key]?.images?.[0];if(!image)continue;const r=await fetch(origin+'/view?'+new URLSearchParams({filename:image.filename,subfolder:image.subfolder,type:image.type}));assert.ok(r.ok);await writeFile(resolve(out,label+suffix+'.png'),Buffer.from(await r.arrayBuffer()));
 }
 const pose=JSON.parse(h.outputs.validation_pose.pose_json[0]).data;
 const record={label,digest,prompt_id:request.prompt_id,image:h.outputs['12'].images[0],pose,target,score:target?measuredScore(pose,target):{people:normalizePose(pose)?.people.length,visualOnly:true},seconds:(Date.now()-start)/1000};
 await writeFile(path,JSON.stringify(record,null,2));console.log(JSON.stringify({complete:label,seconds:record.seconds,score:record.score}));return record;
}
const gs=await guides();
const stage=process.argv[2]||'baseline';
if(['inpaint','inpaint-broad','inpaint-vision'].includes(stage)){
 const f=await startFixture();let mask;
 try{const page=await f.newPage();const url=await page.evaluate(poses=>{
  const c=document.createElement('canvas');c.width=poses[0].canvas_width;c.height=poses[0].canvas_height;const ctx=c.getContext('2d');ctx.fillStyle='black';ctx.fillRect(0,0,c.width,c.height);ctx.strokeStyle='white';ctx.lineWidth=220;ctx.lineCap='round';
  for(const pose of poses.slice(0,2))for(const person of pose.people){const p=person.pose_keypoints_2d;for(const [a,b] of [[2,3],[3,4],[5,6],[6,7],[2,8],[5,11],[8,11],[8,9],[9,10],[11,12],[12,13]]){ctx.beginPath();ctx.moveTo(p[a*3],p[a*3+1]);ctx.lineTo(p[b*3],p[b*3+1]);ctx.stroke();}}
  if(poses[2]){ctx.fillStyle='white';ctx.fillRect(400,300,1420,c.height-300);}
  return c.toDataURL('image/png');
 },[gs.original.data,gs.edited.data,stage!=='inpaint']);const bytes=Buffer.from(url.split(',')[1],'base64');await writeFile(resolve(out,stage+'-mask.png'),bytes);mask=await upload(stage+'-mask',bytes);
 }finally{await f.close();}
 for(const semantic of [false,true]){
  const g=graph({image:gs.edited.image,strength:1,prompt:semantic?minimal:'Full-body photograph of an adult blonde woman wearing a yellow top, short black skirt and green wedge shoes, outdoors on a cobblestone path with a wooden fence and trees. Natural daylight.'});
  g.validation_mask={class_type:'LoadImageMask',inputs:{image:mask.subfolder+'/'+mask.filename,channel:'red'}};
  g.ps_structure_apply.inputs.inpaint_image=['20',0];g.ps_structure_apply.inputs.mask=['validation_mask',0];
  if(stage==='inpaint-vision')delete g['8'].inputs.vae;
  if(!semantic){delete g['8'].inputs['images.image_1'];g.validation_latent={class_type:'EmptySD3LatentImage',inputs:{width:1408,height:800,batch_size:1}};g['10'].inputs.latent_image=['validation_latent',0];}
  await run(stage+(semantic?'-edit':'-create'),g,gs.edited.data);
 }
}
if(stage==='conditioning'){
 const scene='Full-body photograph of an adult blonde woman wearing a yellow top, black skirt and green shoes, outdoors on a cobblestone path with a wooden fence and trees. Natural daylight.';
 for(const [label,strength,image] of [['create-off',0,gs.edited.image],['create-edited',1,gs.edited.image],['create-original',1,gs.original.image]]){
  const g=graph({image,strength,prompt:scene});delete g['8'].inputs['images.image_1'];
  g.validation_latent={class_type:'EmptySD3LatentImage',inputs:{width:1408,height:800,batch_size:1}};g['10'].inputs.latent_image=['validation_latent',0];
  await run(label,g,label==='create-original'?gs.original.data:gs.edited.data);
 }
}
if(stage==='visual'){
 for(const [label,strength,prompt] of [
  ['visual-off',0,'Change the person in <image1> to match the body pose in <image2>. Preserve the identity, clothing and background of <image1>. <image2> is only a skeleton pose guide, not an appearance reference.'],
  ['visual-control',1,'Change the person in <image1> to match the body pose in <image2>. Preserve the identity, clothing and background of <image1>. <image2> is only a skeleton pose guide, not an appearance reference.'],
  ['visual-replace',1,'Replace the existing body pose of the woman in <image1> with the skeleton pose in <image2>. Move her arms and legs to their new positions; remove the old arms and legs and fill the vacated areas with the surrounding background. The result must show one woman with exactly two arms and two legs. Keep her face, hair, yellow top, short black skirt and green shoes unchanged.'],
  ['direct-action',1,'Repose the woman: extend both arms sideways and move both knees and feet far to the left of her hips, matching the pose control. Keep the same woman, outfit and background.'],
 ]){
  const g=graph({image:gs.edited.image,strength,prompt});
  if(label.startsWith('visual'))g['8'].inputs['images.image_2']=['ps_structure_guide',0];
  await run(label,g,gs.edited.data);
 }
}
if(stage==='action'){
 const prompt='Make the woman jump sideways, with both feet off the ground and both legs swung toward the left side of the image, matching the pose guide. Extend both arms horizontally. Replace the old leg positions with cobblestone background. Keep her identity, yellow top, short black skirt, green shoes and the existing scene.';
 for(const strength of [.8,1.5,2])await run('action-'+strength,graph({image:gs.edited.image,strength,prompt}),gs.edited.data);
}
if(stage==='vision-only'){
 for(const [label,withGuide,prompt] of [
  ['vision-source',false,minimal],
  ['vision-pose',true,'Replace the pose of the woman in <image1> with the skeleton pose in <image2>. Keep her identity, clothing and background. Move the existing limbs into their new positions; leave no limbs in the old positions.'],
  ['vision-detailed',false,(await json(resolve(root,'test-results/pose-leg-debug/fixed-prompt.json'))).prompt],
 ]){
  const g=graph({image:gs.edited.image,strength:1,prompt});delete g['8'].inputs.vae;
  if(withGuide)g['8'].inputs['images.image_2']=['ps_structure_guide',0];
  await run(label,g,gs.edited.data);
 }
 await run('cache-off',graph({image:gs.edited.image,noCache:true}),gs.edited.data);
}
if(stage==='current-pipeline'){
 const cases=await json(resolve(out,'scenario-guides.json'));
 const settings={llm_provider:'llamacpp',llamacpp_url:'http://127.0.0.1:8080',keep_models_loaded:false};
 for(const name of ['arms','knee','raised']){
  const c=cases[name],path=resolve(out,'pipeline-'+name+'-instruction.json');let instruction;
  try{instruction=await json(path);}catch{
   await idle();instruction=await api('/promptstudio/prompt-studio/qwen-edit-prompt',{...settings,model:'qwen_image_2_1',source_image:JSON.parse(saved.generationSnapshot.output['20'].inputs.image_ref),user_text:'',references:[{...reference,pose:{...reference.pose,image:c.image,data:c.data},guide:{...reference.guide,type:'pose',input:'prepared'}}]});
   await writeFile(path,JSON.stringify(instruction,null,2));
  }
  assert.ok(instruction.prompt,JSON.stringify(instruction));c.prompt=instruction.prompt;
 }
 for(const name of ['arms','knee','raised']){
  const c=cases[name];
  for(const seed of [1470188345,42,210923])await run('pipeline-'+name+(seed===1470188345?'':'-'+seed),graph({image:c.image,prompt:c.prompt,seed}),c.data);
 }
 for(const seed of [42,210923])await run('detailed-edited-'+seed,graph({image:gs.edited.image,prompt:(await json(resolve(root,'test-results/pose-leg-debug/fixed-prompt.json'))).prompt,seed}),gs.edited.data);
}
if(stage==='holdouts'){
 const info=await api('/object_info');
 const c=(await json(resolve(out,'scenario-guides.json'))).raised;
 const normal=graph({image:c.image,prompt:'Raise the woman\'s right leg out to the left of the image, following the pose guide. Keep the same person, outfit and background.'});
 const lora=info.KCPP_QwenImage21TurboLora.input.required.lora_name[0].find(n=>n.replaceAll('\\','/').endsWith('_Qwen-Image-2.1-viggle-turbo-v0.3-6step-lora-r128.safetensors'));
 assert.ok(lora);
 normal.validation_turbo={class_type:'KCPP_QwenImage21TurboLora',inputs:{model:['5',0],lora_name:lora}};normal['7'].inputs.model=['validation_turbo',0];
 normal['10']={class_type:'KCPP_QwenImage21TurboSampler',inputs:{model:['ps_structure_apply',0],seed:1470188345,positive:['8',0],latent_image:['8',2]}};
 await run('turbo-raised',normal,c.data);
 const f=await startFixture();let guide;const target=defaultPose(768,1024);
 try{const page=await f.newPage();const url=await page.evaluate(async data=>{const {poseFile}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/generation/pose.js');const file=await poseFile(document,data);return await new Promise(r=>{const reader=new FileReader();reader.onload=()=>r(reader.result);reader.readAsDataURL(file);});},target);guide=await upload('portrait-default',Buffer.from(url.split(',')[1],'base64'));}finally{await f.close();}
 const g=graph({image:guide,prompt:'Full-body photograph of one adult man wearing a blue jacket and black trousers, plain gray studio background, both arms slightly away from his sides, hands and feet visible.',strength:1});
 delete g['8'].inputs['images.image_1'];g['4'].inputs.resolution_width=768;g['4'].inputs.resolution_height=1024;
 g.validation_latent={class_type:'EmptySD3LatentImage',inputs:{width:768,height:1024,batch_size:1}};g['10'].inputs.latent_image=['validation_latent',0];
 await run('portrait-create',g,target);
 const donor=(await json(resolve(root,'test-results/reference-edits/pose-donor.json'))).image;
 for(const name of ['source-single','source-two']){
  const source=(await json(resolve(root,'test-results/reference-edits/'+name+'.json'))).image;
  const p=graph({image:donor,prompt:name==='source-single'?'Raise both arms of the man diagonally upward in a wide V, following the pose guide. Preserve his face, blue jacket, black trousers and gray background.':'Only the man on the left should raise both arms in a wide V, following the pose guide in the left half. Keep the woman on the right unchanged. Preserve both people\'s faces and clothes and the gray background.'});
  p['20'].inputs.image_ref=JSON.stringify(source);p['4'].inputs.resolution_width=1056;p['4'].inputs.resolution_height=1056;
  p.ps_structure_guide.inputs.input_mode='photo';
  if(name==='source-two')p.ps_structure_guide.inputs.targeting=JSON.stringify({target:{x:0,y:0,width:.49,height:1}});
  // The donor is a different photo, so this holdout is visual-only validation.
  await run(name==='source-single'?'square-edit':'multi-targeted-edit',p,null);
 }
}
if(stage==='male-leg'){
 const source=await json(resolve(out,'square-edit.json')),target=structuredClone(normalizePose(source.pose));
 assert.ok(rotatePoseJoint(target,0,'pose_keypoints_2d',8,.7));
 const f=await startFixture();let image;
 try{const page=await f.newPage();const url=await page.evaluate(async data=>{const {poseFile}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/generation/pose.js');const file=await poseFile(document,data);return await new Promise(r=>{const reader=new FileReader();reader.onload=()=>r(reader.result);reader.readAsDataURL(file);});},target);image=await upload('male-leg',Buffer.from(url.split(',')[1],'base64'));}finally{await f.close();}
 for(const seed of [1470188345,42]){
  const g=graph({image,seed,prompt:'Move the man\'s right leg diagonally out toward the left side of the image, matching the supplied pose guide. Keep the existing raised arms and left leg unchanged. Preserve his face, blue jacket, black trousers and gray background. Move the existing right leg rather than adding a new leg.'});
  g['20'].inputs.image_ref=JSON.stringify(source.image);g['4'].inputs.resolution_width=1056;g['4'].inputs.resolution_height=1056;
  await run('male-leg-'+seed,g,target);
 }
}
if(stage==='two-stage'){
 const draft=await json(resolve(out,'vision-source.json'));
 for(const strength of [0,.8]){
  const g=graph({strength,image:gs.edited.image,prompt:'Edit <image1>. Replace the woman\'s facial identity, hairstyle and outfit with those of the woman in <image2>: the same face, blonde high bun, fitted yellow scoop-neck top, short black skirt, dark wristwatch and green wedge shoes. Preserve the exact body pose and limb positions from <image1>, including both legs extending toward image-left. Take appearance only from <image2>, never its standing pose. Keep the background of <image1>.'});
  g.validation_identity=structuredClone(g['20']);g['20'].inputs.image_ref=JSON.stringify(draft.image);
  g['8'].inputs['images.image_2']=['validation_identity',0];
  await run('two-stage-'+strength,g,gs.edited.data);
 }
}
if(stage==='baseline'){
 for(const [label,opts,target] of [
  ['minimal-none',{strength:0},gs.edited.data],
  ['minimal-original',{image:gs.original.image},gs.original.data],
  ['minimal-edited',{image:gs.edited.image},gs.edited.data],
  ['detailed-edited',{image:gs.edited.image,prompt:(await json(resolve(root,'test-results/pose-leg-debug/fixed-prompt.json'))).prompt},gs.edited.data],
  ['minimal-full',{image:gs.edited.image,strength:1},gs.edited.data],
  ['minimal-nocache',{image:gs.edited.image,noCache:true},gs.edited.data],
 ])await run(label,graph(opts),target);
}
if(stage==='scenarios'||stage==='visual-scenarios'){
 const f=await startFixture();const cases={};
 try{const page=await f.newPage();
  const arms=structuredClone(reference.pose.original);arms.people[0].pose_keypoints_2d.splice(6,18,...reference.pose.data.people[0].pose_keypoints_2d.slice(6,24));
  for(const part of ['hand_left_keypoints_2d','hand_right_keypoints_2d'])arms.people[0][part]=structuredClone(reference.pose.data.people[0][part]);
  const knee=structuredClone(reference.pose.original);rotatePoseJoint(knee,0,'pose_keypoints_2d',9,.35);
  const raised=structuredClone(reference.pose.original);rotatePoseJoint(raised,0,'pose_keypoints_2d',8,Math.PI/3);
  for(const [name,data] of Object.entries({arms,knee,raised,default:defaultPose(2728,1536)})){
   const url=await page.evaluate(async data=>{const {poseFile}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/generation/pose.js');const file=await poseFile(document,data);return await new Promise(r=>{const reader=new FileReader();reader.onload=()=>r(reader.result);reader.readAsDataURL(file);});},data);
   const bytes=Buffer.from(url.split(',')[1],'base64');await writeFile(resolve(out,name+'-guide.png'),bytes);cases[name]={data,image:await upload(name,bytes)};
  }
 }finally{await f.close();}
 await writeFile(resolve(out,'scenario-guides.json'),JSON.stringify(cases,null,2));
 for(const [name,c] of Object.entries(cases))for(const seed of [1470188345,42,210923]){
  const g=graph({image:c.image,seed});
  if(stage==='visual-scenarios'&&name!=='default'){
   g['8'].inputs['images.image_2']=['ps_structure_guide',0];
   g['4'].inputs.prompt='Change the person in <image1> to match the body pose in <image2>. Preserve the identity, clothing and background of <image1>. <image2> is only a skeleton pose guide, not an appearance reference.';
  }
  if(name==='default'){
   delete g['8'].inputs['images.image_1'];
   g['4'].inputs.prompt='Full-body photograph of an adult blonde woman wearing a yellow top, black skirt and green shoes, outdoors on a cobblestone path with a wooden fence and trees. Natural daylight.';
   g.validation_latent={class_type:'EmptySD3LatentImage',inputs:{width:1408,height:800,batch_size:1}};g['10'].inputs.latent_image=['validation_latent',0];
  }
  await run((stage==='visual-scenarios'?'visual-':'')+name+'-'+seed,g,c.data);
 }
}


