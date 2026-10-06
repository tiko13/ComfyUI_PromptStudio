import { installDialogFocus } from '../ui/dialog-focus.js';

const ignored = new Set(['updatedAt', 'createdAt', 'updated_at', 'created_at', 'currentPrompt', 'mainPromptDirty', 'finalPromptManuallyEdited']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const comparable = value => Array.isArray(value) ? value.map(comparable) : object(value)
  ? Object.fromEntries(Object.keys(value).filter(key => !ignored.has(key)).sort().map(key => [key, comparable(value[key])])) : value;
const equal = (a, b) => JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
const copy = value => value === undefined ? undefined : structuredClone(value);
const labels = { mainPrompt: 'Main prompt', finalPrompt: 'Final prompt', currentPrompt: 'Current prompt',
  studioSettings: 'Generation settings', consultMessages: 'Assistant messages', composerText: 'Unsent message',
  messages: 'Messages', document: 'Video document', generations: 'Generations', shots: 'Shots' };
const label = key => labels[key] || String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
const records = value => Array.isArray(value) && value.every(item => object(item) && typeof item.id === 'string');
export const draftChatLabel = chat => chat?.createdAt ? `Chat · ${new Date(chat.createdAt).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : 'Original chat';
function displayValue(value) {
  if (value === undefined) return '(not present)';
  if (typeof value === 'string') return value || '(empty)';
  if (Array.isArray(value)) return value.length ? value.map(displayValue).join('\n\n') : '(empty)';
  if (object(value)) return Object.entries(value)
    .filter(([key, item]) => !ignored.has(key) && key !== 'id' && item !== null && item !== '' && (!Array.isArray(item) || item.length))
    .map(([key, item]) => `${label(key)}: ${displayValue(item)}`).join('\n') || '(empty)';
  return String(value);
}

// A baseline distinguishes actual local edits from values changed only on the server.
// Legacy drafts have no baseline: offer only values present in the draft and explicit deletions.
export function draftDifferences(local, current, base, path = [], title = '', result = []) {
  if (equal(local, current) || (base !== undefined && equal(local, base))) return result;
  const atomic = path.length > 2 && ['messages', 'consultMessages', 'shots', 'generations', 'versions'].includes(path.at(-2));
  if (!atomic && object(local) && object(current)) {
    const keys = new Set([...Object.keys(local), ...Object.keys(base || {})]);
    for (const key of keys) {
      if (ignored.has(key) || key === 'id' || ['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      draftDifferences(local[key], current[key], base?.[key], [...path, key], `${title} → ${label(key)}`, result);
    }
  } else if (!atomic && records(local) && records(current)) {
    const localOrder = local.map(item => item.id);
    const currentOrder = current.map(item => item.id);
    if (path.length > 1 && equal([...localOrder].sort(), [...currentOrder].sort()) && !equal(localOrder, currentOrder)
        && (!records(base) || !equal(localOrder, base.map(item => item.id)))) {
      result.push({ id: `${JSON.stringify(path)}:order`, path, title: `${title} → Order`, current: currentOrder, value: localOrder, order: true });
    }
    const ids = new Set([...local.map(item => item.id), ...(records(base) ? base.map(item => item.id) : [])]);
    for (const id of ids) {
      const proposed = local.find(item => item.id === id);
      const saved = current.find(item => item.id === id);
      const previous = Array.isArray(base) ? base.find(item => item.id === id) : undefined;
      const name = proposed?.title || proposed?.name || saved?.title || saved?.name
        || (path.length === 1 && path[0] === 'chats' ? draftChatLabel(proposed || saved)
          : `${label(path.at(-1))} ${local.findIndex(item => item.id === id) + 1 || id}`);
      draftDifferences(proposed, saved, previous, [...path, { id }], path.length === 1 ? name : `${title} → ${name}`, result);
    }
  } else {
    result.push({ id: JSON.stringify(path), path, title: title.replace(/^ → /, ''), current: copy(current), value: copy(local) });
  }
  return result;
}

export function draftValue(root, path) {
  return path.reduce((value, key) => object(key) ? value?.find?.(item => item.id === key.id) : value?.[key], root);
}

export function applyDraftDifference(root, difference) {
  const existing = draftValue(root, difference.path);
  if (!equal(difference.order ? existing?.map(item => item.id) : existing, difference.current)) throw new Error('This item changed since you opened the review. Refresh differences and review it again.');
  const next = copy(root);
  if (difference.order) {
    const collection = draftValue(next, difference.path);
    const byId = new Map(collection.map(item => [item.id, item]));
    collection.splice(0, collection.length, ...difference.value.map(id => byId.get(id)));
    return next;
  }
  const parent = draftValue(next, difference.path.slice(0, -1));
  const key = difference.path.at(-1);
  if (!parent) throw new Error('The destination no longer exists. Refresh differences and review it again.');
  if (object(key)) {
    const index = parent.findIndex(item => item.id === key.id);
    if (difference.value === undefined) { if (index >= 0) parent.splice(index, 1); }
    else if (index < 0) parent.push(copy(difference.value));
    else parent[index] = copy(difference.value);
  } else if (difference.value === undefined) delete parent[key];
  else parent[key] = copy(difference.value);
  return next;
}

// Recovery copies use separate keys so normal autosaves and acknowledgements cannot erase them.
export async function archiveDraft(outbox, key, draft) {
  const archiveKey = `${key}:review:${draft.saved_at || 0}:${draft.mutation || 0}`;
  if (!await outbox.get(archiveKey)) await outbox.put(archiveKey, { ...draft, draftSavedAt: draft.saved_at, dismissed: [] });
  await outbox.acknowledge(key, draft.mutation);
  return outbox.get(archiveKey);
}

export async function showDraftReviews({ container, outbox, key, differences, apply }) {
  if (!container) return;
  const archives = (await outbox.list()).filter(record => record.key.startsWith(`${key}:review:`));
  for (const archive of archives) {
    if ([...container.querySelectorAll('[data-draft-review]')].some(node => node.dataset.draftReview === archive.key)) continue;
    const element = (tag, text) => { const node = container.ownerDocument.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
    const button = (text, run) => {
      const node = element('button', text); node.type = 'button'; node.dataset.promptstudioAllowDisconnected = 'true';
      node.style.cssText = 'padding:8px 12px;margin:4px 8px 4px 0;border:1px solid #777;border-radius:6px;background:#333;color:inherit;cursor:pointer';
      node.addEventListener('click', run); return node;
    };
    const notice = element('div'); notice.dataset.draftReview = archive.key; notice.setAttribute('role', 'status');
    notice.style.cssText = 'padding:10px;border:1px solid #777;border-radius:8px;margin:8px 0;overflow-wrap:anywhere';
    const date = new Date(archive.draftSavedAt || archive.saved_at).toLocaleString();
    const status = element('p', `Unsaved draft from ${date}. Review its changes or dismiss it.`);
    const dismiss = async () => { await outbox.remove(archive.key); notice.remove(); };
    const view = button('View draft', async () => {
      // Standalone Studio adopts this notice from its opener or hidden iframe.
      // Resolve the visible document when clicked, not when the notice was built.
      const doc = notice.ownerDocument;
      const dialog = element('dialog'); dialog.className = 'promptstudio-draft-review';
      dialog.setAttribute('aria-label', 'Review unsaved draft');
      dialog.style.cssText = 'box-sizing:border-box;width:min(920px,94vw);max-width:94vw;max-height:90vh;overflow:auto;padding:20px;background:#202126;color:#eee;border:1px solid #777;border-radius:12px;font:14px/1.5 system-ui,sans-serif';
      const message = element('p'); message.setAttribute('role', 'status');
      const list = element('div');
      let pending = false;
      const act = async operation => {
        if (pending) return;
        pending = true;
        dialog.querySelectorAll('button').forEach(node => { node.disabled = true; });
        try { await operation(); } catch (error) { message.textContent = error.message || String(error); }
        finally { pending = false; dialog.querySelectorAll('button').forEach(node => { node.disabled = false; }); }
      };
      const refresh = async ({ removeResolved = false } = {}) => {
        const items = (await differences(archive)).filter(item => !(archive.dismissed || []).includes(item.id));
        list.replaceChildren();
        if (!items.length && removeResolved) await dismiss();
        message.textContent = items.length ? `${items.length} difference${items.length === 1 ? '' : 's'}. Apply saves only the selected change to its original session. Dismiss keeps the current version.`
          : removeResolved ? 'No remaining differences. You can dismiss this draft.'
            : 'No unapplied draft changes were found. Your draft is kept until you choose Dismiss draft.';
        for (const item of items) {
          const card = element('section'); card.dataset.draftDifference = item.id;
          card.style.cssText = 'border-top:1px solid #666;padding:12px 0;overflow-wrap:anywhere';
          card.append(element('h3', item.title));
          const columns = element('div'); columns.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:12px';
          for (const [heading, value] of [['Current version', item.current], ['Draft version', item.value]]) {
            const column = element('div'); column.style.minWidth = '0';
            const pre = element('pre', displayValue(value));
            pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;font:inherit;background:#15161a;padding:10px';
            column.append(element('strong', heading), pre); columns.append(column);
          }
          const resolve = async useDraft => {
            if (useDraft) await apply(item, archive);
            const dismissed = [...(archive.dismissed || []), item.id];
            await outbox.put(archive.key, { ...archive, dismissed });
            archive.dismissed = dismissed;
            await refresh({ removeResolved: true });
            list.querySelector('button')?.focus();
          };
          card.append(columns, button('Apply', () => act(() => resolve(true))), button('Dismiss', () => act(() => resolve(false))));
          list.append(card);
        }
      };
      dialog.append(element('h2', 'Review unsaved draft'), element('p', `Draft from ${date}`), message,
        button('Refresh differences', () => act(refresh)), list,
        button('Dismiss draft', () => act(async () => { await dismiss(); dialog.close(); })),
        button('Close', () => dialog.close()));
      dialog.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
      installDialogFocus(dialog);
      dialog.addEventListener('close', () => dialog.remove());
      doc.body.append(dialog); dialog.showModal();
      await act(refresh);
    });
    notice.append(status, view, button('Dismiss', async () => {
      try { await dismiss(); } catch (error) { status.textContent = error.message; }
    }));
    container.prepend(notice);
  }
}
