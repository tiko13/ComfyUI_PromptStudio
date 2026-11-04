import { backgroundTask } from '../core/scheduling.js';

const values = new Map();
const pending = new Map();
export function readJsonSetting(key, fallback = {}) {
  if (values.has(key)) return values.get(key);
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
    values.set(key, value);
    return value;
  } catch (_) { return fallback; }
}

function flush(key) {
  const entry = pending.get(key);
  if (!entry) return;
  pending.delete(key);
  try { localStorage.setItem(key, JSON.stringify(entry.value)); }
  catch (error) { entry.onError?.(error); }
}

// Memory is authoritative immediately. Encode/write once after an interaction
// burst, so subsequent controls never read stale values from disk.
export function writeJsonSetting(key, value, onError = error => console.warn('Settings could not be saved.', error)) {
  values.set(key, value);
  const scheduled = pending.has(key);
  pending.set(key, { value, onError });
  if (!scheduled) void backgroundTask(() => flush(key));
}

// For request identities that must be durable before a network side effect.
// Unlike ordinary preferences, failures must reach the caller before it submits.
export function persistJsonSetting(key, value) {
  values.set(key, value);
  return backgroundTask(() => localStorage.setItem(key, JSON.stringify(value)));
}

globalThis.addEventListener?.('storage', event => {
  if (event.key === null) {
    for (const key of values.keys()) if (!pending.has(key)) values.delete(key);
  } else if (!pending.has(event.key)) values.delete(event.key);
});
globalThis.addEventListener?.('pagehide', () => { for (const key of pending.keys()) flush(key); });
