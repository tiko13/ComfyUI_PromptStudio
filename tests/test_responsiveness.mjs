import assert from 'node:assert/strict';
import test from 'node:test';
import {createSubmissionOrder,coalesceFrame} from '../web/js/prompt-studio/core/scheduling.js';
import {historySignature} from '../web/js/prompt-studio/ui/keyed-history.js';
import {refreshSelectedWorkflow} from '../web/js/prompt-studio/generation/selected-workflow.js';
import {processData} from '../web/js/prompt-studio/core/background-data.js';
import {storageSnapshot} from '../web/js/prompt-studio/core/storage-snapshot.js';

test('storage snapshots copy editable metadata without traversing immutable workflow graphs', () => {
  const graph = {get output() { throw new Error('Historical graph traversed on UI thread'); }};
  const record = {id:'chat', messages:[{text:'original', generationSnapshot:graph}], other:{value:1}};
  const saved = storageSnapshot(record);
  record.messages[0].text = 'new edit'; record.other.value = 2;
  assert.equal(saved.messages[0].text,'original'); assert.equal(saved.other.value,1);
  assert.equal(saved.messages[0].generationSnapshot,graph);
  const video = storageSnapshot({generations:[{workflow_snapshot:graph,status:'complete'}]});
  assert.equal(video.generations[0].workflow_snapshot,graph);
});

test('frame coalescing uses the controls current document and latest update',()=>{
  const first=[],second=[],painted=[];
  let view={requestAnimationFrame:callback=>first.push(callback),cancelAnimationFrame(){}};
  const paint=coalesceFrame(value=>painted.push(value),()=>view);
  paint(1);paint(2);
  assert.equal(first.length,1);
  first.shift()();assert.deepEqual(painted,[2]);
  paint('stale hidden frame');
  view={requestAnimationFrame:callback=>second.push(callback),cancelAnimationFrame(){}};
  paint(3);assert.equal(second.length,1);
  first.shift()();assert.deepEqual(painted,[2]);
  second.shift()();assert.deepEqual(painted,[2,3]);
});

test('background chat encoding preserves partial saves and deletions without resending unchanged chats', () => {
  const unchanged = {id:'old',messages:[{text:'saved'}]};
  const changed = {id:'edited',messages:[{text:'new'}]};
  const snapshot = {version:2,activeChatId:'edited',chats:[unchanged,changed]};
  const payload = JSON.parse(processData('chat-store', {snapshot,
    acknowledged:{old:JSON.stringify(unchanged)}, revision:7,
    deletedChatIds:['deleted'],deletedMessageIds:{edited:['removed']}}));
  assert.deepEqual(payload, {version:2,activeChatId:'edited',chats:[changed],partial:true,
    revision:7,deletedChatIds:['deleted'],deletedMessageIds:{edited:['removed']}});
  assert.deepEqual(snapshot.chats,[unchanged,changed]);
});

test('failed middle preparation cannot let later submissions overtake the first', async () => {
  const reserve = createSubmissionOrder();
  const first = reserve(), failed = reserve(), third = reserve();
  const calls = [];
  failed.release();
  const last = third.ready.then(() => calls.push('third'));
  await Promise.resolve();
  assert.deepEqual(calls, []);
  await first.ready; calls.push('first'); first.release();
  await last; third.release();
  assert.deepEqual(calls, ['first', 'third']);
});

test('history signatures never serialize saved execution graphs, but detect replacement', () => {
  const graph = {get output() {throw new Error('Execution graph traversed during render');}};
  const message = {id:'a',text:'before',generationSnapshot:graph};
  const before = historySignature(message);
  assert.equal(historySignature(message), before);
  message.text = 'after'; assert.notEqual(historySignature(message), before);
  const after = historySignature(message);
  message.generationSnapshot = {output:{}}; assert.notEqual(historySignature(message), after);
});

test('queue refresh reads only the selected workflow and still runs content validation', async () => {
  const calls = [];
  const profile = {path:'nested/[PS] Selected.json',sourceModified:42};
  const api = {getUserData: async path => {calls.push(path);return {ok:true,json:async()=>({nodes:['new content']})};}};
  const rebuilt = await refreshSelectedWorkflow(api, profile, async (file, data, cached) => {
    assert.equal(cached, profile);assert.equal(file.path,profile.path);
    assert.deepEqual(data.nodes,['new content']); return {...profile,checked:true};
  });
  assert.equal(rebuilt.checked,true);
  assert.deepEqual(calls,['workflows/nested/[PS] Selected.json']);
  await assert.rejects(refreshSelectedWorkflow({getUserData:async()=>({ok:false,status:404})},profile,()=>{}),/could not be read/);
  const cached = {...profile,snapshot:{output:{}}};
  const fallback = await refreshSelectedWorkflow({getUserData:async()=>({ok:false,status:503})},cached,()=>{});
  assert.equal(fallback.stale,true);
  assert.equal(fallback.snapshot,cached.snapshot,'Transient outages retain the last working executable cache');
  await assert.rejects(refreshSelectedWorkflow({getUserData:async()=>({ok:false,status:404})},cached,()=>{}),/could not be read/);
});
