import { installDialogFocus } from "../ui/dialog-focus.js";

export function formatBytes(value) {
  if (!Number.isFinite(value)) return "Unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = Math.max(0, value), i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "Estimating…";
  const n = Math.max(0, Math.round(seconds));
  return n >= 3600 ? `${Math.floor(n / 3600)}h ${Math.floor(n % 3600 / 60)}m` : n >= 60 ? `${Math.floor(n / 60)}m ${n % 60}s` : `${n}s`;
}

const busyStates = new Set(["running", "pausing", "cancelling"]);
const resumableStates = new Set(["paused", "interrupted", "failed", "needs_restart"]);

/** Inject the existing workflow builder; setup never replaces the open graph. */
export function createSetupWizard({ panel, api, buildWorkflow, refreshWorkflows, applyDefaults, restart, providerStatus }) {
  let dialog, plan, state, checkBusy = false, actionBusy = false, pollTimer, validating = false;
  let checkedFirstOpen = false, lastValidated = "", scanSequence = 0;
  let selections = {packs: ["create", "edit", "upscale"], choices: {}};
  const doc = () => panel.ownerDocument;
  const el = (tag, className = "", text = "") => {
    const node = doc().createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const call = async (action, payload) => {
    const response = await api.fetchApi(`/promptstudio/setup/${action}`, payload === undefined ? {cache: "no-store"} : {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Setup is unavailable (${response.status}). Restart ComfyUI after updating Prompt Studio.`);
    if (!data || typeof data !== "object" || !("version" in data)) throw new Error("Restart ComfyUI to load the setup service.");
    return data;
  };
  const button = (label, action, primary = false) => {
    const control = el("button", primary ? "promptstudio-setup-primary" : "", label);
    control.type = "button";
    control.addEventListener("click", () => { Promise.resolve(action()).catch(showError); });
    return control;
  };
  const showError = error => {
    const output = dialog?.querySelector("[data-setup-error]");
    if (output) { output.hidden = false; output.textContent = error.message || String(error); }
  };
  const clearError = () => { const output = dialog?.querySelector("[data-setup-error]"); if (output) { output.hidden = true; output.textContent = ""; } };

  function ensureDialog() {
    if (dialog?.ownerDocument === doc()) return;
    dialog?.remove();
    dialog = el("dialog", "promptstudio-setup-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "promptstudio-setup-title");
    const header = el("header", "promptstudio-setup-header");
    const titles = el("div");
    titles.append(el("span", "promptstudio-setup-eyebrow", "COMFYUI EXTENSION SETUP"));
    const title = el("h2", "", "Set up Prompt Studio"); title.id = "promptstudio-setup-title";
    titles.append(title, el("p", "", "Check what you have. Add only what your workflows need."));
    header.append(titles, button("Close", close));
    const steps = el("ol", "promptstudio-setup-steps");
    for (const text of ["Check", "Review", "Set up", "Verify"]) steps.append(el("li", "", text));
    const content = el("div", "promptstudio-setup-content"); content.dataset.setupContent = "";
    const error = el("p", "promptstudio-setup-error"); error.dataset.setupError = ""; error.hidden = true; error.setAttribute("role", "alert");
    const footer = el("footer", "promptstudio-setup-footer"); footer.dataset.setupFooter = "";
    dialog.append(header, steps, content, error, footer);
    panel.append(dialog);
    installDialogFocus(dialog);
    dialog.addEventListener("cancel", event => { event.preventDefault(); void close().catch(showError); });
  }

  async function close() {
    if (state?.onboarding === "new") state = await call("dismiss", {});
    dialog?.close();
    updateSummary();
  }

  async function open() {
    ensureDialog();
    if (!dialog.open) dialog.showModal();
    clearError();
    state = await call("status");
    if (state.job && (busyStates.has(state.job.status) || resumableStates.has(state.job.status) || state.job.status === "awaiting_validation")) {
      renderJob(); schedulePoll();
      if (state.job.status === "awaiting_validation") await validate();
    } else await scan();
  }

  async function maybeOpen() {
    const owner = doc();
    if (checkedFirstOpen || panel.hidden || owner.body.dataset.studioMode === "video"
        || owner.querySelector('[data-studio-mode="image"]')?.hidden
        || (!owner.body.dataset.studioMode && new URLSearchParams(owner.defaultView.location.search).get("mode") === "video")) return;
    checkedFirstOpen = true;
    try {
      state = await call("status");
      updateSummary();
      if (state.onboarding === "new") await open();
      else if (state.job && busyStates.has(state.job.status)) schedulePoll();
    } catch (_) {
      // Old backend during an extension update: Settings remains the explicit
      // retry path. Do not break Studio startup or hide its existing workflows.
      checkedFirstOpen = false;
    }
  }

  async function scan() {
    const sequence = ++scanSequence;
    checkBusy = true;
    clearError();
    const content = dialog.querySelector("[data-setup-content]");
    content.replaceChildren(el("p", "promptstudio-setup-checking", "Checking registered models, workflow nodes and storage…"));
    renderFooter([]);
    try {
      const next = await call("plan", selections);
      if (sequence !== scanSequence) return;
      plan = next; state = next.state;
      selections.choices = Object.fromEntries(next.requirements.map(r => [r.id, r.choice]));
      renderPlan(); updateSummary();
    } finally { if (sequence === scanSequence) checkBusy = false; }
  }

  function renderFooter(controls) {
    dialog.querySelector("[data-setup-footer]").replaceChildren(...controls);
  }

  function setStep(index) {
    [...dialog.querySelectorAll(".promptstudio-setup-steps li")].forEach((item, i) => {
      if (i === index) item.setAttribute("aria-current", "step"); else item.removeAttribute("aria-current");
    });
  }

  function renderPlan() {
    setStep(1);
    dialog.querySelector("[data-setup-footer]").dataset.signature = "";
    const content = dialog.querySelector("[data-setup-content]");
    content.replaceChildren();
    const choices = el("div", "promptstudio-setup-packs");
    for (const [id, name] of [["create", "Create"], ["edit", "Edit"], ["upscale", "Upscale"]]) {
      const label = el("label"); const input = el("input"); input.type = "checkbox"; input.checked = selections.packs.includes(id);
      input.addEventListener("change", () => {
        const next = input.checked ? [...selections.packs, id] : selections.packs.filter(p => p !== id);
        if (!next.length) { input.checked = true; return; }
        selections.packs = next; void scan().catch(showError);
      });
      label.append(input, el("strong", "", name)); choices.append(label);
    }
    content.append(choices);
    for (const pack of plan.packs) {
      if (pack.file) content.append(el("p", "promptstudio-setup-workflow-file", `${pack.name}: ${pack.file} — ${pack.existing_status}`));
    }
    const checks = el("div", "promptstudio-setup-checks");
    for (const check of plan.checks) checks.append(el("span", "", `${check.status === "ready" ? "✓" : "!"} ${check.name}`));
    checks.append(el("span", "", providerStatus?.() || "LLM: optional; direct prompting is available"));
    content.append(checks);
    const list = el("div", "promptstudio-setup-requirements");
    for (const req of plan.requirements) {
      const row = el("section", "promptstudio-setup-requirement");
      const heading = el("div", "promptstudio-setup-row-heading");
      heading.append(el("h3", "", req.name), el("span", "promptstudio-setup-badge", req.status === "available" ? "Reuse installed" : req.status === "blocked" ? "Needs attention" : "Download needed"));
      row.append(heading, el("p", "promptstudio-setup-used", `Used by ${req.used_by.join(" · ")}`), el("p", "", req.description));
      const label = el("label", "promptstudio-setup-model-choice", "Use model"); const select = el("select"); select.setAttribute("aria-label", req.name);
      for (const candidate of req.candidates) {
        const option = el("option", "", `Installed: ${candidate.name}`); option.value = candidate.name; select.append(option);
      }
      for (const asset of req.download_options) {
        const option = el("option", "", `Download ${asset.name} · ${formatBytes(asset.size)}`); option.value = `__download__:${asset.id}`; select.append(option);
      }
      select.value = req.choice;
      select.addEventListener("change", () => { selections.choices[req.id] = select.value; void scan().catch(showError); });
      label.append(select); row.append(label);
      const details = el("details"); details.append(el("summary", "", "Source and compatibility details"));
      const candidate = req.candidates.find(c => c.name === req.choice);
      if (candidate) details.append(el("p", "", candidate.evidence), el("p", "", candidate.path || candidate.name));
      else {
        const link = el("a", "", req.source); link.href = req.source; link.target = "_blank"; link.rel = "noreferrer";
        details.append(link, el("p", "", `Save to ${req.destination}`));
      }
      for (const rejected of req.rejected) details.append(el("p", "", `${rejected.name}: ${rejected.reason}`));
      row.append(details); list.append(row);
    }
    for (const dep of plan.node_packs) {
      const row = el("section", "promptstudio-setup-requirement");
      const heading = el("div", "promptstudio-setup-row-heading");
      heading.append(el("h3", "", dep.name), el("span", "promptstudio-setup-badge", dep.outdated?.length ? "Update required" : dep.missing.length ? "Install with Manager" : "Already loaded"));
      row.append(heading, el("p", "promptstudio-setup-used", `Used by ${dep.used_by.join(" · ")}`));
      const link = el("a", "", dep.url); link.href = dep.url; link.target = "_blank"; link.rel = "noreferrer"; row.append(link);
      if (dep.missing.length) row.append(el("p", "", "ComfyUI Manager will install this node pack. A restart is required before validation."));
      list.append(row);
    }
    content.append(list);
    for (const blocker of plan.blockers) content.append(el("p", "promptstudio-setup-error", blocker));
    const summary = el("div", "promptstudio-setup-download-summary");
    summary.append(el("strong", "", `${formatBytes(plan.download_bytes)} to download`), el("span", "", "Shared files are downloaded once."));
    for (const disk of plan.disks) summary.append(el("small", "", `${formatBytes(disk.free)} free at ${disk.path}`));
    content.append(summary);
    const licenses = el("details"); licenses.append(el("summary", "", "Model sources and terms"));
    for (const item of plan.licenses) { const a = el("a", "", item.name); a.href = item.url; a.target = "_blank"; a.rel = "noreferrer"; licenses.append(a, el("br")); }
    content.append(licenses);
    const startButton = button("Set up selected workflows", start, true);
    startButton.disabled = plan.blockers.length > 0;
    renderFooter([button("Set up later", close), button("Check again", () => { selections.choices = {}; return scan(); }), startButton]);
  }

  async function start() {
    if (actionBusy || checkBusy) return;
    actionBusy = true;
    try { state = await call("start", selections); lastValidated = ""; renderJob(); schedulePoll(); }
    finally { actionBusy = false; }
  }

  function meter(label, value, total) {
    const wrap = el("div", "promptstudio-setup-meter");
    const progress = el("progress"); progress.setAttribute("aria-label", label);
    if (total > 0) { progress.max = total; progress.value = Math.min(value, total); }
    wrap.append(progress); return wrap;
  }

  function renderJob() {
    if (!dialog?.open || !state?.job) return;
    const job = state.job;
    setStep(["awaiting_validation", "complete"].includes(job.status) ? 3 : 2);
    const content = dialog.querySelector("[data-setup-content]");
    // Keep the live section stable so polling does not reset scroll, details,
    // selection or keyboard focus. Only its text and meter values change.
    let live = content.querySelector("[data-setup-live]");
    if (!live) {
      content.replaceChildren(); live = el("section", "promptstudio-setup-live"); live.dataset.setupLive = "";
      for (const [tag, key] of [["h3", "phase"], ["p", "item"], ["p", "amount"], ["p", "metrics"], ["p", "message"]]) {
        const value = el(tag); value.dataset.metric = key;
        if (key === "phase") { value.setAttribute("role", "status"); value.setAttribute("aria-live", "polite"); }
        live.append(value);
      }
      const current = meter("Current operation", 0, 0); current.dataset.currentMeter = ""; live.append(current);
      const downloadLabel = el("p"); downloadLabel.dataset.metric = "download"; live.append(downloadLabel);
      const overall = meter("Total downloads", 0, 1); overall.dataset.overallMeter = ""; live.append(overall);
      const details = el("details", "promptstudio-setup-log"); details.open = true;
      details.append(el("summary", "", "Activity log")); const log = el("ol"); log.dataset.setupLog = ""; details.append(log);
      live.append(details); content.append(live);
    }
    const downloading = ["Downloading", "Verifying", "Verified"].includes(job.phase);
    const values = {phase: job.status === "paused" ? "Paused" : job.status === "pausing" ? "Pausing…" : job.status === "cancelling" ? "Stopping…" : job.phase, item: job.item || "", message: job.error || job.message,
      download: job.download_total ? `Total downloads: ${formatBytes(job.downloaded)} / ${formatBytes(job.download_total)}${job.phase === "Downloading" && job.speed ? ` · about ${formatTime((job.download_total - job.downloaded) / job.speed)} download time remaining` : ""}` : "No downloads needed — using installed models",
      amount: job.total ? downloading ? `${formatBytes(job.bytes)} / ${formatBytes(job.total)}` : `${job.bytes} / ${job.total}` : "",
      metrics: `${downloading && busyStates.has(job.status) ? `${job.waiting_for_data ? "Waiting for download data…" : job.speed ? formatBytes(job.speed) + "/s" : "Measuring speed…"} · ${job.eta == null ? "Estimating remaining time…" : formatTime(job.eta) + " remaining for this file"} · ` : ""}${formatTime(job.elapsed)} elapsed`};
    for (const [name, value] of Object.entries(values)) live.querySelector(`[data-metric="${name}"]`).textContent = value;
    const current = live.querySelector("[data-current-meter] progress");
    if (job.total > 0) { current.max = job.total; current.value = Math.min(job.bytes, job.total); } else current.removeAttribute("value");
    const overall = live.querySelector("[data-overall-meter] progress"); overall.max = Math.max(1, job.download_total); overall.value = job.download_total ? job.downloaded : 1;
    const log = live.querySelector("[data-setup-log]");
    const events = job.events || [];
    if (log.dataset.signature !== JSON.stringify(events)) {
      log.replaceChildren(...events.map(event => el("li", "", `${new Date(event.time * 1000).toLocaleTimeString()} — ${event.message}`)));
      log.dataset.signature = JSON.stringify(events);
    }
    // Footer changes only on transitions, preserving keyboard focus on buttons.
    const footer = dialog.querySelector("[data-setup-footer]");
    const signature = `${job.status}:${job.phase === "Installing nodes"}:${validating}:${Boolean(job.error)}`;
    if (footer.dataset.signature !== signature) {
      footer.dataset.signature = signature;
      const actions = [button("Close", close)];
      if (busyStates.has(job.status)) {
        const pause = button(job.status === "pausing" ? "Pausing…" : "Pause", () => control("pause"));
        pause.disabled = job.status !== "running" || job.phase === "Installing nodes";
        actions.push(pause);
        const cancel = button("Cancel setup", () => control("cancel")); cancel.disabled = job.phase === "Installing nodes"; actions.push(cancel);
      } else if (resumableStates.has(job.status)) {
        if (job.status === "needs_restart") actions.push(button("Restart ComfyUI", restart));
        actions.push(button(job.status === "failed" ? "Retry setup" : "Resume setup", () => control("resume"), true));
        actions.push(button("Review choices", () => { selections = structuredClone(job.request); return scan(); }));
      } else if (job.status === "awaiting_validation") {
        const verify = button(validating ? "Validating…" : "Check workflows", () => validate(true), true); verify.disabled = validating; actions.push(verify);
      } else if (job.status === "complete") actions.push(button("Open Prompt Studio", close, true), button("Review setup", scan));
      else actions.push(button("Review setup", scan, true));
      renderFooter(actions);
    }
  }

  async function control(action) {
    if (actionBusy) return; actionBusy = true; clearError();
    try { state = await call(action, {}); lastValidated = ""; renderJob(); schedulePoll(); }
    finally { actionBusy = false; }
  }

  async function validate(force = false) {
    const job = state?.job;
    if (!job || validating || (!force && lastValidated === job.id)) return;
    validating = true; lastValidated = job.id; renderJob();
    try {
      const results = [];
      for (const item of job.workflows) {
        let error = "";
        try {
          const response = await api.fetchApi(`/userdata/${encodeURIComponent(`workflows/${item.path}`)}`);
          if (!response.ok) throw new Error(`Cannot read ${item.path}`);
          const workflow = await response.json();
          const profile = await buildWorkflow({path: item.path, modified: Date.now()}, workflow, null);
          if (profile.kind !== item.role) throw new Error(`Expected ${item.role}, detected ${profile.kind}`);
        } catch (failure) { error = failure.message || String(failure); }
        results.push({path: item.path, role: item.role, error});
      }
      state = await call("finish", {job_id: job.id, results});
      if (state.job.status === "complete") {
        await refreshWorkflows(); await applyDefaults?.(job.workflows);
      }
    } catch (error) { showError(error); }
    finally { validating = false; renderJob(); updateSummary(); }
  }

  function updateSummary() {
    const summary = panel.querySelector("#promptstudio-setup-summary");
    const launch = panel.querySelector("#promptstudio-run-setup");
    if (!summary) return;
    const job = state?.job;
    const attention = job && (busyStates.has(job.status) || resumableStates.has(job.status) || job.status === "awaiting_validation");
    const phase = job?.status === "paused" ? "Paused" : job?.status === "awaiting_validation" ? "Verify workflows" : job?.phase;
    summary.textContent = attention ? `${phase} · ${job.item || "Setup in progress"}` :
      job?.status === "complete" ? "Selected workflows ready" : state?.onboarding === "deferred" ? "Setup postponed" : "Check workflows, models and prerequisites";
    if (launch) launch.textContent = attention ? "View setup" : "Run setup";
    const badge = panel.querySelector("#promptstudio-setup-activity");
    if (badge) { badge.hidden = !attention; badge.textContent = `Setup: ${phase || ""}`; }
  }

  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    if (!state?.job || !busyStates.has(state.job.status)) return;
    pollTimer = setTimeout(async () => {
      try {
        state = await call("status"); renderJob(); updateSummary();
        if (state.job?.status === "awaiting_validation" && dialog?.open) await validate();
      } catch (error) { showError(error); }
      schedulePoll();
    }, 800);
  }

  return {open, maybeOpen, destroy() { if (pollTimer) clearTimeout(pollTimer); dialog?.remove(); }};
}
