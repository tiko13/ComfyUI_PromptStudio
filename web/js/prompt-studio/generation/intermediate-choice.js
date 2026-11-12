export const CHOICE_TYPE = "PS_IntermediateChoice";
const SOURCE_TYPE = "PS_IntermediateSource";
const copy = value => structuredClone(value);
const link = value => Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]);
export const hasChoices = snapshot => Object.values(snapshot?.output || {}).some(node => node.class_type === CHOICE_TYPE);

// Persist only completed media references, never the live continuation tokens.
export function normalizeChoiceStages(value) {
  return Array.isArray(value) ? value.filter(stage => stage && typeof stage.promptId === "string" && Array.isArray(stage.outputs))
    .map(stage => ({promptId: stage.promptId, outputs: stage.outputs.filter(output => output && typeof output.filename === "string").map(copy)})) : [];
}

export function recordChoiceStage(stages, promptId, outputs) {
  const result = normalizeChoiceStages(stages), stage = {promptId: String(promptId), outputs: copy(outputs)};
  const index = result.findIndex(item => item.promptId === stage.promptId);
  if (index < 0) result.push(stage); else result[index] = stage;
  return result;
}

export const choiceMediaKey = output => JSON.stringify([output?.type || "output", output?.subfolder || "", output?.filename || ""]);
export function choiceStageOutputs(stages) {
  return [...new Map(normalizeChoiceStages(stages).flatMap(stage => stage.outputs).map(output => [choiceMediaKey(output), output])).values()];
}

export function choiceLabels(value) {
  const labels = String(value || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!labels.length || labels.length > 32 || labels.some(s => s.length > 120)) throw Error("Intermediate / Choice needs 1–32 labels, one per line (at most 120 characters each).");
  return labels;
}

/** Cut all unchosen edges before collecting dependencies. Only one branch can execute.
 * Selected gates become memory sources; original samplers are never their ancestors.
 */
export function choiceStage(snapshot, resultIds, selections = {}) {
  const output = copy(snapshot.output), blocked = new Set();
  const gates = Object.entries(output).filter(([, node]) => node.class_type === CHOICE_TYPE);
  for (const [id, gate] of gates) {
    const labels = choiceLabels(gate.inputs.options), selected = selections[id];
    if (selected && (!Number.isInteger(selected.index) || !labels[selected.index])) throw Error("Unknown Intermediate option.");
    for (const [target, node] of Object.entries(output)) {
      for (const [name, input] of Object.entries(node.inputs || {})) {
        if (!link(input) || input[0] !== id) continue;
        if (!selected || input[1] !== selected.index) blocked.add(target);
        else node.inputs[name] = [id, 0];
      }
    }
    if (selected) {
      const latent = gate.inputs.latent;
      output[id] = {class_type: SOURCE_TYPE, inputs: {token: selected.token, ticket: selected.ticket}};
      if (link(latent)) for (const [target, node] of Object.entries(output)) {
        if (target === id) continue;
        for (const [name, input] of Object.entries(node.inputs || {})) {
          if (link(input) && input[0] === latent[0] && input[1] === latent[1]) node.inputs[name] = [id, 1];
        }
      }
    }
  }
  // Sources have no upstream dependencies, even when their original gates were tainted.
  for (const id of Object.keys(selections)) blocked.delete(id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, node] of Object.entries(output)) if (!blocked.has(id) &&
      Object.values(node.inputs || {}).some(input => link(input) && blocked.has(input[0]))) {
      blocked.add(id); changed = true;
    }
  }
  const candidates = [...new Set([...gates.filter(([id]) => !selections[id]).map(([id]) => id), ...resultIds.map(String)])]
    .filter(id => output[id] && !blocked.has(id) && !selections[id]);
  if (candidates.length !== 1) throw Error(`Each Intermediate stage needs exactly one image/video output or Choice node; found ${candidates.length}. Route each branch through its own output.`);
  const target = candidates[0], required = new Set(), visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) throw Error("Intermediate workflow contains a cycle.");
    if (required.has(id)) return;
    if (!output[id] || blocked.has(id)) throw Error("Intermediate branch has a missing or unchosen dependency.");
    visiting.add(id);
    for (const value of Object.values(output[id].inputs || {})) if (link(value)) visit(value[0]);
    visiting.delete(id); required.add(id);
  }
  visit(target);
  const stage = {...copy(snapshot), output: Object.fromEntries([...required].map(id => [id, output[id]]))};
  const gate = output[target].class_type === CHOICE_TYPE ? {id: target, message: String(output[target].inputs.message || ""), labels: choiceLabels(output[target].inputs.options)} : null;
  return {snapshot: stage, resultIds: [target], gate};
}

export function validateChoiceGraph(snapshot, resultIds) {
  if (!hasChoices(snapshot)) return;
  const pending = [{}]; let count = 0;
  while (pending.length) {
    if (++count > 256) throw Error("Intermediate workflow has too many alternative routes to validate.");
    const selected = pending.pop(), stage = choiceStage(snapshot, resultIds, selected);
    if (!stage.gate) continue;
    stage.gate.labels.forEach((_, index) => {
      if (!Object.values(snapshot.output).some(node => Object.values(node.inputs || {}).some(input => link(input) && input[0] === stage.gate.id && input[1] === index))) {
        throw Error(`Connect Intermediate option '${stage.gate.labels[index]}' to its continuation.`);
      }
      pending.push({...selected, [stage.gate.id]: {index, token: "validation", ticket: "validation"}});
    });
  }
}

/** All state stays outside chat/project persistence. Tokens are released on invalidation.
 * Browser reload cannot reconstruct a choice from saved history.
 */
export function createChoiceController({fetchApi, changed = () => {}, reportError = () => {}}) {
  const scopes = new Map(), prompts = new Map(), revisions = new Map();
  const request = async (action, data = {}) => {
    const response = await fetchApi(`/promptstudio/choices/${action}`, {method: "POST", keepalive: action === "release", headers: {"Content-Type": "application/json"}, body: JSON.stringify(data)});
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "Intermediate choice failed.");
    return result;
  };
  const release = entry => { for (const token of entry?.tokens || []) void request("release", {token}).catch(() => {}); };
  function invalidate(scope) {
    revisions.set(scope, (revisions.get(scope) || 0) + 1);
    const entry = scopes.get(scope);
    scopes.delete(scope);
    if (entry) { for (const [id, saved] of prompts) if (saved === entry) prompts.delete(id); release(entry); changed(); }
    return revisions.get(scope);
  }
  async function prepare(scope, snapshot, resultIds, continuation = null, revision = null) {
    let entry;
    if (continuation) {
      entry = continuation;
      if (scopes.get(scope) !== entry || !entry.claimed) throw Error("This choice has expired.");
    } else {
      if (!hasChoices(snapshot)) return {snapshot, resultIds};
      if (revision !== null && revisions.get(scope) !== revision) throw Error("This generation was superseded.");
      if (revision === null) invalidate(scope);
      resultIds = snapshot.workflow?.extra?.promptstudio_choice_results || resultIds;
      validateChoiceGraph(snapshot, resultIds);
      entry = {scope, snapshot: copy(snapshot), resultIds: [...resultIds], selections: {}, tokens: new Set(), ready: false};
      scopes.set(scope, entry);
    }
    const stage = choiceStage(entry.snapshot, entry.resultIds, entry.selections);
    entry.stage = stage; entry.ready = false; entry.claimed = false;
    if (stage.gate) {
      const {token} = await request("reserve");
      if (scopes.get(scope) !== entry) { void request("release", {token}); throw Error("This generation was superseded."); }
      entry.tokens.add(token); entry.token = token;
      stage.snapshot.output[stage.gate.id].inputs._choice_token = token;
    }
    return {...stage, entry};
  }
  function bind(prepared, promptId, run) {
    if (!prepared.entry) return;
    const entry = prepared.entry;
    entry.run = run; entry.promptId = String(promptId);
    prompts.set(String(promptId), entry);
  }
  function abort(prepared) {
    const entry = prepared?.entry;
    if (entry && scopes.get(entry.scope) === entry) invalidate(entry.scope);
  }
  async function complete(promptId, success = true) {
    const entry = prompts.get(String(promptId));
    if (!entry || scopes.get(entry.scope) !== entry || entry.promptId !== String(promptId)) return false;
    if (!success || !entry.stage.gate) { invalidate(entry.scope); return false; }
    const status = await request("status", {token: entry.token});
    if (scopes.get(entry.scope) !== entry) return false;
    entry.ready = status.state === "ready";
    if (!entry.ready) { invalidate(entry.scope); return false; }
    changed(); return true;
  }
  async function select(entry, index) {
    if (scopes.get(entry.scope) !== entry || !entry.ready || entry.claimed) return;
    entry.ready = false; entry.claimed = true; changed();
    try {
      const {ticket} = await request("claim", {token: entry.token, index});
      if (scopes.get(entry.scope) !== entry) return;
      entry.selections[entry.stage.gate.id] = {index, token: entry.token, ticket};
      await entry.run(entry);
    } catch (error) { if (scopes.get(entry.scope) === entry) invalidate(entry.scope); reportError(error); }
  }
  function mount(container, promptId, disabled = false) {
    container.querySelectorAll(":scope > .studio-choice-overlay").forEach(node => node.remove());
    const entry = prompts.get(String(promptId));
    if (!entry?.ready || entry.promptId !== String(promptId) || scopes.get(entry.scope) !== entry) return;
    const doc = container.ownerDocument, overlay = doc.createElement("div");
    overlay.className = "studio-choice-overlay";
    overlay.style.cssText = "position:absolute;right:12px;bottom:12px;z-index:3;max-width:calc(100% - 24px);padding:10px;border-radius:10px;background:rgba(16,20,26,.9);color:white;display:flex;flex-wrap:wrap;gap:8px;align-items:center;box-sizing:border-box";
    container.style.position = "relative";
    const message = doc.createElement("span"); message.textContent = entry.stage.gate.message; overlay.append(message);
    entry.stage.gate.labels.forEach((label, index) => {
      const button = doc.createElement("button"); button.type = "button"; button.textContent = label; button.disabled = disabled;
      button.style.cssText = "min-height:44px;padding:8px 14px;background:#f0f4fa;color:#142033;border:1px solid #8495ac;border-radius:8px;font:inherit;cursor:pointer";
      button.addEventListener("click", event => { event.stopPropagation(); void select(entry, index); }); overlay.append(button);
    });
    overlay.addEventListener("click", event => event.stopPropagation()); container.append(overlay);
  }
  const dispose = () => { for (const scope of [...scopes.keys()]) invalidate(scope); };
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", dispose);
    // A live tab renews pending choices; abandoned/disconnected sessions expire server-side.
    const timer = setInterval(() => {
      for (const entry of scopes.values()) if (entry.ready) void request("status", {token: entry.token})
        .then(result => { if (result.state !== "ready" && scopes.get(entry.scope) === entry) invalidate(entry.scope); }).catch(() => {});
    }, 60000);
    window.addEventListener("pagehide", () => clearInterval(timer), {once: true});
  }
  return {prepare, bind, complete, invalidate, mount, dispose, abort,
    pending: promptId => { const entry = prompts.get(String(promptId)); return Boolean(entry?.ready && entry.promptId === String(promptId) && scopes.get(entry.scope) === entry); }};
}
