import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {startFixture,root} from './fixture.mjs';
const fixture=await startFixture();
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const reference={filename:'reference.png',subfolder:'imports',type:'promptstudio',width:64,height:64};
try {
 await fixture.context.route('**/js/prompt_studio.js',async route=>{const response=await route.fetch();await route.fulfill({response,body:await response.text()+'\nexport {updateComposeMode,refreshWorkflowControls,captureGenerationQueueSettings,queueGeneration,restoreChatState};'});});
 await fixture.context.route('**/scripts/api.js',async route=>{const response=await route.fetch();await route.fulfill({response,body:await response.text()+'\napi.queuePrompt=async(_,snapshot)=>{window.queuedSnapshots||=[];window.queuedSnapshots.push(structuredClone(snapshot));return {prompt_id:"ref-test-"+window.queuedSnapshots.length};};'});});
 await fixture.context.route('**/promptstudio/prompt-studio/import-image',route=>route.fulfill({json:{image:reference}}));
 await fixture.context.route('**/promptstudio/prompt-studio/image?*',route=>route.fulfill({contentType:'image/png',body:png}));
 const page=await fixture.newPage();
 async function activate(){await page.evaluate(async()=>{
  const m=await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
  const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
  window.refTest={m,state};
  const chat=state.chats.find(c=>c.id===state.activeChatId);
  chat.initialized=true;chat.selectedSource={filename:'base.png',subfolder:'',type:'output',width:64,height:64};
  const snapshot={workflow:{nodes:[],links:[]},output:{'1':{class_type:'KCPP_PromptSlot',inputs:{prompt:'Edit'}},'2':{class_type:'KCPP_ChatImageInput',inputs:{image_ref:''}},'3':{class_type:'KCPP_ChatImageReference',inputs:{image_ref:''}},'4':{class_type:'Krea2EditModelPatch',inputs:{source_image:['2',0],source_image_b:['3',0]}},'5':{class_type:'SaveImage',inputs:{images:['4',0]}}}};
  const profile={id:'ref',path:'ref',name:'[PS] Reference Edit',kind:'edit',promptNodeId:'1',imageNodeId:'2',resultNodeIds:['5'],snapshot,loraNodes:[],modelNodes:[]};
  const plain=structuredClone(profile);plain.id='plain';plain.path='plain';plain.name='[PS] Plain Edit';delete plain.snapshot.output['3'];delete plain.snapshot.output['4'].inputs.source_image_b;
  state.workflowProfiles=[profile,plain,{...plain,id:'create',path:'create',name:'[PS] Create',kind:'create'}];
  state.workflowBusy=true; // Host workflow listing is outside this composer test.
  chat.editWorkflowId='ref';state.apiConnected=true;
  m.refreshWorkflowControls();
  document.querySelector('#promptstudio-edit-workflow').value='ref';
  document.querySelector('input[name="promptstudio-generation-action"][value="edit"]').checked=true;
  document.querySelector('#promptstudio-use-llm-amplification').checked=false;
  m.updateComposeMode();
 });}
 await activate();
 const tile=page.locator('#promptstudio-edit-reference');
 assert.equal(await tile.isVisible(),true);
 await page.locator('#promptstudio-revision').fill('Use the jacket from the reference.');
 await tile.locator('input[type=file]').setInputFiles({name:'jacket.png',mimeType:'image/png',buffer:png});
 await page.waitForFunction(()=>document.querySelector('#promptstudio-edit-reference').dataset.filled==='true');
 assert.equal(await page.locator('#promptstudio-revision').inputValue(),'Use the jacket from the reference.');
 assert.equal(await page.locator('#promptstudio-pasted-image').isVisible(),false,'Model reference must not become an LLM attachment');
 assert.deepEqual(await page.evaluate(()=>window.refTest.m.captureGenerationQueueSettings('edit').referenceImage),reference);
 for(const width of [1440,390]) {
  await page.setViewportSize({width,height:1000});
  const bounds=await page.evaluate(()=>{const row=document.querySelector('.promptstudio-compose-input-row'),tile=document.querySelector('#promptstudio-edit-reference'),input=document.querySelector('#promptstudio-revision');return {scroll:row.scrollWidth,client:row.clientWidth,left:tile.getBoundingClientRect().right,right:input.getBoundingClientRect().left,input:input.getBoundingClientRect().width,edge:input.getBoundingClientRect().right,viewport:innerWidth};});
  assert.ok(bounds.edge<=bounds.viewport,JSON.stringify(bounds));assert.ok(bounds.scroll<=bounds.client,JSON.stringify(bounds));assert.ok(bounds.left<bounds.right);assert.ok(bounds.input>150);
  await mkdir(resolve(root,'test-results/browser'),{recursive:true});
  await page.locator('.promptstudio-compose').screenshot({path:resolve(root,`test-results/browser/edit-reference-${width}.png`)});
 }
 await page.setViewportSize({width:1440,height:1000});
 await page.evaluate(async()=>{await window.refTest.state.chatSaveChain;});
 await page.reload();await page.waitForFunction(()=>window.studioReady);await activate();
 assert.equal(await tile.getAttribute('data-filled'),'true','Reference survives reload');
 await page.evaluate(()=>{document.querySelector('input[name="promptstudio-generation-action"][value="create"]').checked=true;window.refTest.m.updateComposeMode();});
 assert.equal(await tile.isVisible(),false);assert.equal(await page.evaluate(()=>window.refTest.m.captureGenerationQueueSettings('create').referenceImage),null);
 await page.evaluate(()=>{document.querySelector('input[name="promptstudio-generation-action"][value="edit"]').checked=true;document.querySelector('#promptstudio-edit-workflow').value='plain';window.refTest.m.updateComposeMode();});
 assert.equal(await tile.isVisible(),false);assert.equal(await page.evaluate(()=>window.refTest.m.captureGenerationQueueSettings('edit').referenceImage),null);
 await page.evaluate(()=>{document.querySelector('#promptstudio-edit-workflow').value='ref';window.refTest.m.updateComposeMode();});
 await page.evaluate(async()=>{const {m}=window.refTest;await m.queueGeneration({...m.captureGenerationQueueSettings('edit'),action:'edit',executionPrompt:'Use the reference jacket',independent:true});});
 assert.deepEqual(await page.evaluate(()=>JSON.parse(window.queuedSnapshots[0].output['3'].inputs.image_ref)),reference);
 await tile.getByRole('button',{name:'Remove edit reference image'}).click();
 assert.equal(await tile.getAttribute('data-filled'),'false');
 await page.evaluate(async()=>{const {m}=window.refTest;await m.queueGeneration({...m.captureGenerationQueueSettings('edit'),action:'edit',executionPrompt:'Recolor the mug',independent:true});});
 assert.equal(await page.evaluate(()=>window.queuedSnapshots[1].output['3'].inputs.image_ref),'');
 assert.deepEqual(await page.evaluate(()=>JSON.parse(window.queuedSnapshots[0].output['3'].inputs.image_ref)),reference,'Clearing cannot mutate queued history');
 // Exact replay must use the saved reference even though the current slot is empty.
 await page.evaluate(()=>{const {m}=window.refTest;window.referenceReplay=m.queueGeneration({action:'edit',workflowProfileId:'ref',sourceImage:{filename:'base.png',subfolder:'',type:'output',width:64,height:64},generationSnapshot:window.queuedSnapshots[0],referenceImage:JSON.parse(window.queuedSnapshots[0].output['3'].inputs.image_ref),independent:true});});
 await page.getByRole('dialog',{name:'Review saved replay'}).waitFor();
 await page.getByRole('button',{name:'Replay saved inputs',exact:true}).click();
 await page.evaluate(()=>window.referenceReplay);
 assert.deepEqual(await page.evaluate(()=>JSON.parse(window.queuedSnapshots[2].output['3'].inputs.image_ref)),reference);
 assert.equal(await tile.getAttribute('data-filled'),'false','Replay does not replace the current reference');
 // Drop is confined to the reference tile, without invoking the chat drop path.
 await page.locator('.promptstudio-compose').evaluate(el=>{el.dataset.dragActive='reference';});
 await tile.evaluate((el,b64)=>{const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([bytes],'dropped.png',{type:'image/png'}));el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));},png.toString('base64'));
 await page.waitForFunction(()=>document.querySelector('#promptstudio-edit-reference').dataset.filled==='true');
 assert.equal(await page.locator('#promptstudio-pasted-image').isVisible(),false);
 assert.equal(await page.locator('.promptstudio-compose').getAttribute('data-drag-active'),'false');
 // A delayed upload belongs to the originating chat even after navigation.
 let release;await fixture.context.unroute('**/promptstudio/prompt-studio/import-image');
 await page.route('**/promptstudio/prompt-studio/import-image',async route=>{await new Promise(r=>release=r);await route.fulfill({json:{image:{...reference,filename:'replacement.png'}}});});
 await tile.locator('input[type=file]').setInputFiles({name:'replacement.png',mimeType:'image/png',buffer:png});
 await page.waitForFunction(()=>document.querySelector('#promptstudio-edit-reference').getAttribute('aria-busy')==='true');
 assert.equal(await page.locator('#promptstudio-send').isDisabled(),true);
 const owner=await page.evaluate(()=>{const {state,m}=window.refTest;const original=state.activeChatId;const other=structuredClone(state.chats.find(c=>c.id===original));other.id='other-chat';other.editReferenceImage=null;state.chats.push(other);state.activeChatId=other.id;m.restoreChatState(other);document.querySelector('#promptstudio-edit-workflow').value='ref';document.querySelector('input[name="promptstudio-generation-action"][value="edit"]').checked=true;m.updateComposeMode();return original;});
 release();await page.waitForFunction(id=>window.refTest.state.chats.find(c=>c.id===id)?.editReferenceImage?.filename==='replacement.png',owner);
 assert.equal(await tile.getAttribute('data-filled'),'false','Upload cannot attach to the newly selected chat');
 assert.deepEqual(fixture.errors,[]);
 console.log('Reference tile: upload/drop, optional queue payloads, persistence, chat isolation, and desktop/mobile layouts passed.');
} finally {await fixture.close();}
