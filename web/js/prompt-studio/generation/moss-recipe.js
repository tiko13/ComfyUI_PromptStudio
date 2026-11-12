import {serializedWorkflowNodes} from "./prompt-studio-input.js";
import {layoutBinding, spatialDimensions} from "./spatial-inputs.js";

// Validate the bundled recipe contract; inference stays in native ComfyUI nodes.
export function validateMossRecipe(snapshot, profile) {
  const recipe = snapshot.workflow?.extra?.promptstudio_moss;
  if (!recipe) return;
  if (recipe.version !== 1 || !["sft", "sft-control", "sft-dmd8"].includes(recipe.recipe)) throw new Error("Unknown MOSS recipe version. Refresh the workflow.");
  const output = snapshot.output, records = serializedWorkflowNodes(snapshot.workflow);
  const marked = marker => records.filter(r=>r.node.properties?.promptstudio_asset === marker).map(r=>output[r.id]);
  const sftTurbo = recipe.recipe === "sft-dmd8";
  const dmd = sftTurbo, controlled = recipe.recipe === "sft-control";
  const required = sftTurbo ? "moss_sft_dmd8" : "moss_destripe";
  const adapters = marked(required);
  if (adapters.length !== 1 || adapters[0]?.class_type !== "LoraLoaderModelOnly") throw new Error("The MOSS recipe is missing its adapter loader. Restore the setup workflow.");
  const strength = adapters[0].inputs.strength_model;
  if (dmd ? strength !== 1 : !Number.isFinite(strength) || strength < 0 || strength > 100) throw new Error(dmd ? "The DMD speed adapter requires strength 1." : "Destripe strength must be between 0 and 100 (0 disables it; 1–1.5 is the usual starting range).");
  const controls = Object.values(output).filter(n=>n.class_type === "MOSSImageControl");
  if (controlled !== (controls.length === 1) || controls.length > 1) throw new Error("MOSS control wiring does not match the selected recipe.");
  if (controlled) {
    const loaders = marked("moss_control");
    if (loaders.length !== 1 || loaders[0]?.inputs.strength_model !== 1) throw new Error("Keep the control adapter at strength 1; change Map strength for conditioning.");
    const {start_percent:start, end_percent:end, strength:weight} = controls[0].inputs;
    if (![start,end,weight].every(Number.isFinite) || start < 0 || end > 1 || start > end || weight < 0 || weight > 10) throw new Error("Control requires 0 ≤ start ≤ end ≤ 1 and a map strength between 0 and 10.");
    const maps = Object.values(output).filter(n=>n.class_type === "PS_StructureInput" && n.inputs.control_key && n.inputs.reference_json);
    if (!maps.length) throw new Error("Add a color or depth map, or select MOSS SFT Create for an unpatched baseline.");
  }
  const names = new Set(records.filter(r=>r.node.properties?.promptstudio_asset).map(r=>basename(output[r.id]?.inputs.lora_name)));
  for (const n of Object.values(output).filter(n=>n.class_type === "KCPP_PromptStudioLoraLoader")) {
    const stack = JSON.parse(n.inputs.lora_stack_json || "[]");
    if (stack.some(l=>names.has(basename(l.name || l.lora_name)))) throw new Error("A required MOSS adapter is already in the recipe. Remove its duplicate from the user LoRA stack.");
  }
  if (!layoutBinding({...profile,snapshot})) throw new Error("The MOSS recipe needs its connected native layout compiler.");
  const {width,height} = spatialDimensions(output[profile.promptNodeId]?.inputs);
  if (![width,height].every(n=>Number.isFinite(n) && n >= 64 && n <= 8192 && n % 16 === 0)) throw new Error("MOSS dimensions must be multiples of 16 between 64 and 8192.");
}

const basename = value => String(value || "").replaceAll("\\", "/").split("/").at(-1).toLowerCase();
