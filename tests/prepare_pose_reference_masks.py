"""Build reproducible masks over original limb positions for a live experiment."""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps

root = Path(__file__).resolve().parents[1]
out = root / "test-results" / "pose-reference-strength"
out.mkdir(parents=True, exist_ok=True)
guides = json.loads((root / "test-results" / "pose-matrix" / "guides.json").read_text())
pose = guides["original"]["data"]
photo = Image.open(root / "test-results" / "pose-leg-debug" / "source.webp").convert("RGB")
photo = photo.resize((pose["canvas_width"], pose["canvas_height"]))
p = pose["people"][0]["pose_keypoints_2d"]
for name, bones in {
    "right-leg": [(8, 9), (9, 10)],
    "right-calf": [(9, 10)],
    "legs": [(8, 9), (9, 10), (11, 12), (12, 13)],
    "arms": [(2, 3), (3, 4), (5, 6), (6, 7)],
    "body": [(1, 8), (1, 11), (2, 3), (3, 4), (5, 6), (6, 7), (8, 9), (9, 10), (11, 12), (12, 13)],
}.items():
    mask = Image.new("L", photo.size, 0)
    draw = ImageDraw.Draw(mask)
    radius = round(photo.width * (0.033 if name != "body" else 0.05))
    for a, b in bones:
        pts = [tuple(p[i*3:i*3+2]) for i in (a, b)]
        draw.line(pts, fill=255, width=radius*2)
        for x, y in pts:
            draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=255)
    mask.save(out / f"{name}-mask.png")
    ImageOps.invert(mask).save(out / f"{name}-keep-mask.png")
    preview = Image.composite(Image.blend(photo, Image.new("RGB", photo.size, "magenta"), .55), photo, mask)
    preview.thumbnail((1100, 800))
    preview.save(out / f"{name}-overlay.png")

male = json.loads((root / "test-results" / "pose-matrix" / "square-edit.json").read_text())["pose"]
if isinstance(male, list):
    male = male[0]
male_photo = Image.open(root / "test-results" / "pose-matrix" / "square-edit.png").convert("RGB")
male_photo = male_photo.resize((male["canvas_width"], male["canvas_height"]))
mp = male["people"][0]["pose_keypoints_2d"]
mask = Image.new("L", male_photo.size, 0)
draw = ImageDraw.Draw(mask)
radius = round(male_photo.width * .04)
for a, b in [(8, 9), (9, 10)]:
    pts = [tuple(mp[i*3:i*3+2]) for i in (a, b)]
    draw.line(pts, fill=255, width=radius*2)
    for x, y in pts:
        draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=255)
mask.save(out / "male-right-leg-mask.png")
ImageOps.invert(mask).save(out / "male-right-leg-keep-mask.png")
preview = Image.composite(Image.blend(male_photo, Image.new("RGB", male_photo.size, "magenta"), .55), male_photo, mask)
preview.thumbnail((800, 800))
preview.save(out / "male-right-leg-overlay.png")
