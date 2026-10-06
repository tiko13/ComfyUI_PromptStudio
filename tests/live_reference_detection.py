"""Opt-in CPU detector benchmark through the running Studio's public API.

Downloads the official Ultralytics bus test image, imports isolated fixtures, and
removes only those imported assets. Does not call any LLM or queue generation.
"""
import argparse
import io
import json
import urllib.request
import uuid
from PIL import Image, ImageOps


def run(origin):
    def post(path, data):
        req = urllib.request.Request(origin+path, json.dumps(data).encode(), {"Content-Type":"application/json"})
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)
    references = []
    def upload(image):
        stream = io.BytesIO(); image.save(stream, format="PNG")
        boundary = "detector-" + uuid.uuid4().hex
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="detector-test.png"\r\nContent-Type: image/png\r\n\r\n'.encode()
                + stream.getvalue() + f"\r\n--{boundary}--\r\n".encode())
        req = urllib.request.Request(origin+"/promptstudio/prompt-studio/import-image", body, {"Content-Type":f"multipart/form-data; boundary={boundary}"})
        with urllib.request.urlopen(req, timeout=30) as response:
            ref = json.load(response)["image"]
        references.append(ref)
        return ref
    with urllib.request.urlopen("https://raw.githubusercontent.com/ultralytics/ultralytics/main/ultralytics/assets/bus.jpg", timeout=30) as response:
        bus = Image.open(io.BytesIO(response.read())).convert("RGB")
    fixtures = {"multiple":bus, "single":ImageOps.expand(bus.crop((210, 380, 365, 900)), border=50, fill="#eeeeee"),
                "empty":Image.new("RGB", (512,512), "#eeeeee")}
    try:
        inputs = {name:upload(image) for name,image in fixtures.items()}
        results = {}
        for name, ref in inputs.items():
            result = post("/promptstudio/references/detect", {"image":ref})
            results[name] = result
            print(json.dumps({"case":name, **result}), flush=True)
            assert result.get("available"), result
        assert len(results["multiple"]["boxes"]) > 1
        assert not results["multiple"]["single_person"]
        assert not results["empty"]["single_person"]
        assert results["single"]["single_person"], results["single"]
        cached = post("/promptstudio/references/detect", {"image":inputs["single"]})
        assert cached["cached"]
        print(json.dumps({"case":"cached", "elapsed_ms":cached["elapsed_ms"]}), flush=True)
        for name, expected in (("single","simple"), ("multiple","deep"), ("empty","deep")):
            result = post("/promptstudio/references/triage", {"model":"qwen_image_2_1", "user_text":"", "source_image":inputs[name],
                          "references":[{"role":"pose", "image":inputs["single"]}]})
            assert result["decision"] == expected, result
            print(json.dumps({"case":name+"-to-single", "decision":result["decision"]}), flush=True)
    finally:
        print(json.dumps({"cleanup":post("/promptstudio/prompt-studio/delete-image-files", {"images":references})}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--origin", default="http://127.0.0.1:8188")
    run(parser.parse_args().origin)
