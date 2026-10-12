import assert from 'node:assert/strict';
import {test} from 'node:test';
import {defaultPose,normalizePose,normalizePoseReference,jointRotation,rotatePoseJoint} from '../web/js/prompt-studio/generation/pose.js';
import {normalizeQwenReferences,canReuseQwenPosePrompt,QWEN_POSE_PROMPT_VERSION} from '../web/js/prompt-studio/generation/qwen-references.js';
import {guideGraph,applyStructureGuide} from '../web/js/prompt-studio/generation/structure-guide.js';
import {referenceInputsMatch,normalizeReferenceState} from '../web/js/prompt-studio/generation/reference-inputs.js';

const image={filename:'edited.png',subfolder:'',type:'input'},source={...image,filename:'photo.png'};
const data=defaultPose(),pose={data,original:data,image,sourceImage:source,sourceRegion:{x:.2,y:.1,width:.5,height:.8}};

test('old image-only pose prompts refresh once while current prompts remain repeatable',()=>{
 const references=normalizeQwenReferences([{image,use:'structure',guide:{type:'pose'},pose}]);
 assert.equal(canReuseQwenPosePrompt({},references),false);
 assert.equal(canReuseQwenPosePrompt({qwenPosePromptVersion:1},references),false);
 const saved=normalizeReferenceState({qwenPosePromptVersion:QWEN_POSE_PROMPT_VERSION,qwenReferences:references});
 assert.equal(canReuseQwenPosePrompt(saved,references),true);
 assert.equal(canReuseQwenPosePrompt({},[{...references[0],guide:{type:'pose',strength:0}}]),true);
 assert.equal(canReuseQwenPosePrompt({},[{...references[0],use:'reference'}]),true);
 assert.equal(canReuseQwenPosePrompt({},[]),true);
});
test('pose data survives saved-reference normalization and edited joints invalidate replay',()=>{
 const entries=normalizeQwenReferences([{id:'pose',image:source,use:'both',role:'subject',guide:{type:'pose'},pose}]);
 assert.deepEqual(entries[0].pose,normalizePoseReference(pose));
 const changed=structuredClone(entries);changed[0].pose.data.people[0].pose_keypoints_2d[0]+=10;
 assert.equal(referenceInputsMatch({qwenReferences:entries},{qwenReferences:changed}),false);
 assert.deepEqual(normalizeQwenReferences(JSON.parse(JSON.stringify(entries))),entries);
});
test('edited guide bypasses detection and donor crop but preserves target placement',()=>{
 const target={x:.1,y:.2,width:.4,height:.7};
 const graph=guideGraph({image:source,pose,guide:{type:'pose',input:'photo'},targeting:{reference:pose.sourceRegion,target}},{width:1280,height:720});
 assert.deepEqual(JSON.parse(graph.ps_structure_source.inputs.image_ref),image);
 assert.equal(graph.ps_structure_guide.inputs.input_mode,'prepared');
 assert.deepEqual(JSON.parse(graph.ps_structure_guide.inputs.targeting).target,target);
 assert.equal(JSON.parse(graph.ps_structure_guide.inputs.targeting).reference,null);
 assert.equal(graph.ps_structure_guide.inputs.width,1280);
});
test('malformed data is bounded, absent points stay absent and original is independent',()=>{
 assert.equal(normalizePose({canvas_width:1e6,canvas_height:2,people:[]}),null);
 const d=defaultPose();d.people[0].hand_left_keypoints_2d=[Infinity,3,1,-2,3,1,4,5,0];
 const clean=normalizePose(d);assert.ok(clean.people[0].hand_left_keypoints_2d.every(v=>v===0));
 const saved=normalizePoseReference(pose);saved.data.people[0].pose_keypoints_2d[0]=10;
 assert.notEqual(saved.original.people[0].pose_keypoints_2d[0],10);
});
test('edited pose can execute without the detector and Create ignores Edit placement',async()=>{
 const snapshot={output:{p:{class_type:'KCPP_PromptSlot',inputs:{}},e:{class_type:'TextEncodeQwenImage21',inputs:{prompt:['p',0]}},s:{class_type:'KCPP_QwenImage21TurboSampler',inputs:{model:['m',0],positive:['e',0]}},d:{class_type:'VAEDecode',inputs:{vae:['v',0],samples:['s',0]}}}};
 const profile={kind:'create',promptNodeId:'p',snapshot};
 await applyStructureGuide(snapshot,profile,[{image:source,pose,use:'structure',guide:{type:'pose',input:'photo'},targeting:{target:{x:0,y:0,width:.5,height:1}}}],async()=>({ok:true,json:async()=>({ready:true,model:'control.safetensors',methods:{pose:{ready:false}}})}));
 assert.equal(snapshot.output.ps_structure_guide.inputs.input_mode,'prepared');
 assert.equal(snapshot.output.ps_structure_guide.inputs.targeting,undefined);
 assert.deepEqual(snapshot.output.s.inputs.model,['ps_structure_apply',0]);
 assert.deepEqual(JSON.parse(snapshot.output.ps_structure_source.inputs.image_ref),image);
});
test('elbow rotation keeps pivot, upper arm, other people and limb lengths intact, carrying fingers',()=>{
 const p=defaultPose(),person=p.people[0],body=person.pose_keypoints_2d;
 person.hand_right_keypoints_2d=Array.from({length:21},(_,i)=>[body[12]+i,body[13]+i,1]).flat();
 p.people.push(structuredClone(person));const before=structuredClone(p),old=before.people[0];
 assert.ok(rotatePoseJoint(p,0,'pose_keypoints_2d',3,-Math.PI/2));
 const a=person.pose_keypoints_2d,b=old.pose_keypoints_2d;
 assert.deepEqual(a.slice(9,12),b.slice(9,12),'Pivot is fixed');
 assert.deepEqual(a.slice(0,12),b.slice(0,12),'Shoulder and elbow stay fixed');
 assert.deepEqual(a.slice(15),b.slice(15),'Other limbs stay fixed');
 assert.deepEqual(p.people[1],before.people[1]);
 assert.ok(Math.abs(Math.hypot(a[12]-a[9],a[13]-a[10])-Math.hypot(b[12]-b[9],b[13]-b[10]))<1e-8);
 const hand=person.hand_right_keypoints_2d,oldHand=old.hand_right_keypoints_2d;
 assert.ok(Math.abs(Math.hypot(hand[3]-hand[0],hand[4]-hand[1])-Math.hypot(oldHand[3]-oldHand[0],oldHand[4]-oldHand[1]))<1e-8);
 assert.notDeepEqual(hand,oldHand);
});
test('rotation targets anatomical descendants and ignores hidden joints and endpoints',()=>{
 const p=defaultPose(),person=p.people[0];
 assert.equal(jointRotation(person,'pose_keypoints_2d',10),null,'Ankle has no foot points');
 assert.equal(jointRotation(person,'pose_keypoints_2d',4),null,'Wrist without hand has nothing to rotate');
 person.face_keypoints_2d.splice(0,3,380,160,1);
 assert.deepEqual(jointRotation(person,'pose_keypoints_2d',1).targets.map(t=>t.part+':'+t.index),['pose_keypoints_2d:0','pose_keypoints_2d:14','pose_keypoints_2d:15','pose_keypoints_2d:16','pose_keypoints_2d:17','face_keypoints_2d:0']);
 person.hand_left_keypoints_2d=Array.from({length:21},(_,i)=>[300+i*2,300+i*3,1]).flat();
 assert.deepEqual(jointRotation(person,'hand_left_keypoints_2d',2).targets.map(t=>t.index),[3,4]);
 assert.equal(jointRotation(person,'hand_left_keypoints_2d',4),null,'Fingertip has no descendants');
 person.hand_left_keypoints_2d[11]=0;
 assert.deepEqual(jointRotation(person,'hand_left_keypoints_2d',2).targets.map(t=>t.index),[4]);
 assert.equal(jointRotation(person,'face_keypoints_2d',0),null);
 person.pose_keypoints_2d[8]=0;assert.equal(jointRotation(person,'pose_keypoints_2d',2),null,'Hidden pivots have no ring');
});
test('out-of-frame rotation is rejected as a whole instead of distorting bones',()=>{
 const p=defaultPose(),body=p.people[0].pose_keypoints_2d;
 body.splice(9,6,2,2,1,30,2,1);const before=structuredClone(p);
 assert.equal(rotatePoseJoint(p,0,'pose_keypoints_2d',3,Math.PI),false);
 assert.deepEqual(p,before);
});

test('both hips rotate knee and ankle; knees rotate only their ankle',()=>{
 for(const [pivot,descendants] of [[8,[9,10]],[9,[10]],[11,[12,13]],[12,[13]]]){
  const p=defaultPose(),before=structuredClone(p),part='pose_keypoints_2d';
  assert.ok(rotatePoseJoint(p,0,part,pivot,Math.PI/12));
  const points=p.people[0][part],old=before.people[0][part];
  for(let i=0;i<18;i++){
   if(descendants.includes(i)){
    assert.notDeepEqual(points.slice(i*3,i*3+2),old.slice(i*3,i*3+2));
    assert.ok(Math.abs(Math.hypot(points[i*3]-points[pivot*3],points[i*3+1]-points[pivot*3+1])-Math.hypot(old[i*3]-old[pivot*3],old[i*3+1]-old[pivot*3+1]))<1e-8);
   }else assert.deepEqual(points.slice(i*3,i*3+3),old.slice(i*3,i*3+3));
  }
 }
});
