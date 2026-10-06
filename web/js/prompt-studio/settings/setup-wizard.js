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
  let selections = {packs: ["create", "edit", "upscale"], choices: {}, license_acceptances: {}};
  let licenseDialog;
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
    const title = el("h2", "", "Set up Prompt Studio"); title.id = "promptstudio-setup-title";
    titles.append(title, el("p", "", "Choose workflows. Reuse installed models or download what’s missing."));
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
    const scrollTop = content.scrollTop;
    const focused = doc().activeElement;
    const focusKey = focused?.dataset.setupPack || focused?.dataset.setupModel;
    const focusAttribute = focused?.dataset.setupPack ? "setupPack" : "setupModel";
    const expanded = [...content.querySelectorAll("details[open][data-setup-details]")].map(node => node.dataset.setupDetails);
    content.setAttribute("aria-busy", "true");
    if (!plan || !content.querySelector(".promptstudio-setup-packs")) {
      content.replaceChildren(el("p", "promptstudio-setup-checking", "Checking models and workflows…"));
      renderFooter([]);
    } else {
      renderModels(true);
      dialog.querySelectorAll("[data-setup-content] input,[data-setup-content] select,[data-setup-footer] button").forEach(control => { control.disabled = true; });
    }
    try {
      const next = await call("plan", selections);
      if (sequence !== scanSequence) return;
      plan = next; state = next.state;
      selections.choices = Object.fromEntries(next.requirements.map(r => [r.id, r.choice]));
      renderPlan(); updateSummary();
      content.scrollTop = scrollTop;
      for (const details of content.querySelectorAll("details[data-setup-details]")) details.open = expanded.includes(details.dataset.setupDetails);
      if (focusKey) [...content.querySelectorAll("input,select")].find(node => node.dataset[focusAttribute] === focusKey)?.focus({preventScroll: true});
    } catch (error) {
      if (sequence === scanSequence) {
        // A failed refresh must not leave a stale plan startable or controls stuck.
        dialog.querySelectorAll("button,input,select").forEach(control => { control.disabled = false; });
        const startControl = dialog.querySelector("[data-setup-start]");
        if (startControl) startControl.disabled = true;
        const modelStatus = dialog.querySelector("[data-setup-model-status]");
        if (modelStatus) modelStatus.textContent = "Could not refresh model choices. Check again to retry.";
      }
      throw error;
    } finally {
      if (sequence === scanSequence) { checkBusy = false; content.removeAttribute("aria-busy"); }
    }
  }

  function acceptLicense(pack, trigger) {
    return new Promise(resolve => {
      const popup = el("dialog", "promptstudio-setup-dialog promptstudio-setup-license");
      licenseDialog = popup;
      popup.setAttribute("aria-labelledby", "promptstudio-setup-license-title");
      popup.setAttribute("aria-describedby", "promptstudio-setup-license-notice");
      const title = el("h2", "", "Strict non-commercial license"); title.id = "promptstudio-setup-license-title";
      const notice = el("p", "", pack.license.notice); notice.id = "promptstudio-setup-license-notice";
      const link = el("a", "", "Read the full Qwen Research License");
      link.href = pack.license.url; link.target = "_blank"; link.rel = "noreferrer";
      const body = el("div", "promptstudio-setup-content");
      body.append(title, el("strong", "", pack.name), notice, link);
      const footer = el("footer", "promptstudio-setup-footer");
      const cancel = button("Cancel", () => popup.close("cancel")); cancel.autofocus = true;
      footer.append(cancel, button("Accept", () => popup.close("accept"), true));
      popup.append(body, footer); panel.append(popup); installDialogFocus(popup);
      popup.addEventListener("cancel", event => { event.preventDefault(); popup.close("cancel"); });
      popup.addEventListener("click", event => {
        const bounds = popup.getBoundingClientRect();
        if (event.target === popup && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) popup.close("cancel");
      });
      popup.addEventListener("close", () => {
        const accepted = popup.returnValue === "accept";
        popup.remove(); licenseDialog = null; trigger?.focus({preventScroll: true}); resolve(accepted);
      }, {once: true});
      popup.showModal();
    });
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
    const packs = plan.available_packs || [{id: "create", name: "Create", family: "Krea2"}, {id: "edit", name: "Edit", family: "Krea2"}, {id: "upscale", name: "Upscale", family: "Krea2"}];
    const choices = el("div", "promptstudio-setup-packs");
    for (const family of new Set(packs.map(pack => pack.family || "Workflows"))) {
      const group = el("fieldset", "promptstudio-setup-family");
      group.append(el("legend", "", family));
      const options = packs.filter(pack => (pack.family || "Workflows") === family);
      if (options.some(pack => pack.license)) group.append(el("p", "promptstudio-setup-license-hint", "Non-commercial only · acceptance required for each workflow"));
      const grid = el("div", "promptstudio-setup-pack-grid");
      for (const pack of options) {
        const label = el("label"); const input = el("input");
        input.type = "checkbox"; input.checked = selections.packs.includes(pack.id);
        input.dataset.setupPack = pack.id; input.setAttribute("aria-label", pack.name);
        input.addEventListener("change", async () => {
          if (checkBusy || actionBusy || licenseDialog) { input.checked = selections.packs.includes(pack.id); return; }
          const selecting = input.checked;
          if (selecting && pack.license) {
            input.checked = false;
            if (!await acceptLicense(pack, input) || !dialog.open || !input.isConnected) return;
            selections.license_acceptances[pack.id] = pack.license.id;
            input.checked = true;
          }
          if (!selecting) delete selections.license_acceptances[pack.id];
          selections.packs = selecting ? [...selections.packs, pack.id] : selections.packs.filter(id => id !== pack.id);
          await scan().catch(showError);
        });
        label.append(input, el("span", "", pack.label || pack.name)); grid.append(label);
      }
      group.append(grid); choices.append(group);
    }
    content.append(choices);
    if (plan.available_addons?.length) {
      selections.addons ||= [];
      const group = el("fieldset", "promptstudio-setup-family");
      group.append(el("legend", "", "Optional · Structure guides (ControlNet)"));
      group.append(el("p", "", "Add to existing Qwen workflows. Edges and prepared guides need no extra extractor."));
      const grid = el("div", "promptstudio-setup-pack-grid");
      for (const addon of plan.available_addons) {
        const label = el("label"), input = el("input"); input.type = "checkbox";
        input.checked = selections.addons.includes(addon.id); input.dataset.setupPack = addon.id;
        input.setAttribute("aria-label", addon.name); label.title = addon.description;
        input.addEventListener("change", async () => {
          if (checkBusy || actionBusy || licenseDialog) { input.checked = selections.addons.includes(addon.id); return; }
          const selecting = input.checked;
          if (selecting && addon.license) {
            input.checked = false;
            if (!await acceptLicense(addon, input) || !dialog.open || !input.isConnected) return;
            selections.license_acceptances[addon.id] = addon.license.id;
          }
          if (!selecting) delete selections.license_acceptances[addon.id];
          selections.addons = selecting ? [...selections.addons, addon.id] : selections.addons.filter(id => id !== addon.id);
          await scan().catch(showError);
        });
        label.append(input, el("span", "", addon.name)); grid.append(label);
      }
      group.append(grid); content.append(group);
    }
    const modelsHeading = el("div", "promptstudio-setup-section-heading");
    modelsHeading.append(el("h3", "", "Models"), el("span", "", "Required by your selected workflows · shared files listed once"));
    content.append(modelsHeading);
    const list = el("div", "promptstudio-setup-requirements");
    list.dataset.setupModels = "";
    content.append(list);
    renderModels();
    const environment = el("details", "promptstudio-setup-environment"); environment.dataset.setupDetails = "environment";
    environment.append(el("summary", "", "Checks, workflow files and model terms"));
    const checks = el("div", "promptstudio-setup-checks");
    for (const check of plan.checks) checks.append(el("span", "", `${check.status === "ready" ? "✓" : "!"} ${check.name}`));
    checks.append(el("span", "", providerStatus?.() || "LLM: optional; direct prompting is available"));
    environment.append(checks);
    for (const pack of plan.packs) {
      if (pack.file) environment.append(el("p", "", `${pack.name}: ${pack.file} — ${pack.existing_status}`));
    }
    for (const dep of plan.node_packs) {
      const row = el("div", "promptstudio-setup-node-pack");
      row.append(el("strong", "", `${dep.name} · ${dep.outdated?.length ? "Update required" : dep.missing.length ? "Install with Manager" : "Loaded"}`));
      const link = el("a", "", "Source"); link.href = dep.url; link.target = "_blank"; link.rel = "noreferrer"; row.append(link);
      if (dep.missing.length) row.append(el("p", "", "ComfyUI Manager will install this node pack. A restart is required."));
      if (dep.missing.length || dep.outdated?.length) content.append(row); else environment.append(row);
    }
    for (const disk of plan.disks) environment.append(el("p", "", `${formatBytes(disk.free)} free at ${disk.path}`));
    for (const item of plan.licenses) { const a = el("a", "", item.name); a.href = item.url; a.target = "_blank"; a.rel = "noreferrer"; environment.append(a, el("br")); }
    content.append(environment);
    for (const blocker of plan.blockers) content.append(el("p", "promptstudio-setup-error", blocker));
    const summary = el("div", "promptstudio-setup-download-summary");
    summary.append(el("strong", "", `${formatBytes(plan.download_bytes)} to download`), el("span", "", `${plan.packs.length} workflows · ${plan.addons?.length || 0} optional features`));
    const startButton = button("Set up selections", start, true); startButton.dataset.setupStart = "";
    startButton.disabled = plan.blockers.length > 0;
    renderFooter([summary, button("Check again", () => { selections.choices = {}; return scan(); }), startButton]);
  }

  function renderModels(pending = false) {
    const list = dialog.querySelector("[data-setup-models]");
    if (!list) return;
    const expanded = new Set([...list.querySelectorAll("details[open]")].map(node => node.dataset.setupDetails));
    const selectedPacks = [...(plan.available_packs || plan.packs).filter(pack => selections.packs.includes(pack.id)),
      ...(plan.available_addons || []).filter(addon => selections.addons?.includes(addon.id))];
    const required = new Set(selectedPacks.flatMap(pack => pack.requirements || []));
    list.replaceChildren();
    for (const req of plan.requirements.filter(req => required.has(req.id))) {
      const row = el("section", "promptstudio-setup-requirement");
      const heading = el("div", "promptstudio-setup-row-heading");
      heading.append(el("h4", "", req.name), el("span", "promptstudio-setup-badge", req.status === "available" ? "Installed" : req.status === "blocked" ? "Needs attention" : "Download"));
      row.append(heading);
      const select = el("select"); select.setAttribute("aria-label", req.name); select.dataset.setupModel = req.id;
      for (const candidate of req.candidates) {
        const option = el("option", "", `Installed: ${candidate.name}`); option.value = candidate.name; select.append(option);
      }
      for (const asset of req.download_options) {
        const option = el("option", "", `${asset.name} · ${formatBytes(asset.size)}`); option.value = `__download__:${asset.id}`; select.append(option);
      }
      select.value = req.choice;
      select.addEventListener("change", () => { selections.choices[req.id] = select.value; void scan().catch(showError); });
      row.append(select);
      const details = el("details"); details.dataset.setupDetails = req.id;
      details.open = expanded.has(req.id);
      const usedBy = selectedPacks.filter(pack => pack.requirements?.includes(req.id)).map(pack => pack.name);
      details.append(el("summary", "", "Details"), el("p", "promptstudio-setup-used", `Used by ${usedBy.join(" · ")}`), el("p", "", req.description));
      const candidate = req.candidates.find(c => c.name === req.choice);
      if (candidate) details.append(el("p", "", candidate.evidence), el("p", "", candidate.path || candidate.name));
      else {
        const link = el("a", "", "Model source"); link.href = req.source; link.target = "_blank"; link.rel = "noreferrer";
        details.append(link, el("p", "", `Save to ${req.destination}`));
      }
      for (const rejected of req.rejected) details.append(el("p", "", `${rejected.name}: ${rejected.reason}`));
      row.append(details); list.append(row);
    }
    if (!required.size || pending) {
      const status = el("p", pending && required.size ? "promptstudio-setup-checking" : "", required.size ? "Updating models for your selections…" : "Select a workflow or optional feature to see its required models.");
      status.dataset.setupModelStatus = ""; status.setAttribute("role", "status"); list.append(status);
    }
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

  return {open, maybeOpen, destroy() { if (pollTimer) clearTimeout(pollTimer); licenseDialog?.close("cancel"); dialog?.remove(); }};
}
