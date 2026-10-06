"""Viggle Qwen Image 2.1 v0.3 inference, shared by all Studio workflows.

Schedule and runtime LoRA formulation follow Viggle's reference implementation:
https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo/blob/009a44a895ef85f7e643c80fdca9543795248867/comfyui/viggle_turbo.py
The adapter remains a side branch; it must not be merged/requantized into INT8.
"""
import json
import math

VERSION = "viggle-v0.3"
SAMPLER_TYPE = "KCPP_QwenImage21TurboSampler"
LORA_TYPE = "KCPP_QwenImage21TurboLora"
RAW_SIGMAS = (1.0, 0.9375, 0.875, 0.75, 0.5, 0.25)


def shifted_sigmas(height, width, downscale=16):
    """Latent geometry, including EmptyLatentImage's explicit /8 metadata."""
    tokens = round(height * downscale / 16) * round(width * downscale / 16)
    mu = 0.5 + 0.4 * (tokens - 256) / (8192 - 256)
    shift = math.exp(mu)
    return [shift / (shift + 1 / sigma - 1) for sigma in RAW_SIGMAS] + [0.0]


def _branch(value, pair):
    import torch.nn.functional as functional
    return functional.linear(functional.linear(value, pair[0].to(value.dtype)), pair[1].to(value.dtype))


def _run_with_adapter(weights, executor, *args, **kwargs):
    """Install hooks only for this call, including cleanup on setup failures."""
    model = executor.class_obj
    device = args[0].device
    # Retain the moved tensors across the six denoising calls, as in Viggle's
    # reference loader. Rebuilding a local copy would transfer 680 MB each step.
    for name, pair in weights.items():
        weights[name] = tuple(t.to(device) for t in pair)
    handles = []
    try:
        for name, pair in weights.items():
            parent, _, leaf = name.rpartition(".")
            module = model.get_submodule(parent)
            if not getattr(module, "fused", False):
                def apply(_module, inputs, output, pair=pair):
                    return output + _branch(inputs[0], pair)
                handles.append(model.get_submodule(name).register_forward_hook(apply))
            elif leaf == "out":
                # Comfy's fused SwiGLU bypasses the out Linear's forward hooks.
                import torch
                import torch.nn.functional as functional
                gate_pair, up_pair = weights[parent + ".gate_layer"], weights[parent + ".proj"]
                state = {}
                def gate(_module, inputs, output, gp=gate_pair, up=up_pair, state=state):
                    value = output + torch.cat((_branch(inputs[0], gp), _branch(inputs[0], up)), -1)
                    state["value"] = value
                    return value
                def finish(_module, inputs, output, pair=pair, state=state):
                    gate_value, up_value = state.pop("value").chunk(2, -1)
                    return output + _branch(functional.silu(gate_value) * up_value, pair)
                handles.append(module.gate_up.register_forward_hook(gate))
                handles.append(module.register_forward_hook(finish))
        return executor(*args, **kwargs)
    finally:
        for handle in reversed(handles):
            handle.remove()


class QwenImage21TurboLora:
    @classmethod
    def INPUT_TYPES(cls):
        import folder_paths
        return {"required": {"model": ("MODEL",), "lora_name": (folder_paths.get_filename_list("loras"),)}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "load"
    CATEGORY = "Prompt Studio"
    DESCRIPTION = "Viggle v0.3 adapter at its trained strength, applied without merging into diffusion weights."

    def load(self, model, lora_name):
        import comfy.utils
        import comfy.patcher_extension
        import folder_paths
        if model.model_options.get("promptstudio_qwen_turbo"):
            raise ValueError("The Qwen Turbo adapter is already applied")
        tensors, metadata = comfy.utils.load_torch_file(folder_paths.get_full_path_or_raise("loras", lora_name), return_metadata=True)
        config = json.loads((metadata or {}).get("lora_adapter_metadata", "{}"))
        rank = config.get("transformer.r", 1)
        scale = config.get("transformer.lora_alpha", 1) / rank
        pairs = {}
        for key, value in tensors.items():
            if not key.endswith(".lora_A.weight"):
                continue
            other = key.removesuffix(".lora_A.weight") + ".lora_B.weight"
            if other not in tensors:
                raise ValueError(f"Incomplete Qwen Turbo adapter: {other}")
            name = key.removeprefix("transformer.").removesuffix(".lora_A.weight")
            pairs[name] = (value, tensors[other] * scale)
        if not pairs or not any(name.endswith(".gate_layer") for name in pairs):
            raise ValueError("Select the Viggle Qwen Image 2.1 v0.3 adapter")
        result = model.clone()
        result.model_options["promptstudio_qwen_turbo"] = VERSION
        result.add_wrapper_with_key(comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL, VERSION,
                                    lambda executor, *a, **kw: _run_with_adapter(pairs, executor, *a, **kw))
        return (result,)


class QwenImage21TurboSampler:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",),
            "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "control_after_generate": True}),
            "positive": ("CONDITIONING",), "latent_image": ("LATENT",),
        }}

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("samples",)
    FUNCTION = "sample"
    CATEGORY = "Prompt Studio"
    DESCRIPTION = "Qwen Turbo v0.3: six Euler steps, resolution-aware Viggle schedule, CFG 1. Seed is adjustable."

    def sample(self, model, seed, positive, latent_image):
        import torch
        import comfy.samplers
        from comfy_extras.nodes_custom_sampler import SamplerCustom
        if model.model_options.get("promptstudio_qwen_turbo") != VERSION:
            raise ValueError("Qwen Turbo sampling requires the v0.3 unmerged adapter")
        samples = latent_image["samples"]
        sigmas = torch.tensor(shifted_sigmas(*samples.shape[-2:], latent_image.get("downscale_ratio_spacial", 16)), dtype=torch.float32)
        output, _ = SamplerCustom().sample(model, True, seed, 1.0, positive, positive,
                                          comfy.samplers.sampler_object("euler"), sigmas, latent_image)
        return (output,)
