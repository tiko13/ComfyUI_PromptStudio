import test from 'node:test';
import assert from 'node:assert/strict';
import {createSubmissionJournal} from '../web/js/prompt-studio/generation/submission-journal.js';

function storage() {
  const records = new Map();
  return {records,
    async put(key, value) { const copy=structuredClone({...value,key}); records.set(key,copy); return copy; },
    async list() { return structuredClone([...records.values()]); },
    async acknowledge(key, mutation) { if (records.get(key)?.mutation <= mutation) records.delete(key); },
  };
}

for (const collection of ['messages','generations']) test(`${collection}: isolated submission recovery preserves older history and newer accepted state`, async () => {
  const outbox=storage(), options={outbox,prefix:'tab:'};
  const journal=createSubmissionJournal('test',collection,options);
  const entry={id:'new',operationId:'new',updatedAt:10,generationState:'',generationSnapshot:{output:{node:{inputs:{seed:42}}}}};
  await journal.checkpoint({id:'owner',title:'Owner'},entry);
  entry.generationSnapshot.output.node.inputs.seed=99;
  const owners=[];
  const reloaded=createSubmissionJournal('test',collection,options);
  const existing={id:'owner',[collection]:[{id:'older',text:'Keep old history'},
    {id:'new',generationState:'error',updatedAt:9}]};
  assert.equal(await reloaded.restore(owners,async()=>existing),true);
  assert.equal(owners[0],existing);
  assert.equal(existing[collection][0].text,'Keep old history');
  assert.equal(existing[collection][1].generationSnapshot.output.node.inputs.seed,42);
  existing[collection][1]={...entry,promptId:'accepted',updatedAt:11};
  assert.equal(await reloaded.restore(owners),false);
  await reloaded.acknowledge([{id:'owner',[collection]:[{...entry,promptId:'older-ack',updatedAt:9}]}]);
  assert.equal(outbox.records.size,1,'Old acknowledgement must retain recovery intent');
  await reloaded.acknowledge(owners);
  assert.equal(outbox.records.size,0);
});

test('failed checkpoints reject and unrelated tab records are retained',async()=>{
  const outbox=storage();
  const journal=createSubmissionJournal('image','messages',{outbox,prefix:'this:'});
  await outbox.put('other:job',{owner:{id:'other'},entry:{id:'job'}});
  assert.equal(await journal.restore([]),false);
  outbox.put=async()=>{throw new Error('quota');};
  await assert.rejects(journal.checkpoint({id:'chat'},{id:'job'}),/quota/);
});

test('recovery does not recreate an explicitly deleted saved owner or acknowledge on read failure',async()=>{
  const outbox=storage(), options={outbox,prefix:'tab:'};
  await createSubmissionJournal('image','messages',options).checkpoint({id:'deleted'},{id:'job'},true);
  const journal=createSubmissionJournal('image','messages',options), owners=[];
  await assert.rejects(journal.restore(owners,async()=>{throw new Error('offline');}),/offline/);
  assert.equal(outbox.records.size,1);
  assert.equal(await journal.restore(owners,async()=>null),false);
  assert.deepEqual(owners,[]);
  assert.equal(outbox.records.size,0);
});
