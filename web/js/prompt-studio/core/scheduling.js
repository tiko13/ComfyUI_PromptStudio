// Yield to input/paint before non-interactive work. Promise.resolve() only yields
// to microtasks and therefore does not let the browser paint.
export function backgroundTask(task) {
  if (globalThis.scheduler?.postTask) return globalThis.scheduler.postTask(task, { priority: 'background' });
  return new Promise((resolve, reject) => setTimeout(() => {
    try { resolve(task()); } catch (error) { reject(error); }
  }, 0));
}

export function coalesceFrame(task, getView = () => globalThis) {
  let pending = false;
  let latestArgs;
  let scheduledView, frame, revision = 0;
  return (...args) => {
    latestArgs = args;
    const view = getView() || globalThis;
    if (pending && scheduledView === view) return;
    if (pending) {
      if (typeof scheduledView.cancelAnimationFrame === 'function') scheduledView.cancelAnimationFrame(frame);
      else scheduledView.clearTimeout(frame);
    }
    scheduledView = view;
    pending = true;
    const current = ++revision;
    const run = () => { if (current !== revision) return; pending = false; task(...latestArgs); };
    // Standalone/popout controls can belong to a different visible document
    // than the hidden ComfyUI frame that originally imported this module.
    if (typeof view.requestAnimationFrame === 'function') frame = view.requestAnimationFrame(run);
    else frame = view.setTimeout(run, 0);
  };
}

// Reserve before asynchronous preparation, submit in reservation order. A failed
// or cancelled preparation releases its place without letting later work jump
// over an earlier, still pending submission.
export function createSubmissionOrder() {
  let tail = Promise.resolve();
  return () => {
    const ready = tail;
    let release;
    const done = new Promise(resolve => { release = resolve; });
    tail = ready.then(() => done);
    return { ready, release };
  };
}
