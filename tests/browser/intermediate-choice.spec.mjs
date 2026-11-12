import assert from 'node:assert/strict';
import {startFixture,attachVideo,videoEnabled} from './fixture.mjs';
const fixture=await startFixture();
const snapshots=[], tokens=new Map(); let tokenNumber=0, rejectNext=false;
try {
 await fixture.context.route('**/scripts/api.js',async route=>{
  const response=await route.fetch();await route.fulfill({response,body:await response.text()+
   '\napi.queuePrompt=async(_,s)=>{const r=await fetch("/test-choice-queue",{method:"POST",body:JSON.stringify(s)});return r.json();};'});
 });
 await fixture.context.route('**/test-choice-queue',async route=>{
  const s=route.request().postDataJSON(),id='choice-'+(snapshots.length+1);snapshots.push(s);
  if(rejectNext){rejectNext=false;await route.fulfill({json:{}});return;}
  for(const node of Object.values(s.output))if(node.class_type==='PS_IntermediateChoice')tokens.set(node.inputs._choice_token,'ready');
  await route.fulfill({json:{prompt_id:id}});
 });
 await fixture.context.route('**/promptstudio/choices/*',async route=>{
  const {token,index}=route.request().postDataJSON();let data={};
  if(route.request().url().endsWith('/reserve')){data={token:'token-'+(++tokenNumber)};tokens.set(data.token,'reserved');}
  if(route.request().url().endsWith('/status'))data={state:tokens.get(token)||'expired'};
  if(route.request().url().endsWith('/release'))tokens.delete(token);
  if(route.request().url().endsWith('/claim')){assert.equal(tokens.get(token),'ready');assert.equal(index,0);tokens.set(token,'claimed');data={ticket:'ticket-'+token};}
  await route.fulfill({json:data});
 });
 await fixture.context.route('**/history/choice-*',async route=>{
  const id=route.request().url().split('/').at(-1),s=snapshots[Number(id.split('-').at(-1))-1];
  const gate=Object.entries(s.output).find(([,n])=>n.class_type==='PS_IntermediateChoice');
  await route.fulfill({json:{[id]:{status:{completed:true},outputs:{[gate?.[0]||'5']:{images:[{filename:gate?(gate[0]==='6'?'middle.png':'base.png'):'refined.png',subfolder:'',type:'temp',width:32,height:32}]}}}}});
 });
 await fixture.context.route('**/view?*',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="steelblue"/></svg>'}));
 await fixture.context.route('**/js/prompt_studio.js',async route=>{
  const response=await route.fetch();await route.fulfill({response,body:await response.text()+'\nwindow.choiceImage={queueGeneration,imageChoices,flushChatStore,renderChatHistory};'});
 });
 await fixture.context.route('**/js/promptstudio_video_studio.js',async route=>{
  const response=await route.fetch();await route.fulfill({response,body:await response.text()+'\nwindow.choiceVideo={queueSnapshot,videoChoices,state,renderAll,newProject,persistProjects};'});
 });
 const page=await fixture.newPage();
 await page.evaluate(async()=>{
  const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
  await window.choiceImage.flushChatStore();window.choiceImage.state=state;
  const snapshot={workflow:{nodes:[],links:[],extra:{promptstudio_choice_results:['5']}},output:{
   '1':{class_type:'KCPP_PromptSlot',inputs:{prompt:'Frozen prompt'}},
   '2':{class_type:'Sampler',inputs:{prompt:['1',0],seed:42}},
   '3':{class_type:'PS_IntermediateChoice',inputs:{images:['2',0],options:'Refine',message:'Optional refinement'}},
   '4':{class_type:'Refine',inputs:{images:['3',0],seed:42}},
   '5':{class_type:'SaveImage',inputs:{images:['4',0]}},
  }};
  const profile={id:'choice-test',path:'',name:'Choice test',kind:'create',promptNodeId:'1',snapshot,
   resultNodeIds:['5'],resultFields:['images'],loraNodes:[],modelNodes:[],samplingNodes:[],additionalInputs:[]};
  state.workflowProfiles.push(profile);state.apiConnected=true;
  window.choiceSnapshot=snapshot;
  await window.choiceImage.queueGeneration({workflowProfileId:profile.id,executionPrompt:'Frozen prompt',finalPrompt:'Frozen prompt',mainPrompt:'Frozen prompt',independent:true});
 });
 await page.getByRole('button',{name:'Refine',exact:true}).waitFor();
 assert.equal(snapshots.length,1);assert.equal(snapshots[0].output['4'],undefined);
 const originalMessage = await page.evaluate(()=>window.choiceImage.state.chats.find(c=>c.id===window.choiceImage.state.activeChatId).messages.find(m=>m.promptId==='choice-1').id);
 await page.evaluate(()=>{window.choiceImage.state.currentPrompt='Changed after generation';});
 await page.getByRole('button',{name:'Refine',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('img[alt="refined.png"]'));
 assert.equal(snapshots.length,2);assert.equal(snapshots[1].output['2'],undefined);
 assert.equal(snapshots[1].output['3'].class_type,'PS_IntermediateSource');
 assert.equal(snapshots[1].output['4'].inputs.seed,42);
 assert.equal(await page.getByRole('button',{name:'Refine',exact:true}).count(),0);
 assert.deepEqual(await page.evaluate(()=>{
  const chat=window.choiceImage.state.chats.find(c=>c.id===window.choiceImage.state.activeChatId);
  return chat.messages.filter(m=>m.choiceStages).map(m=>({id:m.id,images:m.images.map(i=>i.filename),stages:m.choiceStages.length}));
 }),[{id:originalMessage,images:['base.png','refined.png'],stages:2}]);
 const imageCards=page.locator('.promptstudio-message').filter({has:page.locator('img[alt="refined.png"]')});
 assert.equal(await imageCards.locator('img[alt="base.png"]').count(),1);
 // Chained choices share the same message and only the current stage has an action.
 await page.evaluate(async()=>{
  const profile=window.choiceImage.state.workflowProfiles.find(p=>p.id==='choice-test');
  profile.snapshot=structuredClone(window.choiceSnapshot);
  profile.snapshot.output['6']={class_type:'PS_IntermediateChoice',inputs:{images:['4',0],message:'Another stage',options:'Finish'}};
  profile.snapshot.output['7']={class_type:'Refine',inputs:{images:['6',0],seed:42}};
  profile.snapshot.output['5'].inputs.images=['7',0];
  await window.choiceImage.queueGeneration({workflowProfileId:profile.id,executionPrompt:'Chained',finalPrompt:'Chained',independent:true});
 });
 await page.getByRole('button',{name:'Refine',exact:true}).click();
 await page.getByRole('button',{name:'Finish',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Finish',exact:true}).count(),1);
 assert.equal(await page.locator('.studio-choice-preview').filter({has:page.locator('img[alt="middle.png"]')}).count(),1);
 await page.getByRole('button',{name:'Finish',exact:true}).click();
 await page.waitForFunction(()=>window.choiceImage.state.chats.find(c=>c.id===window.choiceImage.state.activeChatId).messages.some(m=>m.choiceStages?.length===3));
 assert.deepEqual(await page.evaluate(()=>window.choiceImage.state.chats.find(c=>c.id===window.choiceImage.state.activeChatId).messages.find(m=>m.choiceStages?.length===3).images.map(i=>i.filename)),['base.png','middle.png','refined.png']);
 await page.evaluate(()=>{window.choiceImage.state.workflowProfiles.find(p=>p.id==='choice-test').snapshot=structuredClone(window.choiceSnapshot);});
 // Replacing the generation removes its action immediately; reload does not revive it.
 await page.evaluate(async()=>{
  await window.choiceImage.queueGeneration({workflowProfileId:'choice-test',executionPrompt:'Next',finalPrompt:'Next',independent:true});
 });
 await page.getByRole('button',{name:'Refine',exact:true}).waitFor();
 rejectNext=true;
 await page.getByRole('button',{name:'Refine',exact:true}).click();
 await page.waitForFunction(()=>window.choiceImage.state.chats.find(c=>c.id===window.choiceImage.state.activeChatId).messages.some(m=>m.choiceStages?.length===1&&m.operationPhase==='error'));
 assert.equal(await page.evaluate(()=>window.choiceImage.state.chats.find(c=>c.id===window.choiceImage.state.activeChatId).messages.find(m=>m.choiceStages?.length===1&&m.operationPhase==='error').images.length),1);
 assert.equal(await page.getByRole('button',{name:'Refine',exact:true}).count(),0);
 if(videoEnabled){
  await attachVideo(page);
  await page.evaluate(async()=>{
   const {state,queueSnapshot,newProject}=window.choiceVideo;
   if(!state.projects.length)await newProject();
   const project=state.projects.find(p=>p.id===state.activeProjectId);
   if(!project)throw Error('Video fixture needs its initial project');
   const snapshot=structuredClone(window.choiceSnapshot);snapshot.output['1'].class_type='PSV_MiniMaxH3Director';snapshot.output['5'].class_type='SaveVideo';
   state.apiConnected=true;
   await queueSnapshot(project,{id:'video-choice',name:'Video choice',director_node_id:'1',result_node_ids:['5'],result_fields:['images','videos']},snapshot,
    {document:structuredClone(project.document),compiled_prompt:'Frozen video',resolved_mode:'t2va',frame_count:1,effective_duration:1});
  });
  await page.locator('#psvstudio-preview').getByRole('button',{name:'Refine',exact:true}).waitFor();
  const before=snapshots.length;
  await page.locator('#psvstudio-preview').getByRole('button',{name:'Refine',exact:true}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll('#psvstudio-preview img')].some(img=>img.src.includes('refined.png')));
  assert.equal(snapshots.length,before+1);assert.equal(snapshots.at(-1).output['2'],undefined);
  assert.notEqual(snapshots.at(-1).workflow.extra.promptstudio_submission,snapshots.at(-2).workflow.extra.promptstudio_submission);
  assert.equal(await page.locator('#psvstudio-preview img').count(),2);
  assert.deepEqual(await page.evaluate(()=>{
   const {state}=window.choiceVideo,project=state.projects.find(p=>p.id===state.activeProjectId);
   return project.generations.filter(g=>g.workflow_id==='video-choice').map(g=>g.choiceStages.length);
  }),[2]);
  await page.evaluate(()=>window.choiceVideo.persistProjects({immediate:true}));
 }
 await page.evaluate(()=>window.choiceImage.flushChatStore());
 await page.reload();await page.waitForFunction(()=>window.studioReady||window.bootError);
 assert.equal(await page.locator('.studio-choice-overlay').count(),0);
 assert.equal(await page.locator('#promptstudio-image-mount img[alt="refined.png"]').count(),2);
 if(videoEnabled){
  await attachVideo(page);
  assert.equal(await page.locator('#psvstudio-preview img').count(),2);
  assert.equal(await page.locator('#psvstudio-generation-list .psvstudio-generation-card').count(),1);
 }
 assert.deepEqual(fixture.errors,[]);
 console.log('Intermediate choices: real Studio queues, frozen settings, pruning, actions, invalidation and reload passed'+(videoEnabled?' in both studios.':'.'));
}finally{await fixture.close();}
