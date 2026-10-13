---
{"id":"lora-studio.comparisons","topic":"plots","studio":"image","summary":"Compare LoRA Studio checkpoints with Create workflows without importing weights into the LoRA library."}
---

In LoRA Studio Results, choose Compare checkpoints. Select saved checkpoints, a compatible Create workflow, model when exposed, strength, prompt and seeds. The grid and saved images stay in LoRA Studio; no Prompt Studio chat or plot is created. Retry failed cells or re-run using retained snapshots, even if training retention removed the original files.

Requires the local comparison bridge and both apps on the same computer. The internal PS_LoraStudioCheckpoint node accepts only registered checkpoint IDs, loads immutable LoRA Studio snapshots, and never adds files or paths to ComfyUI's LoRA library. Restarting ComfyUI clears registrations; resume from LoRA Studio to register pending checkpoints again.

During a comparison the status reads Generating in LoRA studio. Image and Video generation requests queue until the entire comparison finishes or stops, including between checkpoints and seeds. Existing ComfyUI work finishes first. Shared-GPU LLM requests use the same reservation; dedicated keep-loaded providers retain their configured behavior. If LoRA Studio disconnects, the reservation expires automatically after any already submitted comparison image finishes.

Refresh workflows in Prompt Studio if a Create workflow is missing. Supported workflows need explicit matching LoRA families, connected seed controls and image results. Edit and required-image workflows are excluded. Video Studio does not expose checkpoint comparisons.
