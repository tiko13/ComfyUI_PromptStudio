// Coordinates are fractions of the original image, independent of preview size.
export function normalizeRegion(value) {
  if (!value || !["x", "y", "width", "height"].every(k => Number.isFinite(value[k]))) return null;
  const {x, y, width, height} = value;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) return null;
  return {x, y, width, height};
}

export function normalizeTargeting(value) {
  const reference = normalizeRegion(value?.reference), target = normalizeRegion(value?.target);
  return reference || target ? {reference, target,
    ...(target && normalizeImageReference(value?.targetImage) ? {targetImage: normalizeImageReference(value.targetImage)} : {})} : null;
}

export function validateTargetSource(entries, source) {
  const key = image => JSON.stringify([image?.filename, image?.subfolder || "", image?.type || "output"]);
  if ((entries || []).some(entry => entry.targeting?.target && entry.targeting.targetImage && key(entry.targeting.targetImage) !== key(source))) {
    throw new Error("The source image changed. Clear or reselect Apply to source in Targeting before editing.");
  }
  for (const entry of entries || []) {
    const mask = normalizeEditMask(entry.editMask);
    if (mask?.enabled && (key(mask.sourceImage) !== key(source) || JSON.stringify(mask.region) !== JSON.stringify(normalizeRegion(entry.targeting?.target)))) {
      throw new Error("The edit mask no longer matches its source or selection. Create a new mask.");
    }
  }
}

export function normalizeEditMask(value) {
  const image = normalizeImageReference(value?.image), sourceImage = normalizeImageReference(value?.sourceImage), region = normalizeRegion(value?.region);
  return image && sourceImage && region && /^[a-f0-9]{64}$/.test(value?.sourceDigest || "")
    ? {image, sourceImage, region, sourceDigest: value.sourceDigest, enabled: value.enabled === true} : null;
}

export function maskAdapter(profile) {
  if (profile?.kind !== "edit" || !profile.imageNodeId) return null;
  const output = profile.snapshot?.output || {};
  const decoders = Object.entries(output).filter(([,n]) => n.class_type === "VAEDecode");
  if (decoders.length !== 1 || profile.resultNodeIds?.length !== 1) return null;
  const [decoder] = decoders[0], sink = profile.resultNodeIds[0];
  if (!["SaveImage", "PreviewImage", "Save_as_webp_cond"].includes(output[sink]?.class_type)) return null;
  if (output[sink]?.inputs?.images?.[0] !== decoder || output[sink].inputs.images[1] !== 0) return null;
  return {decoder, sink};
}

export function applyReferenceMask(snapshot, profile, entries, source) {
  const masks = (entries || []).map(e => normalizeEditMask(e.editMask)).filter(m => m?.enabled);
  if (!masks.length) return;
  validateTargetSource(entries, source);
  if (masks.length !== 1) throw new Error("Use one active edit mask per generation.");
  const adapter = maskAdapter({...profile, snapshot});
  if (!adapter) throw new Error("This workflow does not support preserving pixels outside an edit mask.");
  if (snapshot.output.ps_reference_composite) throw new Error("Workflow already has a reference mask composite.");
  snapshot.output.ps_reference_composite = {class_type: "KCPP_ReferenceRegionComposite", inputs: {
    generated: [adapter.decoder, 0], source: [String(profile.imageNodeId), 0], mask_ref: JSON.stringify(masks[0].image),
    source_ref: JSON.stringify(masks[0].sourceImage), source_digest: masks[0].sourceDigest}};
  snapshot.output[adapter.sink].inputs.images = ["ps_reference_composite", 0];
  if (snapshot.output[adapter.sink].class_type === "Save_as_webp_cond") snapshot.output[adapter.sink].inputs.mode = "lossless";
}

export function targetingInstruction(entry) {
  const targeting = normalizeTargeting(entry?.targeting);
  const describe = r => `rectangle at ${Math.round(r.x * 100)}% from the left and ${Math.round(r.y * 100)}% from the top, ${Math.round(r.width * 100)}% wide and ${Math.round(r.height * 100)}% high`;
  return [targeting?.reference ? `Take the requested detail only from the ${describe(targeting.reference)} in this reference.` : "",
    targeting?.target ? `Apply it only to the subject in the ${describe(targeting.target)} in the edited source; preserve other subjects.` : ""].filter(Boolean).join(" ");
}
import { normalizeImageReference } from "../chat/image-reference.js";
