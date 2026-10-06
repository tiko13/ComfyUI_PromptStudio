import test from 'node:test';
import assert from 'node:assert/strict';
import {createVideoAvailabilityReader} from '../web/js/prompt-studio/integrations/video-availability.js';

const response = (data, status = 200) => ({ok: status === 200, json: async () => data});
test('only affirmative installation discovery can report missing', async () => {
  for (const failure of [404, 500, 503, 401, 'network', 'html', 'malformed']) {
    const read = createVideoAvailabilityReader({fetch: async path => {
      if (path.endsWith('/video-status')) return response({}, 404);
      if (failure === 'network') throw Error('offline');
      if (failure === 'html') return {ok: true, json: async () => {throw Error('invalid JSON');}};
      return failure === 'malformed' ? response({}) : response({}, failure);
    }});
    assert.deepEqual(await read(), {installed: null, state: 'unavailable'}, String(failure));
  }
  const read = createVideoAvailabilityReader({fetch: async path => path.endsWith('/video-status')
    ? response({installed: false, loaded: false, state: 'missing'}) : response({}, 404)});
  assert.equal((await read()).state, 'missing');
});

test('installed but not loaded is distinct from missing', async () => {
  const read = createVideoAvailabilityReader({fetch: async path => path.endsWith('/video-status')
    ? response({installed: true, loaded: false, state: 'not_loaded'}) : response({}, 404)});
  assert.deepEqual(await read(), {installed: true, state: 'not_loaded'});
});

test('positive evidence survives outages and recovers without stale presence', async () => {
  let online = true;
  const read = createVideoAvailabilityReader({fetch: async () => online
    ? response({features: ['unified_studio_shell'], studio_instances: [{instanceId: 'one'}]}) : response({}, 503)});
  assert.equal((await read()).state, 'loaded');
  online = false;
  assert.deepEqual(await read(), {installed: true, state: 'unavailable'});
  online = true;
  assert.equal((await read()).state, 'loaded');
});

test('hung probes are bounded, single flight, and can be retried', async () => {
  let calls = 0, online = false;
  const read = createVideoAvailabilityReader({timeoutMs: 10, fetch: async () => {
    calls++;
    if (!online) return new Promise(() => {});
    return response({features: []});
  }});
  const first = read();
  assert.equal(read(), first);
  assert.equal((await first).state, 'unavailable');
  assert.equal(calls, 2);
  online = true;
  assert.equal((await read()).state, 'loaded');
  assert.equal(calls, 3);
});
