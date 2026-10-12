import assert from "node:assert/strict";
import { test } from "node:test";
import { applyImageOutputSettings, syncImageOutputWorkflow, normalizeImageOutputSettings, IMAGE_OUTPUT_DEFAULTS } from "../web/js/prompt-studio/settings/image-output.js";

const saver = inputs => ({class_type:"Save_as_webp_cond", inputs:{images:["decoder",0],filename_prefix:"nested/frame",save:"yes",mode:"lossy",compression:80,...inputs}});
test("output preferences update only unforced savers and their embedded workflow", () => {
  const forced = saver({format:"png",force:true,mode:"lossless",png_compression:9});
  const snapshot = {workflow:{nodes:[{id:1,type:"Save_as_webp_cond",widgets_values:["nested/frame","lossy",80,"yes"]}]},
    output:{"1":saver(), "2":structuredClone(forced), "3":{class_type:"SaveImage",inputs:{filename_prefix:"ordinary"}}}};
  applyImageOutputSettings(snapshot,{format:"png",png_compression:0,png_optimize:true});
  assert.equal(snapshot.output["1"].inputs.format,"png");
  assert.equal(snapshot.output["1"].inputs.png_compression,0);
  assert.equal(snapshot.output["1"].inputs.png_optimize,true);
  assert.equal(snapshot.workflow.nodes[0].widgets_values[4],"png");
  assert.equal(snapshot.workflow.nodes[0].widgets_values[8],false);
  assert.deepEqual(snapshot.output["2"],forced);
  assert.deepEqual(snapshot.output["3"].inputs,{filename_prefix:"ordinary"});
  assert.deepEqual(snapshot.output["1"].inputs.images,["decoder",0]);
  assert.equal(snapshot.output["1"].inputs.filename_prefix,"nested/frame");
});
test("lossless effort is separate from lossy quality; defaults stay WebP", () => {
  const snapshot = {output:{save:saver()}};
  applyImageOutputSettings(snapshot,{});
  assert.equal(snapshot.output.save.inputs.format,"webp");
  applyImageOutputSettings(snapshot,{mode:"lossless",quality:33,lossless_effort:91,webp_method:0});
  assert.equal(snapshot.output.save.inputs.compression,91);
  assert.equal(snapshot.output.save.inputs.webp_method,0);
  assert.deepEqual(normalizeImageOutputSettings(null),IMAGE_OUTPUT_DEFAULTS);
  assert.equal(normalizeImageOutputSettings({png_compression:0}).png_compression,0);
});
test("nested saver metadata reflects later lossless mask protection", () => {
  const snapshot={workflow:{nodes:[{id:7,type:"sub"}],definitions:{subgraphs:[{id:"sub",nodes:[{id:2,type:"Save_as_webp_cond",widgets_values:["nested/frame","lossy",80,"yes"],widgets_values_named:{}}]}]}},output:{"7:2":saver()}};
  applyImageOutputSettings(snapshot,{quality:72});
  snapshot.output["7:2"].inputs.mode="lossless";
  syncImageOutputWorkflow(snapshot);
  assert.equal(snapshot.workflow.definitions.subgraphs[0].nodes[0].widgets_values[1],"lossless");
  assert.equal(snapshot.workflow.definitions.subgraphs[0].nodes[0].widgets_values_named.compression,72);
});
test("dynamic node controls are retained", () => {
  for(const inputs of [{force:["switch",0]},{format:["format",0]}]) {
    const snapshot={output:{save:saver(inputs)}}, before=structuredClone(snapshot);
    applyImageOutputSettings(snapshot,{format:"png"});
    assert.deepEqual(snapshot,before);
  }
});
