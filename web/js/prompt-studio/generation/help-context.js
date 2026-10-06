import { supportsEditReference } from "./edit-reference.js";
import { referenceInputDescriptors, workflowReferenceValues } from "./reference-inputs.js";
import { qwenReferenceAdapter, normalizeQwenReferences, REFERENCE_ROLES } from "./qwen-references.js";
import { structureAdapter, GUIDE_TYPES, isStructureReference } from "./structure-guide.js";

// Derive help from the exact adapters used for rendering and generation.
export function workflowHelpFacts(profile, owner = {}, mode = "create") {
  const qwen = qwenReferenceAdapter(profile);
  const structure = structureAdapter(profile);
  const slots = referenceInputDescriptors(profile?.snapshot);
  return {
    mode, workflow: profile?.name || "No workflow selected",
    structure_guide: structure ? "available" : "inactive",
    guide_types: Object.values(GUIDE_TYPES).join(", "),
    reference_mode: !profile ? "unknown" : qwen ? (qwen.mode === "create" ? "qwen-create" : "qwen") : structure ? "structure" : supportsEditReference(profile) ? "single" : slots.length ? "inputs" : "none",
    reference_limit: qwen?.limit ?? (structure ? 1 : slots.length),
    reference_count: qwen ? normalizeQwenReferences(owner.qwenEditReferences).length
      : structure ? normalizeQwenReferences(owner.qwenEditReferences).filter(isStructureReference).length
      : supportsEditReference(profile) ? Number(Boolean(owner.editReferenceImage))
      : Object.values(workflowReferenceValues(owner, profile)).filter(Boolean).length,
    reference_roles: qwen ? Object.values(REFERENCE_ROLES).join(", ") : "Not available",
    reference_inputs: slots.map(slot => slot.label).join(", ") || "None",
    model_selection: profile ? (profile.modelNodes?.length ? "available" : "not exposed") : "unknown",
  };
}

// Stable IDs, read current labels from the actual UI instead of copying them.
export const HELP_CONTROLS = Object.freeze({
  send_label: "#promptstudio-send",
  auto_generate_label: ".promptstudio-auto-generate-toggle",
  activity_label: "#promptstudio-job-refresh",
  diagnostics_label: "#promptstudio-job-diagnostics",
  reference_label: ".promptstudio-edit-reference-choose",
  model_label: "#promptstudio-model-details summary > span:not([aria-hidden]):not(.promptstudio-lora-summary-tools)",
});

export function helpControlLabels(panel) {
  return Object.fromEntries(Object.entries(HELP_CONTROLS).map(([key, selector]) => {
    const element = panel?.querySelector(selector);
    if (key === "reference_label" && element?.closest?.("#promptstudio-edit-reference[hidden]")) return [key, "unavailable"];
    return [key, element?.getAttribute("aria-label") || element?.textContent?.trim() || "unavailable"];
  }));
}
