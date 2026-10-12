import assert from 'node:assert/strict';
import {test} from 'node:test';
import {poseMaskEstimator} from '../web/js/prompt-studio/generation/pose-mask.js';
import {defaultPose} from '../web/js/prompt-studio/generation/pose.js';

test('estimator detects the real source and caches detections while padding uses a native node',async()=>{
 const source={filename:'source.png'},donor={filename:'donor.png'},pose=defaultPose();
 const prompts=[];const fetchApi=async(path,options)=>{
  if(path==='/prompt'){prompts.push(JSON.parse(options.body).prompt);return {ok:true,json:async()=>({prompt_id:String(prompts.length)})};}
  const id=path.split('/').at(-1),graph=prompts[Number(id)-1];
  const outputs=graph.estimate?{preview:{images:[{filename:'estimate.png'}]}}:{ps_structure_preview:{images:[{}]},ps_structure_guide:{pose_json:[JSON.stringify({data:pose})]}};
  return {ok:true,json:async()=>({[id]:{outputs}})};
 };
 const entry={image:donor,pose:{data:pose,original:pose,sourceImage:donor},guide:{type:'pose',input:'prepared',fit:'crop'},targeting:{target:{x:.2,y:.1,width:.6,height:.8}}};
 const estimate=poseMaskEstimator({entry,source,fetchApi,dimensions:async()=>({width:1024,height:768})});
 await estimate({padding:10,width:800,height:600});await estimate({padding:30,width:800,height:600});
 assert.equal(prompts.length,3);
 assert.equal(JSON.parse(prompts[0].ps_structure_source.inputs.image_ref).filename,'source.png');
 assert.equal(prompts[1].estimate.class_type,'PS_EstimatePoseMask');
 assert.equal(prompts[2].estimate.inputs.padding,30);
 assert.equal(prompts[1].estimate.inputs.guide_width,1024);
 assert.deepEqual(JSON.parse(prompts[1].estimate.inputs.targeting),{target:entry.targeting.target});
 assert.equal(prompts[1].estimate.inputs.all_people,false);
});

test('prepared raster without joints requires manual painting without queueing detection',async()=>{
 const estimate=poseMaskEstimator({entry:{guide:{type:'pose',input:'prepared'}},fetchApi:()=>{throw Error('Unexpected queue');}});
 await assert.rejects(()=>estimate({padding:10,width:100,height:100}),/no editable joints/);
});
