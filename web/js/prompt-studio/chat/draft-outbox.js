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
      if (new TextEncoder().encode(JSON.stringify(draft)).length>MAX_DRAFT_BYTES) throw new Error('Draft exceeds the 32 MB browser limit. Export it before closing.');
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

export function showDraftStorageFailure(container, record, message) {
  if (!container) return;
  let notice=container.querySelector('[data-draft-failure]');
  if (!notice) { notice=container.ownerDocument.createElement('div');notice.dataset.draftFailure='true';notice.setAttribute('role','alert');container.prepend(notice); }
  const text=container.ownerDocument.createElement('p');text.textContent=message;
  const button=container.ownerDocument.createElement('button');button.type='button';button.textContent='Export unsaved draft';
  button.addEventListener('click',()=>exportDraft(record,container.ownerDocument));notice.replaceChildren(text,button);
}
