import assert from 'node:assert/strict';
import {startFixture, attachVideo, config} from './fixture.mjs';

const fixture = await startFixture();
const jobs = new Map();
let outcome = 'failed';
let loseAcknowledgement = false;
let submits = 0;
const document = structuredClone(config.default_document);
document.main_description = 'A courier unfolds a map.';
const generation = {id:'source-generation', status:'complete', kind:'base', document:structuredClone(document),
  workflow_id:'[PSV] Fixture.json', workflow_name:'Fixture', effective_duration:5, frame_count:124,
  workflow_snapshot:{workflow:{nodes:[]},output:{'1':{class_type:'PSV_MiniMaxH3Director',inputs:{fl2va_model:['2',0],video_vae:['3',0],audio_vae:['4',0]}}}},
  outputs:[{filename:'source.mp4',type:'output',subfolder:''}], result_node_ids:['5'],result_fields:['videos'], created_at:1,updated_at:1};
const parent = {id:'parent',name:'Parent video',brief:document.main_description,document:structuredClone(document),
  workflow_id:'',generations:[generation],created_at:1,updated_at:1};
fixture.projects = {revision:1,projects:[structuredClone(parent)],active_project_id:parent.id};
const planDocument = structuredClone(document);
planDocument.main_description = 'The courier speaks and walks forward.';
planDocument.shots[0].steps = [{id:'spoken',type:'dialogue',speaker:'The courier',speaker_id:'S1',language:'English',performance:'speech',text:'We move now.',delivery:'firmly'}];
const result = {valid:true,document:planDocument,compiled_prompt:'The courier (S1) says: <d>[English] We move now.</d>',
  continuation_context:{type:'native_h3_soft_av_extension',context_frames:39,authored_tail_duration:119/24},timing:{delivered_duration:119/24}};
try {
  await fixture.context.route('**/promptstudio-video/continuations/plan**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const reply = data => route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
    if (path.endsWith('/plan')) {
      const data = request.postDataJSON();
      submits++;
      if (!jobs.has(data.job_id)) jobs.set(data.job_id,{status:outcome,request:data});
      else assert.deepEqual(jobs.get(data.job_id).request,data,'Transport retry must retain the exact request');
      if (loseAcknowledgement) {loseAcknowledgement=false; return route.abort('failed');}
      return route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({job_id:data.job_id,status:jobs.get(data.job_id).status})});
    }
    const id = path.split('/').at(path.endsWith('/cancel') ? -2 : -1);
    const job = jobs.get(id);
    if (path.endsWith('/cancel')) {job.status='cancelled'; return reply({job_id:id,status:'cancelled'});}
    if (job.status==='running' && outcome==='complete') job.status='complete';
    return reply({status:job.status,...(job.status==='failed'?{error:'Synthetic planner failure'}:{}),
      ...(job.status==='complete'?{result}:{}),director_progress:{phase:'director_generation'}});
  });
  let page = await fixture.newPage();
  await attachVideo(page);
  await page.getByRole('button',{name:'Continue video',exact:true}).click();
  let dialog = page.getByRole('dialog',{name:'Continue video',exact:true});
  await dialog.locator('textarea').fill('The courier says "We move now." and walks forward.');
  await dialog.getByRole('button',{name:'Build full extension',exact:true}).click();
  await dialog.getByRole('button',{name:'Retry full extension',exact:true}).waitFor();
  assert.match(await dialog.getByRole('status').textContent(),/Synthetic planner failure/);
  assert.equal(fixture.projects.projects.length,1,'Failure must not create a child');
  outcome='running';
  await dialog.getByRole('button',{name:'Retry full extension',exact:true}).click();
  await dialog.getByRole('button',{name:'Cancel planning',exact:true}).click();
  await dialog.getByRole('button',{name:'Retry full extension',exact:true}).waitFor();
  assert.equal(fixture.projects.projects.length,1,'Cancellation must not create a child');
  loseAcknowledgement=true;
  await dialog.getByRole('button',{name:'Retry full extension',exact:true}).click();
  await dialog.getByRole('button',{name:'Retry full extension',exact:true}).waitFor();
  const uniqueBeforeRetry=jobs.size;
  await dialog.getByRole('button',{name:'Retry full extension',exact:true}).click();
  await dialog.getByRole('button',{name:'Cancel planning',exact:true}).waitFor();
  assert.equal(jobs.size,uniqueBeforeRetry,'Lost POST acknowledgement must reuse its job');
  await page.reload();
  await page.waitForFunction(()=>window.studioReady||window.bootError);
  assert.equal(await page.evaluate(()=>window.bootError),undefined);
  await attachVideo(page);
  await page.getByRole('button',{name:'Continue video',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'Continue video',exact:true});
  assert.equal(await dialog.locator('textarea').inputValue(),'The courier says "We move now." and walks forward.');
  outcome='complete';
  await dialog.getByRole('button',{name:'Apply extension plan',exact:true}).waitFor();
  assert.equal(jobs.size,uniqueBeforeRetry,'Reload must reconnect to the existing job');
  assert.equal(fixture.projects.projects.length,1,'A completed plan still needs explicit Apply');
  assert.match(await dialog.locator('pre').textContent(),/<d>\[English\] We move now\.<\/d>/);
  await dialog.getByRole('button',{name:'Apply extension plan',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#psvstudio-save-state').textContent==='Saved');
  assert.equal(fixture.projects.projects.length,2);
  assert.deepEqual(fixture.projects.projects.find(project=>project.id==='parent'),parent,'Planning/applying must preserve the parent');
  const child=fixture.projects.projects.find(project=>project.id!=='parent');
  assert.equal(child.document.shots[0].steps[0].text,'We move now.');
  assert.equal(child.document.references.length,0);
  fixture.projects={...fixture.projects,active_project_id:'parent'};
  await page.reload();
  await page.waitForFunction(()=>window.studioReady||window.bootError);
  await attachVideo(page);
  await page.getByRole('button',{name:'Continue video',exact:true}).click();
  await page.getByRole('button',{name:'Apply extension plan',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#psvstudio-save-state').textContent==='Saved');
  assert.equal(fixture.projects.projects.length,2,'Repeated Apply after reload must reuse the child ID');
  assert.deepEqual(fixture.errors,[]);
  assert.equal(fixture.requests.some(request=>request.path==='/prompt'),false,'Planning never queues generation');
  console.log(JSON.stringify({passed:['planner failure/retry','cancel/retry','lost acknowledgement idempotency','reload resumes job','explicit apply','parent immutable','repeat apply idempotency'],submits,uniqueJobs:jobs.size}));
} finally {await fixture.close();}
