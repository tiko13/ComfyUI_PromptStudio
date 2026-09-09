import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalizeIntentProvenance,promptIntentVersion,restorePromptIntentVersion,recordManualMain,recordManualFinal,intentReplayRecord,createIntentSession,effectiveSecondaryInstructions} from '../web/js/prompt-studio/chat/intent-provenance.js';
import {createChatModel} from '../web/js/prompt-studio/chat/model.js';
import {snapshotForPlotCell} from '../web/js/prompt-studio/plot/model.js';

const metadata={version:1,revision:2,last_turn_id:'u2',locked_literals:[{id:'sign',text:'Zostaň tu!',kind:'visible_text',evidence:{source:'user',turn_id:'u1',quote:'Keep "Zostaň tu!"'}}],
  exclusions:[{id:'lamp',text:'lamp',aliases:['lamps'],origin:'final',evidence:{source:'user',turn_id:'u2',quote:'Remove the lamp'}}],source_tags:[],suppressed_sources:[],edit_scope:{kind:'final_only',targets:['lamp'],evidence:{source:'user',turn_id:'u2',quote:'Remove the lamp'}},manual_final:null};
const model=createChatModel({getDefaultLoraSelections:()=>({}),getDefaultModelSelections:()=>({}),loraSelectionKey:(...args)=>args.join(':'),modelSelectionKey:(...args)=>args.join(':'),normalizeLlmProvider:value=>value||'ollama',normalizePromptVersion:value=>({mainPrompt:String(value?.mainPrompt||''),finalPrompt:String(value?.finalPrompt||'')}),promptVersion:(mainPrompt,finalPrompt)=>({mainPrompt,finalPrompt})});

test('request drafts share one classified turn and never publish a partial response',()=>{
  const original=structuredClone(metadata),session=createIntentSession(original,{turnId:'u3',userText:'Change lighting',mainPrompt:'User Main',finalPrompt:'Saved Final'});
  const first=session.payload({mode:'revise_main'});
  assert.equal(first.intent_turn_id,'u3');
  const next={...metadata,revision:3,last_turn_id:'u3'};
  session.accept({intent_provenance:next});
  const second=session.payload({mode:'render'});
  assert.equal(second.intent_provenance.revision,3);
  assert.equal(second.intent_turn_id,first.intent_turn_id);
  assert.deepEqual(original,metadata);
  assert.throws(()=>session.accept({intent_provenance:{version:999}}),/invalid/);
  assert.equal(session.snapshot().revision,3);
});

test('suppressed secondary passthrough stays omitted after persisted metadata reload',()=>{
  const suppressed={...metadata,suppressed_sources:[{source:'secondary',source_id:'secondary_instructions',constraint_id:'lamp',code:'control_suppressed'}]};
  assert.equal(effectiveSecondaryInstructions(JSON.parse(JSON.stringify(suppressed)),'Add a lamp'),'');
  assert.equal(effectiveSecondaryInstructions(metadata,'Warm daylight'),'Warm daylight');
  assert.equal(effectiveSecondaryInstructions(null,'Legacy detail'),'Legacy detail');
});

test('plot cell exclusions suppress only that cell secondary input without mutating the shared base',()=>{
  const base={workflow:{nodes:[],extra:{keep:true}},output:{'1':{class_type:'PromptStudioSlot',inputs:{prompt:'Base',secondary_instructions:'Add a lamp'}}}};
  const plot={base:{workflowSnapshot:base,promptNodeId:'1'},axes:[]};
  const cell={finalPrompt:'A cat.',intentProvenance:{...metadata,suppressed_sources:[{source:'secondary',source_id:'secondary_instructions'}]}};
  const snapshot=snapshotForPlotCell(plot,cell);
  assert.equal(snapshot.output['1'].inputs.secondary_instructions,'');
  assert.equal(base.output['1'].inputs.secondary_instructions,'Add a lamp');
  assert.deepEqual(snapshot.workflow,base.workflow);
});

test('intent metadata survives chat, messages, prompt versions and pending generation normalization',()=>{
  const snapshot={workflow:{nodes:[]},output:{'1':{inputs:{seed:3,prompt:'Saved Final'}}},extra:{keep:true}};
  const source={id:'chat',mainPrompt:'User Main',finalPrompt:'Saved Final',renderedFinalPrompt:'Saved Final',intentProvenance:metadata,versions:[{mainPrompt:'User Main',finalPrompt:'Saved Final',intentProvenance:metadata}],
    messages:[{id:'m',role:'assistant',mainPrompt:'User Main',canonicalPrompt:'Saved Final',generationSnapshot:snapshot,intentProvenance:metadata}],pendingGeneration:{generationSnapshot:snapshot,intentProvenance:metadata},lastGeneration:{canonicalPrompt:'Saved Final',intentProvenance:metadata}};
  const before=JSON.stringify(source),chat=model.normalizeChat(source);
  for(const value of [chat.intentProvenance,chat.versions[0].intentProvenance,chat.messages[0].intentProvenance,chat.pendingGeneration.intentProvenance,chat.lastGeneration.intentProvenance])assert.deepEqual(value,metadata);
  chat.intentProvenance.exclusions.length=0;assert.equal(JSON.stringify(source),before);
  assert.deepEqual(chat.messages[0].generationSnapshot,snapshot);
});

test('manual Final and paired undo restore the corresponding metadata without changing Main',()=>{
  const first=promptIntentVersion('User Main','Rendered Final',metadata);
  const manual=recordManualFinal(metadata,'My exact manual Final, with unusual syntax.');
  const second=promptIntentVersion(first.mainPrompt,manual.manual_final.text,manual);
  assert.equal(second.mainPrompt,'User Main');assert.equal(second.finalPrompt,manual.manual_final.text);
  assert.equal(metadata.manual_final,null);
  const undo=restorePromptIntentVersion(first);assert.deepEqual(undo,first);
  undo.intentProvenance.locked_literals[0].text='Changed';assert.equal(first.intentProvenance.locked_literals[0].text,'Zostaň tu!');
});

test('manual Main replaces stale locks while retaining unchanged literals and unrelated exclusions',()=>{
  const before='A classroom with a sign "Zostaň tu!".';
  const source=structuredClone(metadata);
  source.locked_literals.push({id:'setting',text:'classroom',kind:'literal',evidence:{source:'user',turn_id:'u1',quote:'classroom'}});
  const saved=promptIntentVersion(before,'Old Final',source);
  const edited=recordManualMain(source,'A garden with a sign "Zostaň tu!".',before);
  assert.deepEqual(edited.locked_literals,metadata.locked_literals);
  assert.deepEqual(edited.exclusions,metadata.exclusions);
  assert.equal(edited.edit_scope,null);
  assert.equal(edited.last_turn_id,'');
  assert.equal(edited.revision,source.revision+1);
  assert.deepEqual(recordManualMain(edited,'A garden with a sign "Zostaň tu!".',before),edited,'Repeated draft commits are idempotent');
  assert.deepEqual(restorePromptIntentVersion(saved).intentProvenance,source);
  assert.equal(source.locked_literals.length,2,'Saved history remains intact');
  assert.deepEqual(recordManualMain(source,before,before),source,'An unchanged edit preserves constraints');
  assert.equal(recordManualMain(null,'Manual text','Old text'),null);
});

test('manual Main can restore an excluded object without clearing other exclusions',()=>{
  const source=structuredClone(metadata);
  source.suppressed_sources=[{source:'secondary',source_id:'secondary_instructions',constraint_id:'lamp'}];
  assert.equal(recordManualMain(source,'A cat by two LAMPS.','A cat.').exclusions.length,0);
  assert.deepEqual(recordManualMain(source,'A cat by two LAMPS.','A cat.').suppressed_sources,[]);
  assert.equal(recordManualMain(source,'A clamp beside a cat.','A cat.').exclusions.length,1);
  assert.equal(recordManualMain(source,'A cat, no lamp, at dusk.','A cat, no lamp.').exclusions.length,1);
});

test('legacy chats remain valid and exact replay ignores current exclusions/controls',()=>{
  const legacy=model.normalizeChat({id:'old',mainPrompt:'Old Main',finalPrompt:'Old Final',messages:[]});
  assert.equal(legacy.intentProvenance,null);assert.equal(legacy.mainPrompt,'Old Main');assert.equal(legacy.finalPrompt,'Old Final');
  assert.equal(model.normalizeChat({id:'bad',pendingGeneration:true}).pendingGeneration,null);
  const saved={mainPrompt:'Saved Main',canonicalPrompt:'Saved Final with lamp',intentProvenance:metadata,generationSnapshot:{workflow:{nodes:[]},output:{'1':{inputs:{seed:7,prompt:'Saved Final with lamp'}}}}};
  const before=JSON.stringify(saved),replay=intentReplayRecord(saved);
  assert.equal(JSON.stringify(replay),before);replay.generationSnapshot.output['1'].inputs.seed=9;assert.equal(JSON.stringify(saved),before);
});

test('recovered generation keeps intent metadata and invalid source authority is not normalized',()=>{
  const recovered=model.normalizeChat({id:'recover',messages:[{id:'m',role:'assistant',mainPrompt:'Recovered Main',canonicalPrompt:'Recovered Final',intentProvenance:metadata}]});
  assert.deepEqual(recovered.intentProvenance,metadata);assert.deepEqual(recovered.versions[0].intentProvenance,metadata);
  const invalid=structuredClone(metadata);invalid.exclusions[0].evidence.source='style';assert.equal(normalizeIntentProvenance(invalid),null);
  assert.equal(normalizeIntentProvenance({...metadata,version:2}),null);
});
