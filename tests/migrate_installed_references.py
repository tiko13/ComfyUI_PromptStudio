"""Opt-in local workflow upgrade through ComfyUI userdata API. Dry run by default."""
import argparse
import json
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.reference_workflow_migration import upgrade_reference_workflow

parser = argparse.ArgumentParser()
parser.add_argument("--origin", default="http://127.0.0.1:8188")
parser.add_argument("--apply", action="store_true")
args = parser.parse_args()


def request(path, data=None):
    req = Request(args.origin + path, data=data, headers={"Content-Type": "application/json"} if data is not None else {})
    with urlopen(req, timeout=30) as response:
        return response.read()


files = json.loads(request("/userdata?dir=workflows&recurse=true&full_info=true"))
for file in files:
    path = file["path"].replace("\\", "/")
    if not path.split("/")[-1].startswith("[PS]") or not path.endswith(".json"):
        continue
    url = "/userdata/" + quote("workflows/" + path, safe="")
    original = request(url)
    old = json.loads(original)
    new = upgrade_reference_workflow(old)
    if old == new:
        continue
    if args.apply:
        backup = url + ".pre-reference-nodes.bak"
        try:
            saved_backup = request(backup)
        except HTTPError as error:
            if error.code != 404:
                raise
            request(backup + "?overwrite=false", original)
        else:
            if saved_backup != original:
                raise RuntimeError(f"A different migration backup already exists for {path}")
        if request(url) != original:
            raise RuntimeError(f"Workflow changed during migration: {path}")
        request(url + "?overwrite=true", json.dumps(new, ensure_ascii=False, indent=2).encode("utf-8"))
        if json.loads(request(url)) != new:
            raise RuntimeError(f"Could not verify migrated workflow: {path}")
    print(("Updated " if args.apply else "Would update ") + path)
