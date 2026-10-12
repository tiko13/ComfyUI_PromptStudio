"""Conservative anatomy masks from OpenPose joints; estimates require review."""
import math
from statistics import median


def anatomy_mask(pose, padding=10):
    from PIL import Image, ImageDraw
    if isinstance(pose, list):
        if len(pose) != 1:
            raise ValueError("Use one pose frame to estimate a mask")
        pose = pose[0]
    if not isinstance(pose, dict):
        raise ValueError("Editable pose joints are needed to estimate a mask")
    width, height = pose.get("canvas_width"), pose.get("canvas_height")
    if any(type(n) is not int or not 1 <= n <= 8192 for n in (width, height)):
        raise ValueError("Invalid pose canvas dimensions")
    people = pose.get("people")
    if not isinstance(people, list) or not 1 <= len(people) <= 20:
        raise ValueError("No usable person was detected. Draw the mask manually.")
    if not math.isfinite(padding) or not 0 <= padding <= 100:
        raise ValueError("Mask padding must be between 0 and 100 percent")
    mask = Image.new("L", (width, height))
    draw = ImageDraw.Draw(mask)
    for person in people:
        def points(key, count):
            values = person.get(key) or []
            result = []
            for i in range(count):
                value = values[i*3:i*3+3]
                valid = len(value) == 3 and all(type(v) in (int, float) and math.isfinite(v) for v in value)
                result.append(tuple(value[:2]) if valid and value[2] > .05 and 0 <= value[0] <= width and 0 <= value[1] <= height else None)
            return result
        body = points("pose_keypoints_2d", 18)
        def distance(a, b):
            return math.dist(body[a], body[b]) if body[a] and body[b] else 0
        scales = [distance(2, 5), distance(8, 11)*1.3, distance(1, 8)*.65, distance(1, 11)*.65]
        scales = [n for n in scales if n > 1]
        if not scales or sum(p is not None for p in body) < 5:
            raise ValueError("Too few body joints for a reliable estimate. Draw the mask manually.")
        scale = max(median(scales), max(scales)*.75)
        pad = scale * padding / 100
        def ellipse(p, rx, ry=None):
            if p:
                ry = rx if ry is None else ry
                draw.ellipse((p[0]-rx, p[1]-ry, p[0]+rx, p[1]+ry), fill=255)
        def capsule(a, b, radius):
            if a and b:
                draw.line((a, b), fill=255, width=max(1, round(radius*2)))
                ellipse(a, radius); ellipse(b, radius)
        torso = [body[i] for i in (2, 5, 11, 8) if body[i]]
        if len(torso) >= 3:
            draw.polygon(torso, fill=255)
            for a, b in zip(torso, torso[1:]+torso[:1]):
                capsule(a, b, scale*.12+pad)
        for a, b, radius in ((1,2,.17),(1,5,.17),(1,8,.25),(1,11,.25),
                             (2,3,.15),(3,4,.11),(5,6,.15),(6,7,.11),
                             (8,9,.20),(9,10,.14),(11,12,.20),(12,13,.14)):
            capsule(body[a], body[b], scale*radius+pad)
        head = body[0] or next((body[i] for i in (14,15,16,17) if body[i]), None)
        if head:
            ellipse((head[0], head[1]-scale*.08), scale*.40+pad, scale*.55+pad)
            capsule(body[1], head, scale*.20+pad)
        for wrist, key in ((4,"hand_right_keypoints_2d"),(7,"hand_left_keypoints_2d")):
            ellipse(body[wrist], scale*.15+pad)
            hand = points(key, 21)
            for p in hand:
                capsule(hand[0] or body[wrist], p, scale*.035+pad*.6)
        for index in (10,13):
            if body[index]:
                x, y = body[index]
                ellipse((x,y+scale*.12), scale*.20+pad, scale*.32+pad)
    return mask


def estimate(source_pose, target_pose, source_width, source_height, guide_width, guide_height,
             fit="fit", targeting="", padding=10, all_people=False):
    import json
    import numpy as np
    import torch
    from PIL import Image, ImageChops, ImageFilter
    from .controlnet import QwenStructureGuide
    for pose in (source_pose, target_pose):
        data = pose[0] if isinstance(pose, list) and pose else pose
        if isinstance(data, dict) and len(data.get("people", [])) > 1 and not all_people:
            raise ValueError("Several people were detected. Draw the mask manually, or explicitly choose Whole guide to edit everyone.")
    for size in (source_width, source_height, guide_width, guide_height):
        if type(size) is not int or not 1 <= size <= 8192:
            raise ValueError("Invalid mask dimensions")
    original = anatomy_mask(source_pose, padding).resize((source_width, source_height), Image.Resampling.BILINEAR)
    target = anatomy_mask(target_pose, padding)
    pixels = torch.from_numpy(np.asarray(target, dtype=np.float32).copy()/255)[None, ..., None].repeat(1,1,1,3)
    # Use the exact same native framing/crop/placement implementation as the guide.
    regions = json.loads(targeting) if targeting else {}
    regions.pop("reference", None)  # Target joints already describe the extracted crop.
    mapped = QwenStructureGuide().prepare(pixels, "pose", "prepared", fit, guide_width, guide_height, json.dumps(regions))[0]
    target = Image.fromarray((mapped[0,:,:,0].cpu().numpy()*255).round().astype(np.uint8))
    target = target.resize((source_width, source_height), Image.Resampling.BILINEAR)
    union = ImageChops.lighter(original, target)
    # A short soft boundary avoids a hard cut while leaving distant pixels black.
    union = union.filter(ImageFilter.GaussianBlur(max(.5, min(source_width, source_height)/512)))
    mask = torch.from_numpy(np.asarray(union, dtype=np.float32).copy()/255)[None]
    return mask[..., None].repeat(1,1,1,3), mask
