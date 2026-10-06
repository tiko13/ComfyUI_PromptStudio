---
{"id":"nodes","topic":"nodes","studio":"shared","summary":"List all Prompt Studio suite nodes and what each does; node names, canvas inventory, and which node to choose. Video companion nodes have a separate video-nodes catalog."}
---
Prompt Studio supplies these nodes (display name followed by class ID):
- KoboldCpp Prompt Slot (KCPP_PromptSlot): passes the Studio prompt and resolution into a graph.
- KoboldCpp Prompt Amplify (KCPP_PromptAmplify): rewrites canvas prompts; Studio prompt handoff.
- KoboldCpp Apply (KCPP_Apply): raw KoboldCpp text completion.
- Ideogram4-KoboldCPP (KCPP_Ideogram4): rewrites selected JSON prompt fragments while preserving structure.
- Prompt Studio Image Source (KCPP_ChatImageInput): loads the selected image for editing, with a mask.
- Prompt Studio Reference Image (KCPP_ChatImageReference): independently assigned, named image input.
- Qwen Structure Guide (ControlNet) (KCPP_QwenStructureGuide): extracts and frames a structural reference map.
- Reference Edit Mask Composite (KCPP_ReferenceRegionComposite): preserves source pixels outside a selected edit mask.
- Prompt Studio Upscale (KCPP_PromptStudioUpscale): loads an upscale source and calculates target dimensions.
- Prompt Studio Model Loader (KCPP_PromptStudioModelLoader): loads diffusion models.
- Prompt Studio LoRA Loader (KCPP_PromptStudioLoraLoader): applies an ordered model-only LoRA stack.
- Prompt Studio Sampler (KCPP_PromptStudioSampler): standard KSampler behavior with explicit Studio plot controls.
- Qwen Image 2.1 Turbo v0.3 LoRA (KCPP_QwenImage21TurboLora): unmerged Viggle adapter.
- Qwen Image 2.1 Turbo v0.3 Sampler (KCPP_QwenImage21TurboSampler): six-step schedule, seed plots.
- Save as WebP Conditional (Save_as_webp_cond): saves WebP or produces a temporary preview; passes images through.
- Prompt Studio Input (PromptStudioInput): canvas-only primitive exposing one scalar widget under Additional Inputs.
This lists suite nodes only. Video has additional companion nodes and different Studio controls. Retrieve the matching detail topic for node inputs, outputs, wiring and limitations.
