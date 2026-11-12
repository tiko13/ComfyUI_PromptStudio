import test from "node:test";
import assert from "node:assert/strict";
import { assignSemanticReference, persistentReferences, requestSemanticReference } from "../web/js/prompt-studio/generation/semantic-reference.js";
import { normalizeReferenceClarification, referenceContextMatches } from "../web/js/prompt-studio/generation/reference-grounding.js";
import { normalizeReferenceState } from "../web/js/prompt-studio/generation/reference-inputs.js";
const image = name => ({filename: name, type: "input", subfolder: ""});
const profile = {kind: "edit", promptNodeId: "p", imageNodeId: "source", snapshot: {output: {
  e: {class_type: "TextEncodeQwenImage21", inputs: {prompt: ["p", 0], "images.image_1": ["source", 0]}},
}}};
const manual = {id: "manual", image: image("manual.png"), role: "style", instruction: "Preserve this style"};
const old = {...manual, id: "old", semanticTurn: true};
const settings = () => ({workflowProfileId: "edit", sourceImage: image("source.png"), qwenReferences: [manual, old],
  semanticAttachment: image("dress.png"), semanticBaseReferences: [manual, old]});
const assigned = {status: "assigned", role: "clothing", instruction: "Replace her dress only.", message: ""};

test("assignment replaces only earlier chat references, saves role and scope for replay", async () => {
  const state = settings();
  let payload;
  const fetch = async (_, options) => {payload = JSON.parse(options.body); return {ok: true, json: async () => assigned};};
  assert.match(await assignSemanticReference(fetch, state, profile, "Use this dress", {}), /Replace her dress/);
  assert.equal(payload.attachments.length, 1);
  assert.equal(payload.source_image.filename, "source.png");
  assert.equal(state.qwenReferences.length, 2);
  assert.equal(state.qwenReferences[0].id, manual.id);
  assert.equal(state.qwenReferences[1].role, "clothing");
  assert.equal(normalizeReferenceState(state).qwenReferences[1].semanticTurn, true);
  assert.equal(persistentReferences(state.qwenReferences).length, 1);
});

test("clarification and failures do not mutate staged references", async () => {
  for (const status of ["clarify", "unsupported", "discuss"]) {
    const state = settings(), original = structuredClone(state);
    await assert.rejects(assignSemanticReference(async () => ({ok: true, json: async () => ({status, message: "Which person?"})}),
      state, profile, "Use this dress", {}), /Which person/);
    assert.deepEqual(state, original);
  }
  let calls = 0;
  await assert.rejects(assignSemanticReference(async () => {calls++;}, settings(), {kind: "edit"}, "Dress", {}), /cannot use/);
  assert.equal(calls, 0);
});

test("clarification persists the attachment and matches original inputs, invalidating stale references", () => {
  const state = settings();
  const pending = normalizeReferenceClarification({...state, editPromptModel: "qwen_image_2_1", question: "Which person?", userText: "Use this dress"});
  assert.equal(pending.semanticAttachment.filename, "dress.png");
  assert.equal(referenceContextMatches(pending, state), true);
  assert.equal(referenceContextMatches(pending, {...state, qwenReferences: []}), false);
  assert.equal(referenceContextMatches(pending, {...state, sourceImage: image("other.png")}), false);
});

test("malformed server role is rejected even with an assigned response", async () => {
  await assert.rejects(requestSemanticReference(async () => ({ok: true, json: async () => ({...assigned, role: "fake"})}),
    {supported_roles: {clothing: "Clothing"}}), /invalid/);
});
