import assert from 'node:assert/strict';
import {startFixture,attachVideo,config} from './fixture.mjs';
const fixture=await startFixture();
const snapshot={workflow:{nodes:[],extra:{saved:true}},output:{'1':{class_type:'PSV_MiniMaxH3Director',inputs:{document_json:JSON.stringify(config.default_document)}},'2':{class_type:'Sampler',inputs:{seed:1729}}}};
const generation={id:'saved',prompt_id:'old',status:'complete',workflow_id:'missing-current-profile',workflow_name:'Saved workflow',workflow_snapshot:snapshot,
 document:config.default_document,compiled_prompt:'Saved exact prompt',kind:'base',frame_count:124,effective_duration:5,outputs:[],result_node_ids:['2'],result_fields:['videos'],created_at:1,updated_at:1};
fixture.projects={revision:1,active_project_id:'project',projects:[{id:'project',name:'Saved project',document:config.default_document,generations:[generation],created_at:1,updated_at:1}]};
try {
 await fixture.context.route('**/scripts/api.js',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text())+'\napi.queuePrompt=async(_,snapshot)=>{window.queuedSnapshots||=[];window.queuedSnapshots.push(structuredClone(snapshot));return {prompt_id:"replayed"};};'});});
 const page=await fixture.newPage();
 await page.locator('#promptstudio-revision').fill('Unsent exact text — keep this draft');
 await page.waitForFunction(async()=>{const m=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/chat/draft-outbox.js');return (await m.createDraftOutbox().get(m.draftTabKey('image')))?.composerText==='Unsent exact text — keep this draft';});
 await page.reload();await page.waitForFunction(()=>window.studioReady||window.bootError);
 assert.equal(await page.evaluate(()=>window.bootError),undefined);
 assert.equal(await page.locator('#promptstudio-revision').inputValue(),'Unsent exact text — keep this draft');
 assert.equal(await page.evaluate(()=>window.queuedSnapshots?.length||0),0,'Restoring an unsent draft must not queue');
 await attachVideo(page);
 await page.getByRole('button',{name:'Replay exact',exact:true}).click();
 await page.getByRole('dialog',{name:'Review saved replay'}).waitFor();
 assert.equal(await page.evaluate(()=>window.queuedSnapshots?.length||0),0,'Review happens before queue');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.queuedSnapshots?.length||0),0);
 await page.getByRole('button',{name:'Replay exact',exact:true}).click();
 await page.getByRole('button',{name:'Replay saved inputs',exact:true}).click();
 try { await page.waitForFunction(()=>window.queuedSnapshots?.length===1,{},{timeout:5000}); }
 catch(error) { console.log('Replay failed',fixture.projects.projects[0].generations,fixture.errors);throw error; }
 const queued=await page.evaluate(()=>window.queuedSnapshots[0]);
 assert.deepEqual(queued.workflow,snapshot.workflow);
 assert.equal(queued.output['2'].inputs.seed,1729);
 assert.equal(queued.output['1'].inputs.document_json,snapshot.output['1'].inputs.document_json);
 await page.waitForFunction(()=>document.querySelector('#psvstudio-save-state')?.textContent==='Saved');
 const stored=fixture.projects.projects[0].generations;
 assert.deepEqual(stored.find(item=>item.id==='saved').workflow_snapshot,snapshot,'Original saved inputs remain immutable');
 assert.equal(stored.find(item=>item.prompt_id==='replayed').provenance.version,1);
 await page.route('**/promptstudio-video/projects',route=>route.request().method()==='PUT'?route.abort('failed'):route.continue());
 await page.locator('#psvstudio-project-title').fill('Offline draft retained');
 await page.waitForFunction(async()=>{const m=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/chat/draft-outbox.js');return (await m.createDraftOutbox().get(m.draftTabKey('video')))?.projects?.[0]?.name==='Offline draft retained';});
 await page.reload();await page.waitForFunction(()=>window.studioReady||window.bootError);
 assert.equal(await page.evaluate(()=>window.bootError),undefined);await attachVideo(page);
 assert.equal(await page.locator('#psvstudio-project-title').inputValue(),'Offline draft retained');
 assert.equal(fixture.projects.projects[0].name,'Saved project','Draft recovery preserves server content until an acknowledged save');
 assert.equal(await page.evaluate(()=>window.queuedSnapshots?.length||0),0,'Recovered Video draft must not requeue accepted work');
 assert.deepEqual(fixture.errors,[]);
 console.log('Integrated Image composer and Video offline draft reload plus replay review/cancel/exact saved seed/workflow/provenance passed; synthetic queue.');
} finally {await fixture.close();}
