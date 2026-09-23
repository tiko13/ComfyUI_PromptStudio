import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';
import AxeBuilder from '@axe-core/playwright';
import {readFileSync, mkdirSync} from 'node:fs';
import {resolve} from 'node:path';

const catalog = JSON.parse(readFileSync(new URL('../../setup/catalog.json', import.meta.url)));
const assets = JSON.parse(readFileSync(new URL('../../setup/assets.json', import.meta.url)));

const fixture = await startFixture();
let state = {version:1,onboarding:'new',job:null};
const calls = [];
let nextPlanGate;
const encoder = {id:'encoder', name:'Qwen3-VL 4B text and vision encoder', description:'Either BF16 or FP8 works across all selected workflows.',
 used_by:['Create','Edit','Upscale'],status:'available',choice:'shared/qwen3vl_4b_fp8_scaled.safetensors',download_bytes:0,
 candidates:[{name:'shared/qwen3vl_4b_fp8_scaled.safetensors',evidence:'Expected model name and size; checksum will be verified during setup'}],rejected:[],
 download_options:[{id:'bf16',name:'Qwen3-VL 4B BF16',size:8875719384},{id:'fp8',name:'Qwen3-VL 4B FP8',size:5242467968}],
 source:'https://huggingface.co/example/model',destination:'models/text_encoders/qwen.safetensors'};
await fixture.context.route('**/promptstudio/setup/*', async route => {
 const action = new URL(route.request().url()).pathname.split('/').at(-1);
 const input = route.request().postDataJSON() || {};
 calls.push({action,input});
 let data;
 if(action === 'plan') {
  const gate = nextPlanGate; nextPlanGate = null;
  if (gate) await gate;
  const packs=catalog.packs.filter(p=>(input.packs||['create','edit','upscale']).includes(p.id));
  const requirements=catalog.requirements.filter(r=>packs.some(p=>p.requirements.includes(r.id))).map(req=>{
   const asset=assets.find(a=>a.id===req.default_asset);
   const row=req.id==='encoder'?structuredClone(encoder):{...req,status:'available',choice:asset.relative_path,
    candidates:[{name:asset.relative_path,evidence:'Verified fixture asset'}],rejected:[],download_options:[asset,...(req.alternatives||[]).map(id=>assets.find(a=>a.id===id))],source:asset.url,destination:asset.relative_path};
   row.used_by=packs.filter(p=>p.requirements.includes(req.id)).map(p=>p.name);
   row.choice=input.choices?.[req.id]||row.choice;
   row.status=row.choice.startsWith('__download__:')?'download':'available';
   row.download_bytes=row.status==='download'?row.download_options.find(a=>row.choice==='__download__:'+a.id).size:0;
   return row;
  });
  data={version:1,packs,available_packs:catalog.packs,requirements,node_packs:[],
   blockers:packs.length?[]:['Select at least one workflow'],checks:[{name:'ComfyUI and Prompt Studio nodes',status:'ready'},{name:'Workflow and setup storage',status:'ready'}],
   disks:[],download_bytes:requirements.reduce((sum,row)=>sum+row.download_bytes,0),licenses:catalog.licenses,state:structuredClone(state)};
 } else if(action === 'dismiss') {state.onboarding='deferred';data=state;}
 else if(action === 'start') {
  state.job={id:'setup-job',status:'running',phase:'Downloading',item:'Qwen3-VL 4B encoder',bytes:1000000000,total:5242467968,
   speed:50000000,eta:85,elapsed:20,downloaded:1000000000,download_total:5242467968,
   started_at:Date.now()/1000,message:'Downloading selected encoder',events:[{time:Date.now()/1000,message:'Downloading selected encoder'}],request:input,workflows:[]};data=state;
 } else if(action==='pause'){state.job.status='paused';state.job.phase='Paused';data=state;}
 else if(action==='resume'){state.job.status='running';state.job.phase='Downloading';data=state;}
 else if(action==='cancel'){state.job.status='cancelled';data=state;}
 else data=state;
 await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
});
try {
 const page=await fixture.newPage();
 const wizard=page.locator('.promptstudio-setup-dialog:not(.promptstudio-setup-license)');
 await wizard.waitFor({state:'visible'});
 await wizard.getByRole('checkbox',{name:'Create',exact:true}).waitFor();
 const waitForModels = () => wizard.locator('[data-setup-content]').evaluate(async el=>{while(el.getAttribute('aria-busy')==='true') await new Promise(requestAnimationFrame);});
 const modelIds = () => wizard.locator('[data-setup-model]').evaluateAll(nodes=>nodes.map(node=>node.dataset.setupModel).sort());
 assert.equal(await wizard.getByRole('checkbox').count(),18);
 assert.equal(await wizard.getByRole('checkbox',{checked:true}).count(),3);
 assert.deepEqual(await modelIds(),['encoder','identity_edit','krea2','textfusion','upscaler','vae']);
 await wizard.getByRole('checkbox',{name:'Edit',exact:true}).uncheck(); await waitForModels();
 assert.deepEqual(await modelIds(),['encoder','krea2','textfusion','upscaler','vae']);
 await wizard.getByRole('checkbox',{name:'Upscale',exact:true}).uncheck(); await waitForModels();
 assert.deepEqual(await modelIds(),['encoder','krea2','textfusion','vae']);
 for(const name of ['Edit','Upscale']) { await wizard.getByRole('checkbox',{name,exact:true}).check(); await waitForModels(); }
 assert.equal(await wizard.getByLabel(encoder.name).inputValue(),encoder.choice);
 assert.equal(await wizard.getByText('0 B to download',{exact:true}).count(),1);
 const accessibility=await new AxeBuilder({page}).include('.promptstudio-setup-dialog').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
 assert.deepEqual(accessibility.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);
 for(const name of ['Create','Edit','Upscale']) {
  await wizard.getByRole('checkbox',{name,exact:true}).uncheck();
  await wizard.locator('[data-setup-content]').evaluate(async el=>{while(el.getAttribute('aria-busy')==='true') await new Promise(requestAnimationFrame);});
 }
 assert.equal(await wizard.getByRole('button',{name:'Set up selected workflows',exact:true}).isDisabled(),true);
 assert.equal(await wizard.locator('.promptstudio-setup-requirement').count(),0);
 await wizard.getByText('Select a workflow to see its required models.',{exact:true}).waitFor();
 for(const name of ['Create','Edit','Upscale']) {
  await wizard.getByRole('checkbox',{name,exact:true}).check();
  await wizard.locator('[data-setup-content]').evaluate(async el=>{while(el.getAttribute('aria-busy')==='true') await new Promise(requestAnimationFrame);});
 }
 const qwenName='Qwen 2.1 Create · 25 steps';
 const qwen=wizard.getByRole('checkbox',{name:qwenName,exact:true});
 const popup=page.locator('.promptstudio-setup-license');
 const before=calls.filter(c=>c.action==='plan').length;
 await qwen.click(); await popup.waitFor({state:'visible'});
 assert.equal(await qwen.isChecked(),false);
 assert.match(await popup.textContent(),/research or evaluation only/);
 assert.equal(await popup.getByRole('button',{name:'Cancel',exact:true}).evaluate(el=>el===document.activeElement),true);
 const licenseAccessibility=await new AxeBuilder({page}).include('.promptstudio-setup-license').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
 assert.deepEqual(licenseAccessibility.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);
 await popup.getByRole('button',{name:'Cancel',exact:true}).click();
 await popup.waitFor({state:'detached'}); assert.equal(await qwen.isChecked(),false);
 assert.equal(calls.filter(c=>c.action==='plan').length,before);
 await qwen.click(); await popup.waitFor({state:'visible'}); await page.keyboard.press('Escape');
 await popup.waitFor({state:'detached'}); assert.equal(await qwen.isChecked(),false);
 assert.equal(await qwen.evaluate(el=>el===document.activeElement),true);
 await qwen.click(); await popup.waitFor({state:'visible'}); await page.mouse.click(1,1);
 await popup.waitFor({state:'detached'}); assert.equal(await qwen.isChecked(),false);
 await qwen.click(); await popup.getByRole('button',{name:'Accept',exact:true}).click();
 await wizard.getByLabel('Qwen Image 2.1 diffusion model',{exact:true}).waitFor();
 assert.equal(await qwen.isChecked(),true);
 assert.equal(calls.filter(c=>c.action==='plan').at(-1).input.license_acceptances.qwen21_create_base25,'qwen-research-2026-09-20');
 // Removing and reselecting a workflow requires a new acceptance.
 await qwen.uncheck(); await wizard.getByLabel('Qwen Image 2.1 diffusion model',{exact:true}).waitFor({state:'detached'});
 await qwen.click(); await popup.waitFor({state:'visible'}); assert.equal(await qwen.isChecked(),false);
 await popup.getByRole('button',{name:'Accept',exact:true}).click();
 await wizard.getByLabel('Qwen Image 2.1 diffusion model',{exact:true}).waitFor();
 await wizard.getByRole('checkbox',{name:'Qwen 2.1 Edit · Turbo 4 steps',exact:true}).click();
 await popup.waitFor({state:'visible'}); await popup.getByRole('button',{name:'Accept',exact:true}).click();
 await wizard.getByLabel('Qwen 2.1 Turbo 4-step LoRA',{exact:true}).waitFor();
 // Keep only Qwen: the last Krea selection removes all Krea models immediately,
 // even while the server's next model scan is held open.
 for(const name of ['Edit','Upscale']) { await wizard.getByRole('checkbox',{name,exact:true}).uncheck(); await waitForModels(); }
 let releasePlan;
 nextPlanGate = new Promise(resolve => { releasePlan = resolve; });
 await wizard.getByRole('checkbox',{name:'Create',exact:true}).uncheck();
 assert.deepEqual(await modelIds(),['qwen21','qwen21_encoder','qwen21_turbo','qwen21_vae']);
 await wizard.getByText('Updating models for selected workflows…',{exact:true}).waitFor();
 assert.equal(await wizard.getByRole('button',{name:'Set up selected workflows',exact:true}).isDisabled(),true);
 releasePlan(); await waitForModels();
 assert.deepEqual(await modelIds(),['qwen21','qwen21_encoder','qwen21_turbo','qwen21_vae']);
 await wizard.getByRole('checkbox',{name:'Qwen 2.1 Edit · Turbo 4 steps',exact:true}).uncheck(); await waitForModels();
 assert.deepEqual(await modelIds(),['qwen21','qwen21_encoder','qwen21_vae']);
 await wizard.getByRole('checkbox',{name:'Qwen 2.1 Edit · Turbo 4 steps',exact:true}).click();
 await popup.getByRole('button',{name:'Accept',exact:true}).click(); await waitForModels();
 for(const name of ['Create','Edit','Upscale']) { await wizard.getByRole('checkbox',{name,exact:true}).check(); await waitForModels(); }
 await wizard.getByLabel(encoder.name).selectOption('__download__:bf16');
 await wizard.getByText('8.9 GB to download',{exact:true}).waitFor();
 await wizard.getByLabel(encoder.name).selectOption('__download__:fp8');
 await wizard.getByText('5.2 GB to download',{exact:true}).waitFor();
 for(const width of [1440,390]) {
  await page.setViewportSize({width,height:900});
  const bounds=await wizard.evaluate(dialog=>({scroll:dialog.scrollWidth,client:dialog.clientWidth,left:dialog.getBoundingClientRect().left,right:dialog.getBoundingClientRect().right,viewport:innerWidth}));
  assert.equal(bounds.scroll,bounds.client);assert.ok(bounds.left>=0&&bounds.right<=bounds.viewport);
  assert.equal(await wizard.locator('.promptstudio-setup-packs label').evaluateAll(labels=>labels.every(label=>{
   const outer=label.getBoundingClientRect(),text=label.querySelector('span').getBoundingClientRect();
   return text.right<=outer.right&&text.left>=outer.left&&label.querySelector('input').getBoundingClientRect().width<=20;
  })),true,'Workflow labels and checkboxes must fit inside their cards');
  const output=process.env.SETUP_SCREENSHOT_DIR||resolve('test-results/browser'); mkdirSync(output,{recursive:true});
  await wizard.screenshot({path:resolve(output,`setup-${width}.png`)});
  await wizard.getByRole('checkbox',{name:'Qwen 2.1 RGBA · 25 steps',exact:true}).click();
  await popup.waitFor({state:'visible'});
  assert.ok(await popup.evaluate(el=>el.scrollWidth<=el.clientWidth&&el.getBoundingClientRect().right<=innerWidth));
  await popup.screenshot({path:resolve(output,`setup-license-${width}.png`)});
  await popup.getByRole('button',{name:'Cancel',exact:true}).click(); await popup.waitFor({state:'detached'});
 }
 await wizard.getByRole('button',{name:'Set up selected workflows',exact:true}).click();
 await wizard.getByText('Downloading selected encoder',{exact:true}).first().waitFor();
 assert.equal(calls.filter(c=>c.action==='start').length,1);
 assert.deepEqual(Object.keys(calls.find(c=>c.action==='start').input.license_acceptances).sort(),['qwen21_create_base25','qwen21_edit_turbo4']);
 assert.match(await wizard.locator('[data-metric="metrics"]').textContent(),/50.0 MB\/s/);
 assert.equal(await wizard.getByRole('progressbar',{name:'Current operation'}).count(),1);
 await wizard.getByRole('button',{name:'Pause',exact:true}).click();
 await wizard.getByRole('button',{name:'Resume setup',exact:true}).waitFor();
 await wizard.getByRole('button',{name:'Resume setup',exact:true}).click();
 await wizard.getByRole('button',{name:'Pause',exact:true}).waitFor();
 await wizard.getByRole('button',{name:'Close',exact:true}).first().click();
 await page.locator('#promptstudio-setup-activity').waitFor({state:'visible'});
 assert.equal(state.job.status,'running');
 await page.locator('#promptstudio-setup-activity').click();
 await wizard.waitFor({state:'visible'});
 assert.equal(calls.filter(c=>c.action==='start').length,1);
 await page.reload();await page.waitForFunction(()=>window.studioReady);
 assert.equal(await page.locator('.promptstudio-setup-dialog[open]').count(),0);
 await page.locator('#promptstudio-setup-activity').waitFor({state:'visible'});
 await page.locator('#promptstudio-setup-activity').click();
 await page.locator('.promptstudio-setup-dialog[open]').waitFor();
 assert.equal(calls.filter(c=>c.action==='start').length,1);
 assert.deepEqual(fixture.errors,[]);
 state={version:1,onboarding:'new',job:null};
 const videoPage=await fixture.context.newPage();
 await videoPage.goto(fixture.origin+'/?mode=video');
 await videoPage.waitForFunction(()=>window.studioReady);
 assert.equal(await videoPage.locator('.promptstudio-setup-dialog[open]').count(),0,'Image onboarding must not open for initial Video mode');
 await videoPage.evaluate(()=>{document.body.dataset.studioMode='image';window.__promptstudioPromptStudioHost.setStandaloneVisibility(true);});
 await videoPage.locator('.promptstudio-setup-dialog[open]').waitFor();
 await videoPage.close();
 console.log('Setup browser: 18 workflow choices, empty selection, license accept/cancel/Escape/dismiss/reselect, model choices, accessibility, desktop/mobile layout, progress and recovery passed.');
} finally {await fixture.close();}
