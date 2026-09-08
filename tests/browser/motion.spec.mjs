import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';
const fixture=await startFixture();
try {
 const page=await fixture.context.newPage();
 await page.route(fixture.origin+'/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><link rel="stylesheet" href="/extensions/ComfyUI_PromptStudio/css/studio-tokens.css"><main id="promptstudio-prompt-studio"><section id="history" style="height:300px;overflow:auto"></section></main>'}));
 await page.goto(fixture.origin);await page.emulateMedia({reducedMotion:'no-preference'});
 const initial=await page.evaluate(async()=>{
  const {reconcileKeyedHistory}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/keyed-history.js');
  const container=document.querySelector('#history'),items=Array.from({length:500},(_,id)=>({id:String(id),text:'Saved result '+id}));
  const create=item=>{const card=document.createElement('article');card.textContent=item.text;return card;};
  window.motionTest={container,items,create,reconcileKeyedHistory};reconcileKeyedHistory(container,items,{create});
  container.scrollTop=500;return document.getAnimations().length;
 });
 assert.equal(initial,0,'Loading an archive must not animate 500 cards');
 const result=await page.evaluate(()=>{
  const {container,items,create,reconcileKeyedHistory}=window.motionTest;
  const selected=container.children[30].firstChild,range=document.createRange();range.selectNodeContents(selected);getSelection().removeAllRanges();getSelection().addRange(range);
  const scroll=container.scrollTop;items.push({id:'new',text:'New result'});
  const counts=reconcileKeyedHistory(container,items,{create});
  return {counts,animations:document.getAnimations().length,scrollDelta:container.scrollTop-scroll,selection:getSelection().toString()};
 });
 assert.equal(result.counts.created,1);assert.equal(result.counts.updated,0);assert.equal(result.animations,1);assert.equal(result.scrollDelta,0);assert.equal(result.selection,'Saved result 30');
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.waitForFunction(()=>document.getAnimations().length===0);
 const measurements=await page.evaluate(()=>{
  const {container,items,create,reconcileKeyedHistory}=window.motionTest,times=[];
  for(let i=0;i<30;i++){items.at(-1).text='Progress '+i;const start=performance.now();const counts=reconcileKeyedHistory(container,items,{create});times.push(performance.now()-start);if(counts.updated!==1)throw Error('Unexpected update work');}
  items.push({id:'reduced',text:'Reduced motion result'});reconcileKeyedHistory(container,items,{create});
  return {maxMs:Math.max(...times),medianMs:times.sort((a,b)=>a-b)[15],animations:document.getAnimations().length};
 });
 assert.equal(measurements.animations,0);console.log('Motion: one opacity reveal, no archive/progress animation, selection/scroll retained, reduced-motion immediate.',measurements);
} finally {await fixture.close();}
