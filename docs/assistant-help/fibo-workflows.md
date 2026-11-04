---
{"id":"fibo-workflows","topic":"fibo-workflows","studio":"image","summary":"FIBO 2 Dev Create, Dev Edit and Turbo Edit setup, prompting and modular workflow wiring."}
---
Settings > General > Run setup offers three FIBO presets. Review model terms. Setup shares the Qwen3-VL 4B encoder and Flux2 VAE, downloads missing checkpoints and checks native ComfyUI support. Refresh workflows after setup.
Dev supports Create and Edit; Turbo is an Edit preset. Defaults live on the sampler nodes. Reference capacity and numbering come from connected Reference Collection/Prompt nodes. Image Source supplies the edit target. Prompt Slot, optional LoRA stack, Studio sampler and save nodes are reused.
Use plain instructions; for edits name what changes and what stays. The native encoder also accepts a result VGL JSON caption with edit_instruction. Prompt Settings passes canvas text through; it does not generate JSON.
Create dimensions come from Prompt Slot. Edit defaults follow source aspect near 1 MP. Edit Mask composites after decoding, not native inpainting; without a mask, unchanged details may drift. No Qwen ControlNet or RGBA output is advertised. These are Image Studio presets; Video keeps its own H3 workflows.
