import { installDialogFocus } from '../ui/dialog-focus.js';

// Durable intent only: recovering a record never executes a queue request.
const MAX_DRAFT_BYTES = 32 * 1024 * 1024;
// Capture the latest state after an edit burst, never in the input handler.
// The deadline also checkpoints drafts during continuous typing.
export function createDraftScheduler(write, { delay = 300, maxWait = 1200 } = {}) {
  let timer = null;
  let deadline = null;
  const cancel = () => {
    clearTimeout(timer);
    clearTimeout(deadline);
    timer = deadline = null;
  };
  const flush = () => {
    if (timer === null) return;
    cancel();
    return write();
  };
  return {
    schedule() {
      if (deadline === null) deadline = setTimeout(flush, maxWait);
      clearTimeout(timer);
      timer = setTimeout(flush, delay);
    },
    flush,
    cancel,
  };
}

export function draftTabKey(product, storage) {
  const key = 'promptstudio.draft.tab.v1';
  try {
    storage ||= globalThis.sessionStorage;
    let id = storage.getItem(key);
    if (!id) { id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`; storage.setItem(key,id); }
    return `${product}:${id}`;
  } catch (_) { return `${product}:storage-unavailable`; }
}

export function createDraftOutbox({database='promptstudio-draft-outbox-v1', indexedDB=globalThis.indexedDB} = {}) {
  let opening;
  const open = () => opening ||= new Promise((resolve,reject) => {
    if (!indexedDB) { reject(new Error('Durable browser storage is unavailable. Export your unsaved draft.')); return; }
    const request = indexedDB.open(database,1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts',{keyPath:'key'});
    request.onerror = () => { opening=null; reject(request.error); };
    request.onblocked = () => { opening=null; reject(new Error('Draft storage is blocked by another open Studio tab.')); };
    request.onsuccess = () => { request.result.onversionchange=()=>request.result.close(); resolve(request.result); };
  });
  const transaction = async (mode,operation) => {
    const db=await open();
    return new Promise((resolve,reject) => {
      const tx=db.transaction('drafts',mode);
      let result;
      tx.oncomplete=()=>resolve(result);
      tx.onerror=tx.onabort=()=>reject(tx.error || new Error('Draft storage could not be committed.'));
      operation(tx.objectStore('drafts'),value=>{result=value;});
    });
  };
  return {
    async put(key,record) {
      const draft={...structuredClone(record),key,version:1,saved_at:Date.now()};
      if (new TextEncoder().encode(JSON.stringify(draft)).length>MAX_DRAFT_BYTES) throw new Error('Draft exceeds Prompt Studio’s 32 MiB recovery-copy limit. Server saving may still succeed. Export unsaved changes before closing.');
      return transaction('readwrite',(store,done)=>{ store.put(draft); done(draft); });
    },
    get: key => transaction('readonly',(store,done)=>{const request=store.get(key);request.onsuccess=()=>done(request.result||null);}),
    list: () => transaction('readonly',(store,done)=>{const request=store.getAll();request.onsuccess=()=>done(request.result);}),
    // A late server acknowledgement must not delete a newer local edit.
    acknowledge: (key,mutation) => transaction('readwrite',(store,done)=>{
      const request=store.get(key);request.onsuccess=()=>{
        const saved=request.result;
        if (saved && Number(saved.mutation)<=Number(mutation)) {store.delete(key);done(true);} else done(false);
      };
    }),
    remove: key => transaction('readwrite',(store,done)=>{store.delete(key);done(true);}),
    async close() { if(opening) (await opening).close(); opening=null; },
  };
}

export function exportDraft(record, ownerDocument=globalThis.document) {
  const encoded=JSON.stringify({version:1,exported_at:Date.now(),draft:record},null,2);
  const view=ownerDocument.defaultView;
  const url=view.URL.createObjectURL(new view.Blob([encoded],{type:'application/json'}));
  const link=ownerDocument.createElement('a');
  link.href=url;link.download=`promptstudio-draft-${Date.now()}.json`;link.click();
  view.setTimeout(()=>view.URL.revokeObjectURL(url),1000);
}

const storageFailures = new WeakMap();

function draftButton(doc, label, action) {
  const button = doc.createElement('button');
  button.type = 'button'; button.textContent = label;
  button.dataset.promptstudioAllowDisconnected = 'true';
  button.addEventListener('click', action);
  return button;
}

// Read directly from memory: even an oversized or blocked IndexedDB write can be inspected.
// Expand collections lazily and page long strings rather than rendering megabytes of JSON.
export function viewUnsavedDraft(record, doc = globalThis.document) {
  const element = (tag, text) => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const dialog = element('dialog');
  dialog.className = 'promptstudio-draft-preview';
  dialog.setAttribute('aria-label', 'Unsaved draft');
  dialog.style.cssText = 'box-sizing:border-box;width:min(900px,94vw);max-width:94vw;max-height:85vh;overflow:hidden;flex-direction:column;background:#202127;color:#eee;border:1px solid #666;border-radius:10px;padding:20px;overflow-wrap:anywhere;font:14px/1.5 system-ui,sans-serif';
  const labels = { chats: 'Changed chats', baseChats: 'Previously saved chats', projects: 'Projects', base: 'Previously saved projects', composerText: 'Unsent message' };
  const fieldLabel = key => labels[key] || String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
  function field(key, value) {
    const row = element('details');
    row.style.cssText = 'margin:8px 0;padding-left:10px;border-left:1px solid #666;min-width:0';
    const collection = value !== null && typeof value === 'object';
    const keys = collection ? Object.keys(value) : null;
    const title = collection ? `${keys.length} ${Array.isArray(value) ? 'items' : 'fields'}`
      : String(value ?? '(empty)').slice(0, 120) + (String(value ?? '').length > 120 ? '…' : '');
    row.append(element('summary', `${fieldLabel(key)} — ${title}`));
    row.addEventListener('toggle', () => {
      if (!row.open || row.childElementCount > 1) return;
      if (collection) {
        let offset = 0;
        const more = draftButton(doc, 'Show more items', () => append());
        const append = () => {
          more.remove();
          const end = Math.min(offset + 40, keys.length);
          for (; offset < end; offset++) {
            const childKey = keys[offset];
            const child = value[childKey];
            const label = Array.isArray(value) ? `${offset + 1}${child?.name || child?.title ? ` · ${String(child.name || child.title).slice(0, 100)}` : ''}` : childKey;
            row.append(field(label, child));
          }
          if (offset < keys.length) row.append(more);
        };
        append();
      } else {
        const text = String(value ?? '(empty)');
        let offset = 0;
        const pre = element('pre');
        pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;font:inherit';
        const position = element('p');
        const previous = draftButton(doc, 'Previous text', () => { offset -= 8000; render(); });
        const next = draftButton(doc, 'Next text', () => { offset += 8000; render(); });
        const render = () => {
          pre.textContent = text.slice(offset, offset + 8000) || '(empty)';
          position.textContent = `Characters ${text.length ? offset + 1 : 0}–${Math.min(offset + 8000, text.length)} of ${text.length}`;
          previous.disabled = offset === 0; next.disabled = offset + 8000 >= text.length;
        };
        render(); row.append(pre);
        if (text.length > 8000) row.append(position, previous, next);
      }
    });
    return row;
  }
  dialog.append(element('h2', 'Unsaved draft'), element('p', 'The recovery copy from when browser storage failed. Expand a section to inspect it. It can include whole chats or projects and their saved comparison versions. Your edits stay intact when you close this preview.'));
  const content = element('div');
  content.style.cssText = 'overflow:auto;min-height:0;flex:1';
  for (const [key, value] of Object.entries(record)) content.append(field(key, value));
  const actions = element('div');
  actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;flex-shrink:0;padding-top:12px;border-top:1px solid #666;margin-top:12px';
  actions.append(draftButton(doc, 'Export unsaved draft', () => exportDraft(record, dialog.ownerDocument)), draftButton(doc, 'Close', () => dialog.close()));
  dialog.append(content, actions);
  for (const button of actions.children) button.style.cssText = 'font:inherit;color:inherit;background:#353740;border:1px solid #777;border-radius:6px;padding:7px 12px;cursor:pointer';
  installDialogFocus(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  doc.body.append(dialog); dialog.showModal(); dialog.style.display = 'flex';
}

export function clearDraftStorageFailure(container, record) {
  if (!container) return;
  const failure = storageFailures.get(container);
  // A late success must not clear a warning about newer edits.
  if (record && failure && Number(record.mutation) < Number(failure.record.mutation)) return;
  storageFailures.delete(container);
  container.querySelector('[data-draft-failure]')?.remove();
}

export function showDraftStorageFailure(container, record, message) {
  if (!container) return;
  let failure = storageFailures.get(container);
  if (failure?.message === message) {
    failure.record = record;
    if (failure.dismissed || container.querySelector('[data-draft-failure]')) return;
  } else {
    failure = { record, message, dismissed: false };
    storageFailures.set(container, failure);
  }
  container.querySelector('[data-draft-failure]')?.remove();
  const doc = container.ownerDocument;
  const notice = doc.createElement('div');
  notice.dataset.draftFailure = 'true'; notice.setAttribute('role', 'alert');
  const text = doc.createElement('p'); text.textContent = message;
  const dismiss = draftButton(doc, 'Dismiss warning', () => { failure.dismissed = true; notice.remove(); });
  dismiss.title = 'Hide this warning without deleting your edits. This does not save the draft.';
  notice.append(text,
    draftButton(doc, 'View draft', () => viewUnsavedDraft(failure.record, notice.ownerDocument)),
    draftButton(doc, 'Export unsaved draft', () => exportDraft(failure.record, notice.ownerDocument)), dismiss);
  container.prepend(notice);
}
