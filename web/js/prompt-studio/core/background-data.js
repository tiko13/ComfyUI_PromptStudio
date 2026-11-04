import { backgroundTask } from './scheduling.js';

export function processData(method, value) {
  if (method === 'provenance') return import('../generation/provenance.js')
    .then(module => module.captureProvenance(value.snapshot, value.options));
  if (method === 'compare-provenance') return import('../generation/provenance.js')
    .then(module => module.compareReplayProvenance(value.saved, value.snapshot, value.options));
  if (method === 'encode') return JSON.stringify(value);
  if (method === 'chat-store') {
    const {snapshot,acknowledged,...fields} = value;
    return JSON.stringify({...snapshot,...fields,partial:true,
      chats:snapshot.chats.filter(chat => acknowledged[chat.id] !== JSON.stringify(chat))});
  }
  if (method === 'records') return value.map(record => [record.id, JSON.stringify(record)]);
  if (method === 'project-store') {
    const baseline = new Map(value.base.map(project => [project.id, JSON.stringify(project)]));
    const ids = new Set(value.projects.map(project => project.id));
    return JSON.stringify({version:2,revision:value.revision,active_project_id:value.activeId,partial:true,
      projects:value.projects.filter(project => baseline.get(project.id) !== JSON.stringify(project)),
      deletedProjectIds:value.base.filter(project => !ids.has(project.id)).map(project => project.id)});
  }
  throw new Error('Unknown background data operation.');
}

let worker, sequence = 0;
const pending = new Map();
export function backgroundData(method, value) {
  if (typeof Worker !== 'function') return backgroundTask(() => processData(method, value));
  if (!worker) {
    try {
      worker = new Worker(new URL('./data-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        const request = pending.get(data.id);
        if (!request) return;
        pending.delete(data.id);
        if (data.error) request.reject(new Error(data.error));
        else request.resolve(data.result);
      };
      worker.onerror = event => {
        for (const request of pending.values()) request.reject(new Error(event.message || 'Background data processing failed.'));
        pending.clear(); worker.terminate(); worker = null;
      };
    } catch (_) { return backgroundTask(() => processData(method, value)); }
  }
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    try { worker.postMessage({ id, method, value }); }
    catch (error) { pending.delete(id); reject(error); }
  });
}
