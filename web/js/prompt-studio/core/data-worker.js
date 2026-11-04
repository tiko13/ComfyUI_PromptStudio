import { processData } from './background-data.js';
self.onmessage = async ({ data: { id, method, value } }) => {
  try { self.postMessage({ id, result: await processData(method, value) }); }
  catch (error) { self.postMessage({ id, error: error.message || String(error) }); }
};
