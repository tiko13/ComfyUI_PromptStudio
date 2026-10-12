---
{"id":"models","topic":"models","studio":"image","summary":"Change image-generation model, model profile, or local assistant LLM."}
---
Choose diffusion models in the sidebar's {model_label} section when the workflow exposes loaders (availability: {model_selection}). Refresh models rescans files. Otherwise select a compatible workflow or edit its loader in ComfyUI.
Generation controls > Model profile sets image prompt guidance. Add or edit local profiles in Settings > Model profiles.
LoRA: Add a LoRA searches files/folders; click or arrows/Enter adds, Escape closes. Added files have strength/× controls. Refresh LoRAs rescans. No LoRAs available means none remain. Details left of × shows Civitai triggers/notes; ↑ marks newer versions. Models also have Details.
For the assistant LLM, open the sidebar gear (Prompt Studio settings), choose LLM provider, then Backend settings. Current provider: {provider}. Llama.cpp has managed server/config controls; KoboldCpp loads models on its server; Ollama has model selection.
Switching waits for LLM work, stops managed Llama.cpp or unloads selected/Studio-used Ollama models, even with Keep models loaded. Ollama/external servers stay running. Cleanup errors retain the previous provider. If switching has not loaded after an update, use Restart ComfyUI in the status monitor.
Backends remember connections, models, profiles, thinking modes and Keep models loaded across switches/reloads. Missing models/configs keep their selection until you choose a replacement.
For one GPU, leave Keep models loaded off and target ComfyUI's GPU in the Llama.cpp config. Start/restart via Backend settings for router mode; external servers also need router mode. Studio unloads the LLM before rendering, keeps its server running, then releases ComfyUI models before the next LLM request reloads it. Unloaded models show as ready.
For separate GPUs, enable Keep models loaded: both studios skip rendering handoffs. With Llama.cpp Start with ComfyUI enabled, the configured model also loads at startup, before any prompt. Explicit backend switches still release the previous backend.
