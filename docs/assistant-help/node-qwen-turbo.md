---
{"id":"node.qwen-turbo","topic":"node-qwen-turbo","studio":"shared","summary":"Qwen Image 2.1 Official Turbo Sampler (KCPP_QwenImage21OfficialTurboSampler), legacy Turbo v0.3 LoRA (KCPP_QwenImage21TurboLora) and Sampler (KCPP_QwenImage21TurboSampler): models, wiring, fixed sampling and seed plots."}
---
Qwen Image 2.1 Official Turbo Sampler (KCPP_QwenImage21OfficialTurboSampler) takes model, seed, positive conditioning and latent_image, and returns samples to VAE Decode. Use the official full Turbo INT8 diffusion model, Qwen3-VL encoder and native Qwen 2.1 VAE. No acceleration LoRA is needed. Ordinary user LoRAs remain available in the separate Prompt Studio LoRA Loader before optional Qwen caching.

Official Turbo uses eight Euler steps, CFG 1 and the exact fixed schedule: 1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, then 0. There is no additional resolution shift. Only seed is adjustable; seed plots remain supported. There is no negative-conditioning input or adjustable steps, CFG, scheduler or denoise. Use base25/base40 workflows for configurable sampling.

Setup supplies official Turbo Create, Edit, RGBA, RGBA Edit and Background Removal workflows. References, masks, ControlNet guides and output controls follow each workflow's capabilities. Qwen's research license applies.

Qwen Image 2.1 Turbo v0.3 LoRA (KCPP_QwenImage21TurboLora) and Qwen Image 2.1 Turbo v0.3 Sampler (KCPP_QwenImage21TurboSampler) remain for legacy saved generations. Together they use the base diffusion model, one unmerged Viggle v0.3 adapter and six resolution-shifted Euler steps. Do not combine that adapter with the official sampler.

These are image-generation nodes. Video Studio consumes this shared node help and retains its own video samplers.
