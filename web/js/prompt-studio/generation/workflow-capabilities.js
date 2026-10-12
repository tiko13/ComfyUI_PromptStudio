// Explicit Image Studio contracts. No model class names are needed here.
export const REFERENCE_CAPABILITY_VERSION = 1;
export const DEFAULT_REFERENCE_ROLES = {custom: "Custom instruction", subject: "Subject / identity", clothing: "Clothing", pose: "Pose", background: "Background", style: "Style", object: "Object"};

export function dependsOn(output, link, id, visited = new Set()) {
  if (!Array.isArray(link) || link.length !== 2 || !Number.isInteger(link[1])) return false;
  const key = String(link[0]);
  if (key === String(id)) return true;
  if (visited.has(key)) return false;
  visited.add(key);
  return Object.values(output[key]?.inputs || {}).some(value => dependsOn(output, value, id, visited));
}

export function capabilityNode(profile, type) {
  const output = profile?.snapshot?.output || {};
  const connected = new Set(Object.values(output).flatMap(node => Object.values(node.inputs || {})
    .filter(value => Array.isArray(value) && value.length === 2 && Number.isInteger(value[1])).map(value => String(value[0]))));
  const entries = Object.entries(output).filter(([id, node]) => node.class_type === type && connected.has(id)
    && (!profile?.resultNodeIds?.length || profile.resultNodeIds.some(result => dependsOn(output, [String(result), 0], id))));
  if (entries.length > 1) throw new Error(`Use one connected ${type} node per workflow.`);
  return entries[0] ? {id: entries[0][0], inputs: entries[0][1].inputs || {}} : null;
}

function integer(value, fallback, min, max, label) {
  const number = value == null ? fallback : value;
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Invalid ${label} in reference capability node.`);
  return number;
}

export function declaredReferenceAdapter(profile) {
  if (!["create", "edit"].includes(profile?.kind)) return null;
  const collection = capabilityNode(profile, "PS_ReferenceCollection");
  const prompt = capabilityNode(profile, "PS_ReferencePrompt");
  if (!collection && !prompt) return null;
  const output = profile.snapshot.output;
  if (prompt && !dependsOn(output, prompt.inputs.prompt, profile.promptNodeId)) throw new Error("Reference Prompt Settings must consume the Studio prompt.");
  if (collection && prompt && String(prompt.inputs.references?.[0]) !== collection.id) throw new Error("Connect Reference Collection to Reference Prompt Settings.");
  const limit = collection ? integer(collection.inputs.maximum, 4, 0, 64, "reference maximum") : capabilityNode(profile, "PS_StructureInput") ? 1 : 0;
  const minimum = collection ? integer(collection.inputs.minimum, 0, 0, limit, "reference minimum") : 0;
  const roles = Object.fromEntries(String(collection?.inputs.roles ?? Object.keys(DEFAULT_REFERENCE_ROLES).join(","))
    .split(",").map(role => role.trim()).filter(Boolean).map(role => {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(role)) throw new Error("Reference roles must be comma-separated lowercase identifiers.");
      return [role, DEFAULT_REFERENCE_ROLES[role] || role.replaceAll("_", " ")];
    }));
  if (limit && !Object.keys(roles).length) throw new Error("Choose at least one reference role.");
  const token = String(prompt?.inputs.reference_token ?? "<image{index}>");
  if (!token.includes("{index}") || token.length > 128 || /[\r\n]/.test(token)) throw new Error("Reference token must contain {index} and fit on one line.");
  const promptMode = prompt?.inputs.prompt_mode ?? "full_prompt";
  if (!["edit_instruction", "full_prompt"].includes(promptMode)) throw new Error("Unknown reference prompt mode.");
  const sourceToken = String(prompt?.inputs.source_token ?? "the image");
  const instructions = String(prompt?.inputs.instructions || "");
  if (!sourceToken.trim() || sourceToken.length > 128 || /[\r\n]/.test(sourceToken) || instructions.length > 16000) throw new Error("Invalid reference prompt settings.");
  return {explicit: true, id: prompt?.id || collection.id, collectionId: collection?.id || "", guideOnly: !collection, model: "workflow",
    mode: profile.kind, limit, minimum, roles, promptMode, token, sourceToken, instructions,
    firstImage: integer(prompt?.inputs.first_reference_index, profile.kind === "edit" ? 2 : 1, 0, 1000, "reference numbering")};
}

export function referenceToken(adapter, index) {
  return (adapter?.token || "<image{index}>").replaceAll("{index}", String(index + (adapter?.firstImage ?? 2)));
}

export function poseInpaintAdapter(profile) {
  if (profile?.kind !== "edit" || !profile.imageNodeId) return null;
  const guide = capabilityNode(profile, "PS_StructureInput"), control = capabilityNode(profile, "PS_ApplyQwenStructure"), mask = capabilityNode(profile, "PS_EditMask");
  const link = (value, id, slot) => Array.isArray(value) && String(value[0]) === String(id) && value[1] === slot;
  if (!guide || !control || !mask || !link(guide.inputs.source, profile.imageNodeId, 0)
      || !link(control.inputs.inpaint_image, guide.id, 2) || !link(control.inputs.inpaint_mask, guide.id, 3)
      || !link(mask.inputs.inpaint_mask, guide.id, 3) || !link(mask.inputs.source, profile.imageNodeId, 0)) return null;
  return {guideId: guide.id, preserveBackground: guide.inputs.preserve_background !== false};
}

export function validateDeclaredCapabilities(profile) {
  const output = profile.snapshot.output;
  for (const input of profile.additionalInputs || []) {
    if (["PS_ReferenceCollection", "PS_ReferenceItem", "PS_ReferencePrompt", "PS_EditMask"].includes(output[input.targetNodeId]?.class_type)
        || (output[input.targetNodeId]?.class_type === "PS_StructureInput" && input.targetInputName === "reference_json")) {
      throw new Error("Configure reference capability settings on their workflow nodes; they cannot be overridden by Additional Inputs.");
    }
  }
  const adapter = declaredReferenceAdapter(profile);
  for (const type of ["PS_StructureInput", "PS_EditMask"]) capabilityNode(profile, type);
  if (!adapter?.collectionId) return;
  const items = Object.entries(output).filter(([, node]) => node.class_type === "PS_ReferenceItem" && String(node.inputs.references?.[0]) === adapter.collectionId);
  const reachesResult = id => !profile.resultNodeIds?.length || profile.resultNodeIds.some(result => dependsOn(output, [String(result), 0], id));
  const connectedItems = items.filter(([id]) => reachesResult(id) && Object.values(output).some(node => Object.values(node.inputs || {}).some(link => Array.isArray(link) && String(link[0]) === id)));
  for (const [, node] of items) integer(node.inputs.index, 1, 1, adapter.limit, "reference item index");
  // A custom node can consume the collection directly. Fixed item wiring must
  // expose every advertised slot; accepting images that never reach a model is an error.
  const customConsumer = Object.entries(output).some(([id, node]) => reachesResult(id) && !["PS_ReferenceItem", "PS_ReferencePrompt"].includes(node.class_type)
    && Object.values(node.inputs || {}).some(link => Array.isArray(link) && String(link[0]) === adapter.collectionId));
  if (!customConsumer && Array.from({length: adapter.limit}, (_, i) => i + 1).some(index => !connectedItems.some(([, node]) => node.inputs.index === index))) {
    throw new Error("Connect a Reference Item for every advertised reference slot, or connect the collection to a compatible custom node.");
  }
}
