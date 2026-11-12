import {test} from 'node:test';
import assert from 'node:assert/strict';
import {choiceStage, validateChoiceGraph, createChoiceController, recordChoiceStage, choiceStageOutputs, normalizeChoiceStages} from '../web/js/prompt-studio/generation/intermediate-choice.js';
import {mossCatalog,mossProfile} from './moss-fixture.mjs';
const n=(class_type,inputs={})=>({class_type,inputs});
test('Choice results retain stage order, survive serialization and tolerate repeated completion',()=>{
 const base={filename:'base.webp',type:'output',subfolder:'test'}, refined={...base,filename:'refined.webp'};
 let stages=recordChoiceStage([], 'base', [base]);
 stages=recordChoiceStage(stages, 'refine', [refined]);
 stages=recordChoiceStage(stages, 'refine', [refined]);
 assert.deepEqual(choiceStageOutputs(normalizeChoiceStages(JSON.parse(JSON.stringify(stages)))),[base,refined]);
 assert.equal(stages.length,2);
 assert.deepEqual(normalizeChoiceStages([{promptId:'base',outputs:[base],token:'secret'}]),[{promptId:'base',outputs:[base]}]);
});
const graph=()=>({workflow:{nodes:[]},output:{
 '1':n('Sampler',{seed:42}), '2':n('Decode',{samples:['1',0]}),
 '3':n('PS_IntermediateChoice',{images:['2',0],latent:['1',0],message:'Next?',options:'Refine\nUpscale'}),
 '4':n('Refine',{image:['3',0],latent:['1',0]}), '5':n('Save',{images:['4',0]}),
 '6':n('Upscale',{image:['3',1]}), '7':n('Save',{images:['6',0]}),
}});

test('choice cuts all future branches and resumes only the selected branch with exact cached latent',()=>{
 const snapshot=graph(), original=structuredClone(snapshot);
 validateChoiceGraph(snapshot,['5','7']);
 const first=choiceStage(snapshot,['5','7']);
 assert.deepEqual(Object.keys(first.snapshot.output).sort(),['1','2','3']);
 const next=choiceStage(snapshot,['5','7'],{'3':{index:0,token:'t',ticket:'c'}});
 assert.deepEqual(Object.keys(next.snapshot.output).sort(),['3','4','5']);
 assert.deepEqual(next.snapshot.output['4'].inputs.latent,['3',1]);
 assert.equal(next.snapshot.output['3'].class_type,'PS_IntermediateSource');
 assert.deepEqual(snapshot,original);
 const other=choiceStage(snapshot,['5','7'],{'3':{index:1,token:'t',ticket:'c'}});
 assert.deepEqual(Object.keys(other.snapshot.output).sort(),['3','6','7']);
 assert.deepEqual(other.snapshot.output['6'].inputs.image,['3',0]);
});

test('chained choices stop again and reject disconnected, mixed-branch and ambiguous graphs',()=>{
 const s=graph();
 s.output['5']=n('PS_IntermediateChoice',{images:['4',0],message:'Finish?',options:'Save'});
 s.output['8']=n('Save',{images:['5',0]});
 validateChoiceGraph(s,['8','7']);
 assert.equal(choiceStage(s,['8','7'],{'3':{index:0}}).gate.id,'5');
 assert.equal(choiceStage(s,['8','7'],{'3':{index:0},'5':{index:0}}).gate,null);
 s.output['3'].inputs.options+='\nUnconnected';
 assert.throws(()=>validateChoiceGraph(s,['8','7']),/Connect Intermediate/);
 const mixed=graph();mixed.output['4'].inputs.other=['3',1];
 assert.throws(()=>validateChoiceGraph(mixed,['5','7']),/exactly one/);
 const parallel=graph();parallel.output['8']=n('Save',{images:['2',0]});
 assert.throws(()=>validateChoiceGraph(parallel,['5','7','8']),/exactly one/);
});

test('MOSS SFT choice uses requested adapter and refines the captured image without re-running the base sampler',async()=>{
 const p=await mossProfile(mossCatalog.find(p=>p.id==='moss_sft_dmd8_choice'));
 const first=choiceStage(p.snapshot,p.resultNodeIds);
 assert.equal(first.gate.labels[0],'Refine');
 const out=first.snapshot.output;
 assert.equal(out['14'].inputs.steps,8);assert.equal(out['14'].inputs.cfg,1);
 assert.match(out['6'].inputs.lora_name,/MOSS_Image_SFT_8_steps_dmd_v0.1/);
 assert.equal(out['1'].inputs.model_type,'MOSS-SFT');
 assert.equal(out['17'].inputs.save_intermediate,true);
 const next=choiceStage(p.snapshot,p.resultNodeIds,{'17':{index:0,token:'t',ticket:'c'}});
 assert.equal(next.snapshot.output['14'],undefined);
 assert.equal(next.snapshot.output['20'].inputs.denoise,0.15);
 assert.equal(next.snapshot.output['20'].inputs.steps,4);
 assert.deepEqual(next.snapshot.output['18'].inputs.image,['17',0]);
});

test('controller drops superseded reservations and scopes choices to their chat',async()=>{
 const calls=[], deferred=[];
 const fetchApi=async(url,options)=>{
  const body=JSON.parse(options.body);calls.push([url,body]);
  if(url.endsWith('/reserve'))return new Promise(resolve=>deferred.push(()=>resolve({ok:true,json:async()=>({token:'t'+deferred.length})})));
  return {ok:true,json:async()=>({state:'ready',ticket:'claim'})};
 };
 const c=createChoiceController({fetchApi});
 const pending=c.prepare('a',graph(),['5','7']);
 c.invalidate('a');deferred[0]();
 await assert.rejects(pending,/superseded/);
 const waiting=c.prepare('b',graph(),['5','7']);deferred[1]();
 const prepared=await waiting;c.bind(prepared,'prompt-b',()=>{});
 await c.complete('prompt-b');c.invalidate('a');assert.equal(c.pending('prompt-b'),true);
 c.invalidate('b');assert.equal(c.pending('prompt-b'),false);
 assert.ok(calls.some(([url])=>url.endsWith('/release')));
 const revision=c.invalidate('a');c.invalidate('a');
 await assert.rejects(c.prepare('a',graph(),['5','7'],null,revision),/superseded/);
});
