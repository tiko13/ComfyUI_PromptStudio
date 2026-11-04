import { createDraftOutbox, draftTabKey } from '../chat/draft-outbox.js';

export const SUBMISSION_DATABASE = 'promptstudio-submissions-v1';

// Queue admission must not scan, copy or wait behind the conversation archive.
// Each small record protects exactly one submission; recovery never resubmits it.
export function createSubmissionJournal(product, collection, {
  outbox = createDraftOutbox({ database: SUBMISSION_DATABASE }),
  prefix = draftTabKey(product) + ':',
} = {}) {
  const pending = new Map();
  let mutation = Date.now();
  const timestamp = entry => Number(entry?.updatedAt ?? entry?.updated_at ?? 0);
  const settled = entry => Boolean(entry?.promptId || entry?.prompt_id
    || ['complete', 'completed', 'error', 'cancelled'].includes(entry?.generationState || entry?.status));
  return {
    async checkpoint(owner, entry, ownerExisted = false) {
      const key = prefix + entry.id;
      const record = { mutation: ++mutation, owner, entry, ownerExisted };
      // postMessage snapshots before the first await. Only the pending entry and
      // explicitly selected owner metadata cross the worker boundary.
      const saved = await outbox.put(key, record);
      pending.set(key, saved || structuredClone(record));
    },
    async restore(owners, loadOwner = async () => null) {
      let changed = false;
      for (const saved of await outbox.list()) {
        if (!saved.key.startsWith(prefix) || !saved.entry?.id || !saved.owner?.id) continue;
        pending.set(saved.key, saved);
        mutation = Math.max(mutation, Number(saved.mutation) || 0);
        let owner = owners.find(item => item.id === saved.owner.id);
        if (!owner) {
          owner = await loadOwner(saved.owner.id);
          if (!owner && saved.ownerExisted) {
            // A confirmed server deletion must not resurrect an old session.
            await outbox.acknowledge(saved.key, saved.mutation);
            pending.delete(saved.key);
            continue;
          }
          owner ||= { ...saved.owner, [collection]: [] };
          owners.push(owner);
        }
        owner[collection] ||= [];
        const index = owner[collection].findIndex(item => item.id === saved.entry.id);
        const current = owner[collection][index];
        if (current && (timestamp(current) > timestamp(saved.entry)
          || (settled(current) && timestamp(current) === timestamp(saved.entry)))) continue;
        if (index < 0) owner[collection].push(saved.entry);
        else owner[collection][index] = saved.entry;
        changed = true;
      }
      return changed;
    },
    async acknowledge(owners, deletedIds = []) {
      for (const [key, saved] of pending) {
        const entry = owners.find(owner => owner.id === saved.owner.id)?.[collection]
          ?.find(item => item.id === saved.entry.id);
        // A save started before this checkpoint must not acknowledge it. Retain
        // same-tick records until a later save rather than risk early deletion.
        if (!deletedIds.includes(saved.owner.id) && (!settled(entry) || timestamp(entry) <= timestamp(saved.entry))) continue;
        await outbox.acknowledge(key, saved.mutation);
        if (pending.get(key) === saved) pending.delete(key);
      }
    },
  };
}
