"""Local comparison gallery. Metrics supplement visual review, not anatomy proof."""
import html
import json
import math
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
out = root / "test-results" / "pose-reference-strength"
previous = root / "test-results" / "pose-matrix"
notes_path = out / "observations.json"
notes = json.loads(notes_path.read_text()) if notes_path.exists() else {}
findings_path = out / "findings.json"
findings = json.loads(findings_path.read_text()) if findings_path.exists() else {}
scenarios = json.loads((previous / "scenario-guides.json").read_text())
guides = json.loads((previous / "guides.json").read_text())
records = []
for path in out.glob("*.json"):
    r = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(r, dict) or r.get("status") != "success":
        continue
    image = Image.open(out / (r["label"] + ".png"))
    r["alpha_min"] = image.getchannel("A").getextrema()[0] if image.mode == "RGBA" else 255
    target = guides["edited"]["data"] if r["case"] == "edited" else scenarios.get(r["case"].replace("-explicit", ""), {}).get("data")
    pose = r.get("pose", {})
    if isinstance(pose, list):
        pose = pose[0] if pose else {}
    if target and pose.get("people"):
        t, a = target["people"][0]["pose_keypoints_2d"], pose["people"][0]["pose_keypoints_2d"]
        errors = []
        for i in range(8, 14):
            if t[3*i+2] > 0 and a[3*i+2] > 0:
                errors.append(math.hypot(t[3*i]/target["canvas_width"]-a[3*i]/pose["canvas_width"], t[3*i+1]/target["canvas_height"]-a[3*i+1]/pose["canvas_height"]))
        r["leg_error"] = sum(errors)/len(errors) if errors else None
        r["right_ankle_error"] = math.hypot(t[30]/target["canvas_width"]-a[30]/pose["canvas_width"], t[31]/target["canvas_height"]-a[31]/pose["canvas_height"]) if a[32] > 0 else None
    r["observation"] = notes.get(r["label"], "Awaiting visual review")
    records.append(r)
records.sort(key=lambda r: (r["case"], r["seed"], r["maskName"], r["cache"], ["neutral", "half", "quarter", "tenth", "zero", "exclude"].index(r["mode"])))
cards = []
for r in records:
    label = html.escape(r["label"])
    cards.append(f'<article><h2>{label}</h2><a href="{label}.png"><img src="{label}.png"></a><p>{html.escape(r["observation"])}</p><p>Leg distance: {r.get("leg_error", "n/a")} · Right ankle distance: {r.get("right_ankle_error", "n/a")} · Alpha minimum: {r["alpha_min"]}</p><details><summary>Guide and request</summary><img src="{label}-guide.png"><a href="{label}-request.json">Exact API graph</a></details></article>')
page = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Masked reference pose trial</title><style>body{background:#15171c;color:#e7eaf0;font:15px system-ui;margin:24px}h1{font-size:24px}h2{font-size:15px;overflow-wrap:anywhere}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(460px,100%),1fr));gap:18px}article{background:#22252d;padding:16px;border-radius:12px}img{width:100%;height:auto}a{color:#91caff}p{line-height:1.5}summary{cursor:pointer}</style><h1>Masked reference strength — live comparisons</h1><p>Original leg reference influence is varied. Model, prompt, guide, seed and sampler are held constant within each comparison. Pose error does not detect extra limbs or identity drift.</p><p><a href="../pose-matrix/report.html">Previous 54-render matrix</a> · <a href="environment.json">Runtime and upstream revision</a></p><main>'+''.join(cards)+'</main>'
overview = '<section><h2>Assessment</h2>' + ''.join(
    f'<p>{html.escape(p)}</p>' for p in findings.get("assessment", [])
) + '<details><summary>Method and limitations</summary>' + ''.join(
    f'<p>{html.escape(p)}</p>' for p in findings.get("limitations", [])
) + '</details></section>'
page = page.replace('<main>', overview + '<main>', 1)
(out / "report.html").write_text(page, encoding="utf-8")
(out / "summary.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
for case in sorted({r["case"] for r in records}):
    selected = [r for r in records if r["case"] == case]
    width, height = 700, 450
    board = Image.new("RGB", (width*2, height*math.ceil(len(selected)/2)), "#181b22")
    draw = ImageDraw.Draw(board)
    for i, r in enumerate(selected):
        x, y = (i%2)*width, (i//2)*height
        draw.text((x+10,y+10), r["label"], fill="white")
        thumb = Image.open(out / (r["label"]+'.png')).convert('RGB')
        thumb.thumbnail((width, height-42))
        board.paste(thumb, (x+(width-thumb.width)//2,y+36))
    board.save(out / (case+'-comparison.jpg'))
print(json.dumps({"renders":len(records), "report":str(out/'report.html')}))
