import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLlmProfile, llmProfileModeOptions } from "../web/js/prompt-studio/settings/llm-profile-store.js";
import { normalizeProviderSettings } from "../web/js/prompt-studio/core/wire-contracts.js";
import { thinkingModeEnablesReasoning, llmActivityLabel } from "../web/js/prompt-studio/llm/status.js";

const thinking = ["Spoon", "Einstein", "XHigh", "Medium", "Low"];
const modes = [...thinking, ...thinking.map(mode => `Instruct ${mode}`), "Disabled"];

test("all Twin Turbo modes survive profile persistence and provider requests", () => {
  for (const mode of modes) {
    const profile = normalizeLlmProfile({thinking_modes: thinking, instruct_modes: [...thinking, "Disabled"], thinking_mode: mode});
    const restored = normalizeLlmProfile(JSON.parse(JSON.stringify(profile)));
    assert.deepEqual(restored.thinking_modes, thinking);
    assert.deepEqual(restored.instruct_modes, [...thinking, "Disabled"]);
    assert.deepEqual(llmProfileModeOptions(restored), modes);
    assert.equal(restored.thinking_mode, mode);
    assert.equal(normalizeProviderSettings({wire_version: 1, llm_provider: "llamacpp", thinking_mode: mode}).thinking_mode, mode);
  }
});

test("legacy combined definitions and instruct-only profiles remain selectable", () => {
  const legacy = normalizeLlmProfile({thinking_modes: modes, thinking_mode: "Instruct Spoon"});
  assert.deepEqual(llmProfileModeOptions(legacy), modes);
  assert.equal(legacy.thinking_mode, "Instruct Spoon");
  const instruct = normalizeLlmProfile({thinking_modes: [], instruct_modes: ["Spoon"], thinking_mode: "Instruct Spoon"});
  assert.deepEqual(instruct.thinking_modes, []);
  assert.deepEqual(instruct.instruct_modes, ["Spoon"]);
  assert.deepEqual(llmProfileModeOptions(instruct), ["Instruct Spoon"]);
  assert.equal(instruct.thinking_mode, "Instruct Spoon");
});

test("shared Image and Video status treats instruct variants as non-thinking", () => {
  for (const mode of modes) {
    const enabled = thinkingModeEnablesReasoning(mode);
    assert.equal(enabled, thinking.includes(mode));
    assert.equal(llmActivityLabel({}, enabled), enabled ? "Thinking / processing" : "Processing");
  }
});

test("profiles without non-thinking support do not expose or restore Off", () => {
  for (const definition of [
    {thinking_modes: ["High", "Low"], instruct_modes: []},
    {thinking_modes: ["High"]},
  ]) {
    const profile = normalizeLlmProfile({...definition, thinking_mode: "Disabled"});
    const restored = normalizeLlmProfile(JSON.parse(JSON.stringify(profile)));
    assert.equal(restored.thinking_mode, "High");
    assert.equal(llmProfileModeOptions(restored).includes("Disabled"), false);
    assert.equal(thinkingModeEnablesReasoning(restored.thinking_mode), true);
  }
});
