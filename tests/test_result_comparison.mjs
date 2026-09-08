import assert from 'node:assert/strict';
import test from 'node:test';
import {diffPrompt,diffSavedInputs,imageComparisonRecord,videoComparisonRecord,plotComparisonRecord} from '../web/js/prompt-studio/ui/result-comparison.js';

test('prompt diff is lossless for tags, whitespace, quoted literals and prose',()=>{
  for(const [before,after] of [
    ['<S1> "Keep  this"\nred room','<S1> "Keep  this"\nblue room'],
    ['one two three four','one new three other'],['','<d>Hi</d>'],['old',''],
    ['a '.repeat(700),'b '.repeat(700)],['x < y','x < z'],
  ]) {
    const result=diffPrompt(before,after);
    assert.equal(result.filter(part=>part.kind!=='added').map(part=>part.text).join(''),before);
    assert.equal(result.filter(part=>part.kind!=='removed').map(part=>part.text).join(''),after);
  }
  assert.deepEqual(diffPrompt('same','same'),[{kind:'equal',text:'same'}]);
});
test('input diff distinguishes omitted, null, arrays and escaped paths',()=>{
  const rows=diffSavedInputs({'a/b':{seed:1,absent:null},array:[0,2]},{'a/b':{seed:2},array:[0,3]});
  assert.deepEqual(rows.map(row=>row.path),['/a~1b/absent','/a~1b/seed','/array/1']);
  assert.equal(rows[0].before,null);assert.equal(rows[0].after,undefined);
});
test('saved Image record is deeply immutable and unknown Final origin stays unknown',()=>{
  const saved={id:'image',mainPrompt:'<d>Exact  words</d>',canonicalPrompt:'<d>Exact  words</d> cinema',
    controlsFingerprint:'{"style":"cinema"}',generationSnapshot:{workflow:{nodes:[]},output:{'2':{inputs:{seed:23,prompt:'exact'}}}},images:[]};
  const before=structuredClone(saved),record=imageComparisonRecord(saved);
  assert.equal(record.main,saved.mainPrompt);assert.equal(record.finalOrigin,'Final origin not recorded');
  assert.equal(record.seeds[0].value,23);assert.throws(()=>{record.snapshot.output['2'].inputs.seed=24;},TypeError);
  saved.generationSnapshot.output['2'].inputs.seed=99;assert.equal(record.seeds[0].value,23);
  assert.equal(record.snapshot.output['2'].inputs.seed,before.generationSnapshot.output['2'].inputs.seed);
});
test('plot cell uses its paired LoRA axis, exact seed, prompts and workflow envelope',()=>{
  const plot={id:'plot',axes:[
    {name:'x',label:'LoRA',type:'lora',targetNodeId:'10',values:[{label:'A',value:{name:'A.safetensors',strength:1}},{label:'B',value:{name:'B.safetensors',strength:1}}]},
    {name:'y',label:'Strength',type:'lora_strength',targetNodeId:'10',values:[{label:'.25',value:.25}]},
    {name:'z',label:'Seed',type:'seed',targetNodeId:'20',values:[{label:'42',value:42}]},
  ],base:{mainPrompt:'main',finalPrompt:'final',promptNodeId:'30',loraState:[{nodeId:'10',selections:[{name:'global.safetensors',strength:.7}]}],
    workflowSnapshot:{workflow:{nodes:[{id:10}]},output:{'10':{class_type:'KCPP_PromptStudioLoraLoader',inputs:{lora_stack_json:'[]'}},
      '20':{class_type:'KCPP_PromptStudioSampler',inputs:{seed:1}},'30':{inputs:{prompt:'base'}}}}}};
  const cell={id:'cell',coordinate:[1,0,0],mainPrompt:'cell main',finalPrompt:'cell final',images:[]};
  const before=structuredClone({plot,cell}),record=plotComparisonRecord(plot,cell);
  assert.deepEqual({plot,cell},before);assert.deepEqual(record.snapshot.workflow,{nodes:[{id:10}]});
  assert.equal(record.snapshot.output['30'].inputs.prompt,'cell final');assert.equal(record.seeds[0].value,42);
  assert.deepEqual(JSON.parse(record.snapshot.output['10'].inputs.lora_stack_json),[{name:'global.safetensors',strength:.7},{name:'B.safetensors',strength:.25}]);
  assert.equal(record.settings.axisOverrides[1].pairedAxis,'x');assert.equal(record.settings.axisOverrides[0].value.name,'B.safetensors');
});
test('Video comparison uses authored and effective timing from that saved generation',()=>{
  const saved={id:'video',document:{main_description:'saved',duration_seconds:5},compiled_prompt:'[0s] saved',
    parent_generation_id:'parent',root_generation_id:'root',depth:2,effective_duration:5.125,total_effective_duration:14,frame_count:123,
    workflow_snapshot:{workflow:{nodes:[]},output:{'4':{inputs:{noise_seed:'567'}}}},outputs:[]};
  const before=structuredClone(saved),record=videoComparisonRecord(saved);
  assert.deepEqual(saved,before);assert.equal(record.timing.authoredSeconds,5);assert.equal(record.timing.effectiveSeconds,5.125);
  assert.equal(record.lineage.parent,'parent');assert.equal(record.seeds[0].value,'567');
});
