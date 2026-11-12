import { enableSheetDismiss } from './touch-media.js';

/** Transient, document-owned image actions. Never moves history DOM or media. */
export function openImageCardSheet(trigger, { title, description = '', content, actions = [], reportError }) {
  const doc = trigger.ownerDocument;
  const panel = trigger.closest('#promptstudio-prompt-studio');
  if (!panel) return;
  panel.querySelector('.promptstudio-image-sheet')?.close();
  const dialog = doc.createElement('dialog');
  dialog.className = 'promptstudio-image-sheet';
  dialog.setAttribute('aria-label', title);
  const header = doc.createElement('header');
  const heading = doc.createElement('strong');
  heading.textContent = title;
  const close = doc.createElement('button');
  close.type = 'button'; close.textContent = 'Close';
  header.append(heading, close);
  const body = doc.createElement('div');
  body.className = 'promptstudio-image-sheet-body';
  if (description) {
    const text = doc.createElement('p'); text.textContent = description;
    body.append(text);
  }
  if (content) body.append(content);
  const list = doc.createElement('div');
  list.className = 'promptstudio-image-sheet-actions';
  let finished = false;
  let releaseDrag = () => {};
  const observer = new doc.defaultView.MutationObserver(() => {
    if (!trigger.isConnected || trigger.ownerDocument !== doc || panel.hidden
      || panel.closest('.promptstudio-studio-view')?.hidden) finish(false);
  });
  function finish(restore = true) {
    if (finished) return;
    finished = true;
    observer.disconnect();
    releaseDrag();
    dialog.close();
    dialog.remove();
    if (restore && trigger.isConnected) trigger.focus({ preventScroll: true });
  }
  for (const action of actions) {
    const button = doc.createElement('button');
    button.type = 'button'; button.textContent = action.label;
    button.disabled = Boolean(action.disabled?.());
    if (action.busy) button.dataset.disableBusy = '';
    if (action.danger) button.className = 'promptstudio-image-sheet-danger';
    if (action.hint) button.title = action.hint;
    button.addEventListener('click', () => {
      if (action.disabled?.()) { button.disabled = true; return; }
      // Dismiss synchronously before another confirmation/lightbox takes focus.
      finish();
      Promise.resolve().then(() => action.run(trigger)).catch(error => reportError?.(error));
    });
    list.append(button);
  }
  body.append(list); dialog.append(header, body);
  close.addEventListener('click', () => finish());
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  dialog.addEventListener('close', () => finish());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) finish();
  });
  panel.append(dialog);
  dialog.showModal(); close.focus({ preventScroll: true });
  releaseDrag = enableSheetDismiss(dialog, header, () => finish());
  observer.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  const mount = panel.closest('.promptstudio-studio-view');
  if (mount) observer.observe(mount, { attributes: true, attributeFilter: ['hidden'] });
}
