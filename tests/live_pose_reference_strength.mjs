// User-authorized live experiment. Requires temporary PS_TestPoseReferenceStrength.
// Uses saved inputs and PreviewImage only; never updates chats or app defaults.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..'),dir=resolve(root,'test-results/pose-reference-strength');
const previous=resolve(root,'test-results/pose-matrix');
await mkdir(dir,{recursive:true});
const origin=process.env.COMFYUI_ORIGIN||'http://127.0.0.1:8188';
const read=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));
async function api(path,body){const r=await fetch(origin+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;}
async function idle(){const [q,j]=await Promise.all([api('/queue'),api('/promptstudio/jobs')]);assert.equal(q.queue_running.length+q.queue_pending.length,0,'Server busy');assert.ok(!j.jobs.some(x=>['running','queued'].includes(x.state)),'Studio busy');}
async function upload(name,path=resolve(dir,name+'.png')){const bytes=await readFile(path),form=new FormData();form.append('image',new Blob([bytes],{type:'image/png'}),name+'.png');form.append('subfolder','promptstudio-pose-reference-test');form.append('type','input');const r=await fetch(origin+'/upload/image',{method:'POST',body:form});assert.ok(r.ok);const v=await r.json();return v.subfolder+'/'+v.name;}
const cases=(process.argv[2]||'raised').split(','),modes=(process.argv[3]||'neutral,quarter,zero,exclude').split(','),seeds=(process.argv[4]||'1470188345').split(',').map(Number);
const maskName=process.argv[5]||'right-leg';
const info=await api('/object_info/PS_TestPoseReferenceStrength');assert.ok(info.PS_TestPoseReferenceStrength);
const masks={edit:await upload(maskName+'-mask'),keep:await upload(maskName+'-keep-mask')};
await writeFile(resolve(dir,'environment.json'),JSON.stringify({health:await api('/promptstudio/prompt-studio/runtime-health'),system:await api('/system_stats'),upstream:'fe6caf61b1f705b5ba70e5fd35c93688c3e23496',sourceSha256:createHash('sha256').update(await readFile(resolve(dir,'upstream_masked.py'))).digest('hex')},null,2));
for(const name of cases)for(const seed of seeds)for(const mode of modes){
 const base=name==='edited'?'detailed-edited':name==='male'?'male-leg-1470188345':'pipeline-'+name.replace('-explicit','');
 const g=structuredClone((await read(resolve(previous,base+'-request.json'))).prompt);
 if(name==='male'){const source=await upload('male-source',resolve(previous,'square-edit.png'));g['20'].inputs.image_ref=JSON.stringify({filename:source.split('/').pop(),subfolder:source.slice(0,source.lastIndexOf('/')),type:'input'});}
 g['10'].inputs.seed=seed;
 g['7'].inputs.device=process.env.POSE_REFERENCE_CACHE||'off';
 if(name==='knee-explicit')g['4'].inputs.prompt="Move the woman's right ankle and green shoe toward the LEFT side of the image by about 4% of the image width. Keep her right knee fixed in place. Her right calf must slope DOWN AND LEFT from the knee to the ankle, instead of down and right as in the original photograph, matching the pose guide. Keep the rest of her body, the other leg, clothing and outdoor background unchanged. Reposition the existing leg; do not add a leg.";
 const strength={neutral:1,half:.5,quarter:.25,tenth:.1,zero:0,exclude:1}[mode];assert.ok(strength!==undefined);
 g.test_mask={class_type:'LoadImageMask',inputs:{image:mode==='exclude'?masks.keep:masks.edit,channel:'red'}};
 g.test_reference={class_type:'PS_TestPoseReferenceStrength',inputs:{model:g['10'].inputs.model,mask:['test_mask',0],strength,mask_behavior:mode==='exclude'?'zero_unmasked_tokens':'focus_only',mask_threshold:mode==='exclude'?.9:.1}};
 g['10'].inputs.model=['test_reference',0];
 const label=[name,maskName,mode,seed,g['7'].inputs.device].join('-'),digest=createHash('sha256').update(JSON.stringify(g)).digest('hex');
 const output=resolve(dir,label+'.json'),requestPath=resolve(dir,label+'-request.json');
 try{const old=await read(output);if(old.digest===digest&&old.status==='success'){console.log('REUSED '+label);continue;}}catch{}
 let request;try{request=await read(requestPath);if(request.digest!==digest)request=null;}catch{}
 if(request){const h=(await api('/history/'+request.prompt_id))[request.prompt_id];if(h?.status?.status_str==='error')request=null;}
 if(!request){await idle();const q=await api('/prompt',{prompt:g,client_id:'promptstudio-masked-reference-validation'});request={digest,prompt_id:q.prompt_id,prompt:g};await writeFile(requestPath,JSON.stringify(request,null,2));}
 console.log('QUEUED '+label+' '+request.prompt_id);
 const start=Date.now();let h;
 while(Date.now()-start<1200000){h=(await api('/history/'+request.prompt_id))[request.prompt_id];if(h)break;await new Promise(r=>setTimeout(r,2500));}
 assert.ok(h,'Timed out waiting for '+request.prompt_id);
 const record={label,digest,prompt_id:request.prompt_id,status:h.status.status_str,seconds:(Date.now()-start)/1000,case:name,seed,mode,maskName,cache:g['7'].inputs.device};
 if(record.status==='success'&&(!h.outputs['12']?.images?.length||!h.outputs.validation_pose?.pose_json))record.status='missing_outputs';
 if(record.status==='success'){
  for(const [key,suffix]of [['12',''],['validation_guide','-guide'],['validation_pose_preview','-detected']]){const img=h.outputs[key]?.images?.[0];if(!img)continue;const r=await fetch(origin+'/view?'+new URLSearchParams(img));assert.ok(r.ok);await writeFile(resolve(dir,label+suffix+'.png'),Buffer.from(await r.arrayBuffer()));}
  record.pose=JSON.parse(h.outputs.validation_pose.pose_json[0]).data;
  record.image=h.outputs['12'].images[0];
 }else record.error=h.status.messages.filter(x=>x[0]==='execution_error');
 await writeFile(output,JSON.stringify(record,null,2));console.log(JSON.stringify({complete:label,status:record.status,seconds:record.seconds,error:record.error}));
 if(record.status!=='success')throw Error('Render failed; inspect '+output);
}
