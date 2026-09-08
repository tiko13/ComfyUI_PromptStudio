import test from 'node:test';
import assert from 'node:assert/strict';
import {createPollingScope,createHealthReader} from '../web/js/prompt-studio/ui/polling.js';
test('health subscribers share one request, receive isolated results, and retry failures',async()=>{
 let calls=0,release;const gate=new Promise(resolve=>release=resolve);
 const read=createHealthReader({fetch:async()=>{calls++;await gate;return {ok:true,json:async()=>({busy:true})};}});
 const a=read('/health',{llm_provider:'koboldcpp',kobold_url:'http://local',temperature:1});
 const b=read('/health',{kobold_url:'http://local',llm_provider:'koboldcpp',temperature:0});
 release();const results=await Promise.all([a,b]);assert.equal(calls,1);results[0].busy=false;assert.equal(results[1].busy,true);
 let attempts=0;const retry=createHealthReader({fetch:async()=>{if(++attempts===1)throw Error('offline');return {ok:true,json:async()=>({})};}});
 await assert.rejects(retry('/health'),/offline/);await retry('/health');assert.equal(attempts,2);
});
test('view scopes back off hidden idle work, retain background work, and dispose timers/listeners',async()=>{
 const target=new EventTarget(),doc=new EventTarget(),timers=new Map();let id=0,calls=0,visible=false;
 const view=Object.assign(target,{document:doc,navigator:{onLine:true},setTimeout(fn,delay){timers.set(++id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);}});
 const scope=createPollingScope({view,visible:()=>visible});
 scope.add(async()=>{calls++;},{interval:10,hiddenInterval:100});
 await Promise.resolve();assert.equal(calls,1);assert.equal([...timers.values()][0].delay,100);
 visible=true;doc.dispatchEvent(new Event('visibilitychange'));await Promise.resolve();assert.equal(calls,2);assert.equal(timers.size,1);
 assert.equal([...timers.values()][0].delay,10);
 scope.add(async()=>{}, {interval:10,hiddenInterval:100,background:()=>true});await Promise.resolve();assert.equal(scope.size,2);
 scope.dispose();assert.equal(timers.size,0);assert.equal(scope.size,0);doc.dispatchEvent(new Event('visibilitychange'));assert.equal(calls,2);
});
test('visibility wakes do not overlap an already running poll',async()=>{
 const target=new EventTarget(),doc=new EventTarget();let release,calls=0;
 const view=Object.assign(target,{document:doc,setTimeout:()=>1,clearTimeout(){}});
 const scope=createPollingScope({view});scope.add(async()=>{calls++;await new Promise(resolve=>release=resolve);});
 doc.dispatchEvent(new Event('visibilitychange'));doc.dispatchEvent(new Event('visibilitychange'));assert.equal(calls,1);
 scope.dispose();release();await Promise.resolve();assert.equal(scope.size,0);
});
