// Native dialog provides background inertness; keep keyboard focus in its controls.
export function installDialogFocus(dialog) {
  const trigger = dialog.ownerDocument.activeElement;
  dialog.addEventListener("keydown", event => {
    if (event.key !== "Tab" || !dialog.open) return;
    const controls = [...dialog.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]')]
      .filter(control => !control.disabled && control.tabIndex >= 0 && control.getClientRects().length);
    const first = controls[0];
    const last = controls.at(-1);
    const active = dialog.ownerDocument.activeElement;
    if (!first) { event.preventDefault(); dialog.focus(); return; }
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault(); first.focus();
    }
  });
  dialog.addEventListener("close", () => {
    if (dialog.ownerDocument.querySelector('dialog[open]')) return;
    if (trigger?.isConnected && trigger.getClientRects().length) trigger.focus({preventScroll:true});
  });
}
