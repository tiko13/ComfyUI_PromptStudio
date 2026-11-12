---
{"id":"workflows","topic":"workflows","studio":"image","summary":"Select, refresh or set up Create, Edit and Upscale workflows."}
---
Open the sidebar gear labelled Prompt Studio settings, then ComfyUI workflow templates. Choose Create template, Edit template or Upscale template. Current selector: {workflow_label}; mode: {mode}; workflow: {workflow}. Use Create/Edit in the composer; upscale through an image's Upscale action. Workflow changes immediately refresh input guidance, edit prompt controls, references, models and additional controls, preserving unsent text and saved references.
Install through Settings > General > Setup wizard > Run setup. Compatible [PS] workflows are cached; seed, prompt, model and LoRA changes update a private copy. Saving in ComfyUI refreshes the cache; use Refresh workflows for external file edits. Arbitrary graphs still need the required Prompt Studio nodes.
Selections are saved per chat. Make default workflow sets each row's browser default for new chats and empty selectors, marked Default. Existing choices take priority; without a default, new chats inherit the current choice. Unavailable selections/defaults stay remembered instead of switching to another workflow.
Bundled workflow prompt and image-reference fields start empty. Supply your own prompt and any required images, including the requested operation for a background-removal workflow. Model settings and setup notes are retained.
In the standalone page, use Image/Video in the header to switch studios, including after refreshing. Video requires the companion to be installed and connected.
Settings uses compact sections. Expand Workflow requirements for graph-authoring rules; Image output controls PNG/WebP defaults and identifies forced output nodes.

Qwen Turbo templates use the official INT8 Turbo model with eight fixed Euler steps and CFG 1. Base25/base40 retain adjustable sampling. Older Turbo template selections move to the official variants; saved generation snapshots retain their original execution.
