import assert from 'node:assert/strict';
import test from 'node:test';
import {createDraftScheduler} from '../web/js/prompt-studio/chat/draft-outbox.js';

test('typing bursts capture only the latest state after the pause', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let value = '', writes = [];
  const scheduler = createDraftScheduler(() => writes.push(value));
  for (const character of 'draft') {
    value += character;
    scheduler.schedule();
    t.mock.timers.tick(50);
  }
  assert.deepEqual(writes, []);
  t.mock.timers.tick(300);
  assert.deepEqual(writes, ['draft']);
  t.mock.timers.tick(2000);
  assert.deepEqual(writes, ['draft']);
});

test('continuous typing checkpoints at the deadline and starts a new burst', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let writes = 0;
  const scheduler = createDraftScheduler(() => ++writes);
  for (let i = 0; i < 12; i++) {
    scheduler.schedule();
    t.mock.timers.tick(100);
  }
  assert.equal(writes, 1);
  scheduler.schedule();
  t.mock.timers.tick(300);
  assert.equal(writes, 2);
});

test('lifecycle flush and explicit save cancel duplicate scheduled writes', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let writes = 0;
  const scheduler = createDraftScheduler(() => ++writes);
  scheduler.schedule();
  assert.equal(scheduler.flush(), 1);
  assert.equal(scheduler.flush(), undefined);
  scheduler.schedule();
  scheduler.cancel();
  t.mock.timers.tick(3000);
  assert.equal(writes, 1);
});
