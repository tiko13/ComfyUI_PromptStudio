// Read-only native conversion check. Does not queue generation or change the canvas.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mossCatalog,mossWorkflow} from './moss-fixture.mjs';
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage();await page.goto(process.env.COMFYUI_ORIGIN||'http://127.0.0.1:8188',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>globalThis.LiteGraph?.registered_node_types?.MOSSImageControl&&globalThis.LiteGraph?.registered_node_types?.PromptStudioInput,null,{timeout:90000});
 const results=await page.evaluate(async ({flows,installed})=>{
  const {app}=await import('/scripts/app.js');
  const {createWorkflowTemplateBuilder}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/generation/workflow-template.js');
  const {namedStructureInputs}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/generation/workflow-capabilities.js');
  const {layoutBinding,spatialValue,applySpatialInputs}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/generation/spatial-inputs.js');
  const {validateMossRecipe}=await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/generation/moss-recipe.js');
  const original=app.graph,results=[];
  for(const {pack,flow} of flows){try{
   const source=installed&&pack.id==='moss_sft_dmd8_choice'
    ? await (await fetch('/userdata/'+encodeURIComponent('workflows/'+pack.file))).json() : flow;
   const p=await createWorkflowTemplateBuilder({app,nodeClassName:n=>n.comfyClass||n.type}).buildWorkflowTemplate({path:pack.file},source);
   const slots=namedStructureInputs(p),binding=layoutBinding(p),value=spatialValue({},p);value.elements=[{id:'test',type:'character',x:.1,y:.2,width:.3,height:.4,description:'person'}];
   applySpatialInputs(p.snapshot,p,value);
   if(pack.id==='moss_sft_dmd8_choice')validateMossRecipe(p.snapshot,p);
   results.push({id:pack.id,outputs:p.resultNodeIds.length,controls:p.additionalInputs.length,slots:slots.map(s=>s.key),binding,
    characters:p.snapshot.output[binding.id].inputs.character_boxes,invalid:p.additionalInputs.filter(i=>Array.isArray(i.defaultValue)),
    boxes:p.snapshot.output[binding.boxesId].inputs,
    model:Object.values(p.snapshot.output).find(n=>n.class_type==='LoraLoaderModelOnly').inputs});
  }catch(e){results.push({id:pack.id,error:e.stack});}}
  if(app.graph!==original)throw Error('Canvas was replaced');return results;
 },{flows:mossCatalog.map(pack=>({pack,flow:mossWorkflow(pack)})),installed:process.env.STUDIO_TEST_MOSS_INSTALLED==='1'});
 console.log(JSON.stringify(results,null,2));
 for(const result of results){assert.equal(result.error,undefined);assert.equal(result.outputs,1);assert.equal(result.characters,'1');assert.deepEqual(result.invalid,[]);assert.equal(result.controls,(result.id==='moss_sft_dmd8_choice')?1:result.id.endsWith('controlled')?5:2);}
 assert.deepEqual(results.find(r=>r.id==='moss_sft_controlled').slots,['color','depth']);
 for(const result of results){assert.deepEqual(result.boxes.editor_state,{__value__:[]});assert.deepEqual(result.boxes.last_incoming,{__value__:[]});}
}finally{await browser.close();}
