"""Opt-in live vision smoke test; uses synthetic images and leaves user chats untouched."""
import io
import json
from pathlib import Path
import urllib.request
import uuid

from PIL import Image, ImageDraw

ORIGIN = "http://127.0.0.1:8188"
OUT = Path(__file__).resolve().parents[1] / "test-results" / "semantic-live"
SETTINGS = {"llm_provider": "llamacpp", "llamacpp_url": "http://127.0.0.1:8080"}
ROLES = {"custom": "Custom instruction", "subject": "Subject / identity", "clothing": "Clothing",
         "pose": "Pose", "background": "Background", "style": "Style", "object": "Object"}


def api(path, payload):
    request = urllib.request.Request(ORIGIN + path, json.dumps(payload).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=240) as response:
        return json.load(response)


def upload(name, picture):
    picture.save(OUT / name)
    data = io.BytesIO()
    picture.save(data, format="PNG")
    boundary = uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{name}"\r\nContent-Type: image/png\r\n\r\n'.encode()
            + data.getvalue() + f"\r\n--{boundary}--\r\n".encode())
    request = urllib.request.Request(ORIGIN + "/promptstudio/prompt-studio/import-image", body,
                                     {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)["image"]


def person(draw, x, raised=False):
    draw.ellipse((x-30, 52, x+30, 112), fill="#e4ad86", outline="#292025", width=3)
    draw.arc((x-33, 44, x+33, 125), 160, 380, fill="#39211b", width=13)
    draw.polygon([(x-27, 122), (x+27, 122), (x+68, 330), (x-68, 330)], fill="#346ec4", outline="black", width=3)
    draw.line([(x-20, 330), (x-23, 440)], fill="#e4ad86", width=16)
    draw.line([(x+20, 330), (x+23, 440)], fill="#e4ad86", width=16)
    for side in (-1, 1):
        draw.line([(x+side*30, 137), (x+side*68, 70 if raised else 246)], fill="#e4ad86", width=16)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    source = Image.new("RGB", (512, 512), "#d6e6c7")
    draw = ImageDraw.Draw(source); draw.rectangle((0, 445, 512, 512), fill="#8b897a"); person(draw, 256)
    pair = source.copy(); draw = ImageDraw.Draw(pair); draw.rectangle((0, 0, 512, 445), fill="#d6e6c7"); person(draw, 125); person(draw, 385)
    dress = Image.new("RGB", (512, 512), "#f5f5f5")
    draw = ImageDraw.Draw(dress)
    draw.polygon([(200, 75), (225, 75), (240, 110), (272, 110), (287, 75), (312, 75), (300, 230), (395, 440), (117, 440), (212, 230)], fill="#bd1d34", outline="#40101a", width=4)
    draw.line((212, 230, 300, 230), fill="#f8d37c", width=12)
    for x, y in [(210, 300), (280, 285), (245, 370), (325, 385), (170, 402)]: draw.ellipse((x, y, x+12, y+12), fill="white")
    pose = Image.new("RGB", (512, 512), "#eeeeee"); person(ImageDraw.Draw(pose), 256, True)
    refs = {name: upload(name + ".png", picture) for name, picture in (("source", source), ("pair", pair), ("dress", dress), ("pose", pose))}
    cases = [
        ("dress", "source", "dress", "Make her wear this dress", "assigned", "clothing"),
        ("polite", "source", "dress", "Could you please make her wear this dress?", "assigned", "clothing"),
        ("pose", "source", "pose", "Make her raise her arms like the person in this reference", "assigned", "pose"),
        ("ambiguity", "pair", "dress", "Make her wear this dress", "clarify", ""),
        ("discussion", "source", "dress", "Would this dress suit her? Please only discuss, do not change anything.", "discuss", ""),
        ("partial", "source", "dress", "Use only the white dot pattern from this reference on her existing blue dress; preserve the blue color and cut", "assigned", None),
    ]
    results = []
    for name, source_key, donor, text, status, role in cases:
        payload = {**SETTINGS, "user_text": text, "source_image": refs[source_key], "attachments": [refs[donor]], "supported_roles": ROLES}
        result = api("/promptstudio/prompt-studio/semantic-reference", payload)
        results.append({"case": name, "request": payload, "result": result})
        (OUT / "results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
        print(name, json.dumps(result), flush=True)
        assert result["status"] == status, (name, result)
        if role is not None: assert result["role"] == role, (name, result)
    assignment = results[0]["result"]
    prompt = api("/promptstudio/prompt-studio/qwen-edit-prompt", {**SETTINGS, "model": "qwen_image_2_1",
        "user_text": "Make her wear this dress", "source_image": refs["source"],
        "references": [{"image": refs["dress"], "role": assignment["role"], "instruction": assignment["instruction"]}]})
    (OUT / "prepared-edit.json").write_text(json.dumps({"source": refs["source"], "reference": refs["dress"], **prompt}, indent=2), encoding="utf-8")
    assert "<image1>" in prompt["prompt"] and "<image2>" in prompt["prompt"]
    print("Prepared edit:", prompt["prompt"], flush=True)


if __name__ == "__main__":
    main()
