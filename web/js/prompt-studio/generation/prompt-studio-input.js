export const PROMPT_STUDIO_INPUT_TYPE = "PromptStudioInput";
export const PROMPT_STUDIO_INPUT_TITLE = "Prompt Studio Input";
export const PROMPT_STUDIO_INPUT_PROFILE_VERSION = 3;

const SUPPORTED_TYPES = new Set(["INT", "FLOAT", "BOOLEAN", "STRING", "COMBO"]);
const DEFAULT_NODE_TITLES = new Set([PROMPT_STUDIO_INPUT_TYPE, PROMPT_STUDIO_INPUT_TITLE]);

function graphLink(graph, linkId) {
  return graph?.getLink?.(linkId)
    || graph?.links?.get?.(linkId)
    || graph?.links?.[linkId]
    || null;
}

function inputSpecForNode(node, input) {
  const name = String(input?.widget?.name || input?.name || "");
  const nodeData = node?.constructor?.nodeData;
  return nodeData?.input?.required?.[name]
    || nodeData?.input?.optional?.[name]
    || null;
}

function resolvedOptions(value, widget, node) {
  let options = value;
  if (typeof options === "function") {
    try {
      options = options(widget, node);
    } catch (_) {
      return [];
    }
  }
  if (Array.isArray(options)) return options.filter((item) => ["string", "number"].includes(typeof item));
  if (options && typeof options === "object") return Object.keys(options);
  return [];
}

function normalizedSpec(node, input) {
  const raw = inputSpecForNode(node, input);
  const config = Array.isArray(raw) && raw[1] && typeof raw[1] === "object" ? raw[1] : {};
  const declared = Array.isArray(raw) ? raw[0] : raw?.type;
  const combo = Array.isArray(declared);
  const type = combo ? "COMBO" : String(declared || input?.type || "").toUpperCase();
  if (!SUPPORTED_TYPES.has(type)) return null;
  const widget = node?.widgets?.find((item) => item?.name === (input?.widget?.name || input?.name));
  const options = type === "COMBO"
    ? resolvedOptions(
      combo ? declared : (config.options ?? widget?.options?.values),
      widget,
      node,
    )
    : [];
  if (type === "COMBO" && !options.length) return null;
  const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
  return {
    type,
    min: finite(config.min ?? widget?.options?.min),
    max: finite(config.max ?? widget?.options?.max),
    step: finite(config.step ?? widget?.options?.step2),
    multiline: Boolean(config.multiline),
    labelOn: String(config.label_on ?? widget?.options?.on ?? "true"),
    labelOff: String(config.label_off ?? widget?.options?.off ?? "false"),
    options,
  };
}

function jsonScalar(value) {
  return value == null || ["string", "number", "boolean"].includes(typeof value);
}

function schemaFingerprint(schema) {
  return JSON.stringify({
    type: schema.type,
    min: schema.min,
    max: schema.max,
    step: schema.step,
    multiline: schema.multiline,
    labelOn: schema.labelOn,
    labelOff: schema.labelOff,
    options: schema.options,
  });
}

function explicitNodeTitle(serialized) {
  if (!Object.hasOwn(serialized || {}, "title")) return "";
  const title = String(serialized.title || "").trim();
  return title && !DEFAULT_NODE_TITLES.has(title) ? title : "";
}

function serializedLink(value) {
  if (Array.isArray(value)) {
    return {
      id: value[0],
      originId: value[1],
      originSlot: value[2],
      targetId: value[3],
      targetSlot: value[4],
    };
  }
  if (!value || typeof value !== "object") return null;
  return {
    id: value.id,
    originId: value.origin_id,
    originSlot: value.origin_slot,
    targetId: value.target_id,
    targetSlot: value.target_slot,
  };
}

export function serializedWorkflowNodes(workflowData) {
  const definitions = workflowData?.definitions?.subgraphs || [];
  const byId = new Map(definitions.map(definition => [String(definition?.id), definition]));
  if (byId.size !== definitions.length || definitions.some(definition => !String(definition?.id ?? ""))) {
    throw new Error("Workflow has duplicate or missing subgraph definition IDs.");
  }
  const result = [];
  const ids = new Set();
  const visit = (scope, prefix, stack) => {
    for (const node of scope?.nodes || []) {
      const id = `${prefix}${String(node?.id ?? "")}`;
      if (!String(node?.id ?? "") || ids.has(id)) throw new Error(`Workflow has duplicate or missing node ID ${id}.`);
      ids.add(id);
      result.push({ id, node, scope, prefix });
      const definition = byId.get(String(node?.type || ""));
      if (!definition) continue;
      const definitionId = String(definition.id);
      if (stack.has(definitionId)) throw new Error(`Workflow has a recursive subgraph ${definitionId}.`);
      visit(definition, `${id}:`, new Set([...stack, definitionId]));
    }
  };
  visit(workflowData, "", new Set());
  return result;
}

function extractSerializedSubgraphInputs(snapshot, workflowData) {
  // Validate paths/cycles once, rather than silently dropping recursive graphs.
  serializedWorkflowNodes(workflowData);
  const output = snapshot?.output || {};
  const definitions = Array.isArray(workflowData?.definitions?.subgraphs)
    ? workflowData.definitions.subgraphs
    : [];
  const definitionById = new Map(definitions.map((definition) => [String(definition?.id), definition]));
  const descriptors = [];

  const visit = (scope, prefix, definitionStack) => {
    const nodes = Array.isArray(scope?.nodes) ? scope.nodes : [];
    const nodeById = new Map(nodes.map((node) => [String(node?.id), node]));
    const links = (Array.isArray(scope?.links) ? scope.links : []).map(serializedLink).filter(Boolean);
    for (const node of nodes) {
      const nodeId = String(node?.id ?? "");
      if (String(node?.type || "") === PROMPT_STUDIO_INPUT_TYPE) {
        const outgoing = links.filter((link) => String(link.originId) === nodeId);
        const descriptorId = `${prefix}${nodeId}`;
        if (outgoing.length !== 1) {
          throw new Error(`Prompt Studio Input node ${descriptorId} must connect to exactly one input.`);
        }
        const link = outgoing[0];
        const target = nodeById.get(String(link.targetId));
        const input = target?.inputs?.[Number(link.targetSlot)];
        const targetNodeId = `${prefix}${String(link.targetId ?? "")}`;
        const targetInputName = String(input?.widget?.name || input?.name || "");
        if (
          !target || !input || !output[targetNodeId]?.inputs
          || !Object.hasOwn(output[targetNodeId].inputs, targetInputName)
        ) {
          throw new Error(`Prompt Studio Input node ${descriptorId} must target an executable configurable input.`);
        }
        const TargetNodeType = globalThis.LiteGraph?.registered_node_types?.[target.type];
        const schema = normalizedSpec({ constructor: TargetNodeType || {}, widgets: [] }, input);
        if (!schema) {
          throw new Error(`Prompt Studio Input node ${descriptorId} is connected to unsupported input “${targetInputName || "unknown"}”.`);
        }
        const targetLabel = String(input.label || input.localized_name || targetInputName).trim() || targetInputName;
        const descriptor = normalizePromptStudioInputDescriptor({
          id: descriptorId,
          targetNodeId,
          targetInputName,
          label: explicitNodeTitle(node) || targetLabel,
          targetLabel,
          targetNodeLabel: String(
            target.title || output[targetNodeId]?._meta?.title || target.type || `Node ${targetNodeId}`,
          ).trim(),
          schema,
          defaultValue: output[targetNodeId].inputs[targetInputName],
        });
        if (!descriptor) throw new Error(`Prompt Studio Input node ${descriptorId} has an invalid value contract.`);
        descriptors.push(descriptor);
      }

      const definition = definitionById.get(String(node?.type || ""));
      const definitionId = String(definition?.id || "");
      if (definition && !definitionStack.has(definitionId)) {
        visit(definition, `${prefix}${nodeId}:`, new Set([...definitionStack, definitionId]));
      }
    }
  };

  for (const rootNode of workflowData?.nodes || []) {
    const definition = definitionById.get(String(rootNode?.type || ""));
    const definitionId = String(definition?.id || "");
    if (definition) visit(definition, `${String(rootNode?.id ?? "")}:`, new Set([definitionId]));
  }
  return descriptors;
}

export function normalizePromptStudioInputDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const schema = value.schema && typeof value.schema === "object" && !Array.isArray(value.schema)
    ? value.schema
    : {};
  const type = String(schema.type || value.type || "").toUpperCase();
  if (!SUPPORTED_TYPES.has(type)) return null;
  const options = type === "COMBO" && Array.isArray(schema.options)
    ? schema.options.filter((item) => ["string", "number"].includes(typeof item))
    : [];
  if (type === "COMBO" && !options.length) return null;
  const finite = (requested) => (
    requested == null || requested === "" || !Number.isFinite(Number(requested))
      ? null
      : Number(requested)
  );
  const normalizedSchema = {
    type,
    min: finite(schema.min),
    max: finite(schema.max),
    step: finite(schema.step),
    multiline: Boolean(schema.multiline),
    labelOn: String(schema.labelOn ?? "true"),
    labelOff: String(schema.labelOff ?? "false"),
    options,
  };
  const descriptor = {
    id: String(value.id || "").trim(),
    targetNodeId: String(value.targetNodeId || "").trim(),
    targetInputName: String(value.targetInputName || "").trim(),
    label: String(value.label || value.targetInputName || "Input").trim(),
    targetLabel: String(value.targetLabel || value.targetInputName || "Input").trim(),
    targetNodeLabel: String(value.targetNodeLabel || `Node ${value.targetNodeId || ""}`).trim(),
    schema: normalizedSchema,
    schemaFingerprint: schemaFingerprint(normalizedSchema),
    defaultValue: jsonScalar(value.defaultValue) ? value.defaultValue : null,
  };
  return descriptor.id && descriptor.targetNodeId && descriptor.targetInputName ? descriptor : null;
}

export function normalizePromptStudioInputDescriptors(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.map(normalizePromptStudioInputDescriptor).filter((descriptor) => {
    if (!descriptor || seen.has(descriptor.id)) return false;
    seen.add(descriptor.id);
    return true;
  });
}

export function promptStudioInputSelectionKey(profileId, nodeId) {
  return `${String(profileId || "")}\u0000${String(nodeId || "")}`;
}

export function normalizePromptStudioInputSelections(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    if (!key || !entry || typeof entry !== "object" || Array.isArray(entry) || !jsonScalar(entry.value)) return [];
    return [[String(key), {
      value: entry.value,
      schemaFingerprint: String(entry.schemaFingerprint || ""),
    }]];
  }));
}

export function promptStudioInputValue(descriptor, requested) {
  const fallback = descriptor?.defaultValue;
  const schema = descriptor?.schema || {};
  const source = requested === undefined ? fallback : requested;
  if (schema.type === "BOOLEAN") {
    if (typeof source === "boolean") return source;
    if (source === "true" || source === 1 || source === "1") return true;
    if (source === "false" || source === 0 || source === "0") return false;
    return Boolean(fallback);
  }
  if (schema.type === "INT" || schema.type === "FLOAT") {
    let number = Number(source);
    if (!Number.isFinite(number)) number = Number(fallback);
    if (!Number.isFinite(number)) number = 0;
    if (schema.type === "INT") number = Math.round(number);
    if (schema.min != null) number = Math.max(schema.min, number);
    if (schema.max != null) number = Math.min(schema.max, number);
    return number;
  }
  if (schema.type === "COMBO") {
    const exact = schema.options.find((item) => item === source);
    if (exact !== undefined) return exact;
    const stringMatch = schema.options.find((item) => String(item) === String(source));
    if (stringMatch !== undefined) return stringMatch;
    const defaultMatch = schema.options.find((item) => item === fallback)
      ?? schema.options.find((item) => String(item) === String(fallback));
    return defaultMatch ?? schema.options[0];
  }
  return String(source ?? "");
}

export function selectedPromptStudioInputValue(profileId, descriptor, selections) {
  const entry = selections?.[promptStudioInputSelectionKey(profileId, descriptor?.id)];
  const requested = entry?.schemaFingerprint === descriptor?.schemaFingerprint ? entry.value : undefined;
  return promptStudioInputValue(descriptor, requested);
}

export function applyPromptStudioInputValues(snapshot, profile, selections) {
  for (const descriptor of normalizePromptStudioInputDescriptors(profile?.additionalInputs)) {
    const target = snapshot?.output?.[descriptor.targetNodeId];
    if (!target || !target.inputs || !Object.hasOwn(target.inputs, descriptor.targetInputName)) {
      throw new Error(`Additional Input “${descriptor.label}” no longer has its connected workflow input.`);
    }
    target.inputs[descriptor.targetInputName] = selectedPromptStudioInputValue(
      profile?.id,
      descriptor,
      selections,
    );
  }
  return snapshot;
}

export function extractPromptStudioInputs(graph, snapshot, workflowData = null) {
  const output = snapshot?.output || {};
  const serializedById = new Map((workflowData?.nodes || []).map((node) => [String(node?.id), node]));
  const descriptors = [];
  for (const node of graph?._nodes || []) {
    if (String(node?.type || "") !== PROMPT_STUDIO_INPUT_TYPE) continue;
    const linkIds = node?.outputs?.[0]?.links || [];
    if (!linkIds.length) continue;
    if (linkIds.length !== 1) throw new Error(`Prompt Studio Input node ${node.id} must connect to exactly one input.`);
    const link = graphLink(graph, linkIds[0]);
    const target = link && graph.getNodeById?.(link.target_id);
    const input = target?.inputs?.[link?.target_slot];
    const targetNodeId = String(link?.target_id ?? "");
    const targetInputName = String(input?.widget?.name || input?.name || "");
    if (!target || !input || !output[targetNodeId]?.inputs || !Object.hasOwn(output[targetNodeId].inputs, targetInputName)) {
      throw new Error(`Prompt Studio Input node ${node.id} must target an executable configurable input.`);
    }
    const schema = normalizedSpec(target, input);
    if (!schema) {
      throw new Error(`Prompt Studio Input node ${node.id} is connected to unsupported input “${targetInputName || "unknown"}”.`);
    }
    const serialized = serializedById.get(String(node.id));
    const customTitle = explicitNodeTitle(serialized);
    const targetLabel = String(input.label || input.localized_name || targetInputName).trim() || targetInputName;
    const descriptor = normalizePromptStudioInputDescriptor({
      id: String(node.id),
      targetNodeId,
      targetInputName,
      label: customTitle || targetLabel,
      targetLabel,
      targetNodeLabel: String(target.title || target.type || `Node ${targetNodeId}`).trim(),
      schema,
      defaultValue: output[targetNodeId].inputs[targetInputName],
    });
    if (!descriptor) throw new Error(`Prompt Studio Input node ${node.id} has an invalid value contract.`);
    descriptors.push(descriptor);
  }
  const seen = new Set(descriptors.map((descriptor) => descriptor.id));
  for (const descriptor of extractSerializedSubgraphInputs(snapshot, workflowData)) {
    if (seen.has(descriptor.id)) continue;
    seen.add(descriptor.id);
    descriptors.push(descriptor);
  }
  return descriptors;
}

export function registerPromptStudioInputNode(LiteGraph = globalThis.LiteGraph) {
  if (!LiteGraph || LiteGraph.registered_node_types?.[PROMPT_STUDIO_INPUT_TYPE]) return;
  const PrimitiveNode = LiteGraph.registered_node_types?.PrimitiveNode;
  if (typeof PrimitiveNode !== "function") {
    throw new Error("ComfyUI's Primitive Node is not available for Prompt Studio Input registration.");
  }
  class PromptStudioInputNode extends PrimitiveNode {
    constructor(title = PROMPT_STUDIO_INPUT_TITLE) {
      super(title === PROMPT_STUDIO_INPUT_TYPE ? PROMPT_STUDIO_INPUT_TITLE : title);
      this.properties ||= {};
      this.properties.promptStudioInput = true;
    }

    onConnectOutput(slot, type, input, targetNode, targetSlot) {
      if (this.outputs?.[slot]?.links?.length) return false;
      if (!normalizedSpec(targetNode, input)) return false;
      return super.onConnectOutput?.(slot, type, input, targetNode, targetSlot) ?? true;
    }

    onSerialize(data) {
      super.onSerialize?.(data);
      if (!Array.isArray(data.widgets_values) && Array.isArray(this.widgets_values)) {
        data.widgets_values = structuredClone(this.widgets_values);
      }
    }
  }
  PromptStudioInputNode.title = PROMPT_STUDIO_INPUT_TITLE;
  PromptStudioInputNode.category = "Prompt Studio";
  LiteGraph.registerNodeType(PROMPT_STUDIO_INPUT_TYPE, PromptStudioInputNode);
}
