// Development checks validate these public enums against wire-contract-enums.json.
// Browser startup uses plain JavaScript; no compiler or JSON module loader is needed.
export const WIRE_VERSION = 1;
export const PROVIDERS = /** @type {const} */ (["koboldcpp", "ollama", "llamacpp"]);
export const JOB_STATUSES = /** @type {const} */ (["queued", "running", "complete", "failed", "cancelled"]);
export const THINKING_MODES = /** @type {const} */ (["Disabled", "Minimal", "Low", "Medium", "High", "XHigh"]);
export const JOB_TRANSITIONS = /** @type {const} */ ({
  queued: ["running", "failed", "cancelled"], running: ["complete", "failed", "cancelled"],
  complete: [], failed: [], cancelled: [],
});

/** @typedef {typeof PROVIDERS[number]} LlmProvider */
/** @typedef {typeof JOB_STATUSES[number]} JobStatus */
/** @typedef {'Disabled'|'Minimal'|'Low'|'Medium'|'High'|'XHigh'} ThinkingMode */
/** @typedef {'max_response_tokens'|'llamacpp_reasoning_budget_tokens'|'temperature'|'top_p'|'top_k'|'min_p'|'presence_penalty'|'rep_pen'|'rep_pen_range'|'thinking_temperature'|'thinking_top_p'|'thinking_top_k'|'thinking_min_p'|'thinking_presence_penalty'|'thinking_rep_pen'|'thinking_rep_pen_range'|'sampler_seed'|'request_timeout'} ProfileNumberKey */
/** @typedef {Record<ProfileNumberKey, number> & {id:string, name:string, thinking_mode:ThinkingMode, thinking_modes:readonly ThinkingMode[], stop_sequence:string}} LlmProfile */
/** @typedef {{workflow:Record<string, unknown>, output:Record<string, unknown>}} WorkflowSnapshot */
/** @typedef {{wire_version:1, kind:'workflow_snapshot', snapshot:WorkflowSnapshot}} SnapshotWire */
/** @typedef {{wire_version:1, kind:'llm_job', job_id:string} & ({status:'queued'|'running'}|{status:'complete', result:unknown}|{status:'failed', error:string}|{status:'cancelled'})} JobWire */
/** @typedef {{wire_version:1, llm_provider:LlmProvider, kobold_url:string, ollama_url:string, ollama_model:string, llamacpp_url:string, llamacpp_model:string, llamacpp_executable:string, llamacpp_config_profile:string, llamacpp_autostart:boolean, thinking_mode:ThinkingMode, max_response_tokens:number, llamacpp_reasoning_budget_tokens:number, temperature:number, top_p:number, top_k:number, min_p:number, presence_penalty:number, rep_pen:number, rep_pen_range:number, sampler_seed:number, request_timeout:number, stop_sequence:string}} ProviderSettings */

/** @param {unknown} value @returns {Record<string, unknown>} */
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Wire value must be an object.");
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Record<string, unknown>} value */
function version(value) {
  if (value.wire_version !== undefined && value.wire_version !== WIRE_VERSION) throw new TypeError("Unsupported wire version.");
}

/** @param {unknown} value @returns {LlmProvider} */
export function normalizeLlmProvider(value) {
  const name = String(value || "").trim().toLowerCase();
  return PROVIDERS.find(provider => provider === name) || "koboldcpp";
}

/** Explicit migration of unversioned provider settings; v1 rejects invalid discriminants.
 * @param {unknown} value @param {{strict?:boolean}} options @returns {ProviderSettings}
 */
export function normalizeProviderSettings(value, { strict = false } = {}) {
  const source = object(value);
  version(source);
  const provider = normalizeLlmProvider(source.llm_provider);
  if (source.wire_version === 1 && source.llm_provider !== provider) throw new TypeError("Invalid llm_provider.");
  /** @param {string} key @param {number} fallback @param {number} min @param {number} max */
  const number = (key, fallback, min, max) => {
    const raw = source[key];
    const value = raw === undefined ? fallback : raw === null ? NaN : Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) throw new TypeError(`Invalid provider field ${key}.`);
    return value;
  };
  const thinking = THINKING_MODES.find(mode => mode === source.thinking_mode) || "Disabled";
  if (source.wire_version === 1 && source.thinking_mode !== undefined && source.thinking_mode !== thinking) throw new TypeError("Invalid thinking_mode.");
  const result = {
    wire_version: /** @type {const} */ (1), llm_provider: provider,
    kobold_url: String(source.kobold_url ?? "http://localhost:5001"),
    ollama_url: String(source.ollama_url ?? "http://localhost:11434"), ollama_model: String(source.ollama_model ?? ""),
    llamacpp_url: String(source.llamacpp_url ?? "http://localhost:8080"), llamacpp_model: String(source.llamacpp_model ?? ""),
    llamacpp_executable: String(source.llamacpp_executable ?? ""), llamacpp_config_profile: String(source.llamacpp_config_profile ?? ""),
    llamacpp_autostart: source.llamacpp_autostart === true, thinking_mode: thinking,
    max_response_tokens: number("max_response_tokens", 800, 0, 131072),
    llamacpp_reasoning_budget_tokens: number("llamacpp_reasoning_budget_tokens", 0, 0, 262144),
    temperature: number("temperature", 0.7, 0, 5), top_p: number("top_p", 0.9, 0, 1),
    top_k: number("top_k", 100, 0, 200), min_p: number("min_p", 0, 0, 1),
    presence_penalty: number("presence_penalty", 0, -2, 2), rep_pen: number("rep_pen", 1.05, 0.5, 3),
    rep_pen_range: number("rep_pen_range", 360, 0, 4096), sampler_seed: number("sampler_seed", -1, -1, 999999),
    request_timeout: number("request_timeout", 120, 5, 3600), stop_sequence: String(source.stop_sequence ?? ""),
  };
  if (strict && Object.keys(source).some(key => !Object.hasOwn(result, key))) throw new TypeError("Unknown provider field.");
  return result;
}

/** @param {unknown} value @returns {SnapshotWire} */
export function normalizeSnapshotWire(value) {
  const source = object(value);
  version(source);
  const snapshot = object(source.wire_version === 1 ? source.snapshot : source);
  if (source.wire_version === 1 && source.kind !== "workflow_snapshot") throw new TypeError("Invalid snapshot kind.");
  return { wire_version: 1, kind: "workflow_snapshot", snapshot: {
    ...structuredClone(snapshot),
    workflow: structuredClone(object(snapshot.workflow)), output: structuredClone(object(snapshot.output)),
  } };
}

/** Migrate legacy complete/error spelling without inventing missing results.
 * @param {unknown} value @returns {JobWire}
 */
export function normalizeJobWire(value) {
  const source = object(value);
  version(source);
  if (source.wire_version === 1 && source.kind !== "llm_job") throw new TypeError("Invalid job kind.");
  const status = source.wire_version === undefined && source.status === "error" ? "failed" : source.status;
  const job_id = String(source.job_id || "");
  if (!job_id) throw new TypeError("Job ID is required.");
  const base = { wire_version: /** @type {const} */ (1), kind: /** @type {const} */ ("llm_job"), job_id };
  if (status === "queued" || status === "running" || status === "cancelled") return { ...base, status };
  if (status === "complete" && Object.hasOwn(source, "result")) return { ...base, status, result: structuredClone(source.result) };
  if (status === "failed" && typeof source.error === "string") return { ...base, status, error: source.error };
  throw new TypeError("Invalid job status or missing terminal result/error.");
}

/** @template {JobStatus} S
 * @param {S} from @param {typeof JOB_TRANSITIONS[S][number]} to
 * @returns {void}
 */
export function assertJobTransition(from, to) {
  if (!(/** @type {readonly string[]} */ (JOB_TRANSITIONS[from])).includes(to)) throw new TypeError(`Invalid job transition ${from} -> ${to}.`);
}

/** Polls can miss intermediate states, but may never regress or revive a terminal job.
 * @param {JobStatus} from @param {JobStatus} to
 */
export function assertObservedJobTransition(from, to) {
  if (from === to) return;
  const reachable = new Set(/** @type {readonly string[]} */ (JOB_TRANSITIONS[from]));
  for (const status of reachable) for (const next of JOB_TRANSITIONS[/** @type {JobStatus} */ (status)]) reachable.add(next);
  if (!reachable.has(to)) throw new TypeError(`Invalid observed job transition ${from} -> ${to}.`);
}
