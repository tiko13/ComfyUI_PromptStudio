"""Model-independent preparation of categorical color maps and continuous depth."""


def prepare_map(image, kind, width, height, fit="fit", invert=False):
    import torch
    import torch.nn.functional as F

    if kind not in {"color", "depth"} or fit not in {"fit", "crop", "stretch"}:
        raise ValueError("Unknown control map preparation")
    if not isinstance(invert, bool):
        raise ValueError("Invert depth must be a checkbox value")
    if not 16 <= int(width) <= 8192 or not 16 <= int(height) <= 8192:
        raise ValueError("Control map dimensions must be between 16 and 8192")
    width, height = int(width), int(height)
    if image.ndim != 4 or image.shape[0] < 1 or min(image.shape[1:3]) < 1 or image.shape[3] < 3:
        raise ValueError("Control maps must be nonempty RGB images")
    pixels = image[:1, :, :, :3].movedim(-1, 1)
    if kind == "depth":
        pixels = pixels.mean(dim=1, keepdim=True).expand(-1, 3, -1, -1)
        if invert:
            pixels = 1 - pixels
    h, w = pixels.shape[-2:]
    scale = (max if fit == "crop" else min)(width / w, height / h)
    size = (height, width) if fit == "stretch" else (max(1, round(h * scale)), max(1, round(w * scale)))
    options = {"mode": "nearest-exact"} if kind == "color" else {"mode": "bilinear", "align_corners": False}
    pixels = F.interpolate(pixels, size=size, **options)
    if fit == "crop":
        y, x = (size[0] - height) // 2, (size[1] - width) // 2
        pixels = pixels[:, :, y:y + height, x:x + width]
    elif fit == "fit":
        canvas = torch.zeros((1, 3, height, width), dtype=pixels.dtype, device=pixels.device)
        y, x = (height - size[0]) // 2, (width - size[1]) // 2
        canvas[:, :, y:y + size[0], x:x + size[1]] = pixels
        pixels = canvas
    if not bool(torch.isfinite(pixels).all()):
        raise ValueError("Control map contains non-finite pixels")
    return pixels.movedim(1, -1).clamp(0, 1)


def validate_slot(control_key, guide_types):
    import re
    if control_key and not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", control_key):
        raise ValueError("Control input key must be a lowercase identifier")
    kinds = [part.strip() for part in guide_types.split(",") if part.strip()]
    if not kinds or any(kind not in {"color", "depth", "pose", "edges", "sketch"} for kind in kinds):
        raise ValueError("Unknown supported guide type")
    return kinds
