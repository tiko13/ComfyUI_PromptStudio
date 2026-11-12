import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalizeSpatialInput, normalizeSpatialStore, applySpatialInputs} from '../web/js/prompt-studio/generation/spatial-inputs.js';
import {mossCatalog, mossProfile} from './moss-fixture.mjs';

test('generated-map provenance survives chat normalization without changing generation inputs', async () => {
  const profile = await mossProfile(mossCatalog.find(p => p.id === 'moss_sft_controlled'));
  const layoutSignature = JSON.stringify([['box', .1, .2, .3, .4]]);
  const value = normalizeSpatialInput({guides: {color: {image: {filename: 'regions.png'}, kind: 'color', layoutSignature}}});
  const stored = normalizeSpatialStore({[profile.id]: JSON.parse(JSON.stringify(value))})[profile.id];
  assert.equal(stored.guides.color.layoutSignature, layoutSignature);
  const withProvenance = structuredClone(profile.snapshot), withoutProvenance = structuredClone(profile.snapshot);
  applySpatialInputs(withProvenance, profile, stored);
  delete stored.guides.color.layoutSignature;
  applySpatialInputs(withoutProvenance, profile, stored);
  assert.deepEqual(withProvenance, withoutProvenance, 'Editor metadata must not enter generation inputs');
  assert.equal(Object.hasOwn(normalizeSpatialInput(stored).guides.color, 'layoutSignature'), false, 'Older maps remain unchanged');
});
