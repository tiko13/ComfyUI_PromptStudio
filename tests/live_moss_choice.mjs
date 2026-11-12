// Opt-in GPU smoke. Uses a private graph and temporary images, never the user's canvas.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {choiceStage} from '../web/js/prompt-studio/generation/intermediate-choice.js';
if(process.env.STUDIO_TEST_MOSS_RENDER!=='1')throw Error('Set STUDIO_TEST_MOSS_RENDER=1 to run GPU inference.');
const origin=process.env.COMFYUI_ORIGIN||'http://127.0.0.1:8188';
const request=async(path,body)=>{
 const response=await fetch(origin+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const text=await response.text(),data=text?JSON.parse(text):{};
 assert.equal(response.ok,true,JSON.stringify(data));return data;
};
const queue=await request('/queue');assert.equal(queue.queue_running.length+queue.queue_pending.length,0);
const browser=await chromium.launch({headless:true}),tokens=[];
try{
 const page=await browser.newPage();await page.goto(origin,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>globalThis.LiteGraph?.registered_node_types?.PS_IntermediateChoice&&globalThis.LiteGraph?.registered_node_types?.PromptStudioInput);
 const profile=await page.evaluate(async()=>{
  const {app}=await import('/scripts/app.js');
  const {createWorkflowTemplateBuilder}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/generation/workflow-template.js');
  const {normalizeSpatialSnapshot}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/generation/spatial-inputs.js');
  const path='[PS] - MOSS SFT 8-step Choice.json';
  const workflow=await(await fetch('/userdata/'+encodeURIComponent('workflows/'+path))).json();
  const original=app.graph;
  const p=await createWorkflowTemplateBuilder({app,nodeClassName:n=>n.comfyClass||n.type}).buildWorkflowTemplate({path},workflow);
  if(app.graph!==original)throw Error('Canvas changed');
  normalizeSpatialSnapshot(p.snapshot);
  Object.assign(p.snapshot.output[p.promptNodeId].inputs,{prompt:'A red ceramic teapot on a wooden table in soft daylight, detailed product photograph.',resolution_width:384,resolution_height:384});
  Object.assign(p.snapshot.output['16'].inputs,{save:'no',force:true});
  Object.assign(p.snapshot.output['17'].inputs,{save_intermediate:false,format:'png',force:true});
  return p;
 });
 async function run(stage){
  const started=Date.now(),{prompt_id}=await request('/prompt',{prompt:stage.snapshot.output});
  console.log('Queued',prompt_id,'nodes',Object.keys(stage.snapshot.output).length);
  while(Date.now()-started<300000){
   const item=(await request('/history/'+prompt_id))[prompt_id];
   if(item){assert.equal(item.status.status_str,'success',JSON.stringify(item.status));
    const image=item.outputs[stage.resultIds[0]].images[0];
    const png=Buffer.from(await(await fetch(origin+'/view?'+new URLSearchParams(image))).arrayBuffer());
    const dimensions=[png.readUInt32BE(16),png.readUInt32BE(20)];
    console.log(JSON.stringify({prompt_id,seconds:(Date.now()-started)/1000,image,dimensions}));return dimensions;}
   await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw Error('MOSS render timed out');
 }
 const first=choiceStage(profile.snapshot,profile.resultNodeIds);
 const {token}=await request('/promptstudio/choices/reserve',{});tokens.push(token);
 first.snapshot.output[first.gate.id].inputs._choice_token=token;
 assert.deepEqual(await run(first),[384,384]);
 const {ticket}=await request('/promptstudio/choices/claim',{token,index:0});
 const refine=choiceStage(profile.snapshot,profile.resultNodeIds,{[first.gate.id]:{index:0,token,ticket}});
 assert.equal(refine.snapshot.output['14'],undefined,'Base sampler must not regenerate');
 assert.deepEqual(await run(refine),[576,576]);
 console.log('MOSS GPU base and optional Refine passed.');
}finally{
 for(const token of tokens)await request('/promptstudio/choices/release',{token});
 await browser.close();
}
