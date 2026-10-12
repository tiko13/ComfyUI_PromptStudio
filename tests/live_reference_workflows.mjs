// Opt-in conversion check against a running ComfyUI. Uses private graphs;
// never queues generation or replaces the user's canvas.
import assert from 'node:assert/strict';
import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
const origin = process.env.COMFYUI_ORIGIN || 'http://127.0.0.1:8188';
const root = resolve(import.meta.dirname, '..');
const browser = await chromium.launch({headless:true, executablePath:process.env.BROWSER_EXECUTABLE});
try {
  const page = await browser.newPage();
  await page.goto(origin, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => globalThis.LiteGraph?.registered_node_types?.PS_ReferenceCollection, null, {timeout:90000});
  const flows = [];
  for (const name of await readdir(resolve(root, 'setup/workflows'))) {
    const flow = JSON.parse(await readFile(resolve(root, 'setup/workflows', name), 'utf8'));
    if (flow.nodes.some(n => n.type.startsWith('PS_')) || name.includes('Krea2 Turbo_Edit')) flows.push({name, flow});
  }
  if (process.env.INCLUDE_INSTALLED) {
    const files = await (await fetch(origin+'/userdata?dir=workflows&recurse=true&full_info=true')).json();
    for (const file of files.filter(f=>f.path.split('/').at(-1).startsWith('[PS]'))) {
      const flow = await (await fetch(origin+'/userdata/'+encodeURIComponent('workflows/'+file.path))).json();
      if (flow.nodes.some(n=>n.type.startsWith('PS_') || n.widgets_values_named?.reference_mode==='grounded_edit')) flows.push({name:'installed/'+file.path, flow});
    }
  }
  await page.waitForFunction(() => globalThis.LiteGraph?.registered_node_types?.TextEncodeQwenImage21 && globalThis.LiteGraph?.registered_node_types?.Note, null, {timeout:90000});
  const results = await page.evaluate(async flows => {
    const {app} = await import('/scripts/app.js');
    const {createWorkflowTemplateBuilder} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/generation/workflow-template.js');
    const {declaredReferenceAdapter} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/generation/workflow-capabilities.js');
    const builder = createWorkflowTemplateBuilder({app,nodeClassName:n=>n.comfyClass||n.type});
    const original = app.graph;
    const results = [];
    for (const {name,flow} of flows) {
      try {
        const profile = await builder.buildWorkflowTemplate({path:name},flow);
        results.push({name,kind:profile.kind,adapter:declaredReferenceAdapter(profile),snapshot:profile.snapshot});
      } catch(error) {results.push({name,error:error.stack,missing:flow.nodes.filter(n=>!globalThis.LiteGraph.registered_node_types[n.type]).map(n=>n.type)});}
    }
    if (app.graph !== original) throw Error('Conversion replaced the canvas');
    return results;
  },flows);
  await mkdir(resolve(root,'test-results/reference-nodes'),{recursive:true});
  await writeFile(resolve(root,'test-results/reference-nodes/converted.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results.map(({name,kind,adapter,error,missing})=>({name,kind,limit:adapter?.limit,error:error?.split('\n')[0],missing})),null,2));
  assert.ok(results.every(r=>!r.error),'All affected workflows must convert');
  for (const result of results.filter(r=>r.adapter?.collectionId)) {
    const nodes = Object.values(result.snapshot.output);
    assert.equal(nodes.filter(n=>n.class_type==='PS_ReferenceItem').length,result.adapter.limit);
    const encoder = nodes.find(n=>n.class_type==='TextEncodeQwenImage21');
    assert.equal(Object.keys(encoder.inputs).filter(k=>k.startsWith('images.image_')).length,result.adapter.limit+(result.kind==='edit'?1:0));
    assert.ok(Array.isArray(encoder.inputs.vae));
  }
} finally {await browser.close();}
