import assert from "node:assert/strict";
import {test} from "node:test";
import {referenceDetection} from "../web/js/prompt-studio/generation/reference-detection.js";
import {normalizeQwenReferences} from "../web/js/prompt-studio/generation/qwen-references.js";

test("optional detector falls back on missing endpoint or malformed response", async () => {
  for (const fetchApi of [async()=>({ok:false}), async()=>{throw Error("offline");}, async()=>({ok:true,json:async()=>{throw Error("invalid");}})]) {
    assert.equal((await referenceDetection(fetchApi,"triage",{})).decision,"deep");
  }
});
test("user cancellation does not trigger a deeper request", async () => {
  const controller=new AbortController(); controller.abort();
  await assert.rejects(referenceDetection(async(_,options)=>{if(options.signal.aborted) throw Error("cancelled");},"triage",{},controller.signal), /cancelled/);
});
test("deep override survives reference normalization", () => {
  const [entry]=normalizeQwenReferences([{image:{filename:"ref.png",type:"input"},role:"pose",analysis:"deep"}]);
  assert.equal(entry.analysis,"deep");
});
