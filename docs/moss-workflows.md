# MOSS Image workflows

Settings → General → Run setup supplies three Image Studio creation workflows:

| Workflow | Sampling defaults | Recipe adapters |
| --- | --- | --- |
| MOSS SFT Create | 50 steps, CFG 3, Euler / sgm_uniform, shift 5 | Optional Destripe, initially 0 |
| MOSS SFT 8-step · Optional Refine | 8 steps, CFG 1, Euler / normal, shift 5 | SFT DMD v0.1 at 1; optional 1.5× / 4-step, 0.15-denoise refinement |
| MOSS SFT Controlled | Same SFT defaults | Destripe plus required color/depth adapter |

These are BF16 presets. Setup shares the Qwen3.5 9B encoder between all presets and the existing Flux2 VAE requirement with FIBO. It pins download revisions, sizes and SHA-256 hashes, recognizes matching installed assets and reports missing/outdated native nodes. Required adapters are stored under `MOSS-Required`, separate from user LoRA folders. Setup does not download anything until requested through its existing review flow. INT8/W4A8 recipes and MOSS image editing are not included.

## Modular graph contract

The existing Studio Model Loader, LoRA Loader, Prompt Slot, Sampler and save node remain the Studio interfaces. Native ComfyUI provides `CLIPLoader(type=moss_image)`, `CLIPTextEncode`, `EmptyFlux2LatentImage`, `ModelSamplingAuraFlow`, `LoraLoaderModelOnly`, `VAEDecode`, `CreateBoundingBoxes`, `MOSSImageLayoutPrompt` and `MOSSImageControl`. Standard SFT uses the native skip-layer guidance patch for single layer 22; SFT 8-step omits that patch. There is no new MOSS inference node or custom sampler.

`PromptStudioInput` exposes shift, Destripe and control strength/start/end through the existing Additional Inputs mechanism. The shared workflow adapter normalizes native reactive widget state at the JSON queue boundary before immutable capture. The bounding-box preview is excluded from final-image output discovery; the workflow still has one final image output.

`PS_StructureInput` gains optional `control_key` and `guide_types` fields appended after its existing widgets. Existing unnamed structure guides and outputs remain compatible. Connected named color/depth slots are independent; their keys must be unique. Preparation is model-independent: nearest-neighbor color resizing preserves region IDs, while depth uses continuous interpolation, optional inversion and shared fit/crop/stretch framing. Conditioning remains in the native model-specific node. Prepared maps need no extractor; extracting depth from photos uses the existing optional depth extractor.

## Layout and maps

Open **Additional Inputs → Layout and control maps**. The editor is inset within the visible Studio window, including on ultrawide displays, with a resizable segment list, a canvas that fits the output aspect ratio and a properties panel. Collapse panels with **Segments / Properties**, or explicitly maximize the editor. Narrow screens use switchable side sheets. Description fields grow with their contents and offer **Expand editor**.

Use **Select** to select/move boxes and **Draw** to create an object by dragging. Empty clicks do not create boxes. Right-click an overlap for a foreground-first picker, or Alt+click to cycle through boxes at that point. A chosen covered box remains selected when dragging; picking does not change stacking order. The segment list also selects covered boxes. Resize from any corner or edge, or enter normalized percentages. Objects, characters and exact text remain separate element types. Appearance palette swatches remain distinct from categorical map colors. The list displays foreground first: drag rows or use **Bring forward / Send backward** to order them. Submission still serializes background to foreground. The native MOSS compiler owns prompt syntax and coordinate conversion; Studio does not reproduce its serializer.

Delete/Backspace deletes the selected segment when the canvas or segment list has focus; Ctrl+D duplicates, arrows nudge and Shift+arrows move farther. Text fields retain normal editing shortcuts. Ctrl+Z / Ctrl+Shift+Z undo/redo editor changes outside inputs. A complete drag is one undo step; selection and view changes are not edits. Escape during a drag cancels the gesture. Pan (or Space+drag), zoom and **Fit canvas** change the view without changing generation coordinates. **More** contains reset and JSON import/export.

**Apply changes** saves per chat and workflow, including text still being edited; Cancel/Escape otherwise discard the draft. Workflow switches retain values without applying them to another graph. Changing layout/map connections requires review and Apply again. Controls and maps are captured before asynchronous queue preparation, and exact history replay retains the submitted graph.

The **Control maps** tab provides independent color/depth upload and drop targets, a large preview and map-specific settings. A flat color-region map can also be generated from the ordered layout boxes. New generated maps retain a layout signature so subsequent box/order changes show a regeneration warning, including after reopening. Existing maps without this metadata remain usable. Uploaded maps can be previewed behind the boxes with adjustable opacity. Both maps use one alignment setting and should have matching framing/aspect ratios. Depth uses near-white convention, with inversion available. For photo extraction, the preview shows the source photo, not extracted depth. Color values identify regions; they do not specify final object colors. The generated color map uses its own region IDs, not appearance palettes.

Both maps share native control strength and start/end interval. Suggested starting points are start 0/end 0.5 for synthetic maps, end 1 for photographic depth. A controlled recipe requires at least one active map. It remains a patched model at zero map strength; choose SFT Create for the unpatched baseline.

Destripe is SFT-specific. Its author's starting strengths are 1 at 768 and 1.5 at 1024; 0 disables it. SFT DMD v0.1 is a separate mandatory recipe adapter, not an ordinary user-stack entry; duplicate recipe adapters are rejected. Required model files are not bundled in this repository, and native conversion/unit/browser checks do not establish image quality or hardware memory requirements.

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

Sources: [MOSS native weights](https://huggingface.co/Comfy-Org/MOSS-Image), [Destripe](https://huggingface.co/nynxz/MOSS-Image), [color/depth adapter](https://huggingface.co/darask0/MOSS-Image-color-depth-control), [native MOSS nodes](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_moss_image.py).

## Interactive SFT recipe

The new recipe adapts the generation and low-denoise refinement path from `MOSS_v2.json`. It uses native/Studio nodes, SFT BF16 instead of DirtyMoss, the shared BF16 encoder, and the exact [SFT 8-step Civitai version](https://civitai.red/models/3006599/moss-image-turbo-loras?modelVersionId=3411385), pinned by file ID and SHA-256. The base uses 8 steps at CFG 1, Euler/normal and shift 5. It omits the source style LoRAs, SeedVR2, utility nodes and automatic second pass.

Intermediate / Choice saves the base image permanently by default, using the shared PNG/WebP output preferences. Its saved file appears directly in history, without a duplicate temporary preview. Disable Save intermediate for a temporary image with a small history thumbnail retained after cache cleanup. Refine follows its IMAGE output through native 1.5× bicubic scaling, tiled VAE encoding, four Euler/normal steps at CFG 1 and denoise 0.15, and final saving. It uses the captured image and settings without re-running the base sampler. Required adapters remain separate from the user LoRA stack. Studio resolution controls own the base dimensions.
