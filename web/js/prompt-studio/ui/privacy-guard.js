// A modal top-layer surface also covers previews and dialogs already on screen.
const guards = new WeakMap();

export function syncPrivacyGuard(banner, connected) {
  const doc = banner.ownerDocument;
  let guard = guards.get(doc);
  if (!guard) {
    const view = doc.defaultView;
    const media = view.matchMedia('(max-width: 1400px), (any-pointer: coarse)');
    const entries = new Map();
    const dialog = doc.createElement('dialog');
    dialog.className = 'studio-privacy-guard';
    dialog.setAttribute('aria-label', 'Privacy guard');
    dialog.innerHTML = '<h2>Privacy guard</h2><div role="alert"></div>';
    dialog.addEventListener('cancel', event => event.preventDefault());
    const content = dialog.querySelector('div');
    let source = null;
    let markup = '';
    const sync = () => {
      const active = media.matches && [...entries].find(([node, online]) =>
        !online && node.isConnected && node.parentElement.getClientRects().length);
      if (!active) {
        if (dialog.open) dialog.close();
        source = null;
        return;
      }
      const node = active[0];
      if (source !== node || markup !== node.innerHTML) {
        source = node;
        markup = node.innerHTML;
        content.replaceChildren(...[...node.children].map(child => child.cloneNode(true)));
      }
      if (!dialog.isConnected) doc.body.append(dialog);
      if (!dialog.open) dialog.showModal();
    };
    // Hidden mounts change when switching studios; later dialogs must not expose
    // content over an active guard. Ignore our own open/close mutations.
    new view.MutationObserver(records => {
      if (!records.some(record => record.target !== dialog)) return;
      if (dialog.open && records.some(record => record.target !== dialog
        && record.attributeName === 'open' && record.target.open)) dialog.close();
      sync();
    }).observe(doc.body, {subtree: true, attributes: true, attributeFilter: ['hidden', 'open']});
    media.addEventListener('change', sync);
    guard = {entries, sync};
    guards.set(doc, guard);
  }
  if (!guard.entries.has(banner)) {
    new doc.defaultView.MutationObserver(guard.sync).observe(banner, {
      childList: true, characterData: true, subtree: true,
    });
  }
  guard.entries.set(banner, connected);
  guard.sync();
}
