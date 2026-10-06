import assert from 'node:assert/strict';
import {test} from 'node:test';
import {currentWorkflowId} from '../web/js/prompt-studio/generation/workflow-migrations.js';
import {normalizeWorkflowProfile} from '../web/js/prompt-studio/generation/workflow-profile.js';
import {plotAxisTargets} from '../web/js/prompt-studio/plot/model.js';

test('managed workflow selection migration preserves directories, selection keys and unrelated names', () => {
  for (const role of ['Create','Edit','RGBA','RGBA Edit','Background Removal']) {
    for (const prefix of ['', 'workflows/', 'nested\\']) {
      for (const suffix of ['', '\0' + '5']) {
        assert.equal(currentWorkflowId(`${prefix}[PS] - QwenImage21 ${role} turbo4.json${suffix}`), `${prefix}[PS] - QwenImage21 ${role} turbo6.json${suffix}`);
      }
    }
  }
  for (const id of ['my turbo4.json', '[PS] - QwenImage21 Create base40.json', '[PS] - QwenImage21 Create turbo4.json.backup']) assert.equal(currentWorkflowId(id), id);
});

test('Turbo profile exposes its actual six steps and only allows sampling plots over seeds', () => {
  const profile = normalizeWorkflowProfile({snapshot: {output: {'10': {class_type: 'KCPP_QwenImage21TurboSampler', inputs: {seed: 42}}}}});
  assert.equal(profile.samplingNodes[0].controls.steps, 6);
  assert.equal(profile.samplingNodes[0].controls.cfg, 1);
  assert.equal(plotAxisTargets(profile, 'seed').length, 1);
  for (const field of ['steps', 'cfg', 'sampler', 'scheduler', 'denoise']) assert.equal(plotAxisTargets(profile, field).length, 0);
});
