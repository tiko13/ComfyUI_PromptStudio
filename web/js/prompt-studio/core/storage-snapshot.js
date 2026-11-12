// Historical execution snapshots are immutable. Retain their identity while
// copying editable record metadata; workers perform the deep storage copy.
// This avoids walking every saved graph twice before a save can even start.
const immutableFields = new Set(['generationSnapshot', 'workflow_snapshot']);
const snapshotIds = new WeakMap();
let nextSnapshotId = 0;

// Compare editable metadata without serializing the immutable execution graphs.
// Replacement graphs always invalidate the record, even if their content matches.
// Keep this separate from wire JSON: identity tokens must never reach storage.
export function storageSignature(value) {
  return JSON.stringify(value, (key, item) => {
    if (immutableFields.has(key) && item && typeof item === 'object') {
      if (!snapshotIds.has(item)) snapshotIds.set(item, ++nextSnapshotId);
      return { snapshotIdentity: snapshotIds.get(item) };
    }
    return item;
  });
}

export function changedRecords(records, baseline) {
  return records.filter(record => baseline.get(record.id) !== storageSignature(record));
}

export function projectChanges(projects, base) {
  const signatures = new Map(base.map(record => [record.id, storageSignature(record)]));
  const changed = changedRecords(projects, signatures);
  const ids = new Set(projects.map(record => record.id));
  const deleted = base.filter(record => !ids.has(record.id));
  const changedIds = new Set([...changed, ...deleted].map(record => record.id));
  return { projects: changed, base: base.filter(record => changedIds.has(record.id)),
    deletedProjectIds: deleted.map(record => record.id) };
}

export function storageSnapshot(value, key = '', seen = new Map()) {
  if (!value || typeof value !== 'object' || immutableFields.has(key)) return value;
  if (seen.has(value)) return seen.get(value);
  const result = Array.isArray(value) ? [] : {};
  seen.set(value, result);
  for (const field of Object.keys(value)) result[field] = storageSnapshot(value[field], field, seen);
  return result;
}
