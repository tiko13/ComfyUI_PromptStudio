"""On-demand object boxes and SAM masks in an isolated, bounded CPU worker."""
from collections import OrderedDict
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import threading

ROOT = Path(__file__).resolve().parent
MODEL_ROOT = ROOT / "reference_models"
CATEGORY = "promptstudio_reference_models"
_lock = threading.Lock()
_cache = OrderedDict()


def register_paths(paths):
    paths.folder_names_and_paths[CATEGORY] = ([str(MODEL_ROOT)], {".json", ".txt", ".safetensors"})


def run(path, *, query=None, region=None, output=None):
    from .qwen_edit import targeting_regions
    if region is not None:
        targeting_regions({"target":region})
    if query is not None and (not isinstance(query,str) or not query.strip() or len(query)>120):
        raise ValueError("Enter a short object name, such as jacket or chair (up to 120 characters).")
    if query is None and region is None:
        raise ValueError("Select a region before creating a mask.")
    if not _lock.acquire(blocking=False):
        return {"available":False,"reason":"Region analysis is busy. Try again after it finishes."}
    try:
        request={"path":str(path),"query":query,"region":region,"output":str(output) if output else None}
        if query is not None:
            from .asset_acquisition import verified_file
            assets=json.loads((ROOT/"setup"/"reference-assets.json").read_text())
            for asset in assets:
                if not verified_file(MODEL_ROOT/asset["relative_path"],asset["size"],asset["sha256"]):
                    return {"available":False,"reason":"Install Object detection (Grounding DINO Tiny) in Settings > Setup first."}
            request["model"]=str(MODEL_ROOT/"grounding-dino-tiny")
            model_stamp=[(a["sha256"],(MODEL_ROOT/a["relative_path"]).stat().st_mtime_ns) for a in assets]
        else:
            import folder_paths
            request["model"]=folder_paths.get_full_path("sams","sam_vit_b_01ec64.pth")
            if not request["model"]:
                return {"available":False,"reason":"SAM ViT-B is not installed in the host's SAM model directory."}
            model_stamp=[]
        path=Path(path)
        if path.stat().st_size>32*1024*1024: raise ValueError("Image too large for region analysis")
        with path.open("rb") as stream:
            digest=hashlib.file_digest(stream,"sha256").hexdigest()
        key=json.dumps([digest,query,region,model_stamp],sort_keys=True)
        if query is not None and key in _cache:
            _cache.move_to_end(key);return {**deepcopy(_cache[key]),"cached":True}
        flags=getattr(subprocess,"CREATE_NO_WINDOW",0)
        result=subprocess.run([sys.executable,"-B",str(ROOT/"reference_region_worker.py")],input=json.dumps(request),
                              text=True,capture_output=True,timeout=180,creationflags=flags)
        if result.returncode:
            return {"available":False,"reason":"Region analysis failed. The optional Transformers or Segment Anything backend may be missing or incompatible."}
        response=json.loads(result.stdout.strip().splitlines()[-1])
        if query is not None and response.get("available"):
            _cache[key]=response
            while len(_cache)>32:_cache.popitem(last=False)
        return response
    except subprocess.TimeoutExpired:
        return {"available":False,"reason":"Region analysis timed out; the CPU worker was stopped."}
    finally:
        _lock.release()


class ReferenceRegionComposite:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required":{"generated":("IMAGE",),"source":("IMAGE",),"mask_ref":("STRING",{"default":""}),
                            "source_ref":("STRING",{"default":""}),"source_digest":("STRING",{"default":""})}}
    RETURN_TYPES=("IMAGE",)
    FUNCTION="composite"
    CATEGORY="Prompt Studio/References"

    def composite(self,generated,source,mask_ref,source_ref,source_digest):
        import numpy as np
        import torch
        from PIL import Image
        from .nodes import _parse_chat_image_reference
        _,source_path=_parse_chat_image_reference(source_ref)
        with open(source_path,"rb") as stream:
            if hashlib.file_digest(stream,"sha256").hexdigest()!=source_digest:raise ValueError("The source file changed after mask creation. Create a new mask.")
        if source.shape[-1]!=3 or generated.shape[-1] not in (3,4):raise ValueError("Edit mask compositing currently requires an RGB source")
        _,path=_parse_chat_image_reference(mask_ref)
        with Image.open(path) as image:
            mask=torch.from_numpy(np.array(image.convert("L"),dtype=np.float32)/255).to(generated.device)
        # Keep source resolution: outside the mask these are the original pixels.
        h,w=source.shape[1:3]
        if tuple(mask.shape)!=(h,w):raise ValueError("Edit mask dimensions no longer match the source")
        if source.shape[0] not in (1,generated.shape[0]):raise ValueError("Source and generated image batches do not match")
        pixels=torch.nn.functional.interpolate(generated.float().movedim(-1,1),size=(h,w),mode="bilinear",align_corners=False).movedim(1,-1)
        base=source[:,:,:,:3].to(device=generated.device,dtype=torch.float32)
        weight=mask[None,:,:,None]
        if pixels.shape[-1]==4:weight=weight*pixels[:,:,:,3:4].clamp(0,1)
        return (base+(pixels[:,:,:,:3]-base)*weight,)
