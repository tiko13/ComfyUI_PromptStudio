"""Optional Qwen structure guides. Extraction executes inside ComfyUI's queue."""
from pathlib import Path
import os
import sys
import json

CONTROL_NAME = "Qwen-Image-2.1-Fun-Controlnet-Union.safetensors"
AUX_CATEGORY = "promptstudio_controlnet_aux"
PREPROCESSORS = {"pose": "DWPreprocessor", "depth": "DepthAnythingV2Preprocessor", "sketch": "LineArtPreprocessor"}
WEIGHTS = {
    "pose": ("yzd-v/DWPose/yolox_l.onnx", "yzd-v/DWPose/dw-ll_ucoco_384.onnx"),
    "depth": ("depth-anything/Depth-Anything-V2-Small/depth_anything_v2_vits.pth",),
    "sketch": ("lllyasviel/Annotators/sk_model.pth", "lllyasviel/Annotators/sk_model2.pth"),
}


def register_aux_path(paths):
    # Respect the preprocessor pack's configured directory, including installations
    # outside the default custom_nodes directory. No global environment changes.
    module = sys.modules.get("custom_controlnet_aux.util")
    root = getattr(module, "annotator_ckpts_path", None) or os.environ.get("AUX_ANNOTATOR_CKPTS_PATH")
    if not root:
        roots = [Path(p) / "comfyui_controlnet_aux" for p in paths.get_folder_paths("custom_nodes")]
        root = next((p for p in roots if p.is_dir()), roots[0]) / "ckpts"
    paths.folder_names_and_paths[AUX_CATEGORY] = ([str(root)], {".pth", ".onnx", ".pt"})
    return Path(root)


def capabilities():
    import folder_paths
    import nodes
    from .setup_service import load_catalog
    assets = {a['relative_path']: a for a in load_catalog()['assets']}
    root = register_aux_path(folder_paths)
    names = folder_paths.get_filename_list("model_patches")
    model = next((n for n in names if n.replace('\\', '/').split('/')[-1] == CONTROL_NAME
                  and Path(folder_paths.get_full_path('model_patches', n)).stat().st_size == 7550979904), None)
    ready = bool(model and 'ZImageFunControlnet' in nodes.NODE_CLASS_MAPPINGS)
    methods = {"edges": {"ready": "Canny" in nodes.NODE_CLASS_MAPPINGS}}
    for kind, node in PREPROCESSORS.items():
        files = all((root / name).is_file() and (root / name).stat().st_size == assets[name]['size'] for name in WEIGHTS[kind])
        methods[kind] = {"ready": node in nodes.NODE_CLASS_MAPPINGS and files}
    return {"ready": ready, "model": model, "methods": methods}


class QwenStructureGuide:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"image": ("IMAGE",), "guide_type": (["pose", "depth", "edges", "sketch"],),
                "input_mode": (["photo", "prepared"],), "fit": (["fit", "crop"],),
                "width": ("INT", {"default": 1024, "min": 64, "max": 8192}),
                "height": ("INT", {"default": 1024, "min": 64, "max": 8192})},
                "optional": {"targeting": ("STRING", {"default": ""})}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "prepare"
    CATEGORY = "Prompt Studio/References"

    def prepare(self, image, guide_type, input_mode, fit, width, height, targeting=""):
        import torch
        import comfy.utils
        import nodes
        from .qwen_edit import targeting_regions
        if guide_type not in {"pose", "depth", "edges", "sketch"} or input_mode not in {"photo", "prepared"} or fit not in {"fit", "crop"}:
            raise ValueError("Unknown structure guide option")
        guide = image[:1, :, :, :3]
        regions = targeting_regions(json.loads(targeting)) if targeting else None
        if regions and regions.get("reference"):
            x, y, w, h = region_pixels(regions["reference"], guide.shape[2], guide.shape[1])
            guide = guide[:, y:y+h, x:x+w, :]
        if input_mode == "photo":
            if not capabilities()['methods'][guide_type]['ready']:
                raise ValueError(f"Install {guide_type} extraction in Settings > Setup, then restart ComfyUI.")
            if guide_type == "edges":
                from comfy_extras.nodes_canny import Canny
                guide = Canny().detect_edge(guide, 0.2, 0.6)[0]
            else:
                cls = nodes.NODE_CLASS_MAPPINGS[PREPROCESSORS[guide_type]]
                kwargs = {"image": guide, "resolution": 768}
                if guide_type == "pose":
                    kwargs.update(bbox_detector="yolox_l.onnx", pose_estimator="dw-ll_ucoco_384.onnx")
                elif guide_type == "depth":
                    kwargs.update(ckpt_name="depth_anything_v2_vits.pth")
                else:
                    kwargs.update(coarse="disable")
                result = getattr(cls(), cls.FUNCTION)(**kwargs)
                guide = (result['result'] if isinstance(result, dict) else result)[0]
                if guide_type == "pose" and not bool(guide.max() > 0):
                    raise ValueError("No person was detected. Try a clearer full-body photo or a prepared pose guide.")
        width, height = int(width), int(height)
        canvas_width, canvas_height = width, height
        placement = regions.get("target") if regions else None
        if placement:
            offset_x, offset_y, width, height = region_pixels(placement, width, height)
        pixels = guide.movedim(-1, 1)
        if fit == "crop":
            guide = comfy.utils.common_upscale(pixels, width, height, "bilinear", "center").movedim(1, -1)
        else:
            scale = min(width / pixels.shape[-1], height / pixels.shape[-2])
            w, h = max(1, round(pixels.shape[-1] * scale)), max(1, round(pixels.shape[-2] * scale))
            pixels = comfy.utils.common_upscale(pixels, w, h, "bilinear", "disabled").movedim(1, -1)
            # Sketch has dark lines on white; the other maps have black backgrounds.
            guide = torch.full((pixels.shape[0], height, width, 3), 1.0 if guide_type == "sketch" else 0.0, dtype=pixels.dtype, device=pixels.device)
            x, y = (width - w) // 2, (height - h) // 2
            guide[:, y:y+h, x:x+w] = pixels
        if placement:
            canvas = torch.full((guide.shape[0], canvas_height, canvas_width, 3),
                                1.0 if guide_type == "sketch" else 0.0, dtype=guide.dtype, device=guide.device)
            canvas[:, offset_y:offset_y+height, offset_x:offset_x+width] = guide
            guide = canvas
        return (guide,)


def region_pixels(region, width, height):
    """Keep even a tiny normalized selection inside the original pixel bounds."""
    x, y = min(width - 1, int(region["x"] * width)), min(height - 1, int(region["y"] * height))
    right = min(width, max(x + 1, round((region["x"] + region["width"]) * width)))
    bottom = min(height, max(y + 1, round((region["y"] + region["height"]) * height)))
    return x, y, right - x, bottom - y


def register_controlnet_routes(server):
    from aiohttp import web
    async def status(request):
        return web.json_response(capabilities(), headers={"Cache-Control": "no-store"})
    server.routes.get('/promptstudio/controlnet/status')(status)
