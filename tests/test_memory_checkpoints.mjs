import assert from 'node:assert/strict';
import test from 'node:test';
import {storageSnapshot, storageSignature, changedRecords, projectChanges} from '../web/js/prompt-studio/core/storage-snapshot.js';
import {createDraftOutbox} from '../web/js/prompt-studio/chat/draft-outbox.js';

test('incremental checkpoints skip immutable history but detect metadata, replacement graphs, and deletions', () => {
  const graph = {get output() {throw new Error('Unchanged history must not be traversed');}};
  const old = {id:'old', messages:[{text:'saved', generationSnapshot:graph}]};
  const current = {id:'current', messages:[{text:'before', generationSnapshot:graph}]};
  const baseline = new Map([old,current].map(record => [record.id,storageSignature(record)]));
  assert.deepEqual(changedRecords([old,current],baseline),[]);
  current.messages[0].text = 'after';
  assert.deepEqual(changedRecords([old,current],baseline),[current]);
  old.messages[0].generationSnapshot = {output:{}};
  assert.deepEqual(changedRecords([old,current],baseline),[old,current]);
  const projects = [{id:'one',generations:[{workflow_snapshot:graph,status:'complete'}]}, {id:'two',name:'original'}, {id:'deleted'}];
  const base = storageSnapshot(projects);
  projects[1].name = 'edited'; projects.pop();
  const delta = projectChanges(projects,base);
  assert.deepEqual(delta.projects,[projects[1]]);
  assert.deepEqual(delta.base,[base[1],base[2]]);
  assert.deepEqual(delta.deletedProjectIds,['deleted']);
  assert.equal(base[1].name,'original');
});

test('slow draft workers retain only the newest waiting checkpoint and preserve ordering barriers', async t => {
  const sent=[], listeners=new Map(); let client;
  class Worker {
    constructor() {client=this;}
    postMessage(message) {sent.push(structuredClone(message));}
    terminate() {this.terminated=true;}
    reply(message, result={mutation:message.args[1]?.mutation,chatCount:1}) {this.onmessage({data:{id:message.id,result}});}
  }
  const originalWorker=globalThis.Worker, add=globalThis.addEventListener, remove=globalThis.removeEventListener;
  globalThis.Worker=Worker;
  globalThis.addEventListener=(name, fn)=>listeners.set(name,fn);
  globalThis.removeEventListener=name=>listeners.delete(name);
  t.after(()=>{globalThis.Worker=originalWorker;globalThis.addEventListener=add;globalThis.removeEventListener=remove;});
  const outbox=createDraftOutbox();
  const first=outbox.putReceipt('tab',{mutation:1,chats:[]});
  const waiting=[];
  for(let i=2;i<=100;i++)waiting.push(outbox.putReceipt('tab',{mutation:i,chats:[{id:'one',text:`edit ${i}`}]}));
  assert.equal(sent.length,1,'A slow worker must not receive 100 cloned archives');
  client.reply(sent[0]);await first;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sent.length,2);assert.equal(sent[1].args[1].mutation,100);
  const latest=outbox.putReceipt('tab',{mutation:101,chats:[{id:'one',text:'last'}]});
  const read=outbox.get('tab');
  assert.deepEqual(sent.map(message=>message.method),['putReceipt','putReceipt','putReceipt','get']);
  client.reply(sent[1]);client.reply(sent[2]);client.reply(sent[3],{mutation:101});
  assert.ok((await Promise.all(waiting)).every(result=>result.mutation===100));
  await latest;assert.equal((await read).mutation,101);
  await new Promise(resolve=>setImmediate(resolve));
  const a=outbox.putReceipt('tab',{mutation:102,chats:[]});
  const b=outbox.putReceipt('tab',{mutation:103,chats:[]});
  listeners.get('pagehide')();
  assert.equal(sent.at(-1).args[1].mutation,103,'Page exit sends the newest pending recovery copy synchronously');
  client.reply(sent.at(-2));client.reply(sent.at(-1));await Promise.all([a,b]);
  const later=outbox.putReceipt('tab',{mutation:104,chats:[]});
  assert.equal(sent.at(-1).args[1].mutation,104,'A later pagehide handler can still checkpoint synchronously');
  client.reply(sent.at(-1));await later;
  const close=outbox.close();client.reply(sent.at(-1));await close;
  assert.equal(client.terminated,true);assert.equal(listeners.has('pagehide'),false);
});
