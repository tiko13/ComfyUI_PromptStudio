import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { WIRE_VERSION, PROVIDERS, JOB_STATUSES, JOB_TRANSITIONS, THINKING_MODES,
  normalizeProviderSettings, normalizeSnapshotWire, normalizeJobWire, assertJobTransition, assertObservedJobTransition } from "../web/js/prompt-studio/core/wire-contracts.js";
import { LLM_THINKING_MODE_OPTIONS, LLM_PROFILE_STORAGE_KEY } from "../web/js/prompt-studio/core/constants.js";
import { normalizeLlmProfile, loadLlmProfiles } from "../web/js/prompt-studio/settings/llm-profile-store.js";
import { normalizeGenerationSnapshot } from "../web/js/prompt-studio/chat/generation-state.js";

const read = name => JSON.parse(fs.readFileSync(new URL(`../web/js/prompt-studio/core/${name}.json`, import.meta.url), "utf8"));
const fixtures = read("wire-contract-fixtures");

test("shared JS enums and legacy profile options match the canonical Python source", () => {
  const enums = read("wire-contract-enums");
  assert.equal(WIRE_VERSION, enums.wire_version);
  assert.deepEqual(PROVIDERS, enums.providers);
  assert.deepEqual(JOB_STATUSES, enums.job_statuses);
  assert.deepEqual(JOB_TRANSITIONS, enums.job_transitions);
  assert.deepEqual(THINKING_MODES, enums.thinking_modes);
  assert.deepEqual(LLM_THINKING_MODE_OPTIONS, enums.thinking_modes);
});

for (const kind of ["provider", "job", "snapshot"]) test(`${kind} persisted legacy fixtures migrate explicitly`, () => {
  const normalize = { provider: normalizeProviderSettings, job: normalizeJobWire, snapshot: normalizeSnapshotWire }[kind];
  for (const { input, expected } of fixtures[`${kind}_legacy`]) {
    const original = structuredClone(input);
    const actual = normalize(input);
    if (kind === "provider") for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value);
    else assert.deepEqual(actual, expected);
    assert.deepEqual(input, original);
  }
});

test("versioned provider discriminants, misspelled fields and invalid numbers are rejected", () => {
  assert.throws(() => normalizeProviderSettings({ wire_version: 2 }), /version/);
  assert.throws(() => normalizeProviderSettings({ wire_version: 1, llm_provider: "typo" }), /llm_provider/);
  assert.throws(() => normalizeProviderSettings({ llm_provder: "ollama" }, { strict: true }), /Unknown/);
  for (const value of [NaN, Infinity, null, 6]) assert.throws(() => normalizeProviderSettings({ temperature: value }), /temperature/);
});

test("new snapshots require both envelopes and preserve unknown metadata", () => {
  for (const snapshot of [{ output: {} }, { workflow: {} }, { workflow: [], output: {} }]) {
    assert.throws(() => normalizeSnapshotWire({ wire_version: 1, kind: "workflow_snapshot", snapshot }));
  }
  const source = fixtures.snapshot_legacy[0].input;
  const migrated = normalizeSnapshotWire(source);
  migrated.snapshot.custom.keep = false;
  assert.equal(source.custom.keep, true);
});

test("Image saved generation snapshots retain workflow and all metadata; output-only is explicit legacy", () => {
  const source = fixtures.snapshot_legacy[0].input;
  const normalized = normalizeGenerationSnapshot(source);
  assert.deepEqual(normalized, source);
  normalized.workflow.nodes.push({ id: 1 });
  assert.equal(source.workflow.nodes.length, 0);
  assert.deepEqual(normalizeGenerationSnapshot({ output: { one: {} }, legacyMetadata: "keep" }), { output: { one: {} }, legacyMetadata: "keep" });
  assert.equal(normalizeGenerationSnapshot({ output: {}, workflow: [] }), null);
  assert.equal(normalizeGenerationSnapshot({ workflow: {} }), null);
});

test("all job transitions follow the published graph and terminal payloads are required", () => {
  for (const from of JOB_STATUSES) for (const to of JOB_STATUSES) {
    if (JOB_TRANSITIONS[from].includes(to)) assert.doesNotThrow(() => assertJobTransition(from, to));
    else assert.throws(() => assertJobTransition(from, to), /transition/);
  }
  assert.throws(() => normalizeJobWire({ job_id: "job", status: "complete" }), /result/);
  assert.throws(() => normalizeJobWire({ job_id: "job", status: "failed" }), /error/);
  assert.doesNotThrow(() => assertObservedJobTransition("queued", "complete"));
  assert.doesNotThrow(() => assertObservedJobTransition("running", "running"));
  assert.throws(() => assertObservedJobTransition("running", "queued"), /transition/);
  assert.throws(() => assertObservedJobTransition("failed", "running"), /transition/);
});

test("old profile arrays and Qwen presets migrate through the shared Video/Image reader", () => {
  const values = new Map([[LLM_PROFILE_STORAGE_KEY, JSON.stringify([{ id: "qwen3.5", name: "Qwen3.5", temperature: 0.8 }])]]);
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  try {
    const profiles = loadLlmProfiles();
    assert.equal(profiles.find(profile => profile.id === "qwen3.5").name, "Default");
    assert.ok(profiles.some(profile => profile.id === "qwen3.8-27b"));
    assert.equal(JSON.parse(values.get(LLM_PROFILE_STORAGE_KEY)).version, 6);
    assert.equal(normalizeLlmProfile({ thinking_modes: ["invalid"] }).thinking_mode, "Disabled");
  } finally { delete globalThis.localStorage; }
});
