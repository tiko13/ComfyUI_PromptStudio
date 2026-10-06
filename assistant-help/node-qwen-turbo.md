---
{"id":"node.qwen-turbo","topic":"node-qwen-turbo","studio":"shared","summary":"Qwen Image 2.1 Turbo v0.3 LoRA (KCPP_QwenImage21TurboLora) and Qwen Image 2.1 Turbo v0.3 Sampler (KCPP_QwenImage21TurboSampler): wiring, adapter, fixed sampling and seed plots."}
---
Qwen Image 2.1 Turbo v0.3 LoRA (KCPP_QwenImage21TurboLora) takes a MODEL and the Viggle v0.3 six-step rank-128 adapter. Its MODEL output feeds optional Qwen caching, then the matching Turbo Sampler. Apply user LoRAs in the separate Prompt Studio LoRA Loader before the Turbo adapter. Do not add the Turbo adapter twice. It stays separate from the base model weights to preserve quality with quantized models.

Qwen Image 2.1 Turbo v0.3 Sampler (KCPP_QwenImage21TurboSampler) takes model, seed, positive conditioning and latent_image, and returns samples to VAE Decode. It uses six Euler steps, CFG 1 and a resolution-dependent sigma schedule. It has no negative-conditioning input or adjustable steps, CFG, scheduler or denoise. Seed plots remain supported; use a base workflow when adjustable sampling is needed. The schedule reads the actual latent dimensions, including edit-target dimensions.

Setup supplies Create, Edit, RGBA, RGBA Edit and Background Removal variants. The base diffusion model, text encoder and native Qwen 2.1 VAE are still required. Qwen's research license applies. These are image-generation nodes; Video Studio consumes the shared node help but uses its own video sampling nodes.
