// Opt-in live smoke: CPU image stages; no model loading and no canvas changes.
import assert from 'node:assert/strict';
import {choiceStage} from '../web/js/prompt-studio/generation/intermediate-choice.js';
const origin=process.env.COMFYUI_ORIGIN||'http://127.0.0.1:8188';
const request=async(path,body)=>{
 const response=await fetch(origin+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const text=await response.text(),data=text?JSON.parse(text):{};assert.equal(response.ok,true,JSON.stringify(data));return data;
};
const queue=await request('/queue');assert.equal(queue.queue_running.length+queue.queue_pending.length,0,'Wait for idle ComfyUI');
const tokens=[],prompts=[],createdImages=[];
async function run(snapshot){
 const {prompt_id}=await request('/prompt',{prompt:snapshot.output});prompts.push(prompt_id);
 const deadline=Date.now()+30000;
 while(Date.now()<deadline){
  const item=(await request('/history/'+prompt_id))[prompt_id];
  if(item){assert.equal(item.status.status_str,'success',JSON.stringify(item.status));
   for(const node of Object.values(item.outputs||{}))for(const image of node.images||[])createdImages.push({filename:image.filename,subfolder:image.subfolder,type:image.type});
   return item;}
  await new Promise(resolve=>setTimeout(resolve,150));
 }
 throw Error('Live choice smoke timed out');
}
try{
 const {token}=await request('/promptstudio/choices/reserve',{});tokens.push(token);
 const snapshot={workflow:{},output:{
  '1':{class_type:'EmptyImage',inputs:{width:32,height:32,batch_size:1,color:0x286090}},
  '2':{class_type:'EmptyFlux2LatentImage',inputs:{width:32,height:32,batch_size:1}},
  '3':{class_type:'PS_IntermediateChoice',inputs:{images:['1',0],latent:['2',0],message:'Smoke test',options:'Double\nTriple',save_intermediate:false,format:'png',filename_prefix:'StudioChoiceValidation'}},
  '4':{class_type:'ImageScaleBy',inputs:{image:['3',0],upscale_method:'nearest-exact',scale_by:2}},
  '5':{class_type:'PreviewImage',inputs:{images:['4',0]}},
  '6':{class_type:'ImageScaleBy',inputs:{image:['3',1],upscale_method:'nearest-exact',scale_by:3}},
  '7':{class_type:'PreviewImage',inputs:{images:['6',0]}},
 }};
 const first=choiceStage(snapshot,['5','7']);first.snapshot.output['3'].inputs._choice_token=token;
 const base=await run(first.snapshot);assert.ok(base.outputs['3'].images.length);assert.equal(base.outputs['5'],undefined);
 assert.equal(base.outputs['3'].images[0].type,'temp');
 assert.match(base.outputs['3'].images[0].previewThumbnail,/^data:image\/webp;base64,/);
 const {ticket}=await request('/promptstudio/choices/claim',{token,index:1});
 const duplicate=await fetch(origin+'/promptstudio/choices/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,index:1})});assert.equal(duplicate.status,400);
 const next=choiceStage(snapshot,['5','7'],{'3':{index:1,token,ticket}});
 assert.deepEqual(Object.keys(next.snapshot.output).sort(),['3','6','7']);
 const result=await run(next.snapshot);assert.ok(result.outputs['7'].images.length);assert.equal(result.outputs['5'],undefined);
 const savedToken=(await request('/promptstudio/choices/reserve',{})).token;tokens.push(savedToken);
 const saved=structuredClone(first.snapshot);
 Object.assign(saved.output['3'].inputs,{_choice_token:savedToken,save_intermediate:true,format:'webp',mode:'lossless',filename_prefix:'PromptStudio/Validation/ChoiceSaved'});
 const stored=await run(saved),ref=stored.outputs['3'].images[0];
 assert.equal(ref.type,'output');assert.equal(ref.intermediate,true);assert.equal(ref.previewThumbnail,undefined);
 const response=await fetch(origin+'/view?'+new URLSearchParams({filename:ref.filename,subfolder:ref.subfolder,type:ref.type}));
 assert.equal(response.ok,true);assert.equal(Buffer.from(await response.arrayBuffer()).toString('ascii',8,12),'WEBP');
 console.log('Live Choice passed: temporary thumbnail, permanent WebP, atomic claim, cached source, only selected branch, idle worker.');
}finally{
 for(const token of tokens)await request('/promptstudio/choices/release',{token});
 if(createdImages.length)await request('/promptstudio/prompt-studio/delete-image-files',{images:createdImages});
 if(prompts.length)await request('/history',{delete:prompts});
}
