# Local reference detection

Manual reference preparation is independent of detection: Crop / mask… in the
shared reference editor offers a rectangle crop, hide/restore brushes and undo.
It runs in the browser and saves a separate PNG using the existing image upload.
The prepared reference is then used consistently for vision, ControlNet and
generation/replay. Hidden pixels become neutral gray rather than an attention or
output-preservation mask. Applying clears the old donor rectangle but preserves
recipient targeting. Image and Video workflow input slots share these controls.
Draft changes are discarded on close; the original file is retained. The editor
caps inputs at 32 megapixels and uploads at 20 MB and adds no model dependencies.

Qwen Edit with amplification runs `/promptstudio/references/triage` before the
vision capability probe. A single empty-text pose reference with one clear person
candidate in both photos qualifies. An explicit Whole guide selection also allows
one structure-only reference of any supported type, including prepared maps, to
skip subject matching. Custom instructions, multiple references, selected regions,
active masks or a forced-deep reference use the existing vision path.
It does not classify arbitrary user language or infer identity relationships.
Before deep prompt construction, empty-text pose requests with multiple confident
people and no matching selection ask for the recipient or donor. This prevents a
vision model from silently using gender resemblance as permission to pick someone.
Unavailable or uncertain detection still leaves ambiguity assessment to vision.

`/promptstudio/references/detect` supplies optional person candidates to the shared
reference editor's **Find people** control. Choosing a candidate saves the same
normalized rectangle as manual selection, including source-image binding. Boxes
are not masks. The Video reference controller uses the shared service/client;
person counts do not bypass the Video Director or its temporal analysis.

The optional backend reuses the installed pose pack's verified YOLOX-L ONNX asset,
preprocessing and postprocessing. No downloads, package installs or GPU allocations
occur here. One CPU session (two inference threads) is kept for the process lifetime;
there is a RAM cost even after inference. Missing weights, incompatible pack APIs,
missing ONNX runtime or concurrent detector work fall back to deeper analysis.
The browser bounds its optional request to ten seconds. A cancelled request can
finish the one admitted CPU inference but cannot queue additional detector work.

The bounded 32-entry cache uses image byte hashes and is invalidated on model-file
identity changes. It retains boxes, not image pixels. File references pass the same
path validator as normal image inputs. Images are EXIF-transposed before analysis.
The implementation keeps candidates above 0.15, including weak extra people; a
single candidate needs score 0.75, area at least 5%, and a 1% margin from all edges.
These are conservative routing heuristics, not calibrated probabilities or proof
of exact scene contents. Small, occluded and stylized people can still be missed.

`tests/live_reference_detection.py` exercises the real API without an LLM or render
queue and removes its imported fixtures. On this Windows installation, the first
CPU detection took 968 ms including model initialization; subsequent uncached
fixtures took 361–493 ms, cached requests 1–5 ms (server timings). These small smoke
tests establish wiring and rough latency, not accuracy across real editing data.
Unit/browser tests cover uncertainty, forced analysis, cancellation, no-LLM bypass,
candidate selection, keyboard use and existing clarification/queue behavior.

The deeper tools are explicit actions in Targeting:

- Resolve donor and recipient supplies detected person IDs and boxes to the
  configured vision provider. Only returned IDs present in that evidence can be
  applied. The user sees donor/recipient boxes and chooses Use these selections;
  unresolved cases produce a clarification. It does not guess garment ownership
  from box counts.
- Find object uses Grounding DINO Tiny only when requested. The current selection
  crops its search region. Setup installs a pinned, verified checkpoint and text
  processor files into the extension's ignored `reference_models` directory.
  The optional host Transformers runtime must be available. Model files never
  download during inference. A separate CPU process uses two threads, no remote
  code and local-only model loading; it exits after inference. Its timeout is
  180 seconds; admission and the 32-entry content/model/query/region cache are
  shared for object analysis. There is no per-generation cost unless requested.
- Create edit mask uses the host's installed SAM ViT-B and Segment Anything
  runtime in the same bounded CPU worker. It clips the segmentation to the chosen
  region and feathers inward, then saves a PNG for preview. Mask use is opt-in.
  Source file hashes and exact source dimensions protect against stale masks.
  `KCPP_ReferenceRegionComposite` supports RGB sources and RGB/RGBA generated
  pixels, resizing the generated result to source dimensions. A zero mask retains
  original pixels; generated alpha modulates the blend. It accepts only the
  tested direct VAE Decode to SaveImage, PreviewImage or Save as WebP graph shape;
  masked WebP saves become lossless. This is post-compositing, not latent inpainting.

Workers may finish their single admitted operation after a UI request is closed.
Late results cannot overwrite changed selections; closing/changing the reference
context aborts browser requests. Missing optional packages/models leave manual
selection and ordinary editing available. Masks are part of saved reference state
and executable replay; Video retains its separate temporal generation path.

In the live two-person fixture, object detection took 9.6–11.6 seconds and SAM
8.8 seconds on CPU (worker inference timings, excluding process startup). The
unrestricted jacket query also matched a sweater; limiting the search to the
chosen donor/recipient is useful, and candidate review remains necessary. These
are heavier on-demand tools, not additions to the fast automatic classifier.
Real edit outcomes, pixel-preservation checks and remaining quality limits are
recorded in [reference validation](reference-validation.md).
See the upstream
[pose detector](https://github.com/Fannovel16/comfyui_controlnet_aux/blob/main/src/custom_controlnet_aux/dwpose/dw_onnx/cv_ox_det.py)
for the reused model preprocessing contract.
