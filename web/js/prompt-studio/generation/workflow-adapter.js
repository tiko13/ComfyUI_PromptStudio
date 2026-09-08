import { normalizeSnapshotWire } from "../core/wire-contracts.js";
import { sha256 } from "./sha256.js";
import { PROMPT_STUDIO_INPUT_PROFILE_VERSION, extractPromptStudioInputs, serializedWorkflowNodes } from "./prompt-studio-input.js";

export const WORKFLOW_ADAPTER_VERSION = 1;
const conversions = new WeakMap();

function canonical(value, seen = new Set()) {
  if (value === undefined) return null;
  if (typeof value === "function") return String(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) throw new Error("Workflow/capability data contains a cycle.");
  const nested = new Set([...seen, value]);
  if (Array.isArray(value)) return value.map(item => canonical(item, nested));
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], nested)]));
}

async function digest(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  return sha256(bytes);
}

export function discoverWorkflowFiles(files, prefix) {
  return (Array.isArray(files) ? files : []).filter(file => {
    if (typeof file?.path !== "string") return false;
    const path = file.path.replaceAll("\\", "/");
    const filename = path.split("/").at(-1) || "";
    return filename.startsWith(prefix) && filename.toLowerCase().endsWith(".json");
  }).map(file => ({ ...file, path: file.path.replaceAll("\\", "/") }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export async function workflowCacheIdentity(workflowData, { adapterId, adapterVersion = 1, capabilities = {}, registry = globalThis.LiteGraph?.registered_node_types || {} }) {
  const subgraphTypes = new Set((workflowData?.definitions?.subgraphs || []).map(definition => String(definition.id)));
  const classes = [...new Set(serializedWorkflowNodes(workflowData).map(({ node }) => String(node.type)).filter(type => !subgraphTypes.has(type)))].sort();
  const nodes = Object.fromEntries(classes.map(type => [type, registry[type]?.nodeData || null]));
  return {
    version: 1, adapterId, adapterVersion, conversionVersion: WORKFLOW_ADAPTER_VERSION,
    inputVersion: PROMPT_STUDIO_INPUT_PROFILE_VERSION,
    contentHash: await digest(workflowData), capabilityHash: await digest({ capabilities, nodes }),
  };
}

export function normalizeWorkflowCacheIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!["image", "minimax_h3"].includes(value.adapterId)) return null;
  if (!["version", "adapterVersion", "conversionVersion", "inputVersion"].every(key => Number.isInteger(value[key]) && value[key] > 0)) return null;
  if (!["contentHash", "capabilityHash"].every(key => /^[0-9a-f]{64}$/.test(value[key]))) return null;
  return Object.fromEntries(["version", "adapterId", "adapterVersion", "conversionVersion", "inputVersion", "contentHash", "capabilityHash"].map(key => [key, value[key]]));
}

export function workflowCacheMatches(cached, identity) {
  const saved = normalizeWorkflowCacheIdentity(cached?.cacheIdentity);
  return !cached?.stale && saved !== null && JSON.stringify(saved) === JSON.stringify(normalizeWorkflowCacheIdentity(identity));
}

function bridgeSubgraphs(app, graph, workflowData) {
  const definitions = workflowData?.definitions?.subgraphs || [];
  if (!definitions.length) return () => {};
  const root = app.rootGraph || app.graph;
  if (!graph.events?.addEventListener || !root?.events?.dispatch) throw new Error("ComfyUI subgraph conversion is unavailable.");
  const registry = globalThis.LiteGraph?.registered_node_types;
  const originals = new Map(definitions.map(definition => {
    const id = String(definition.id);
    return [id, { subgraph: root.subgraphs?.get(id), descriptor: registry && Object.getOwnPropertyDescriptor(registry, id) }];
  }));
  const listener = event => root.events.dispatch("subgraph-created", event.detail);
  graph.events.addEventListener("subgraph-created", listener);
  return () => {
    graph.events.removeEventListener("subgraph-created", listener);
    for (const [id, original] of originals) {
      if (original.subgraph) {
        root.events.dispatch("subgraph-created", { subgraph: original.subgraph, data: original.subgraph.asSerialisable?.() || { id } });
        root.subgraphs?.set?.(id, original.subgraph);
      } else root.subgraphs?.delete?.(id);
      if (registry) {
        if (original.descriptor) Object.defineProperty(registry, id, original.descriptor);
        else delete registry[id];
      }
    }
  };
}

export function executableWorkflowNodes(graph, snapshot, workflowData) {
  const serialized = new Map(serializedWorkflowNodes(workflowData).map(record => [record.id, record.node]));
  return Object.entries(snapshot.output).map(([id, output]) => {
    const data = serialized.get(id) || {};
    const live = id.includes(":") ? null : (graph.getNodeById?.(id) || graph.getNodeById?.(Number(id)));
    const type = String(output.class_type || data.type || "");
    const node = live || { ...data, id, type, title: data.title || output._meta?.title || type,
      constructor: globalThis.LiteGraph?.registered_node_types?.[type] || {} };
    return { id, type, node, output };
  });
}

export function workflowResultOutputs(history, resultNodeIds, resultFields) {
  const outputs = [];
  const seen = new Set();
  const nodeIds = resultNodeIds?.length ? resultNodeIds : Object.keys(history?.outputs || {});
  for (const id of nodeIds) {
    const node = history?.outputs?.[String(id)] || {};
    const fields = resultFields?.length ? resultFields : Object.keys(node);
    for (const field of fields) {
    const values = node[field];
    for (const output of Array.isArray(values) ? values : [values]) {
      if (!output || typeof output !== "object" || !output.filename) continue;
      const key = JSON.stringify([output.filename, output.subfolder || "", output.type || "output"]);
      if (seen.has(key)) continue;
      seen.add(key);
      outputs.push(structuredClone(output));
    }
    }
  }
  return outputs;
}

/** Convert on a private graph; serialize temporary global subgraph registration
 * across Image and Video. Never replace app.graph or register an extension.
 */
export function createWorkflowAdapter({ app, adapterId, adapterVersion = 1, capabilities = {}, build }) {
  return async function buildWorkflow(file, workflowData, cached = null) {
    const identity = await workflowCacheIdentity(workflowData, { adapterId, adapterVersion, capabilities });
    if (workflowCacheMatches(cached, identity)) return structuredClone(cached);
    const predecessor = conversions.get(app) || Promise.resolve();
    const operation = predecessor.catch(() => {}).then(async () => {
      const Graph = app.rootGraph?.constructor || app.graph?.constructor;
      if (typeof Graph !== "function") throw new Error("ComfyUI's workflow graph is not ready.");
      const graph = new Graph();
      const restore = bridgeSubgraphs(app, graph, workflowData);
      try {
        const errors = graph.configure(structuredClone(workflowData));
        if (Array.isArray(errors) ? errors.length > 0 : Boolean(errors)) throw new Error("ComfyUI could not configure one or more workflow nodes.");
        const definitionIds = new Set((workflowData?.definitions?.subgraphs || []).map(definition => String(definition.id)));
        if ((graph._nodes || []).some(node => definitionIds.has(String(node.type)) && !node.isSubgraphNode?.())) throw new Error("ComfyUI could not resolve a serialized subgraph.");
        const snapshot = normalizeSnapshotWire(await app.graphToPrompt(graph)).snapshot;
        const nodes = executableWorkflowNodes(graph, snapshot, workflowData);
        const additionalInputs = extractPromptStudioInputs(graph, snapshot, workflowData);
        const result = await build({ file, workflowData, graph, snapshot, nodes, additionalInputs, cached });
        return { ...result, cacheIdentity: identity, promptStudioInputVersion: PROMPT_STUDIO_INPUT_PROFILE_VERSION };
      } finally {
        try { graph.stop?.(); graph.clear?.(); } finally { restore(); }
      }
    });
    conversions.set(app, operation);
    try { return await operation; }
    finally { if (conversions.get(app) === operation) conversions.delete(app); }
  };
}
