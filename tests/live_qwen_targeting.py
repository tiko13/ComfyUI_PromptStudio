"""Opt-in prompt-builder smoke test with synthetic images and an existing local LLM.

Uses temporary storage; does not queue image generation or modify user chats.
"""
import argparse
import json
from pathlib import Path
import tempfile

from PIL import Image, ImageDraw
from test_regressions import load_modules


def run(url):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        _, routes = load_modules(directory)
        source = Image.new("RGB", (384, 512), "#eeeeee")
        draw = ImageDraw.Draw(source)
        draw.ellipse((153, 50, 231, 128), fill="#e4ac83", outline="black", width=3)
        draw.rectangle((145, 133, 240, 285), fill="#287bcc", outline="black", width=3)
        draw.line((145, 150, 112, 270), fill="#e4ac83", width=22)
        draw.line((240, 150, 270, 270), fill="#e4ac83", width=22)
        draw.line((166, 284, 157, 451), fill="#333333", width=28)
        draw.line((219, 284, 228, 451), fill="#333333", width=28)
        source.save(root / "source.png")
        guide = Image.new("RGB", source.size, "black")
        draw = ImageDraw.Draw(guide)
        for line, color in [((192, 85, 192, 150), "red"), ((192, 150, 140, 155, 90, 85, 65, 30), "yellow"),
                            ((192, 150, 240, 155, 290, 85, 320, 30), "lime"), ((192, 150, 192, 290), "cyan"),
                            ((192, 290, 150, 370, 130, 460), "blue"), ((192, 290, 235, 370, 260, 460), "magenta")]:
            draw.line(line, fill=color, width=7)
        guide.save(root / "pose.png")
        settings = {"llm_provider": "llamacpp", "llamacpp_url": url, "thinking_mode": "Disabled", "request_timeout": 180,
                    "model": "qwen_image_2_1", "source_image": {"filename": "source.png", "type": "input", "subfolder": ""}}
        ref = {"image": {"filename": "pose.png", "type": "input", "subfolder": ""}, "role": "custom", "use": "structure",
               "instruction": "", "guide": {"type": "pose", "input": "prepared", "strength": .8, "fit": "fit"}}
        prompt = routes._build_qwen_edit_prompt({**settings, "references": [ref], "user_text": ""})
        assert prompt and "<image" not in prompt, prompt
        print(json.dumps({"case": "single subject and pose guide, empty text", "prompt": prompt}), flush=True)
        def people(filename, colors):
            image = Image.new("RGB", (512, 512), "#eeeeee")
            d = ImageDraw.Draw(image)
            for x, (hair, jacket) in zip((135, 375), colors):
                d.ellipse((x-36, 60, x+36, 140), fill="#e4ac83", outline="black", width=3)
                d.pieslice((x-39, 51, x+39, 122), 180, 360, fill=hair)
                d.rectangle((x-49, 145, x+49, 300), fill=jacket, outline="black", width=3)
                d.line((x, 145, x, 300), fill="black", width=3)
                d.line((x-49, 160, x-73, 285), fill=jacket, width=24)
                d.line((x+49, 160, x+73, 285), fill=jacket, width=24)
                d.line((x-23, 300, x-30, 470), fill="#333333", width=30)
                d.line((x+23, 300, x+30, 470), fill="#333333", width=30)
            image.save(root / filename)
        people("two-source.png", [("#171717", "#287bcc"), ("#e9c135", "#31964c")])
        people("two-reference.png", [("#e9c135", "#d52b27"), ("#171717", "#9a37c0")])
        payload = {**settings, "source_image": {"filename": "two-source.png", "type": "input", "subfolder": ""},
                   "user_text": "Make the dark-haired person wear only the jacket from the person on the viewer's left in the reference. Keep the other source person unchanged.",
                   "references": [{"image": {"filename": "two-reference.png", "type": "input", "subfolder": ""},
                                   "role": "clothing", "instruction": "Only the left person's jacket; preserve the source person's face, hair and pose."}]}
        prompt = routes._build_qwen_edit_prompt(payload)
        assert "<image1>" in prompt and "<image2>" in prompt, prompt
        print(json.dumps({"case": "two source people and two reference people, selective jacket transfer", "prompt": prompt}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    run(parser.parse_args().url)
