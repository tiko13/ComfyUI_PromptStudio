import { createDraftOutbox } from './draft-outbox.js';

const stores = new Map();
const baselines = new Map();
// Serialize operations so an acknowledgement cannot overtake an earlier put.
let chain = Promise.resolve();
self.onmessage = ({ data: { id, database, method, args, baseline } }) => {
  chain = chain.catch(() => {}).then(async () => {
    try {
      if (!stores.has(database)) stores.set(database, createDraftOutbox({ database, worker: false }));
      if (baseline) {
        const key = JSON.stringify([database, args[0]]);
        const records = baselines.get(key) || new Map();
        for (const id of baseline.removed) records.delete(id);
        for (const [id, value] of baseline.updates) records.set(id, value);
        baselines.set(key, records);
        args[1].chatBaseline = Object.fromEntries(records);
      }
      const result = await stores.get(database)[method](...args);
      if (method === 'close') baselines.clear();
      self.postMessage({ id, result });
    } catch (error) { self.postMessage({ id, error: error.message || String(error) }); }
  });
};
