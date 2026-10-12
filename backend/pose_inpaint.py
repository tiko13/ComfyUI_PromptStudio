"""Reviewed source-space masks for native Qwen control + inpainting."""
import base64
import hashlib
import io
import json


def source_info(path):
    from PIL import Image, ImageOps
    with open(path, "rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    with Image.open(path) as image:
        width, height = ImageOps.exif_transpose(image).size
    if width * height > 64 * 1024 * 1024:
        raise ValueError("Source exceeds the 64-megapixel mask limit")
    return dict(width=width, height=height, source_digest=digest)


def save_painted_mask(path, data, expected_digest, output):
    from PIL import Image
    info = source_info(path)
    if info["source_digest"] != expected_digest:
        raise ValueError("The source changed while the mask editor was open. Reopen it.")
    if not isinstance(data, str) or not data.startswith("data:image/png;base64,") or len(data) > 20 * 1024 * 1024:
        raise ValueError("Supply a PNG edit mask smaller than 20 MB")
    try:
        raw = base64.b64decode(data.split(",", 1)[1], validate=True)
        with Image.open(io.BytesIO(raw)) as image:
            if image.format != "PNG" or image.size != (info["width"], info["height"]):
                raise ValueError("Mask dimensions must match the source")
            mask = image.convert("L")
            if mask.getextrema()[1] == 0:
                raise ValueError("Paint the area to regenerate before applying the mask")
            if mask.getextrema()[0] == 255:
                raise ValueError("Leave the background to preserve unpainted")
            mask.save(output, format="PNG")
    except (OSError, base64.binascii.Error) as exc:
        raise ValueError("Invalid PNG edit mask") from exc
    if source_info(path)["source_digest"] != expected_digest:
        raise ValueError("The source changed while saving the mask. Reopen the editor.")
    return info


def reviewed_mask(record, source):
    import numpy as np
    import torch
    from PIL import Image
    from .nodes import _parse_chat_image_reference, KCPP_ChatImageInput
    if not isinstance(record, dict) or not record.get("enabled"):
        raise ValueError("Preserve background needs an enabled edit mask. Open Edit background mask to estimate both body positions, review it and Apply mask, or turn preservation off.")
    _, path = _parse_chat_image_reference(json.dumps(record.get("sourceImage")))
    if source_info(path)["source_digest"] != record.get("sourceDigest"):
        raise ValueError("The mask's source changed. Review a new background mask.")
    expected = KCPP_ChatImageInput().load_image(json.dumps(record["sourceImage"]))[0]
    if expected.shape != source.shape or not torch.equal(expected.to(source), source):
        raise ValueError("The background mask belongs to another source. Review it for this image.")
    _, mask_path = _parse_chat_image_reference(json.dumps(record.get("image")))
    with Image.open(mask_path) as image:
        if image.size != (source.shape[2], source.shape[1]):
            raise ValueError("Background mask dimensions no longer match the source")
        mask = torch.from_numpy(np.asarray(image.convert("L"), dtype=np.float32).copy() / 255)[None]
    return mask


def composite(generated, source, mask):
    import torch
    if source.shape[-1] != 3 or generated.shape[-1] not in (3, 4):
        raise ValueError("Background preservation requires an RGB source")
    if mask.ndim != 3 or tuple(mask.shape[-2:]) != tuple(source.shape[1:3]):
        raise ValueError("Inpaint mask dimensions must match the source")
    if source.shape[0] not in (1, generated.shape[0]) or mask.shape[0] not in (1, generated.shape[0]):
        raise ValueError("Inpaint image batches do not match")
    pixels = torch.nn.functional.interpolate(generated.float().movedim(-1, 1), size=source.shape[1:3], mode="bilinear", align_corners=False).movedim(1, -1)
    base = source.to(device=generated.device, dtype=torch.float32)
    weight = mask.to(device=generated.device, dtype=torch.float32).clamp(0, 1)[..., None]
    return base + (pixels[..., :3] - base) * weight
