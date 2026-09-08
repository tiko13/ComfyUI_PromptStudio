import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';
import AxeBuilder from '@axe-core/playwright';

const fixture = await startFixture();
let state = {version:1,onboarding:'new',job:null};
const calls = [];
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
  const row=structuredClone(encoder); row.choice=input.choices?.encoder || row.choice;
  row.status=row.choice.startsWith('__download__:')?'download':'available';
  row.download_bytes=row.choice.endsWith(':bf16')?8875719384:row.choice.endsWith(':fp8')?5242467968:0;
  data={version:1,packs:(input.packs||['create','edit','upscale']).map(id=>({id,name:id})),requirements:[row],node_packs:[],
   blockers:[],checks:[{name:'ComfyUI and Prompt Studio nodes',status:'ready'},{name:'Workflow and setup storage',status:'ready'}],
   disks:[],download_bytes:row.download_bytes,licenses:[],state:structuredClone(state)};
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
 const wizard=page.locator('.promptstudio-setup-dialog');
 await wizard.waitFor({state:'visible'});
 await wizard.getByText('Used by Create · Edit · Upscale',{exact:true}).waitFor();
 assert.equal(await wizard.getByLabel(encoder.name).inputValue(),encoder.choice);
 assert.equal(await wizard.getByText('0 B to download',{exact:true}).count(),1);
 const accessibility=await new AxeBuilder({page}).include('.promptstudio-setup-dialog').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
 assert.deepEqual(accessibility.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[]);
 await wizard.getByLabel(encoder.name).selectOption('__download__:bf16');
 await wizard.getByText('8.9 GB to download',{exact:true}).waitFor();
 await wizard.getByLabel(encoder.name).selectOption('__download__:fp8');
 await wizard.getByText('5.2 GB to download',{exact:true}).waitFor();
 for(const width of [1440,390]) {
  await page.setViewportSize({width,height:900});
  const bounds=await wizard.evaluate(dialog=>({scroll:dialog.scrollWidth,client:dialog.clientWidth,left:dialog.getBoundingClientRect().left,right:dialog.getBoundingClientRect().right,viewport:innerWidth}));
  assert.equal(bounds.scroll,bounds.client);assert.ok(bounds.left>=0&&bounds.right<=bounds.viewport);
  if(process.env.SETUP_SCREENSHOT_DIR) await wizard.screenshot({path:`${process.env.SETUP_SCREENSHOT_DIR}/setup-${width}.png`});
 }
 await wizard.getByRole('button',{name:'Set up selected workflows',exact:true}).click();
 await wizard.getByText('Downloading selected encoder',{exact:true}).first().waitFor();
 assert.equal(calls.filter(c=>c.action==='start').length,1);
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
 console.log('Setup browser: automatic opening, encoder reuse/choice, mobile bounds, progress, pause/resume, close and reload recovery passed.');
} finally {await fixture.close();}
