import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';
const fixture=await startFixture();
try {
 await fixture.context.route('**/extensions/ComfyUI_PromptStudio/js/prompt_studio.js',async route=>{
  const response=await route.fetch();await route.fulfill({response,body:(await response.text())+'\nwindow.judgingActions={requestPromptAgentPhase,renderConsultAgentCard};'});
 });
 const requests=[];
 const evaluation={score:80,confidence:.85,pass:false,criteria:[{id:'face',status:'partial',score:80,evidence:'Candidate cheek visible',reference_evidence:'Reference cheek differs'}],defects:[],forbidden:[],summary:'Reference mismatch',reference_comparison:{attached_pixels:true},metrics:{version:1,model_calls:2,elapsed_ms:1234,reference_comparison:true,calibration_measured:false}};
 await fixture.context.route('**/promptstudio/prompt-studio/agent',async route=>{requests.push(route.request().postDataJSON());await route.fulfill({json:{evaluation,metrics:evaluation.metrics}});});
 const page=await fixture.newPage();
 assert.equal(await page.locator('#promptstudio-agent-reference-comparison').isChecked(),false,'Reference comparison costs no extra calls by default');
 await page.locator('#promptstudio-toggle-consult').click();
 await page.locator('#promptstudio-consult-toggle-attachments').click();
 await page.locator('#promptstudio-agent-reference-comparison').check();
 await page.evaluate(async()=>{
  const {state}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js');
  const {normalizeConsultAgent}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/consult/model.js');
  const chat=state.chats.find(item=>item.id===state.activeChatId);
  chat.consultAgent=normalizeConsultAgent({id:'judge-fixture',goal:'Match face shape',referenceComparison:document.querySelector('#promptstudio-agent-reference-comparison').checked,references:[{image:{filename:'ref.png',type:'input',subfolder:''},purpose:'face identity'}],rubric:{summary:'Identity',criteria:[{id:'face',description:'Matching face',weight:1,hard:true}],forbidden:[]},iterations:[]});
  const result=await window.judgingActions.requestPromptAgentPhase('evaluate',chat.consultAgent,{generated_images:[{filename:'candidate.png',type:'output',subfolder:''}]},{connectionPayload:{llm_provider:'koboldcpp',kobold_url:'http://localhost:5001'},generationSettings:{thinking_mode:'Disabled'}},new AbortController().signal);
  chat.consultAgent.iterations=[{id:'candidate-1',index:1,status:'complete',evaluation:(await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/consult/model.js')).normalizePromptAgentEvaluation(result.evaluation),generation:null,candidate:null}];
  const container=document.createElement('div');container.id='judge-card-fixture';document.body.append(container);
  window.judgingActions.renderConsultAgentCard(container,chat.consultAgent);
 });
 assert.equal(requests.length,1);assert.equal(requests[0].reference_comparison,true);assert.equal(requests[0].references[0].image.filename,'ref.png');
 const text=await page.locator('#judge-card-fixture').innerText();
 assert.match(text,/2 completed model calls/);assert.match(text,/1.2s model phases/);assert.match(text,/required checks have not all passed/);
 await page.locator('#judge-card-fixture .promptstudio-agent-verdict summary').click();
 assert.match(await page.locator('#judge-card-fixture').innerText(),/Reference cheek differs/);
 assert.deepEqual(fixture.errors,[]);
 console.log('Prompt Agent browser option, actual phase payload, cost metrics, winner explanation and reference evidence passed with a controlled response; no image generation.');
} finally {await fixture.close();}
