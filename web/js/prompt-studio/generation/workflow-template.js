import {
  AMPLIFY_TYPE,
  IMAGE_SOURCE_TYPE,
  LORA_LOADER_TYPE,
  MODEL_LOADER_TYPE,
  SAMPLER_CONTROL_TYPE,
  SLOT_TYPE,
  UPSCALE_TYPE,
} from "../core/constants.js";
import { cleanModelName } from "./model-name.js";
import {
  normalizeWorkflowProfile,
  workflowNameFromPath,
} from "./workflow-profile.js";
import {
  PROMPT_STUDIO_INPUT_PROFILE_VERSION,
  serializedWorkflowNodes,
} from "./prompt-studio-input.js";

import { createWorkflowAdapter } from "./workflow-adapter.js";

export function createWorkflowTemplateBuilder({ app, nodeClassName }) {
  function imageOutputNode(node) {
    const data = node?.constructor?.nodeData;
    if (!data?.output_node) return false;
    if (Object.values({ ...data.input?.required, ...data.input?.optional }).some(schema => Array.isArray(schema) && schema[0] === "IMAGE")) return true;
    const sockets = [...(node?.inputs || []), ...(node?.outputs || [])];
    if (sockets.some((socket) => String(socket?.type || "").split(",").includes("IMAGE"))) return true;
    const identity = `${nodeClassName(node)} ${node?.type || ""} ${node?.title || ""}`;
    return /(?:image.*(?:save|preview|output)|(?:save|preview|output).*image|save.*(?:png|jpe?g|webp))/i.test(identity);
  }

  const buildWorkflowTemplate = createWorkflowAdapter({
    app, adapterId: "image", capabilities: { resultFields: ["images", "gifs"], outputRuleVersion: 1 },
    build: async ({ file, workflowData, snapshot, nodes, additionalInputs }) => {
      const firstExecutableNode = (types) => nodes.find(record => types.includes(record.type));
      const serialized = serializedWorkflowNodes(workflowData);
      const graphUpscaleNodes = serialized.filter(record => record.node.type === UPSCALE_TYPE);
      const upscaleWorkflow = graphUpscaleNodes.length > 0;
      const upscaleNode = firstExecutableNode([UPSCALE_TYPE]);
      if (upscaleWorkflow && !upscaleNode) throw new Error("Upscaling workflows need an executable Prompt Studio Upscale node.");
      const graphImageSources = serialized.filter(record => record.node.type === IMAGE_SOURCE_TYPE);
      const editingWorkflow = !upscaleWorkflow && graphImageSources.length > 0;
      const imageNode = firstExecutableNode([IMAGE_SOURCE_TYPE]);
      if (editingWorkflow && !imageNode) throw new Error("Image workflows need an executable Prompt Studio Image Source node.");
      const promptNode = firstExecutableNode([SLOT_TYPE, AMPLIFY_TYPE]);
      if (!upscaleWorkflow && !promptNode) {
        throw new Error(`${editingWorkflow ? "Editing" : "Creation"} workflows need an executable KoboldCpp Prompt Slot or Prompt Amplify node.`);
      }

      const output = snapshot?.output || {};
      const loraNodes = Object.entries(output)
        .filter(([, node]) => node?.class_type === LORA_LOADER_TYPE)
        .map(([id, node]) => ({ id: String(id), loraType: String(node.inputs?.lora_type || "").trim() }));
      const modelNodes = Object.entries(output)
        .filter(([, node]) => node?.class_type === MODEL_LOADER_TYPE)
        .map(([id, node]) => ({
          id: String(id),
          modelType: String(node.inputs?.model_type || "").trim(),
          modelName: cleanModelName(node.inputs?.unet_name),
        }));
      const samplingNodes = Object.entries(output)
        .filter(([, node]) => node?.class_type === SAMPLER_CONTROL_TYPE)
        .map(([id, node]) => ({
          id: String(id),
          label: String(nodes.find(record => record.id === id)?.node?.title || `Sampler ${id}`).trim(),
          controls: {
            seed: Number(node.inputs?.seed ?? 0),
            steps: Number(node.inputs?.steps ?? 20),
            cfg: Number(node.inputs?.cfg ?? 8),
            sampler: String(node.inputs?.sampler_name || ""),
            scheduler: String(node.inputs?.scheduler || ""),
            denoise: Number(node.inputs?.denoise ?? 1),
          },
        }));
      const imageOutputs = nodes.filter(record => imageOutputNode(record.node));
      if (imageOutputs.length !== 1) {
        throw new Error(`Workflow must have exactly one image output; found ${imageOutputs.length}.`);
      }

      return normalizeWorkflowProfile({
        id: file.path,
        path: file.path,
        name: workflowNameFromPath(file.path),
        kind: upscaleWorkflow ? "upscale" : editingWorkflow ? "edit" : "create",
        promptNodeId: upscaleWorkflow ? "" : String(promptNode.id),
        imageNodeId: editingWorkflow ? String(imageNode.id) : "",
        upscaleNodeId: upscaleWorkflow ? String(upscaleNode.id) : "",
        loraNodes,
        modelNodes,
        samplingNodes,
        additionalInputs,
        promptStudioInputVersion: PROMPT_STUDIO_INPUT_PROFILE_VERSION,
        resultNodeIds: [String(imageOutputs[0].id)],
        snapshot,
        updatedAt: Date.now(),
        sourceModified: Number(file.modified || 0),
      });
    },
  });

  return { buildWorkflowTemplate };
}
