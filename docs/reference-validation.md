# Reference edit validation, 2026-10-06

Local Windows validation used the existing ComfyUI runtime, Qwen Image 2.1 INT8,
the INT8 vision encoder, BF16 VAE, Turbo v0.3 six-step LoRA/sampler and seed
210923. Created fixtures are 768 square; ordinary edits decode at 1056 square.
Masked output returns to source dimensions. ControlNet strength was 0.8.
These are small, inspected examples, not a model-quality benchmark.

`tests/live_reference_edits.py` is an opt-in harness. It checks the existing queue
and Image/Video jobs before rendering, uses the managed GPU handoff, and records
exact executable graphs, prompts, output references and prompt IDs under
`test-results/reference-edits/`. Completed named renders are reused. A pending
request must be checked before retrying; there is no automatic queue cancellation.

| Case | Observed result | Limitation |
| --- | --- | --- |
| Two source people, two reference people, jacket transfer | Correct dark-haired recipient received the left reference person's red jacket | Unmasked output also changed surrounding pixels; jacket details were approximate |
| Resolve donor and recipient | Correct donor and recipient candidate IDs and preview boxes | Still requires vision; missed detections require manual selection |
| Find jacket inside selected recipient | One useful jacket box | Unrestricted search also matched the other person's sweater |
| SAM mask and real Qwen edit | Red jacket transfer within the selected silhouette | Thin blue borders and seams remain where original and generated silhouettes differ |
| Masked PNG and lossless WebP | Maximum channel difference outside zero-mask pixels was exactly 0 | Post-compositing does not guide diffusion or provide room for moved limbs |
| Single-person pose transfer | Raised arms transferred while retaining blue clothing and photographic appearance | One inspected fixture |
| Empty instructions, two source people and one pose; reverse case | Both now ask for the missing recipient/donor selection, with no generated prompt | Requires confident detector evidence; unavailable detection still uses vision |
| Apply wide pose only to left person | Correct person changed pose | Fitting the wide pose into half the canvas shrank that person significantly |
| Whole Depth and Edges guides | Photographic output retained broad composition and clothing colors | Not pixel-preserving without a mask; same-image guides used in this smoke test |
| Whole Sketch guide | Guide affected output | Strong line-art drift, including after an explicit geometry-only photographic instruction |

Object detection took roughly 9.6–11.6 seconds and SAM about 8.8 seconds on CPU,
excluding worker process startup. The fast person detector is separate; Grounding
DINO and SAM run only when requested. This installation already had the optional
Transformers and Segment Anything packages and SAM checkpoint. The pinned official
Grounding DINO Tiny assets were downloaded and verified through the existing asset
installer. No package installation was added.

The masked workflow exposed a four-channel decoder output; the compositor now
accepts RGB or RGBA generated pixels with an RGB source and uses generated alpha
in blending. It retains all generated batch items. Source hashes, selection checks
and dimension validation reject stale masks. Supported WebP saves become lossless
to retain pixels outside the mask.

The initial real ambiguity check exposed a vision model that chose the man without
an explicit recipient. Empty-text pose requests now check for multiple confident
person candidates before vision prompting and ask for the missing selection.
The guard respects supplied selections, instructions and explicit Whole guide.
Both directions passed against the real fixtures after restarting the backend.

Automated validation covers conservative routing, mapping candidate validation,
mask graph insertion, batch/alpha/pixel preservation, stale selection rejection,
setup catalog/routes, reference persistence and help budgets. Browser cases cover
mapping review, object selection, mask preview/enable, pointer and keyboard use,
narrow layout, clarification continuation and shared Video reference inputs.
Video's temporal workflow does not receive the image compositor. Validation was
performed on Windows; Linux execution has not been verified here.

The quality limitations above remain visible in the UI guidance. Better selective
pose placement needs keypoint or torso alignment and explicit room for new limbs;
rectangle fitting alone cannot guarantee the original subject scale. Better mask
boundaries need an expansion/refinement workflow or compatible latent inpainting.
Sketch needs strength/model benchmarking before promising photographic fidelity.

Local example artifacts: `jacket-baseline.png`, `jacket-masked.png`,
`jacket-lossless.webp`, `pose-single.png`, `pose-two-targeted.png`,
`whole-depth.png`, `whole-edges.png`, `whole-sketch-contours.png`.
