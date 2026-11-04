# MOSS Image workflows

Settings → General → Run setup supplies four Image Studio creation workflows:

| Workflow | Sampling defaults | Recipe adapters |
| --- | --- | --- |
| MOSS SFT Create | 50 steps, CFG 3, Euler / sgm_uniform, shift 5 | Optional Destripe, initially 0 |
| MOSS SFT Controlled | Same SFT defaults | Destripe plus required color/depth adapter |
| Kromoss DMD2 Create | 8 steps, CFG 1, Euler / simple, shift 5 | Required DMD2 at strength 1 |
| Kromoss Realism Create | 12 steps, CFG 1, Euler / simple, shift 5 | DMD2 1 + older DMD 0.5 + Snapshot Photo v14 0.5 |

These are BF16 presets. Setup shares the Qwen3.5 9B encoder between all four and the existing Flux2 VAE requirement with FIBO. It pins download revisions, sizes and SHA-256 hashes, recognizes matching installed assets and reports missing/outdated native nodes. Required adapters are stored under `MOSS-Required`, separate from user LoRA folders. Setup does not download anything until requested through its existing review flow. INT8/W4A8 recipes and MOSS image editing are not included.

## Experimental realism variant

Kromoss Realism Create adapts the [dual-turbo Reddit recipe](https://www.reddit.com/r/StableDiffusion/comments/1xf5i17/moss_turbo_without_the_blur_for_realism/) to the existing Kromoss BF16 checkpoint. It reuses the encoder, VAE and DMD2 adapter; only the older DMD and [Smartphone Snapshot Photo Reality v14](https://civitai.com/models/3010926?modelVersionId=3417017) are added. The photo adapter is pinned by Civitai model-version/file IDs, size and SHA-256. The original Kromoss preset is unchanged.

Set Studio Resolution to 1.5 MP to match the guide; normal Studio resolution/aspect controls remain authoritative. A native StringConcatenate node prepends the trained `photo` trigger before layout compilation, including when Studio replaces the scene prompt. The guide's negative prompt has no guidance effect at CFG 1, so negative conditioning starts empty. The author recommends one turbo adapter at a time; this combination is experimental, and quality on Kromoss is unverified. Required adapters stay out of the user LoRA stack.

## Modular graph contract

The existing Studio Model Loader, LoRA Loader, Prompt Slot, Sampler and save node remain the Studio interfaces. Native ComfyUI provides `CLIPLoader(type=moss_image)`, `CLIPTextEncode`, `EmptyFlux2LatentImage`, `ModelSamplingAuraFlow`, `LoraLoaderModelOnly`, `VAEDecode`, `CreateBoundingBoxes`, `MOSSImageLayoutPrompt` and `MOSSImageControl`. SFT uses the native skip-layer guidance patch for single layer 22; DMD2 omits that patch. There is no new MOSS inference node or custom sampler.

`PromptStudioInput` exposes shift, Destripe and control strength/start/end through the existing Additional Inputs mechanism. The shared workflow adapter normalizes native reactive widget state at the JSON queue boundary before immutable capture. The bounding-box preview is excluded from final-image output discovery; the workflow still has one final image output.

`PS_StructureInput` gains optional `control_key` and `guide_types` fields appended after its existing widgets. Existing unnamed structure guides and outputs remain compatible. Connected named color/depth slots are independent; their keys must be unique. Preparation is model-independent: nearest-neighbor color resizing preserves region IDs, while depth uses continuous interpolation, optional inversion and shared fit/crop/stretch framing. Conditioning remains in the native model-specific node. Prepared maps need no extractor; extracting depth from photos uses the existing optional depth extractor.

## Layout and maps

Open **Additional Inputs → Layout and control maps**. Draw, move and resize boxes or enter normalized percentages. Objects, characters and exact text are separate element types. Descriptions and appearance palettes remain distinct from categorical map colors. Order elements from background to foreground. The native MOSS compiler owns prompt syntax and coordinate conversion; Studio does not reproduce its serializer.

The editor supports duplication, deletion, ordering, centering, keyboard movement, undo/redo, reset and JSON import/export. Apply saves per chat and workflow; Cancel/Escape discard the draft. Workflow switches retain values without applying them to another graph. Changing layout/map connections requires review and Apply again. Controls and maps are captured before asynchronous queue preparation, and exact history replay retains the submitted graph.

Color and depth uploads are independent. A flat color-region map can also be generated from the ordered layout boxes. Uploaded maps can be previewed behind the boxes. Both maps use one alignment setting and should have matching framing/aspect ratios. Depth uses near-white convention, with inversion available. Color values identify regions; they do not specify final object colors. The generated color map uses its own region IDs, not appearance palettes.

Both maps share native control strength and start/end interval. Suggested starting points are start 0/end 0.5 for synthetic maps, end 1 for photographic depth. A controlled recipe requires at least one active map. It remains a patched model at zero map strength; choose SFT Create for the unpatched baseline. Kromoss plus color/depth control is deliberately not offered until render validation.

Destripe is SFT-specific. Its author's starting strengths are 1 at 768 and 1.5 at 1024; 0 disables it. It is not automatically applied to Kromoss. DMD2 is a separate mandatory recipe adapter, not an ordinary user-stack entry; duplicate recipe adapters are rejected. Required model files are not bundled in this repository, and native conversion/unit/browser checks do not establish image quality or hardware memory requirements.

## Image and Video integration

The shared implementation lives in Prompt Studio. MOSS creation templates and their layout editor belong to Image Studio. Video retains its H3 graph contract and consumes generated images through its existing reference path. It benefits from the shared conversion fix without acquiring a duplicate image pipeline. Existing unnamed references, masks, samplers, workflow state and output contracts are regression-tested in standalone and paired modes.

## Verification

- `tests/test_moss.mjs`: recipe wiring, scalar controls, geometry, named maps, persistence, immutable snapshots and invalid contracts.
- `tests/test_structure_maps.py`: categorical interpolation, continuous depth, padding/inversion and backwards-compatible widget order.
- `tests/test_moss_setup.py`: shared assets, pinned downloads and outdated runtime schemas.
- `tests/browser/moss.spec.mjs`: draft Apply/Cancel, order/undo, drawing/upload, persistence, queue isolation, accessibility and mobile layout.
- `tests/live_moss_workflows.mjs`: opt-in private-graph conversion against a running ComfyUI, without generation or replacing the user's canvas.

The repository's full Image standalone, Video integration and shared integration CI gates remain required. Actual diffusion renders require the selected model assets and are separate from these contract checks.

API submissions wrap bounding-box list widgets in ComfyUI's `__value__` envelope; bare arrays are interpreted as node links and rejected before sampling. Canvas metadata keeps ordinary arrays. Saved submissions and plot snapshots from before this fix are normalized without changing their captured layout. After updating, hard-refresh Studio before retrying a failed generation.

Sources: [MOSS native weights](https://huggingface.co/Comfy-Org/MOSS-Image), [Kromoss/DMD2](https://huggingface.co/lodestones/Kromoss), [Destripe](https://huggingface.co/nynxz/MOSS-Image), [color/depth adapter](https://huggingface.co/darask0/MOSS-Image-color-depth-control), [native MOSS nodes](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_moss_image.py).
