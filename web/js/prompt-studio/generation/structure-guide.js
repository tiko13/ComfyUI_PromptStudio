export const GUIDE_TYPES = Object.freeze({pose: "Pose", depth: "Depth", edges: "Edges", sketch: "Sketch"});
export const isStructureReference = entry => entry?.use === "structure" || entry?.use === "both";
export const semanticReferences = entries => (entries || []).filter(entry => entry.use !== "structure");
function connected(output, link, target, visited = new Set()) {
  if (!Array.isArray(link) || link.length !== 2 || !Number.isInteger(link[1])) return false;
  const id = String(link[0]);
  if (id === target) return true;
  if (visited.has(id)) return false;
  visited.add(id);
  return Object.values(output[id]?.inputs || {}).some(value => connected(output, value, target, visited));
}
export function normalizeGuide(value) {
  return {type: Object.hasOwn(GUIDE_TYPES, value?.type) ? value.type : "edges",
    strength: Number.isFinite(Number(value?.strength)) ? Math.min(1, Math.max(0, Number(value.strength))) : 0.8,
    input: value?.input === "prepared" ? "prepared" : "photo", fit: value?.fit === "crop" ? "crop" : "fit",
    ...(value?.scope === "whole" ? {scope: "whole"} : {})};
}

// Require an unambiguous Qwen 2.1 encoder/sampler/VAE contract, not a filename.
export function structureAdapter(profile) {
  if (!["create", "edit"].includes(profile?.kind)) return null;
  const output = profile.snapshot?.output || {};
  const encoders = Object.entries(output).filter(([, n]) => n.class_type === "TextEncodeQwenImage21");
  const samplers = Object.entries(output).filter(([, n]) => ["KCPP_PromptStudioSampler", "KCPP_QwenImage21TurboSampler"].includes(n.class_type));
  const decoders = Object.values(output).filter(n => n.class_type === "VAEDecode");
  if (encoders.length !== 1 || samplers.length !== 1 || decoders.length !== 1 || !profile.promptNodeId
      || !Array.isArray(decoders[0].inputs.vae) || !Array.isArray(samplers[0][1].inputs.model)
      || !connected(output, samplers[0][1].inputs.positive, encoders[0][0])
      || !connected(output, decoders[0].inputs.samples, samplers[0][0])
      || Object.values(output).some(n => ["ZImageFunControlnet", "QwenImageDiffsynthControlnet"].includes(n.class_type))) return null;
  return {sampler: samplers[0][0], vae: decoders[0].inputs.vae, prompt: String(profile.promptNodeId)};
}

export function guideGraph(entry, {width = 1024, height = 1024} = {}) {
  const guide = normalizeGuide(entry.guide);
  return {
    ps_structure_source: {class_type: "KCPP_ChatImageReference", inputs: {image_ref: JSON.stringify(entry.image), source_name: "Structure guide"}},
    ps_structure_guide: {class_type: "KCPP_QwenStructureGuide", inputs: {image: ["ps_structure_source", 0], guide_type: guide.type,
      input_mode: guide.input, fit: guide.fit, width, height,
      ...(normalizeTargeting(entry.targeting) ? {targeting: JSON.stringify(normalizeTargeting(entry.targeting))} : {})}},
  };
}

export async function controlnetStatus(fetchApi) {
  const response = await fetchApi("/promptstudio/controlnet/status", {cache: "no-store"});
  if (!response.ok) throw new Error("Restart ComfyUI to load structure guides, then check Settings > Setup.");
  return response.json();
}

export async function applyStructureGuide(snapshot, profile, references, fetchApi) {
  const entries = (references || []).filter(isStructureReference);
  if (!entries.length) return;
  const adapter = structureAdapter({...profile, snapshot});
  if (!adapter) return; // Saved guide stays inactive on incompatible workflows.
  if (entries.length !== 1) throw new Error("Use one structure guide at a time.");
  const entry = profile.kind === "create" ? {...entries[0], targeting: {...entries[0].targeting, target: null}} : entries[0];
  const guide = normalizeGuide(entry.guide);
  if (guide.strength === 0) return;
  const status = await controlnetStatus(fetchApi);
  if (!status.ready) throw new Error("Install Qwen Structure guide (ControlNet) in Settings > Setup.");
  if (guide.input === "photo" && !status.methods?.[guide.type]?.ready) throw new Error(`Install ${GUIDE_TYPES[guide.type]} extraction in Settings > Setup, or use a prepared guide.`);
  const nodes = guideGraph(entry, {width: [adapter.prompt, 2], height: [adapter.prompt, 3]});
  nodes.ps_structure_model = {class_type: "ModelPatchLoader", inputs: {name: status.model}};
  nodes.ps_structure_apply = {class_type: "ZImageFunControlnet", inputs: {model: snapshot.output[adapter.sampler].inputs.model,
    model_patch: ["ps_structure_model", 0], vae: adapter.vae, image: ["ps_structure_guide", 0], strength: guide.strength}};
  if (Object.keys(nodes).some(id => Object.hasOwn(snapshot.output, id))) throw new Error("Workflow already contains managed structure guide nodes.");
  Object.assign(snapshot.output, nodes);
  snapshot.output[adapter.sampler].inputs.model = ["ps_structure_apply", 0];
}

export async function previewStructureGuide(entry, fetchApi, dimensions, signal) {
  const prompt = guideGraph(entry, dimensions?.resolution ? {width: ["ps_structure_size", 2], height: ["ps_structure_size", 3]} : dimensions);
  if (dimensions?.resolution) prompt.ps_structure_size = {class_type: "KCPP_PromptSlot", inputs: {prompt: "", slot_name: "Guide preview", secondary_instructions: "", ...dimensions.resolution}};
  prompt.ps_structure_preview = {class_type: "PreviewImage", inputs: {images: ["ps_structure_guide", 0]}};
  const response = await fetchApi("/prompt", {method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({prompt}), signal});
  const queued = await response.json();
  if (!response.ok || !queued.prompt_id) throw new Error("Could not queue guide preview. Check Setup and ComfyUI's node errors.");
  const deadline = Date.now() + 180000;
  while (!signal?.aborted && Date.now() < deadline) {
    const result = await fetchApi(`/history/${encodeURIComponent(queued.prompt_id)}`, {signal, cache: "no-store"});
    if (!result.ok) throw new Error("Could not read guide preview progress.");
    const history = (await result.json())[queued.prompt_id];
    if (history?.status?.status_str === "error") throw new Error(history.status.messages?.find(([type]) => type === "execution_error")?.[1]?.exception_message || "Guide extraction failed.");
    const image = history?.outputs?.ps_structure_preview?.images?.[0];
    if (image) return image;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(signal?.aborted ? "Preview closed" : "Guide preview is still queued. Check ComfyUI's queue.");
}
import { normalizeTargeting } from "./reference-targeting.js";
