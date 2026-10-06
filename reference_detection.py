"""Optional local person boxes and conservative reference triage; never downloads.

Uses the pose pack's existing YOLOX weights and preprocessing on CPU. Boxes are
evidence for routing, not identity, clothing recognition, segmentation or certainty.
"""
from collections import OrderedDict
from copy import deepcopy
import hashlib
import importlib.util
import threading
import time

_lock = threading.Lock()
_session = None
_model_key = None
_cache = OrderedDict()
MODEL = "dwpose-yolox-l"


def _model():
    import folder_paths
    from .controlnet import register_aux_path
    from .setup_service import load_catalog
    asset = next(a for a in load_catalog()["assets"] if a["id"] == "controlnet_person")
    path = register_aux_path(folder_paths) / asset["relative_path"]
    if not path.is_file() or path.stat().st_size != asset["size"]:
        raise RuntimeError("Install pose extraction in Settings > Setup to enable person detection.")
    if importlib.util.find_spec("onnxruntime") is None:
        raise RuntimeError("Person detection needs the optional pose pack's ONNX runtime.")
    return path, asset


def _single(boxes):
    if len(boxes) != 1:
        return False
    box = boxes[0]
    r = box["region"]
    return (box["score"] >= .75 and r["width"] * r["height"] >= .05
            and r["x"] > .01 and r["y"] > .01
            and r["x"] + r["width"] < .99 and r["y"] + r["height"] < .99)


def detect(path):
    """Path must first be resolved by the shared image-reference validator.

    Nonblocking admission prevents cancelled or simultaneous requests from queuing
    unlimited CPU work. Cache keys hash image bytes, so filename reuse is safe.
    """
    if not _lock.acquire(blocking=False):
        return {"available": False, "reason": "Person detector is busy; use deeper analysis."}
    started = time.perf_counter()
    try:
        return _detect(path, started)
    except Exception:
        # Optional acceleration must not break normal editing or expose disk paths.
        return {"available": False, "reason": "Person detector unavailable. Check pose extraction in Settings > Setup; deeper analysis remains available."}
    finally:
        _lock.release()


def _detect(path, started):
    global _session, _model_key
    from pathlib import Path
    import numpy as np
    from PIL import Image, ImageOps
    import onnxruntime as ort
    from custom_controlnet_aux.dwpose.dw_onnx.cv_ox_det import preprocess, demo_postprocess, multiclass_nms

    model_path, asset = _model()
    stat = model_path.stat()
    model_key = (str(model_path), stat.st_mtime_ns, stat.st_size)
    if _model_key != model_key:
        with model_path.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != asset["sha256"]:
                raise ValueError("Detector weights failed verification")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        session = ort.InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])
        _session, _model_key = session, model_key
        _cache.clear()
    path = Path(path)
    if path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("Image too large for quick detection")
    content = path.read_bytes()
    key = hashlib.sha256(content).hexdigest()
    if key in _cache:
        _cache.move_to_end(key)
        return {**deepcopy(_cache[key]), "cached": True, "elapsed_ms": round((time.perf_counter() - started) * 1000)}
    import io
    with Image.open(io.BytesIO(content)) as source:
        if source.width * source.height > 64 * 1024 * 1024 or getattr(source, "n_frames", 1) != 1:
            raise ValueError("Quick detection requires one bounded image")
        rgb = ImageOps.exif_transpose(source).convert("RGB")
        width, height = rgb.size
        # Official pose pack expects BGR, with raw 0..255 values and 640 padding.
        pixels, ratio = preprocess(np.asarray(rgb)[:, :, ::-1], (640, 640))
    output = _session.run(None, {_session.get_inputs()[0].name: pixels[None].astype(np.float32)})
    rows = demo_postprocess(output[0], (640, 640))[0]
    centers, sizes = rows[:, :2], rows[:, 2:4]
    corners = np.concatenate((centers - sizes / 2, centers + sizes / 2), axis=1) / ratio
    # Keep weak candidates too: a possible second person vetoes the shortcut.
    detections = multiclass_nms(corners, rows[:, 4:5] * rows[:, 5:6], .45, .15)
    boxes = []
    if detections is not None:
        for row in detections:
            x1, y1, x2, y2 = np.clip(row[:4] / [width, height, width, height], 0, 1)
            if not np.isfinite(row).all() or x2 <= x1 or y2 <= y1:
                continue
            boxes.append({"label": "person", "score": round(float(row[4]), 4),
                          "region": dict(x=float(x1), y=float(y1), width=float(x2-x1), height=float(y2-y1))})
    boxes.sort(key=lambda b: b["region"]["x"])
    result = {"available": True, "model": MODEL, "device": "cpu", "boxes": boxes[:32],
              "single_person": _single(boxes), "width": width, "height": height,
              "reason": "One clear person candidate." if _single(boxes) else "Multiple, uncertain, small, cropped, or no person candidates; use deeper analysis."}
    _cache[key] = result
    while len(_cache) > 32:
        _cache.popitem(last=False)
    return {**deepcopy(result), "cached": False, "elapsed_ms": round((time.perf_counter()-started)*1000)}


def pose_mapping_clarification(data, resolve_image):
    """Do not let vision invent an unspecified multi-person pose assignment."""
    refs=data.get("references",[])
    if data.get("user_text","").strip() or len(refs)!=1:return None
    entry=refs[0];guide=entry.get("guide") or {};use=entry.get("use","reference")
    if entry.get("instruction","").strip() or guide.get("scope")=="whole":return None
    if use in ("structure","both"):
        if guide.get("type")!="pose" or guide.get("input","photo")!="photo" or guide.get("strength",.8)<=0:return None
    elif entry.get("role")!="pose":return None
    targeting=entry.get("targeting") or {}
    missing=[]
    for key,image,label in (("target",data["source_image"],"recipient in the source image"),("reference",entry["image"],"pose donor in the reference image")):
        if targeting.get(key):continue
        result=detect(resolve_image(image))
        if result.get("available") and sum(box.get("score",0)>=.75 for box in result.get("boxes",[]))>1:missing.append(label)
    if missing:
        return "Select the "+" and ".join(missing)+" in Targeting before applying this pose. More than one person was detected, so the assignment is unclear."
    return None


def triage(data, resolve_image):
    """Only unqualified, one-reference pose transfers qualify for a shortcut."""
    from .qwen_edit import request_context
    request_context(data)  # Validate the same contract as the deeper path.
    deep = lambda reason, **extra: {"decision": "deep", "reason": reason, **extra}
    refs = data.get("references", [])
    if data.get("user_text", "").strip() or len(refs) != 1:
        return deep("Written instructions or multiple references need deeper analysis.")
    entry = refs[0]
    if entry.get("analysis") == "deep":
        return deep("Deeper analysis was selected for this reference.")
    if entry.get("instruction", "").strip() or entry.get("targeting") or (entry.get("editMask") or {}).get("enabled"):
        return deep("Instructions or selected regions need deeper analysis.")
    use = entry.get("use", "reference")
    guide = entry.get("guide") or {}
    if use == "structure" and guide.get("scope") == "whole" and guide.get("strength", .8) > 0:
        return {"decision": "simple", "reason": "Whole-guide use was explicitly selected; no subject matching or LLM analysis needed."}
    if use != "structure" and entry["role"] != "pose":
        return deep("Only whole-person pose transfers use the automatic shortcut.")
    if use in ("structure", "both") and (guide.get("type") != "pose" or guide.get("input", "photo") != "photo" or guide.get("strength", .8) <= 0):
        return deep("Prepared maps and non-pose guides need deeper analysis.")
    results = [detect(resolve_image(image)) for image in (data["source_image"], entry["image"])]
    if not all(item.get("available") and item.get("single_person") for item in results):
        return deep("Person detection did not establish a clear one-to-one pose transfer.", images=results)
    return {"decision": "simple", "reason": "One clear person detected in each image; using the selected pose role without LLM analysis.", "images": results}
