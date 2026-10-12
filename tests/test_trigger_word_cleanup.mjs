import assert from 'node:assert/strict';
import { test } from 'node:test';
import { removeTriggerWords, cleanupRemovedLoraTriggers } from '../web/js/prompt-studio/ui/trigger-word-cleanup.js';

test('removes repeated literal triggers and sanitizes separators at every position', () => {
  for (const text of ['solo, keep', 'keep, solo', 'solo, keep, solo', ', solo, , keep, \n\t, solo ,']) {
    assert.equal(removeTriggerWords(text, ['solo']), 'keep');
  }
  assert.equal(removeTriggerWords(' \t, solo , first \n trigger, , ', ['solo', 'first trigger']), '');
  assert.equal(removeTriggerWords('keep   this\n text, solo, and\tthat', ['solo']), 'keep this text, and that');
  assert.equal(removeTriggerWords('A [style]+, 猫, end', ['[style]+', '猫']), 'A, end');
});

test('protects shared triggers, longer words and overlapping retained phrases', () => {
  assert.equal(removeTriggerWords('solo, SOLO, first trigger, keep', ['solo', 'first trigger'], [' SOLO ']), 'solo, SOLO, keep');
  assert.equal(removeTriggerWords('soloist, my_solo, solo2, solo, keep', ['solo']), 'soloist, my_solo, solo2, keep');
  assert.equal(removeTriggerWords('first trigger, trigger, keep', ['trigger'], ['first trigger']), 'first trigger, keep');
  assert.equal(removeTriggerWords('keep,  \n text,', ['absent']), 'keep,  \n text,');
});

function fixture() {
  const events = [];
  const editor = { value: 'solo, shared, keep', isConnected: true,
    ownerDocument: { defaultView: { Event } }, dispatchEvent: event => events.push(event.type) };
  const context = { chatId: 'chat', profileId: 'workflow', names: ['remaining'] };
  return { editor, context, events, options: { editor, name: 'removed', getContext: () => ({ ...context, names: [...context.names] }),
    loadWords: async name => name === 'removed' ? ['solo', 'shared'] : ['shared'] } };
}

test('preserves shared triggers and dispatches persistence events', async () => {
  const f = fixture();
  await cleanupRemovedLoraTriggers(f.options);
  assert.equal(f.editor.value, 'shared, keep');
  assert.deepEqual(f.events, ['input', 'change']);
});

test('pending metadata respects re-add, chat/workflow switch and latest user text', async () => {
  for (const change of ['readd', 'chat', 'workflow', 'edit']) {
    const f = fixture();
    let release;
    f.options.loadWords = name => name === 'removed' ? new Promise(resolve => { release = resolve; }) : Promise.resolve(['shared']);
    const work = cleanupRemovedLoraTriggers(f.options);
    if (change === 'readd') f.context.names.push('removed');
    if (change === 'chat') f.context.chatId = 'other';
    if (change === 'workflow') f.context.profileId = 'other';
    if (change === 'edit') f.editor.value = 'solo, shared, new user text';
    release(['solo', 'shared']);
    await work;
    assert.equal(f.editor.value, change === 'edit' ? 'shared, new user text' : 'solo, shared, keep');
  }
});

test('rechecks remaining LoRAs when selections change during metadata lookup', async () => {
  const f = fixture();
  let release;
  f.options.loadWords = async name => name === 'removed' ? ['solo', 'shared'] : await new Promise(resolve => { release = resolve; });
  const work = cleanupRemovedLoraTriggers(f.options);
  await Promise.resolve();
  f.context.names = [];
  release(['shared']);
  await work;
  assert.equal(f.editor.value, 'keep');
});

test('failed metadata never deletes potentially shared words', async () => {
  const f = fixture();
  f.options.loadWords = async name => { if (name === 'remaining') throw new Error('offline'); return ['solo', 'shared']; };
  await assert.rejects(cleanupRemovedLoraTriggers(f.options), /offline/);
  assert.equal(f.editor.value, 'solo, shared, keep');
});
