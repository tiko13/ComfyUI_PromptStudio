import { api } from "/scripts/api.js";

const preparations = new Map();

async function prepare(endpoint, report) {
  if (preparations.has(endpoint)) return preparations.get(endpoint);
  const operation = (async () => {
    let offset = 0;
    for (;;) {
      const response = await api.fetchApi(`${endpoint}/maintenance`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({offset,limit:100}),
        signal: AbortSignal.timeout(60000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'History preparation failed.');
      report(`Prepared ${result.nextOffset} session records. Previous revisions remain available.`);
      if (!result.hasMore) break;
      if (!Number.isInteger(result.nextOffset) || result.nextOffset <= offset) throw new Error('History preparation did not advance. Retry after checking the store.');
      offset = result.nextOffset;
    }
  })();
  preparations.set(endpoint, operation);
  try { await operation; } finally { preparations.delete(endpoint); }
}

/** Existing split stores get their missing summaries in bounded batches on load.
 * Legacy monolithic imports retain the explicit preparation action below.
 */
export async function prepareHistoryIndex(data, container, endpoint, resume) {
  if (!data?.maintenance_required || !Number.isInteger(data.summary_records_remaining)) return false;
  try { requireHistoryIndex(data, container, endpoint, resume); } catch (_) { /* Notice also supplies retry. */ }
  const notice = container?.querySelector('[data-history-maintenance]');
  const text = notice?.querySelector('p');
  const button = notice?.querySelector('button');
  if (text) text.textContent = 'Loading saved sessions: updating the history index…';
  if (button) button.disabled = true;
  try {
    await prepare(endpoint, message => { if (text) text.textContent = message; });
    notice?.remove();
    return true;
  } catch (error) {
    if (text) text.textContent = error.message || 'Saved sessions could not be loaded. Retry history preparation.';
    throw error;
  } finally { if (button) button.disabled = false; }
}

export function requireHistoryIndex(data, container, endpoint, resume) {
  if (!data?.maintenance_required) return;
  if (container && !container.querySelector('[data-history-maintenance]')) {
    const notice = container.ownerDocument.createElement('div');
    notice.dataset.historyMaintenance = 'true';
    notice.setAttribute('role', 'alert');
    const text = container.ownerDocument.createElement('p');
    text.textContent = 'Prepare the history index to load saved sessions. Existing files and previous revisions are retained. Large legacy stores may take longer on the first import.';
    const button = container.ownerDocument.createElement('button');
    button.type = 'button';
    button.textContent = 'Prepare history index';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await prepare(endpoint, message => { text.textContent = message; });
        await resume();
        notice.remove();
      } catch (error) { text.textContent = error.message; }
      finally { button.disabled = false; }
    });
    notice.append(text,button);
    container.prepend(notice);
  }
  throw new Error('Saved history needs index preparation. Use Prepare history index to continue.');
}
