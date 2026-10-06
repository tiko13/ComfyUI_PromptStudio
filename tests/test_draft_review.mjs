import assert from 'node:assert/strict';
import test from 'node:test';
import { draftDifferences, applyDraftDifference, archiveDraft } from '../web/js/prompt-studio/chat/draft-review.js';

test('review separates local fields and missing messages while retaining server-only edits', () => {
  const base = { chats: [{ id: 'a', title: 'Scene', mainPrompt: 'Old', finalPrompt: 'Original', messages: [] }] };
  const local = structuredClone(base); local.chats[0].mainPrompt = 'Draft';
  local.chats[0].messages.push({ id: 'm', text: 'Missing message' });
  const current = structuredClone(base); current.chats[0].finalPrompt = 'Newer server final';
  current.chats.push({ id: 'b', title: 'Other session' });
  const differences = draftDifferences(local, current, base);
  assert.equal(differences.length, 2);
  const merged = differences.reduce(applyDraftDifference, current);
  assert.equal(merged.chats[0].mainPrompt, 'Draft');
  assert.equal(merged.chats[0].finalPrompt, 'Newer server final');
  assert.equal(merged.chats[0].messages[0].text, 'Missing message');
  assert.equal(merged.chats[1].title, 'Other session');
  assert.equal(current.chats[0].mainPrompt, 'Old');
});

test('legacy snapshots do not delete server-only records or fields', () => {
  const changes = draftDifferences({ chats: [{ id: 'a', title: 'Draft' }] }, { chats: [{ id: 'a', title: 'Server', newField: 'Keep' }, { id: 'b' }] });
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].path, ['chats', { id: 'a' }, 'title']);
});

test('video shots and generations are atomic; baseline deletions are individually reviewable', () => {
  const base = { projects: [{ id: 'p', document: { shots: [{ id: 's', composition: 'Old', camera: 'Static' }] }, generations: [{ id: 'g', status: 'complete' }] }] };
  const local = structuredClone(base); local.projects[0].document.shots[0].composition = 'Draft'; local.projects[0].generations = [];
  const current = structuredClone(base); current.projects[0].document.shots[0].camera = 'Pan';
  const changes = draftDifferences(local, current, base);
  assert.equal(changes.length, 2);
  assert.equal(changes[0].value.camera, 'Static');
  assert.equal(changes[0].current.camera, 'Pan');
  assert.equal(changes[1].value, undefined);
  assert.equal(applyDraftDifference(current, changes[1]).projects[0].generations.length, 0);
});

test('apply refuses stale values or removed destinations', () => {
  const current = { chats: [{ id: 'a', mainPrompt: 'Old' }] };
  const change = draftDifferences({ chats: [{ id: 'a', mainPrompt: 'Draft' }] }, current)[0];
  assert.throws(() => applyDraftDifference({ chats: [{ id: 'a', mainPrompt: 'New' }] }, change), /changed/);
  assert.throws(() => applyDraftDifference({ chats: [] }, change), /changed/);
});

test('timestamp-only changes do not create recovery noise', () => {
  assert.deepEqual(draftDifferences({ messages: [{ id: 'm', text: 'Same', updatedAt: 1 }] }, { messages: [{ updatedAt: 2, text: 'Same', id: 'm' }] }), []);
});

test('record ordering can be recovered independently of record contents', () => {
  const base = { projects: [{ id: 'p', shots: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }] };
  const local = structuredClone(base); local.projects[0].shots.reverse();
  const current = structuredClone(base); current.projects[0].shots[0].text = 'New server content';
  const changes = draftDifferences(local, current, base);
  assert.equal(changes.length, 1);
  const merged = applyDraftDifference(current, changes[0]);
  assert.deepEqual(merged.projects[0].shots.map(shot => shot.id), ['b', 'a']);
  assert.equal(merged.projects[0].shots[1].text, 'New server content');
});

test('archived reviews survive normal acknowledgements and preserve dismissed decisions', async () => {
  const records = new Map();
  const outbox = { get: async key => records.get(key), put: async (key, value) => records.set(key, { ...value, key }),
    acknowledge: async (key, mutation) => { if (records.get(key)?.mutation <= mutation) records.delete(key); } };
  const draft = { mutation: 5, saved_at: 123, chats: [{ id: 'a' }] };
  records.set('image:tab', draft);
  const archived = await archiveDraft(outbox, 'image:tab', draft);
  archived.dismissed = ['one'];
  records.set('image:tab', { mutation: 6 });
  await archiveDraft(outbox, 'image:tab', draft);
  assert.equal(records.get('image:tab').mutation, 6);
  assert.deepEqual(records.get(archived.key).dismissed, ['one']);
});
