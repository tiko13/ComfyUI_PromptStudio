import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {videoTestOptions} from './integration-mode.mjs';
import {createFeatureController} from '../web/js/prompt-studio/ui/feature-controller.js';
import {createImageGenerationProgressController} from '../web/js/prompt-studio/ui/generation-progress-controller.js';
import {createImageFocusController} from '../web/js/prompt-studio/ui/focus-controller.js';

const shared = new URL('../web/js/prompt-studio/ui/feature-controller.js', import.meta.url).href;
async function videoModule(name) {
  const source = await readFile(new URL(`../../PromptStudio_Video/web/js/controllers/${name}.js`, import.meta.url), 'utf8');
  return import('data:text/javascript;base64,' + Buffer.from(source.replace(
    '/extensions/ComfyUI_PromptStudio/js/prompt-studio/ui/feature-controller.js', shared,
  )).toString('base64'));
}
function events() {
  const target = new EventTarget();
  return Object.assign(target, {emit(name, detail) {
    const event = new Event(name); Object.defineProperty(event, 'detail', {value:detail}); target.dispatchEvent(event);
  }});
}

test('mount/update/dispose own only their listeners and timers; stale callbacks cannot update', () => {
  const api = events(), first = {}, second = {}, timers = new Map();
  let sequence = 0, mounted = 0, updated = 0, handled = 0, foreign = 0;
  const clock = {setInterval(fn){const id=++sequence;timers.set(id,fn);return id;},clearInterval(id){timers.delete(id);}};
  const foreignId = clock.setInterval(() => foreign++);
  api.addEventListener('tick', () => foreign++);
  const feature = createFeatureController({timers:clock,
    mount(target, scope){mounted++;scope.listen(api,'tick',()=>handled++);scope.interval(()=>handled++,10);},
    update(){updated++;},
  });
  feature.mount(first).mount(first).update();
  assert.equal(mounted,1);assert.equal(updated,3);
  api.emit('tick');assert.equal(handled,1);
  const stale = [...timers.values()].at(-1);
  feature.mount(second);stale();assert.equal(handled,1);
  feature.dispose().dispose();api.emit('tick');
  assert.equal(handled,1);assert.equal(foreign,2);
  assert.deepEqual([...timers.keys()],[foreignId]);
});

test('failed mounting cleans every listener without removing another feature', () => {
  const api=events();let calls=0;
  api.addEventListener('tick',()=>calls++);
  const feature=createFeatureController({mount(target,scope){scope.listen(target,'tick',()=>calls+=100);throw Error('mount failure');}});
  assert.throws(()=>feature.mount(api),/mount failure/);
  api.emit('tick');assert.equal(calls,1);
});

test('Image progress stays bound to originating job when active chat changes', () => {
  const api=events(); const jobs=new Map([['a',{state:'queued'}],['b',{state:'queued'}]]);
  const preparation=new AbortController();const state={activeChatId:'one',studioPreparations:new Map([['prepare-a',preparation]])};
  let projections=0;
  const feature=createImageGenerationProgressController({state,
    studioGenerationRecord:id=>jobs.get(id),setStudioGenerationState:(id,value)=>{jobs.get(id).state=value;},
    updatePlotPromptState(){},updateGenerationProgress(id,progress){projections++;jobs.get(id).progress=progress;},
    executionFailureMessage:()=> 'failure',failTrackedGeneration(){},
  });
  feature.mount(api).mount(api);state.activeChatId='two';feature.update({chatId:'two'});
  api.emit('execution_start',{prompt_id:'a'});api.emit('progress',{prompt_id:'a',value:2,max:10});
  assert.equal(jobs.get('a').state,'generating');assert.equal(jobs.get('b').state,'queued');assert.equal(projections,2);
  feature.dispose();assert.equal(preparation.signal.aborted,false);assert.equal(state.studioPreparations.size,1);
});

test('Video progress and observer ownership do not dispose jobs belonging to another project', videoTestOptions, async () => {
  const {createVideoGenerationProgressController}=await videoModule('generation-progress-controller');
  const api=events(), job=new AbortController();let renders=0,disconnected=0;
  const state={generationProgress:new Map(),generationControllers:new Map([['prepare-a',job]]),panel:{},apiConnected:true};
  class Observer {observe(){} disconnect(){disconnected++;}}
  const feature=createVideoGenerationProgressController({state,MutationObserver:Observer,
    markGenerationExecuting:id=>id==='a',renderGenerations:()=>renders++,failGeneration(){},executionFailureMessage(){},
    setApiConnected(){},renderSystemStatusSummary(){},freezeDisconnectedControls(){},isVideoStudioControl(){},isDisconnectedAllowedControl(){},
  });
  feature.mount(api).mount(api);feature.update({projectId:'other'});
  api.emit('progress',{prompt_id:'a',value:7,max:10});api.emit('progress',{prompt_id:'unknown',value:1,max:10});
  assert.equal(renders,1);assert.equal(state.generationProgress.get('a').value,7);
  assert.equal(state.pendingGenerationProgress.get('unknown').value,1);
  feature.dispose();assert.equal(disconnected,1);assert.equal(job.signal.aborted,false);
  api.emit('progress',{prompt_id:'a',value:8,max:10});assert.equal(renders,1);
});

test('Image focus controller detaches old documents and never double-registers', () => {
  const windowA=events(),windowB=events(),docA={defaultView:windowA},docB={defaultView:windowB};
  let queries=0;
  const state={panel:{hidden:false,ownerDocument:docA,querySelector(){queries++;return null;},querySelectorAll(){return [];}}};
  const feature=createImageFocusController({state,closeSystemStatus(){},openPromptStudioDialog:()=>null,toggleConsult(){},toggleStudioSettings(){}});
  feature.mount(docA).mount(docA);windowA.emit('click');assert.equal(queries,4);
  state.panel.ownerDocument=docB;feature.mount(docB);windowA.emit('click');assert.equal(queries,4);
  windowB.emit('click');assert.equal(queries,8);feature.dispose();windowB.emit('click');assert.equal(queries,8);
});

test('Video editor document teardown removes media handlers, without cancelling pending imports', videoTestOptions, async () => {
  const {createVideoDocumentInteractionController}=await videoModule('document-interaction-controller');
  const docA=events(),docB=events();for(const doc of [docA,docB])doc.body={classList:{add(){},remove(){}}};
  let imported=0,cleared=0;const state={panel:{hidden:false,ownerDocument:docA},mediaDropDepth:new Map()};
  const feature=createVideoDocumentInteractionController({state,isFileDrag:()=>true,clearMediaDrag:()=>cleared++,
    addMediaFiles:()=>imported++,clipboardImageFiles:()=>['synthetic'],closeSystemStatus(){},closeVideoDrawer(){}});
  feature.mount(docA).mount(docA);docA.emit('paste');assert.equal(imported,1);
  state.panel.ownerDocument=docB;feature.mount(docB);docA.emit('paste');docB.emit('paste');assert.equal(imported,2);
  feature.dispose();docB.emit('paste');assert.equal(imported,2);assert.equal(cleared,2);
});
