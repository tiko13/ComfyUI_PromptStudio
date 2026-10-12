// Opt-in live render smoke test. Run live_reference_workflows.mjs first.
// Uses temporary previews; leaves chats, defaults and saved workflows unchanged.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'), origin=process.env.COMFYUI_ORIGIN||'http://127.0.0.1:8188';
const converted=JSON.parse(await readFile(resolve(root,'test-results/reference-nodes/converted.json'),'utf8'));
const source=JSON.parse(await readFile(process.argv[2]||resolve(root,'test-results/reference-edits/source-single.json'),'utf8')).image;
async function api(path,body){const r=await fetch(origin+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;}
const results=[];
for(const mode of ['create-empty','create-reference','edit-reference-guide']) {
  const edit=mode.startsWith('edit'), name=`installed/[PS] - QwenImage21 ${edit?'Edit':'Create'} turbo8.json`;
  const record=converted.find(r=>r.name===name)||converted.find(r=>r.name===name.replace('installed/',''));
  const prompt=structuredClone(record.snapshot.output);
  for(const node of Object.values(prompt)) {
    if(node.class_type==='KCPP_PromptSlot') Object.assign(node.inputs,{prompt:edit?'Edit <image1>. Use the clothing colors from <image2>, retain the person and follow the edge guide.':'A studio photograph of an adult man wearing a blue jacket on a gray background.',width:512,height:512});
    if(node.class_type==='KCPP_ChatImageInput')node.inputs.image_ref=JSON.stringify(source);
    if(node.class_type==='PS_ReferenceCollection')node.inputs.references_json=JSON.stringify(mode==='create-empty'?[]:[{image:source,role:'clothing',instruction:''}]);
    if(node.class_type==='PS_StructureInput'&&edit)node.inputs.reference_json=JSON.stringify({image:source,use:'structure',guide:{type:'edges',input:'photo',fit:'fit',strength:.25}});
    if(node.class_type==='Save_as_webp_cond'){const images=node.inputs.images;node.class_type='PreviewImage';node.inputs={images};}
  }
  const [queue,jobs]=await Promise.all([api('/queue'),api('/promptstudio/jobs')]);
  assert.equal(queue.queue_running.length+queue.queue_pending.length,0,'User queue must be idle');
  assert.ok(!jobs.jobs.some(j=>['running','queued'].includes(j.state)),'Studio must be idle');
  const queued=await api('/prompt',{prompt,client_id:'promptstudio-reference-node-validation'}), start=Date.now();
  console.log(JSON.stringify({mode,prompt_id:queued.prompt_id}));
  let history;
  while(Date.now()-start<600000){history=(await api('/history/'+queued.prompt_id))[queued.prompt_id];if(history)break;await new Promise(r=>setTimeout(r,1000));}
  const result={mode,prompt_id:queued.prompt_id,seconds:(Date.now()-start)/1000,status:history?.status,outputs:history?.outputs};
  results.push(result);await writeFile(resolve(root,'test-results/reference-nodes/renders.json'),JSON.stringify(results,null,2));
  assert.equal(history?.status?.status_str,'success',JSON.stringify(result));
  assert.ok(Object.values(history.outputs).some(output=>output.images?.length));
  console.log(JSON.stringify({mode,status:'success',seconds:result.seconds}));
}
