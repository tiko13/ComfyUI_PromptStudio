// Historical execution snapshots are immutable. Retain their identity while
// copying editable record metadata; workers perform the deep storage copy.
// This avoids walking every saved graph twice before a save can even start.
const immutableFields = new Set(['generationSnapshot', 'workflow_snapshot']);
export function storageSnapshot(value, key = '', seen = new Map()) {
  if (!value || typeof value !== 'object' || immutableFields.has(key)) return value;
  if (seen.has(value)) return seen.get(value);
  const result = Array.isArray(value) ? [] : {};
  seen.set(value, result);
  for (const field of Object.keys(value)) result[field] = storageSnapshot(value[field], field, seen);
  return result;
}
