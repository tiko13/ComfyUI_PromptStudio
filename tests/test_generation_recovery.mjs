import test from 'node:test';
import assert from 'node:assert/strict';
import {tagSubmission,findSubmittedPrompt,readPromptHistory} from '../web/js/prompt-studio/generation/recovery.js';

const entry = (promptId, id) => [0,promptId,{}, {extra_pnginfo:{workflow:tagSubmission({workflow:{extra:{saved:true}}},id).workflow}}];
test('finds the exact submission in running or pending queue without reading history', async () => {
  for (const key of ['queue_running','queue_pending']) {
    const calls=[];
    const api={fetchApi:async path=>{calls.push(path);return {ok:true,json:async()=>({queue_running:[],queue_pending:[],[key]:[entry('foreign','other'),entry('accepted','wanted')]})};}};
    assert.equal(await findSubmittedPrompt(api,'wanted'),'accepted');
    assert.deepEqual(calls,['/queue']);
  }
});
test('finds a generation finishing after the queue snapshot in history', async () => {
  const calls=[];
  const api={fetchApi:async path=>{
    calls.push(path);
    return {ok:true,json:async()=>path==='/queue'?{queue_running:[],queue_pending:[]}:{done:{prompt:entry('done','wanted')}}};
  }};
  assert.equal(await findSubmittedPrompt(api,'wanted'),'done');
  assert.deepEqual(calls,['/queue','/history?max_items=200']);
});
test('unavailable or malformed queue is not evidence that a submission is absent', async () => {
  for (const response of [{ok:false,status:503},{ok:true,json:async()=>({})}]) {
    await assert.rejects(findSubmittedPrompt({fetchApi:async()=>response},'wanted'));
  }
});
test('temporary history failures preserve the ability to poll again', async () => {
  for (const fetchApi of [async()=>{throw Error('disconnected');},async()=>({ok:false}),async()=>({ok:true,json:async()=>{throw Error('invalid JSON');}})]) {
    assert.equal(await readPromptHistory({fetchApi},'a'),null);
  }
  const item={status:{completed:true}};
  assert.deepEqual(await readPromptHistory({fetchApi:async()=>({ok:true,json:async()=>({a:item})})},'a'),item);
});
