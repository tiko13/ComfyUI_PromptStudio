---
{"id":"models","topic":"models","studio":"image","summary":"Change image-generation model, model profile, or local assistant LLM."}
---
There are three different model choices. The image-generation model is selected in the sidebar's {model_label} section when the selected workflow exposes model loaders (current availability: {model_selection}). Choose a model for the relevant loader there; use Refresh models to rescan available files. If no loader is exposed, change to an appropriate workflow or edit its loader in ComfyUI; do not invent a Studio dropdown.
Model profile under Generation controls changes prompt formatting/guidance, not the loaded diffusion model.
For the assistant LLM, open the sidebar header gear (Prompt Studio settings), choose LLM provider, then Backend settings for connection/model/server options. Current provider: {provider}. Llama.cpp uses its managed server/config controls; KoboldCpp's loaded model belongs to that server; Ollama uses its model selection. Ask which kind only when the context does not make the distinction clear.
