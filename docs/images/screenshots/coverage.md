# Prompt Studio screenshot coverage

Captured 2026-09-24. Open [the visual gallery](gallery.html). All 39 PNGs are native **1920 × 1080**, captured at device scale 1 without resizing. Opaque privacy redactions cover session history and local runtime identifiers; all pixels outside those rectangles are unchanged. Video was excluded. The older unredacted overview JPG is an ignored local draft and is not included in this gallery.

## Ready to review for the README

39 candidates cover creation, conversational revision, Main/Final separation, style/framing, direct mode, image discussion, editing, single and multiple references, upscale controls/results, models/LoRAs/resolution, XY(Z) configuration/results, saved inputs/replay, explicit assistant context, setup, workflow selection, backend settings, profile editing, reusable configuration, system status, image preview, every Prompt Studio server-side node category, the client-side workflow input, and embedded canvas chat.

Suggested first selection: 01 overview, 04 watercolor, 07 edit, 09 reference roles, 14 comparison grid, 19 setup, 40 node pipeline, and 41 embedded canvas chat.

- Generated result examples are real ComfyUI outputs. The six-cell plot completed all six cells.
- Single/multiple reference screenshots show staged inputs. The single Krea edit was not executed; the setup check reported an installed-node compatibility problem involving target_latent.
- The five reusable configuration forms are unsaved examples and were canceled. The model/LoRA controls and profile editor are configuration demonstrations, not inference validation.
- Canvas diagrams use real registered nodes in an unsaved scratch graph. They are focused wiring fragments, with some required ports intentionally outside the fragment. They are not complete runnable workflows or execution results.
- Llama.cpp was restored as provider and Keep models loaded remained enabled for the user's separate-GPU setup. No ComfyUI restart or model installation was performed.

## Remaining UI coverage

- **Multiple named workflow image slots:** none of the 22 installed templates exposes more than one generic Reference Image node. Qwen roles are captured in 09; the underlying named source/reference nodes are shown in 35. A separate multi-slot dialog capture needs an appropriate real workflow.
- **Native Llama.cpp config builder:** the editor now opens inside Prompt Studio and is browser-capturable. Existing captures 21 and 22 show backend/profile controls; they predate the in-app editor.
- **Password-protected LAN login:** the local loopback session bypasses this screen; LAN access/security configuration was not changed for a screenshot.
- **Mobile layout:** intentionally omitted because this set is strictly 1920 × 1080 desktop captures.

## Capture index

| PNG | Use | Caption |
| --- | --- | --- |
| [01-studio-overview-landscape](01-studio-overview-landscape.png) | README candidate | Overview: landscape generation, conversation, Main and Final prompts. |
| [02-conversational-revision](02-conversational-revision.png) | README candidate | Two generated variants show a blue-to-terracotta pot revision. |
| [03-main-and-final-prompts](03-main-and-final-prompts.png) | README candidate | Main preserves scene intent; Final contains the rendered generation prompt. |
| [04-style-and-framing](04-style-and-framing.png) | README candidate | A generated watercolor scene with style and framing controls. |
| [05-direct-generation](05-direct-generation.png) | README candidate | Direct prompt generation with LLM amplification disabled. |
| [06-image-discussion](06-image-discussion.png) | README candidate | Image discussion and a proposed prompt change. |
| [07-image-editing](07-image-editing.png) | README candidate | A real edit adds a copper watering can to the botanical scene. |
| [08-single-edit-reference](08-single-edit-reference.png) | README candidate | Single Krea reference and workflow controls. Staged attachment; no Krea edit was run. |
| [09-multiple-edit-references](09-multiple-edit-references.png) | README candidate | Two Qwen references with background and custom-instruction roles. Staged; not submitted. |
| [11-upscale-dialog](11-upscale-dialog.png) | README candidate | Choose the upscale factor for an existing image. |
| [11a-upscaled-result](11a-upscaled-result.png) | README candidate | Actual result from the 2x Krea UltimateSD upscale workflow. |
| [12-model-lora-resolution](12-model-lora-resolution.png) | README candidate | Select a model, add a photography LoRA, and choose landscape resolution. Configuration example. |
| [13-xyz-plot-builder](13-xyz-plot-builder.png) | README candidate | Configure six cells: Steps 10/20/30 against CFG 2/5. |
| [14-xyz-comparison-results](14-xyz-comparison-results.png) | README candidate | The completed six-image comparison with labeled axes. |
| [15-saved-generation-inputs](15-saved-generation-inputs.png) | README candidate | Saved workflow, dimensions, model, node inputs, and prompt replay. |
| [16a-assistant-context](16a-assistant-context.png) | README candidate | Explicit Main, Final and generation-settings attachments. Question is staged; image attachment is available. |
| [19-setup-wizard](19-setup-wizard.png) | README candidate | Workflow and model choices in setup. No installation was started. |
| [20-workflow-templates](20-workflow-templates.png) | README candidate | Create, Edit and Upscale workflow selection. |
| [21-local-backend](21-local-backend.png) | README candidate | Llama.cpp settings with Keep models loaded enabled for separate GPUs. |
| [22-llm-profile-editor](22-llm-profile-editor.png) | README candidate | Thinking and sampler profile editor. Viewed without saving; Llama.cpp restored afterward. |
| [23-known-references](23-known-references.png) | README candidate | A staged Botanical Studio named-reference definition; canceled without saving. |
| [23a-style-presets](23a-style-presets.png) | README candidate | A staged botanical watercolor style preset; canceled without saving. |
| [23b-framing-presets](23b-framing-presets.png) | README candidate | A staged workbench-detail framing preset; canceled without saving. |
| [23c-instruction-templates](23c-instruction-templates.png) | README candidate | A staged scene-preservation instruction template; canceled without saving. |
| [23d-protected-words](23d-protected-words.png) | README candidate | A staged protected botanical phrase; canceled without saving. |
| [24-system-status](24-system-status.png) | README candidate | Local backend readiness, ComfyUI controls, recent activity and diagnostics entry points. |
| [28-full-size-preview](28-full-size-preview.png) | README candidate | Full-size image preview inside Prompt Studio. |
| [30-prompt-slot-canvas](30-prompt-slot-canvas.png) | README candidate | Prompt Slot wired to CLIP Text Encode. |
| [31-prompt-amplify-canvas](31-prompt-amplify-canvas.png) | README candidate | Prompt Amplify controls and the text-encoding handoff. |
| [32-model-loader-canvas](32-model-loader-canvas.png) | README candidate | Model Loader connected to the LoRA Loader. |
| [33-lora-loader-canvas](33-lora-loader-canvas.png) | README candidate | LoRA Loader connected to the Prompt Studio Sampler. |
| [34-sampler-canvas](34-sampler-canvas.png) | README candidate | Latent image through the Sampler to VAE Decode. |
| [35-source-and-reference-canvas](35-source-and-reference-canvas.png) | README candidate | Image Source and a named Reference Image node. |
| [36-upscale-node-canvas](36-upscale-node-canvas.png) | README candidate | Prompt Studio Upscale image output and downstream scaling. |
| [37-general-llm-node-canvas](37-general-llm-node-canvas.png) | README candidate | KoboldCpp Apply for general local-LLM text processing. |
| [38-ideogram-json-canvas](38-ideogram-json-canvas.png) | README candidate | Ideogram JSON amplification with a safe botanical description. |
| [39-workflow-input-canvas](39-workflow-input-canvas.png) | README candidate | A named workflow input feeds a 25-step value into the sampler. |
| [40-model-lora-sampler-canvas](40-model-lora-sampler-canvas.png) | README candidate | Model, LoRA and Sampler wiring in one canvas view. |
| [41-canvas-prompt-chat](41-canvas-prompt-chat.png) | README candidate | Embedded Prompt Chat beside the ComfyUI node canvas. |
