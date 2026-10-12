// Opt-in detector/queue smoke test, using a previously saved validation image.
// No diffusion generation, chat edits, settings changes or model downloads.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {normalizePose} from '../web/js/prompt-studio/generation/pose.js';
const origin=process.env.COMFYUI_ORIGIN||'http://127.0.0.1:8188';
const root=resolve(import.meta.dirname,'..');
const record=JSON.parse(await readFile(process.argv[2]||resolve(root,'test-results/reference-edits/source-single.json'),'utf8'));
const api=async(path,data)=>{const response=await fetch(origin+path,data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{});const result=await response.json();if(!response.ok)throw Error(JSON.stringify(result));return result;};
const queue=await api('/queue'),jobs=await api('/promptstudio/jobs');
assert.equal(queue.queue_running.length+queue.queue_pending.length,0,'User queue must be idle');
assert.ok(!jobs.jobs.some(j=>['running','queued'].includes(j.state)),'Studio jobs must be idle');
const status=await api('/promptstudio/controlnet/status');assert.ok(status.methods.pose.ready);
const prompt={
 source:{class_type:'KCPP_ChatImageReference',inputs:{image_ref:JSON.stringify(record.image),source_name:'Pose editor validation'}},
 guide:{class_type:'KCPP_QwenStructureGuide',inputs:{image:['source',0],guide_type:'pose',input_mode:'photo',fit:'fit',width:768,height:1024,emit_pose:true}},
 preview:{class_type:'PreviewImage',inputs:{images:['guide',0]}}
};
const queued=await api('/prompt',{prompt});console.log(JSON.stringify({queued:queued.prompt_id}));
const deadline=Date.now()+180000;
let history;
while(Date.now()<deadline){history=(await api('/history/'+queued.prompt_id))[queued.prompt_id];if(history)break;await new Promise(r=>setTimeout(r,1000));}
assert.equal(history?.status?.status_str,'success',JSON.stringify(history?.status));
const exported=JSON.parse(history.outputs.guide.pose_json[0]),data=normalizePose(exported.data);
assert.ok(data?.people.length,'Real detector returns editable people');
assert.ok(data.people.some(p=>p.pose_keypoints_2d.some((v,i)=>i%3===0&&v>1)),'Detector returns pixel coordinates');
const out=resolve(root,'test-results/pose-editor');await mkdir(out,{recursive:true});
await writeFile(resolve(out,'live-extraction.json'),JSON.stringify({sourceImage:record.image,...exported,data},null,2));
const preview=history.outputs.preview.images[0];const response=await fetch(origin+'/view?'+new URLSearchParams(preview));assert.ok(response.ok);
await writeFile(resolve(out,'live-extraction.png'),new Uint8Array(await response.arrayBuffer()));
console.log(JSON.stringify({people:data.people.length,width:data.canvas_width,height:data.canvas_height,bodyPoints:data.people.map(p=>p.pose_keypoints_2d.filter((v,i)=>i%3===2&&v>0).length),preview}));
