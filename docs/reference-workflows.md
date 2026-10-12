# Image Studio reference workflow nodes

Image Studio can discover reference/edit capabilities from connected nodes without recognizing the image model. Video Studio keeps its MiniMax contract. Existing undeclared Qwen and Krea workflows retain their legacy adapters.

## Small building blocks

| Node | Responsibility |
| --- | --- |
| `KCPP_ChatImageInput` (Image Source) | The image being edited; existing Studio source/history behavior. |
| `KCPP_ChatImageReference` | One named IMAGE/MASK input. `required` rejects missing images. `reference_mode=grounded_edit` opts a single donor into assisted editing; `workflow` uses the workflow's own prompt path. |
| `PS_ReferenceCollection` | Declares minimum/maximum references and comma-separated roles. Studio supplies the ordered image records. Maximum is configurable from 0 to 64, independently of Qwen. |
| `PS_ReferenceItem` | Reads one one-based collection item as IMAGE/MASK. Wire one for each advertised slot, or consume PS_REFERENCES in your own node. Missing optional items return None. |
| `PS_ReferencePrompt` | Declares prompt mode, reference numbering/tokens, source token and model instructions. Passes its STRING input through unchanged on the ComfyUI canvas. |
| `PS_StructureInput` | Prepares one optional pose/depth/edge/sketch guide at the wired dimensions; outputs IMAGE and strength. No model application is built in. |
| `PS_ApplyQwenStructure` | Applies an active guide with Qwen's union ControlNet. With no guide it passes MODEL through without loading a patch. Other models use their own application nodes. |
| `PS_EditMask` | Composites the generated edit over the source using Studio's paint mask. Without a mask it passes the generated image through. |

## Connecting a custom model

The reusable pattern is **Reference Collection -> Reference Item(s) -> your model's existing IMAGE/MASK inputs**. Collection carries ordered `PS_REFERENCES` records, not an image tensor. Item is the adapter to ordinary ComfyUI sockets, so the encoder can be native ComfyUI or supplied by another extension. For example, the bundled Qwen encoder is ComfyUI's `TextEncodeQwenImage21`, not a Prompt Studio encoder. Hover the Studio node title, each input/setting, or each output for its purpose and connection guidance.

1. Connect the existing Studio Prompt Slot/Amplify output to Reference Prompt Settings, then its prompt output to your model's encoder.
2. Set Reference Collection's maximum to the model's supported count (for example 2 or 16), its minimum, and roles such as `subject,style,texture`. Connect it to Reference Prompt Settings and to Reference Item nodes numbered 1 through the maximum.
3. Connect each item's image/mask to the corresponding model inputs. Your model node must accept None for unfilled optional slots; set minimum=maximum for nodes that require all slots, or use a custom PS_REFERENCES consumer to handle variable lists.
4. For editing, wire Studio Image Source to the model's source input. Set `source_token` and `reference_token` to its conventions; `{index}` is replaced using `first_reference_index`. Example: source `[canvas]`, references `[ref-{index}]`, first index 0.
5. Choose `edit_instruction` for a source-aware instruction prepared from the user's request and references. Choose `full_prompt` to keep the normal prompt pipeline and append reference guidance. Model instructions describe the encoder's wording conventions. These settings affect Studio preparation, not standalone canvas execution.
6. Optionally wire Structure Input to your model's guide application node, and connect its width/height to the Studio prompt dimensions. Add Edit Mask between decoded images and the image output, with the original Image Source on its source input.

Only connected capability nodes reaching the workflow's image output are active. Use one of each declaration per workflow, and keep capability settings as literal node widgets rather than Additional Inputs. Named reference nodes remain suitable for models with distinct inputs such as identity, style, or material; collections handle interchangeable ordered references.

The structure extractor is shared, but guide conditioning is model-specific. A prepared guide can be used without installing Qwen ControlNet. Extraction from photos still needs the corresponding optional extractor. One structure guide is supported; structure-only images do not occupy semantic model slots or reference numbering, but count toward the References panel capacity. Edit masks preserve pixels outside the painted region; they do not imply native model inpainting support.

## Compatibility and setup

The bundled Qwen workflows retain 10 Create entries and 9 Edit entries, their prompt conventions and model/sampler settings. Krea Edit explicitly declares its existing single donor behavior. RGBA output paths retain their previous mask availability.

Setup installs these explicit workflows. When an installed workflow is exactly equivalent to an older bundle after migration, Setup backs it up as `.json.pre-reference-nodes.bak` and upgrades it in place. Customized or ambiguous graphs are preserved; Setup installs a numbered copy instead. `reference_workflow_migration.upgrade_reference_workflow` is an idempotent, conservative migration helper for compatible serialized Qwen/Krea graphs.

Saved references and Main/Final prompts survive workflow switches. Unsupported controls hide without discarding stored values. Changing capacity/roles/prompt conventions invalidates prepared reference instructions; history retains the submitted graph for exact replay. Node declarations cannot make a model support more images than its encoder actually accepts.

## Qwen edit resolution and intermediate quality

The bundled Edit, RGBA Edit and Background Removal graphs set native `TextEncodeQwenImage21.resolution` to `0`: references keep their own dimensions, rounded to multiples of 32. Its latent output remains connected to the sampler so reference and output dimensions agree. The source controls edit dimensions independently of the Create resolution selector. This replaces the fixed 1056 setting that reduced approximately 4 MP sources to approximately 1.1 MP.

Their `Save_as_webp_cond` nodes set `format=png`, `mode=lossless`, and `force=true`. This is part of the serialized workflow, including direct ComfyUI canvas execution; Studio's existing forced-node contract respects it. No generation-time JavaScript resolution or format rewrite is required. Lossless saving prevents file-compression damage, not model reconstruction drift. Use the existing explicit edit mask where unchanged pixels must be retained; pose guides do not create preservation masks.

`tests/migrate_qwen_edit_quality.py` previews the corresponding installed-file and cached-profile migration; `--apply` backs up and updates them through ComfyUI APIs with conflict checks. It checks both studios, keeps sampler/model/source/mask wiring, and leaves generation history and exact replay snapshots unchanged. Higher-resolution edits require more memory and time.

Use different seeds between generation and editing, and between successive edits. At identical dimensions, reusing a generated image's seed can cause grain and halos through Qwen 2.1's noise replay behavior, as explained by the model contributor in [Diffusers issue 14824](https://github.com/huggingface/diffusers/issues/14824). Seed choices remain explicit; this migration does not silently alter a fixed seed.

## Reviewed pose background preservation

The six Qwen Edit/RGBA Edit bundles connect Image Source to Structure Input's source, its inpaint_image/inpaint_mask outputs to Apply Qwen Structure, and that same mask to Edit Mask. The source and mask reach native `ZImageFunControlnet` as `inpaint_image` and `mask`, following the [model card's combined pose and inpainting guidance](https://huggingface.co/alibaba-pai/Qwen-Image-2.1-Fun-Controlnet-Union). Describe the complete intended result, including the retained scene. The final composite keeps unpainted pixels exact at source resolution; the bundled save nodes force PNG.

Preserve background defaults on for pose edits. References > Edit background mask opens a source-resolution brush editor; paint the old body and all space needed by its new pose. White regenerates and black preserves. Review hair, clothes and shadows, especially after changing the pose. Apply stores a lossless PNG, source identity and SHA-256 digest. Source changes, incompatible dimensions and empty masks fail explicitly. Manual canvas users can connect an ordinary MASK to Structure Input's edit_mask instead. Preservation off returns empty inpaint outputs and bypasses the composite while retaining the saved mask. It allows scene changes, not guaranteed transparent removal. Background Removal and Create bundles remain outside this feature.

The shared reference controller detects the actual native node wiring; JavaScript only edits settings and mask records. Video consumes that controller, while its H3 graphs do not advertise Qwen inpainting. `tests/migrate_pose_inpaint.py --apply` backs up and upgrades installed files and both studios' cached profiles through supported APIs. History replay graphs stay unchanged. Customized conflicting inpaint connections require manual review.

When opening the mask editor without a matching saved mask, Studio detects the original source pose through the existing queued extractor, obtains target joints from the edited pose or reference photo, and queues `PS_EstimatePoseMask`. The node unions body-aware original/target masks, uses the exact guide framing/placement implementation and adds soft edges. A donor's original skeleton is never substituted for the source. Multiple people require explicit Whole guide scope; otherwise manual review/painting avoids guessing a recipient. Source and target detections are cached only within the editor session for padding adjustments. Mask padding affects the next Estimate from poses operation; re-estimating can be undone. Existing masks reopen unchanged and require an explicit re-estimate. The circle cursor shows brush size in display pixels in Paint and Erase modes. Apply still saves a reviewed mask; estimation does not silently start diffusion.
