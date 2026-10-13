/** Read-only background activity. Never changes the parent health indicator. */
export function mountBackgroundTasks(section, { scope, fetchApi }) {
  const control = section.closest('details');
  const doc = section.ownerDocument;
  const add = (tag, text = '') => {
    const node = doc.createElement(tag);
    node.textContent = text;
    section.append(node);
    return node;
  };
  add('strong', 'Background tasks');
  add('small', 'LoRA / model library');
  const status = add('span', 'Open the monitor to check progress.');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const progress = add('progress');
  progress.setAttribute('aria-label', 'LoRA / model library progress');
  progress.style.width = '100%';
  progress.hidden = true;
  const records = add('small');
  const message = add('small');
  let pending = false;
  const count = value => Math.max(0, Math.floor(Number(value) || 0));
  const labels = { idle: 'Waiting to scan', indexing: 'Indexing installed files',
    populating: 'Looking up Civitai metadata', complete: 'Scan complete',
    deferred: 'Waiting to retry', failed: 'Scan failed', stopped: 'Scan stopped' };
  const refresh = async () => {
    if (pending || !control.open || !section.isConnected || section.ownerDocument.hidden
        || !section.getClientRects().length) return;
    pending = true;
    try {
      const response = await fetchApi('/promptstudio/prompt-studio/model-metadata/library', {
        cache: 'no-store', signal: AbortSignal.timeout(8000),
      });
      const data = await response.json();
      if (!response.ok || !Object.hasOwn(labels, data.state)) throw new Error('Status unavailable');
      const total = count(data.total);
      const processed = Math.min(count(data.processed), total);
      const errors = count(data.errors);
      status.textContent = `${labels[data.state]}${data.state === 'indexing' ? ` · ${total} files discovered`
        : ` · ${processed} / ${total} files`}${errors ? ` · ${errors} ${errors === 1 ? 'error' : 'errors'}` : ''}`;
      progress.hidden = !['indexing', 'populating', 'deferred'].includes(data.state);
      if (data.state === 'indexing' || !total) progress.removeAttribute('value');
      else { progress.max = total; progress.value = processed; }
      const saved = data.records || {};
      records.textContent = `Database: ${count(saved.found)} matched${count(saved.local) ? ` · ${count(saved.local)} embedded` : ''} · ${count(saved.not_found)} unmatched · ${count(saved.unchecked)} unchecked`;
      message.textContent = data.error || (data.state === 'deferred' ? 'Population resumes automatically after a cooldown.' : '');
    } catch (_) {
      status.textContent = 'Background task status unavailable';
      progress.hidden = true;
      message.textContent = 'Retrying while this monitor is open. Saved records are kept.';
      // Keep the last observed database counts, explicitly marked as stale.
      if (records.textContent && !records.textContent.startsWith('Last known: ')) records.textContent = `Last known: ${records.textContent}`;
    } finally { pending = false; }
  };
  control.addEventListener('toggle', refresh);
  const stop = scope.add(refresh, { interval: 5000 });
  return () => { stop(); control.removeEventListener('toggle', refresh); };
}
