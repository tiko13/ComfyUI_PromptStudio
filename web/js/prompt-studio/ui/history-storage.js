import { installDialogFocus } from "./dialog-focus.js";

const size = bytes => `${(Number(bytes || 0) / 1048576).toFixed(2)} MiB`;

export async function openHistoryStorage({ ownerDocument = document, endpoint, fetchApi, beforeOpen, onRestored }) {
  await beforeOpen?.();
  const make = (tag, text) => {
    const element = ownerDocument.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const dialog = make("dialog");
  dialog.setAttribute("aria-label", "History storage");
  dialog.style.cssText = "box-sizing:border-box;width:min(620px,calc(100vw - 24px));max-height:85vh;overflow:auto;padding:24px;border:1px solid #657080;border-radius:12px;background:#20242b;color:#f0f2f5;font:14px/1.5 system-ui;";
  const heading = make("h2", "History storage");
  const status = make("p", "Loading…");
  status.setAttribute("role", "status");
  const content = make("div");
  const close = make("button", "Close");
  close.addEventListener("click", () => dialog.close());
  dialog.append(heading, status, content, close);
  installDialogFocus(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  ownerDocument.body.append(dialog);
  dialog.showModal();
  let busy = false;
  const request = async (suffix = "", body) => {
    const response = await fetchApi(endpoint + suffix, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `History storage request failed (${response.status}).`);
    return data;
  };
  const work = async action => {
    if (busy) return;
    busy = true;
    const controls = [...dialog.querySelectorAll("button,select,input")];
    const previous = controls.map(control => control.disabled);
    controls.forEach(control => { control.disabled = true; });
    try { await action(); }
    catch (error) { status.textContent = error.message || String(error); }
    finally { controls.forEach((control, index) => { control.disabled = previous[index]; }); busy = false; }
  };
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  const load = async () => {
    const data = await request();
    if (!dialog.isConnected) return;
    if (!Number.isInteger(data.revision) || !Array.isArray(data.checkpoints) || !data.policy) throw new Error("Invalid history storage response.");
    content.replaceChildren();
    status.textContent = data.maintenance?.error || (data.maintenance?.budget_exceeded ? "The minimum recovery fallback exceeds the storage budget and has been preserved." : "Current sessions are preserved. Recovery checkpoints expire automatically.");
    content.append(make("p", `Current history: ${size(data.current_bytes)} · Recovery storage: ${size(data.recovery_bytes)} · Other / migration backups: ${size(data.other_bytes)}`));
    const policy = data.policy;
    content.append(make("p", `Recovery: ${policy.recent} recent saves, daily checkpoints for ${policy.daily_days} days, weekly checkpoints for ${policy.weekly_weeks} weeks. Recovery budget: ${size(policy.budget_bytes)}. Oldest checkpoints may expire earlier to meet the budget.`));
    if (data.maintenance?.legacy_expires_at && data.maintenance.legacy_expires_at * 1000 > Date.now()) content.append(make("p", `Temporary legacy backups expire ${new Date(data.maintenance.legacy_expires_at * 1000).toLocaleString()}.`));
    const optimize = make("button", "Optimize now");
    optimize.addEventListener("click", () => work(async () => { status.textContent = "Verifying and optimizing history…"; await request("", { action: "optimize" }); await load(); }));
    const refresh = make("button", "Refresh");
    refresh.addEventListener("click", () => work(load));
    content.append(optimize, refresh, make("h3", "Restore one session"));
    if (!data.checkpoints.length) { content.append(make("p", "No recovery checkpoints yet.")); return; }
    const checkpoint = make("select");
    checkpoint.setAttribute("aria-label", "Recovery checkpoint");
    checkpoint.style.cssText = "display:block;width:100%;margin:8px 0;";
    checkpoint.append(new ownerDocument.defaultView.Option("Choose a checkpoint", ""));
    for (const item of data.checkpoints) checkpoint.append(new ownerDocument.defaultView.Option(`${new Date(item.saved_at * 1000).toLocaleString()} · Revision ${item.revision}`, String(item.revision)));
    const records = make("select");
    records.setAttribute("aria-label", "Session to restore");
    records.style.cssText = checkpoint.style.cssText;
    records.disabled = true;
    const confirm = make("input");
    confirm.type = "checkbox";
    const label = make("label");
    label.style.display = "block";
    label.append(confirm, ownerDocument.createTextNode(" Replace this session with its saved version. Other sessions are preserved."));
    const restore = make("button", "Restore selected session");
    restore.disabled = true;
    const update = () => { restore.disabled = !records.value || !confirm.checked; };
    records.addEventListener("change", () => { confirm.checked = false; update(); });
    confirm.addEventListener("change", update);
    checkpoint.addEventListener("change", () => work(async () => {
      confirm.checked = false; records.replaceChildren(); restore.disabled = true;
      if (!checkpoint.value) return;
      const snapshot = await request(`?checkpoint=${encodeURIComponent(checkpoint.value)}`);
      if (!Array.isArray(snapshot.records)) throw new Error("Invalid checkpoint response.");
      for (const record of snapshot.records) {
        const summary = record.summary || {};
        const created = summary.createdAt ?? (Number(summary.created_at || 0) * 1000);
        const date = created ? ` · ${new Date(created).toLocaleString()}` : "";
        records.append(new ownerDocument.defaultView.Option(`${summary.title || summary.name || record.id}${date} (${summary.messageCount ?? summary.generation_count ?? 0} entries)`, record.id));
      }
    }).then(() => { records.disabled = !records.options.length; update(); }));
    restore.addEventListener("click", () => work(async () => {
      const result = await request("", { action: "restore", revision: data.revision, checkpoint: Number(checkpoint.value), record_id: records.value });
      if (result.ok !== true || !Number.isInteger(result.revision)) throw new Error("Invalid restore acknowledgement. Refresh history before retrying.");
      await onRestored?.();
      dialog.close();
    }));
    content.append(checkpoint, records, label, restore);
  };
  await work(load);
}
