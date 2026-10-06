import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {startFixture, attachVideo, config, root, videoEnabled} from './fixture.mjs';
if (!videoEnabled) process.exit(0);
const fixture = await startFixture();
const saved = id => ({id, status:'complete', workflow_name:'MiniMax H3', effective_duration:5, frame_count:124,
  document:structuredClone(config.default_document), outputs:[{filename:id+'.webm',type:'output'}],
  workflow_snapshot:{workflow:{nodes:[]},output:{'1':{class_type:'Sampler',inputs:{seed:42}}}}, compiled_prompt:'Saved '+id, created_at:1, updated_at:1});
const latest=saved('latest'), older=saved('older'), extension=saved('extension');
older.document.main_description='Earlier draft';
extension.kind='extension';extension.parent_generation_id='older';extension.depth=1;
extension.segment_outputs=[{filename:'segment.webm',type:'output'}];extension.total_effective_duration=10;
fixture.projects={revision:1,active_project_id:'review',projects:[{id:'review',name:'Viewport review',document:structuredClone(config.default_document),
  generations:[latest,older,extension,{...saved('failed'),status:'error',outputs:[],error:'Fixture failure'},
    ...Array.from({length:12},(_,i)=>saved('archive-'+i))],created_at:1,updated_at:1}]};
try {
  await fixture.context.route('**/js/promptstudio_video_studio.js',async route=>{
    const response=await route.fetch();await route.fulfill({response,body:await response.text()+'\nwindow.viewportTest={state,activeProject,renderAll,renderGenerations,renderPreview,persistProjects,markProjectChanged,selectedPreviewMatchesTimeline};'});
  });
  const capturePage=await fixture.context.newPage();
  // An actual encoded video verifies native playback and static frame extraction.
  const encoded=await capturePage.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
    const context=canvas.getContext('2d');
    const paint=()=>{const gradient=context.createLinearGradient(0,0,640,360);gradient.addColorStop(0,'#1d365d');gradient.addColorStop(1,'#8b507f');context.fillStyle=gradient;context.fillRect(0,0,640,360);context.fillStyle='#ecbd87';context.beginPath();context.arc(410,120,55,0,Math.PI*2);context.fill();context.fillStyle='#192737';context.beginPath();context.moveTo(0,360);context.lineTo(190,125);context.lineTo(340,310);context.lineTo(510,210);context.lineTo(640,360);context.fill();};
    paint();const stream=canvas.captureStream(12);const recorder=new MediaRecorder(stream,{mimeType:'video/webm'});const chunks=[];
    recorder.ondataavailable=event=>chunks.push(event.data);
    const done=new Promise(resolve=>recorder.onstop=resolve);recorder.start();
    const timer=setInterval(paint,80);await new Promise(resolve=>setTimeout(resolve,1300));recorder.stop();await done;clearInterval(timer);stream.getTracks().forEach(track=>track.stop());
    const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());return Array.from(bytes);
  });
  await capturePage.close();
  await fixture.context.route('**/view?**',route=>route.fulfill({contentType:'video/webm',body:Buffer.from(encoded)}));
  const page=await fixture.newPage();
  await attachVideo(page);
  const player=page.locator('#psvstudio-preview video'), history=page.locator('#psvstudio-generation-list'), details=page.locator('#psvstudio-player-details');
  const card=id=>history.locator('[data-generation-id="'+id+'"]');
  await page.waitForFunction(()=>document.querySelector('#psvstudio-preview video')?.readyState>=2);
  await history.locator('img').first().waitFor();
  assert.equal(await history.locator('video').count(),0);
  assert.equal(await card('latest').getAttribute('aria-pressed'),'true');
  const original=await page.evaluate(()=>JSON.stringify(viewportTest.activeProject().document));
  await card('older').click();assert.match(await player.getAttribute('src'),/older.webm/);
  assert.equal(await player.getAttribute('data-timeline-preview'),'false');
  assert.equal(await page.evaluate(()=>JSON.stringify(viewportTest.activeProject().document)),original);
  assert.deepEqual(await page.evaluate(()=>{
    const p=viewportTest.activeProject(),g=p.generations.find(item=>item.id==='extension');
    const extensionProject={...p,extension_source:{parent_project_id:'parent',parent_generation_id:'take'}};
    return [viewportTest.selectedPreviewMatchesTimeline(extensionProject,g,'full'),viewportTest.selectedPreviewMatchesTimeline(extensionProject,g,'segment')];
  }),[false,true],'Extension timelines link only to the delivered segment');
  await card('older').press('ArrowDown');await page.keyboard.press('Enter');
  assert.equal(await card('extension').getAttribute('aria-pressed'),'true');
  await details.getByRole('button',{name:'Extension only',exact:true}).click();assert.match(await player.getAttribute('src'),/segment.webm/);
  assert.equal(await details.getByRole('button',{name:'Extension only',exact:true}).evaluate(node=>node===node.ownerDocument.activeElement),true);
  await details.getByRole('button',{name:'Full video',exact:true}).click();assert.match(await player.getAttribute('src'),/extension.webm/);
  await card('failed').click();assert.equal(await player.count(),0);assert.match(await page.locator('#psvstudio-preview').innerText(),/Fixture failure/);
  await card('latest').click();
  await page.waitForFunction(()=>document.querySelector('#psvstudio-preview video')?.readyState>=2);
  await details.getByRole('button',{name:'Loop: Off',exact:true}).click();
  await page.evaluate(async()=>{window.originalPlayer=document.querySelector('#psvstudio-preview video');originalPlayer.muted=true;await originalPlayer.play();viewportTest.renderAll();});
  assert.equal(await player.evaluate(node=>node===window.originalPlayer&&!node.paused&&node.loop),true,'Rerenders preserve the playing media element');
  await page.evaluate(()=>{viewportTest.activeProject().document.main_description='Unsaved edit';viewportTest.renderPreview();});
  assert.equal(await player.getAttribute('data-timeline-preview'),'false','Direct settings refresh detaches a changed editing document');
  assert.equal(await player.evaluate(node=>!node.paused),true,'Detaching the timeline does not interrupt review');
  await page.evaluate(()=>window.__promptstudioVideoStudioHost.setStandaloneVisibility(false));
  assert.equal(await player.evaluate(node=>node.paused),true,'Leaving Video Studio pauses independent review playback');
  await page.evaluate(async()=>{window.__promptstudioVideoStudioHost.setStandaloneVisibility(true);viewportTest.activeProject().document.main_description='';viewportTest.renderAll();await document.querySelector('#psvstudio-preview video').play();});
  await page.evaluate(()=>{const p=viewportTest.activeProject();p.generations.unshift({...structuredClone(p.generations[0]),id:'new-completion',outputs:[{filename:'new.webm'}]});viewportTest.renderAll();});
  assert.match(await player.getAttribute('src'),/latest.webm/);assert.equal(await player.evaluate(node=>node===window.originalPlayer&&!node.paused),true);
  await page.evaluate(()=>document.querySelector('#psvstudio-preview video').pause());
  await history.evaluate(node=>node.scrollTop=100);const scroll=await history.evaluate(node=>node.scrollTop);
  await page.evaluate(()=>viewportTest.renderGenerations());assert.equal(await history.evaluate(node=>node.scrollTop),scroll);
  await page.setViewportSize({width:1920,height:1080});
  const stage=await page.locator('.psvstudio-stage').boundingBox(),rail=await page.locator('.psvstudio-generations').boundingBox();
  assert.ok(rail.x>=stage.x+stage.width,'History is beside the main player');
  assert.equal(await card('latest').evaluate(node=>node.scrollHeight<=node.clientHeight),true,'History cards show all metadata without clipping');
  assert.equal(await history.evaluate(node=>node.scrollHeight>node.clientHeight),true,'Long history scrolls independently');
  await page.screenshot({path:resolve(root,'test-results/browser/video-viewport-desktop.png')});
  await card('older').click();
  await page.evaluate(async()=>{viewportTest.markProjectChanged();await viewportTest.persistProjects({immediate:true});});
  await page.reload();await page.waitForFunction(()=>window.studioReady);await attachVideo(page);
  assert.match(await player.getAttribute('src'),/older.webm/,'Selection survives refresh');
  await page.evaluate(()=>{const p=viewportTest.activeProject();const other={...structuredClone(p),id:'other'};viewportTest.state.projects.push(other);viewportTest.state.activeProjectId=other.id;viewportTest.renderAll();});
  assert.match(await player.getAttribute('src'),/new.webm/);
  await page.evaluate(()=>{viewportTest.state.activeProjectId='review';viewportTest.renderAll();});
  assert.match(await player.getAttribute('src'),/older.webm/,'Selection belongs to its project');
  await page.evaluate(()=>{const p=viewportTest.activeProject();p.generations.unshift({...structuredClone(p.generations[0]),id:'pending',status:'generating',outputs:[]});viewportTest.renderAll();});
  await card('pending').click();assert.equal(await player.count(),0);assert.equal(await details.getByRole('button',{name:'Cancel',exact:true}).count(),1);
  await page.evaluate(()=>{const g=viewportTest.activeProject().generations[0];g.status='complete';g.outputs=[{filename:'finished.webm'}];viewportTest.renderGenerations();});
  assert.match(await player.getAttribute('src'),/finished.webm/,'Selected running result becomes playable on completion');
  await page.setViewportSize({width:390,height:844});
  await page.locator('.psvstudio-workspace').evaluate(node=>node.scrollTop=0);
  const narrowStage=await page.locator('.psvstudio-stage').boundingBox(),narrowRail=await page.locator('.psvstudio-generations').boundingBox();
  assert.ok(narrowRail.y>=narrowStage.y+narrowStage.height-1,'Stacked history does not cover player actions');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:resolve(root,'test-results/browser/video-viewport-narrow.png')});
  assert.deepEqual(fixture.errors,[]);
  console.log('Video viewport: native playback, static thumbnails, selection, completion, keyboard, persistence, project isolation, desktop and narrow layout passed.');
} finally {await fixture.close();}
