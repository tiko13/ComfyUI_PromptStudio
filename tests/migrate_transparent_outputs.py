"""Upgrade installed transparency outputs through ComfyUI APIs; dry run by default."""
import argparse
import json
import sys
from pathlib import Path, PurePosixPath
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.image_output_migration import force_transparent_png, is_transparency_workflow


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", default="http://127.0.0.1:8188")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    def request(path, value=None, method=None):
        data = json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8") if value is not None else None
        with urlopen(Request(args.origin + path, data=data, method=method,
                             headers={"Content-Type": "application/json"}), timeout=30) as response:
            raw = response.read()
            return json.loads(raw) if raw else None

    files = request("/userdata?dir=workflows&recurse=true&full_info=true")
    changed = 0
    for file in files:
        path = file["path"].replace("\\", "/")
        if not path.endswith(".json") or not is_transparency_workflow(PurePosixPath(path).name):
            continue
        url = "/userdata/" + quote("workflows/" + path, safe="")
        old = request(url)
        new = force_transparent_png(old)
        if old == new:
            continue
        if args.apply:
            backup = url + ".pre-png-force.bak"
            try:
                request(backup)
            except HTTPError as error:
                if error.code != 404:
                    raise
                request(backup + "?overwrite=false", old)
            if request(url) != old:
                raise RuntimeError(f"Workflow changed during migration: {path}")
            request(url + "?overwrite=true", new)
            if request(url) != new:
                raise RuntimeError(f"Workflow verification failed: {path}")
        changed += 1
        print(("Updated " if args.apply else "Would update ") + path)

    store_url = "/promptstudio/prompt-studio/workflows"
    store = request(store_url)
    cached = 0
    for template in store.get("templates", []):
        name = PurePosixPath(str(template.get("path", "")).replace("\\", "/")).name
        if not (is_transparency_workflow(name) or is_transparency_workflow(template.get("name", ""))):
            continue
        snapshot = template.get("snapshot", {})
        before = json.dumps(snapshot, sort_keys=True)
        for node in snapshot.get("output", {}).values():
            if node.get("class_type") == "Save_as_webp_cond":
                node.setdefault("inputs", {}).update(format="png", mode="lossless", force=True)
        if snapshot.get("workflow"):
            snapshot["workflow"] = force_transparent_png(snapshot["workflow"])
        if json.dumps(snapshot, sort_keys=True) != before:
            template.pop("cacheIdentity", None)
            cached += 1
    if cached and args.apply:
        result = request(store_url, {"version": 4, "revision": store["revision"], "templates": store["templates"]}, "PUT")
        verified = request(store_url)
        if verified["revision"] != result["revision"]:
            raise RuntimeError("Workflow cache changed during verification")
        expected = {t["id"]: t.get("snapshot") for t in store["templates"]}
        if any(t.get("snapshot") != expected[t["id"]] for t in verified["templates"]):
            raise RuntimeError("Cached workflow verification failed")
    print(f"{'Updated' if args.apply else 'Would update'} {changed} saved workflows and {cached} cached profiles.")


if __name__ == "__main__":
    main()
