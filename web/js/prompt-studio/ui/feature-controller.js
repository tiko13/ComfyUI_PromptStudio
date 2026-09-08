/** Owned UI resources. Disposing a view never cancels application jobs. */
export function createFeatureController({ mount, update = () => {}, dispose = () => {}, timers = globalThis }) {
  let current = null;
  const controller = {
    mount(target, context = {}) {
      if (!target) return controller.dispose();
      if (current?.target === target) return controller.update(context);
      controller.dispose();
      const resources = [];
      const session = { target, context, resources };
      current = session;
      const own = cleanup => {
        let owned = true;
        const release = () => { if (owned) { owned = false; cleanup(); } };
        if (current === session) resources.push(release);
        else release();
        return release;
      };
      const scope = {
        isCurrent: () => current === session,
        own,
        listen(node, type, listener, options) {
          const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
          node.addEventListener(type, listener, options);
          return own(() => node.removeEventListener(type, listener, { capture }));
        },
        interval(callback, delay) {
          const id = timers.setInterval(() => { if (current === session) callback(); }, delay);
          own(() => timers.clearInterval(id));
          return id;
        },
        timeout(callback, delay) {
          const id = timers.setTimeout(() => { if (current === session) callback(); }, delay);
          own(() => timers.clearTimeout(id));
          return id;
        },
      };
      session.scope = scope;
      try {
        mount(target, scope, context);
        controller.update(context);
      } catch (error) {
        controller.dispose();
        throw error;
      }
      return controller;
    },
    update(context = {}) {
      if (current) {
        current.context = context;
        update(current.target, context, current.scope);
      }
      return controller;
    },
    dispose() {
      const previous = current;
      current = null;
      if (previous) {
        // Release every resource even if one consumer's cleanup fails.
        const errors = [];
        for (const release of previous.resources.reverse()) {
          try { release(); } catch (error) { errors.push(error); }
        }
        try { dispose(previous.target, previous.context); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, "Feature cleanup failed");
      }
      return controller;
    },
  };
  return controller;
}

/** Adopt the existing panel; keep inputs, plot grids and media elements alive. */
export function movePanelPreservingFocus(panel, mount, { visible = true } = {}) {
  const active = panel.ownerDocument.activeElement;
  const restore = active && panel.contains(active) ? active : null;
  const selection = restore && typeof restore.selectionStart === "number"
    ? [restore.selectionStart, restore.selectionEnd, restore.selectionDirection] : null;
  if (panel.parentNode !== mount) mount.appendChild(panel);
  // The standalone shell owns this startup placeholder, not a second grid row.
  for (const placeholder of mount.querySelectorAll(':scope > .promptstudio-popout-loading')) placeholder.remove();
  panel.hidden = !visible;
  if (restore?.isConnected && visible) {
    restore.focus({ preventScroll: true });
    if (selection) restore.setSelectionRange(...selection);
  }
}
