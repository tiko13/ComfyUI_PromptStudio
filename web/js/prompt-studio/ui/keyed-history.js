import {revealResult} from './result-motion.js';
/** Message identity belongs to its session; rendering never owns jobs/storage. */
const histories = new WeakMap();

function nodeKey(node) {
  if (node.nodeType !== 1) return `node:${node.nodeType}`;
  return `${node.tagName}:${node.id || node.getAttribute('data-history-part') || node.className || ''}`;
}

function syncAttributes(current, next) {
  for (const attribute of [...current.attributes]) {
    if (current.tagName === 'DETAILS' && attribute.name === 'open') continue;
    if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of [...next.attributes]) {
    if (current.tagName === 'DETAILS' && attribute.name === 'open') continue;
    if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  }
}

function patchNode(current, next) {
  if (nodeKey(current) !== nodeKey(next)) { current.replaceWith(next); return next; }
  if (current.nodeType !== 1) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return current;
  }
  // Event handlers on changed controls capture the new variant/message data.
  // Keep media in place, but rebuild controls instead of retaining stale closures.
  if (['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(current.tagName)) {
    const media = [...current.querySelectorAll('img,video,audio')];
    for (const replacement of next.querySelectorAll('img,video,audio')) {
      const retained = media.find(node => node.tagName === replacement.tagName && node.getAttribute('src') === replacement.getAttribute('src'));
      if (retained) { media.splice(media.indexOf(retained), 1); syncAttributes(retained, replacement); replacement.replaceWith(retained); }
    }
    current.replaceWith(next);
    return next;
  }
  if (['IMG', 'VIDEO', 'AUDIO'].includes(current.tagName)) {
    if (current.getAttribute('src') !== next.getAttribute('src')) { current.replaceWith(next); return next; }
    syncAttributes(current, next);
    return current;
  }
  syncAttributes(current, next);
  const previous = [...current.childNodes];
  let cursor = current.firstChild;
  for (const child of [...next.childNodes]) {
    let match = previous.find(node => node.parentNode === current && nodeKey(node) === nodeKey(child));
    if (match) {
      const atCursor = match === cursor;
      previous.splice(previous.indexOf(match), 1);
      match = patchNode(match, child);
      if (!atCursor) current.insertBefore(match, cursor);
      cursor = match.nextSibling;
    } else {
      current.insertBefore(child, cursor);
    }
  }
  for (const child of previous) child.remove();
  return current;
}

function focusSnapshot(card) {
  const active = card.ownerDocument?.activeElement;
  if (!active || !card.contains(active)) return null;
  const path = [];
  let node = active;
  while (node !== card) { path.unshift([...node.parentNode.children].indexOf(node)); node = node.parentNode; }
  return {active, path, tag:active.tagName, id:active.id,
    selection:typeof active.selectionStart === 'number' ? [active.selectionStart,active.selectionEnd,active.selectionDirection] : null};
}

/** Patch a changed card; preserve unchanged text nodes, media, and open details. */
export function patchHistoryCard(current, next) {
  if (current.hasAttribute('data-history-key')) next.setAttribute('data-history-key', current.getAttribute('data-history-key'));
  const focus = focusSnapshot(current);
  const result = patchNode(current, next);
  if (focus && !focus.active.isConnected) {
    const replacement = focus.path.reduce((node, index) => node?.children[index], result);
    if (replacement?.tagName === focus.tag && replacement.id === focus.id) {
      replacement.focus({preventScroll:true});
      if (focus.selection) replacement.setSelectionRange(...focus.selection);
    }
  }
  return result;
}

function prepareImages(card) {
  for (const image of card.querySelectorAll?.('img') || []) {
    if (!image.hasAttribute('loading')) image.loading = 'lazy';
    image.decoding = 'async';
  }
  return card;
}

export function forgetKeyedHistory(container) { histories.delete(container); }

/** O(n) identity/signature scan; construct only new/changed message views.
 * create must return a detached card. Signature must include rendered external
 * state (for example, whether this message owns the active variant controls).
 */
export function reconcileKeyedHistory(container, items, {
  namespace = '', key = item => item.id, signature = item => JSON.stringify(item), create,
  update = (node, item, index) => patchHistoryCard(node, prepareImages(create(item, index))),
  preserveViewport = true,
} = {}) {
  const entries = items.map((item, index) => ({item, index, key:String(key(item, index) ?? ''), signature:signature(item, index)}));
  const keys = entries.map(entry => entry.key);
  if (keys.some(value => !value) || new Set(keys).size !== keys.length) throw new Error('History messages require unique non-empty IDs');
  const prior = histories.get(container);
  const records = prior?.namespace === namespace ? prior.records : new Map();
  const bounds = preserveViewport && container.getBoundingClientRect?.();
  const anchor = bounds ? [...container.children].find(node => node.getBoundingClientRect().bottom > bounds.top) : null;
  const anchorTop = anchor?.getBoundingClientRect().top;
  const scrollTop = container.scrollTop;
  const retained = new Map();
  const counts = {examined:items.length, created:0, updated:0, retained:0, removed:0, moved:0};
  let cursor = container.firstChild;
  for (const entry of entries) {
    const record = records.get(entry.key);
    let node = record?.node;
    if (!node || node.parentNode !== container) {
      node = prepareImages(create(entry.item, entry.index));
      node.setAttribute?.('data-history-key', entry.key);
      counts.created++;
    }
    else if (record.signature !== entry.signature) {
      const atCursor = node === cursor;
      node = update(node, entry.item, entry.index) || node;
      if (atCursor) cursor = node;
      counts.updated++;
    }
    else counts.retained++;
    if (node !== cursor) { container.insertBefore(node, cursor); counts.moved++; }
    if (!record && prior?.namespace === namespace && records.size && entry.index === entries.length - 1) revealResult(node);
    cursor = node.nextSibling;
    retained.set(entry.key, {node, signature:entry.signature});
  }
  const wanted = new Set([...retained.values()].map(record => record.node));
  for (const node of [...container.childNodes]) if (!wanted.has(node)) { node.remove(); counts.removed++; }
  histories.set(container, {namespace, records:retained});
  if (preserveViewport) {
    if (anchor?.parentNode === container) container.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    else container.scrollTop = scrollTop;
  }
  return counts;
}
