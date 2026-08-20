import {
  AMPLIFY_TYPE,
  IMAGE_SOURCE_TYPE,
  LORA_LOADER_TYPE,
  MODEL_LOADER_TYPE,
  SLOT_TYPE,
  UPSCALE_TYPE,
} from "../core/constants.js";
import { cleanModelName } from "./model-name.js";
import {
  normalizeWorkflowProfile,
  workflowNameFromPath,
} from "./workflow-profile.js";

export function createWorkflowTemplateBuilder({ app, nodeClassName }) {
  function imageOutputNode(node) {
    const data = node?.constructor?.nodeData;
    if (!data?.output_node) return false;
    const sockets = [...(node?.inputs || []), ...(node?.outputs || [])];
    if (sockets.some((socket) => String(socket?.type || "").split(",").includes("IMAGE"))) return true;
    const identity = `${nodeClassName(node)} ${node?.type || ""} ${node?.title || ""}`;
    return /(?:image.*(?:save|preview|output)|(?:save|preview|output).*image|save.*(?:png|jpe?g|webp))/i.test(identity);
  }

  function firstExecutableNode(graph, snapshot, classTypes) {
    const output = snapshot?.output || {};
    return (graph?._nodes || []).find((node) => (
      Object.hasOwn(output, String(node.id)) && classTypes.includes(output[String(node.id)]?.class_type)
    ));
  }

  function bridgeWorkflowSubgraphs(graph, workflowData) {
    const definitions = workflowData?.definitions?.subgraphs;
    if (!Array.isArray(definitions) || definitions.length === 0) return () => {};

    // Off-canvas graphs do not inherit ComfyUI's root subgraph listener. Forward
    // their creation events so each node type binds to this graph's definitions.
    const originals = new Map();
    for (const definition of definitions) {
      const id = String(definition?.id || "");
      const original = id && app.rootGraph?.subgraphs?.get(id);
      if (original) originals.set(id, original);
    }

    const listener = (event) => {
      app.rootGraph.events.dispatch("subgraph-created", event.detail);
    };
    graph.events.addEventListener("subgraph-created", listener);

    return () => {
      graph.events.removeEventListener("subgraph-created", listener);
      for (const [id, subgraph] of originals) {
        app.rootGraph.events.dispatch("subgraph-created", {
          subgraph,
          data: subgraph.asSerialisable?.() || { id },
        });
      }
    };
  }

  async function buildWorkflowTemplate(file, workflowData, cached) {
    const Graph = app.rootGraph?.constructor || app.graph?.constructor;
    if (typeof Graph !== "function") throw new Error("ComfyUI's workflow graph is not ready.");
    const graph = new Graph();
    const restoreSubgraphTypes = bridgeWorkflowSubgraphs(graph, workflowData);
    let snapshot;
    try {
      const configureError = graph.configure(structuredClone(workflowData));
      if (configureError) throw new Error("ComfyUI could not load one or more workflow nodes.");
      const subgraphIds = new Set((workflowData?.definitions?.subgraphs || []).map((definition) => String(definition.id)));
      const unresolvedSubgraphs = (graph._nodes || []).filter((node) => (
        subgraphIds.has(String(node.type)) && !node.isSubgraphNode?.()
      ));
      if (unresolvedSubgraphs.length) {
        throw new Error(`ComfyUI could not resolve ${unresolvedSubgraphs.length} subgraph node${unresolvedSubgraphs.length === 1 ? "" : "s"}.`);
      }
      snapshot = structuredClone(await app.graphToPrompt(graph));
    } finally {
      restoreSubgraphTypes();
    }

    const graphUpscaleNodes = (graph._nodes || []).filter((node) => nodeClassName(node) === UPSCALE_TYPE);
    const upscaleWorkflow = graphUpscaleNodes.length > 0 || cached?.kind === "upscale";
    const upscaleNode = firstExecutableNode(graph, snapshot, [UPSCALE_TYPE]);
    if (upscaleWorkflow && !upscaleNode) throw new Error("Upscaling workflows need an executable Prompt Studio Upscale node.");
    const graphImageSources = (graph._nodes || []).filter((node) => nodeClassName(node) === IMAGE_SOURCE_TYPE);
    const editingWorkflow = !upscaleWorkflow && (graphImageSources.length > 0 || cached?.kind === "edit");
    const imageNode = firstExecutableNode(graph, snapshot, [IMAGE_SOURCE_TYPE]);
    if (editingWorkflow && !imageNode) throw new Error("Image workflows need an executable Prompt Studio Image Source node.");
    const promptNode = firstExecutableNode(graph, snapshot, [SLOT_TYPE, AMPLIFY_TYPE]);
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
    const imageOutputs = (graph._nodes || []).filter((node) => (
      Object.hasOwn(output, String(node.id)) && imageOutputNode(node)
    ));
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
      resultNodeIds: [String(imageOutputs[0].id)],
      snapshot,
      updatedAt: Date.now(),
      sourceModified: Number(file.modified || 0),
    });
  }

  return { buildWorkflowTemplate };
}
