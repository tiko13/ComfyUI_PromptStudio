import assert from 'node:assert/strict';
import {startFixture, attachVideo, videoEnabled} from './fixture.mjs';
if (!videoEnabled) process.exit(0);
const fixture = await startFixture();
try {
  await fixture.context.route('**/js/promptstudio_video_studio.js',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:await response.text()+'\nwindow.adapterTest={state,activeProject,persistProjects,renderAll,localResolvedMode,generateProject,queueSnapshot};'});
  });
  await fixture.context.route('**/scripts/api.js',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:await response.text()+'\napi.queuePrompt=async(_,snapshot)=>{(window.adapterQueued ||= []).push(structuredClone(snapshot));return {prompt_id:"adapter-test-"+window.adapterQueued.length};};'});
  });
  const catalog={adapters:[
    {name:'MiniMax3/style.safetensors',category:'loras',kind:'lora',modalities:[],tokens:0},
    {name:'MiniMax3/hero.safetensors',category:'refmods',kind:'refmod',modalities:['image'],tokens:256},
    {name:'MiniMax3/actor.safetensors',category:'loras',kind:'reflora',modalities:['image','audio'],tokens:400},
    {name:'Image/wrong-style.safetensors',category:'loras',kind:'lora',modalities:[],tokens:0},
    {name:'Image/wrong-reference.safetensors',category:'refmods',kind:'refmod',modalities:['image'],tokens:4},
  ],errors:[]};
  await fixture.context.route('**/promptstudio-video/adapters',route=>route.fulfill({json:catalog}));
  const page=await fixture.newPage(); await attachVideo(page);
  await page.locator('#psvstudio-new-project').click();
  const panel=page.locator('.psvstudio-adapters');
  const loras=panel.getByRole('combobox',{name:'Add LoRAs',exact:true});
  await loras.fill('wrong');
  assert.equal(await panel.getByRole('option').count(),0);
  await loras.fill('style'); await loras.press('ArrowDown'); await loras.press('Enter');
  await panel.getByRole('spinbutton',{name:'MiniMax3/style.safetensors LoRA strength'}).fill('0.65');
  await panel.getByRole('spinbutton',{name:'MiniMax3/style.safetensors LoRA strength'}).press('Tab');
  const refs=panel.getByRole('combobox',{name:'Add RefMods / RefLoRAs',exact:true});
  await refs.fill('wrong');
  assert.equal(await panel.getByRole('option').count(),0);
  await refs.fill('hero'); await refs.press('Escape');
  assert.equal(await page.evaluate(()=>window.adapterTest.activeProject().document.reference_adapters?.length||0),0);
  await refs.fill('actor'); await panel.getByRole('option',{name:/actor/}).click();
  assert.equal(await page.evaluate(()=>window.adapterTest.localResolvedMode(window.adapterTest.activeProject().document)),'ref2va');
  await panel.getByRole('spinbutton',{name:'MiniMax3/actor.safetensors LoRA strength'}).fill('0.35');
  await panel.getByRole('spinbutton',{name:'MiniMax3/actor.safetensors LoRA strength'}).press('Tab');
  await page.evaluate(()=>window.adapterTest.persistProjects({immediate:true}));
  await page.reload(); await page.waitForFunction(()=>window.studioReady); await attachVideo(page);
  assert.equal(await panel.getByRole('spinbutton',{name:'MiniMax3/style.safetensors LoRA strength'}).inputValue(),'0.65');
  assert.equal(await panel.getByRole('spinbutton',{name:'MiniMax3/actor.safetensors LoRA strength'}).inputValue(),'0.35');
  assert.equal(await panel.locator('.promptstudio-lora-row').first().evaluate(node => getComputedStyle(node).display), 'grid');
  assert.equal(await panel.getByRole('spinbutton',{name:'MiniMax3/style.safetensors LoRA strength'}).evaluate(node => getComputedStyle(node).borderRadius), '7px');
  if (process.env.ADAPTER_SCREENSHOT) await panel.screenshot({path:process.env.ADAPTER_SCREENSHOT});
  await page.setViewportSize({width:390,height:844});
  await page.locator('#psvstudio-mobile-inspector').click();
  await refs.fill('hero'); await refs.press('ArrowDown'); await refs.press('Enter');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await panel.getByRole('button',{name:'Remove MiniMax3/hero.safetensors'}).click();
  assert.equal(await page.evaluate(()=>window.adapterTest.activeProject().document.reference_adapters.length),1);
  // Exercise the actual asynchronous queue path: edits during preparation must
  // not replace the frozen adapter choices or disappear from the project.
  let releaseCompile, sawCompile;
  const compileStarted=new Promise(resolve=>sawCompile=resolve);
  const compileGate=new Promise(resolve=>releaseCompile=resolve);
  await fixture.context.route('**/promptstudio-video/document/compile',async route=>{
    const document=route.request().postDataJSON().document;
    sawCompile(); await compileGate;
    await route.fulfill({json:{document,compiled_prompt:'A scene.',resolved_mode:'ref2va',frame_count:124,effective_duration:124/24}});
  });
  await page.evaluate(()=>{
    const t=window.adapterTest,p=t.activeProject();
    const workflow={id:'adapters',name:'[PSV] Adapters',director_node_id:'10',result_node_ids:['12'],result_fields:['videos'],
      snapshot:{workflow:{nodes:[],links:[]},output:{
        '10':{class_type:'PSV_MiniMaxH3Director',inputs:{ref2va_model:['9',0]}},
        '11':{class_type:'BasicGuider',inputs:{model:['10',0],conditioning:['10',1]}},
        '12':{class_type:'SaveVideo',inputs:{video:['11',0]}}}}};
    t.state.workflows=[workflow]; p.workflow_id=workflow.id; t.state.apiConnected=true;
    window.adapterGeneration=t.generateProject();
  });
  await compileStarted;
  await page.evaluate(()=>{window.adapterTest.activeProject().document.content_loras[0].strength=.99;});
  releaseCompile();
  await page.evaluate(()=>window.adapterGeneration);
  const queued=await page.evaluate(()=>({snap:window.adapterQueued?.[0],project:window.adapterTest.activeProject()}));
  assert.ok(queued.snap,JSON.stringify(queued.project.generations));
  const lora=Object.values(queued.snap.output).find(n=>n.class_type==='KCPP_PromptStudioLoraLoader');
  assert.equal(JSON.parse(lora.inputs.lora_stack_json)[0].strength,.65);
  assert.equal(lora.inputs.lora_type,'MiniMax3');
  assert.equal(queued.project.document.content_loras[0].strength,.99);
  await page.evaluate(async()=>{
    const t=window.adapterTest,p=t.activeProject(),saved=p.generations[0];
    p.document.reference_adapters[0].lora_strength=1.5;
    const replay={...structuredClone(saved),id:'adapter-replay',preparation_kind:'replay',status:'validating'};
    p.generations.unshift(replay);
    await t.queueSnapshot(p,t.state.workflows[0],structuredClone(saved.workflow_snapshot),saved,replay);
  });
  const replayed=await page.evaluate(()=>window.adapterQueued[1]);
  assert.equal(Object.values(replayed.output).filter(n=>n.class_type==='PSV_MiniMaxH3ReferenceAdapters').length,1);
  const ref=Object.values(replayed.output).find(n=>n.class_type==='PSV_MiniMaxH3ReferenceAdapters');
  assert.equal(JSON.parse(ref.inputs.reference_stack_json)[0].lora_strength,.35);
  assert.equal(ref.inputs.adapter_type,'MiniMax3');
  assert.deepEqual(fixture.errors,[]);
  console.log('Video adapter keyboard/mouse selection, strengths, persistence, narrow layout, frozen queue preparation and exact replay passed.');
} finally { await fixture.close(); }
