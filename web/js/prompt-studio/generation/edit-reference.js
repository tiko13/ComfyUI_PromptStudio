import { normalizeImageReference } from "../chat/image-reference.js";

export const EDIT_REFERENCE_TYPE = "KCPP_ChatImageReference";

// Inspect executable links, including flattened subgraphs. An unused loader does
// not make a workflow reference-capable.
export function editReferenceNodeIds(snapshot) {
  const output = snapshot?.output || {};
  const connected = new Set(Object.values(output).flatMap(node =>
    Object.values(node?.inputs || {}).filter(value => Array.isArray(value) && value.length === 2 && Number.isInteger(value[1]))
      .map(value => String(value[0]))));
  return Object.entries(output).filter(([id, node]) => node?.class_type === EDIT_REFERENCE_TYPE && connected.has(id)).map(([id]) => id);
}

export function supportsEditReference(profile) {
  return profile?.kind === "edit" && editReferenceNodeIds(profile.snapshot).length > 0;
}

export function applyEditReference(snapshot, reference) {
  const image = normalizeImageReference(reference);
  const ids = editReferenceNodeIds(snapshot);
  if (image && !ids.length) throw new Error("This edit workflow no longer supports a reference image. Remove the reference or select a compatible workflow.");
  for (const id of ids) {
    snapshot.output[id].inputs ||= {};
    snapshot.output[id].inputs.image_ref = image ? JSON.stringify(image) : "";
  }
  return image;
}
