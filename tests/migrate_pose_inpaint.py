"""Wire native pose inpainting into installed Qwen edit workflows via supported APIs; dry run by default."""
import argparse
import copy
import json
from pathlib import Path, PurePosixPath
import sys
from urllib.parse import quote
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.pose_inpaint_migration import is_pose_edit_workflow, upgrade_pose_workflow, upgrade_pose_snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", default="http://127.0.0.1:8188")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--backup-dir", type=Path, default=Path(__file__).resolve().parents[1] / "development-internal" / "pose-inpaint-backup")
    args = parser.parse_args()

    def request(path, value=None, method=None):
        data = json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8") if value is not None else None
        with urlopen(Request(args.origin + path, data=data, method=method, headers={"Content-Type": "application/json"}), timeout=60) as response:
            raw = response.read()
            return json.loads(raw) if raw else None

    def backup(name, data):
        args.backup_dir.mkdir(parents=True, exist_ok=True)
        # Never overwrite an earlier backup, including after a partial migration.
        path = args.backup_dir / name
        if not path.exists():
            with path.open("x", encoding="utf-8") as stream:
                json.dump(data, stream, ensure_ascii=False, indent=2)

    changed = 0
    for entry in request("/userdata?dir=workflows&recurse=true&full_info=true"):
        path = entry["path"].replace("\\", "/")
        if not path.endswith(".json") or not is_pose_edit_workflow(PurePosixPath(path).name):
            continue
        url = "/userdata/" + quote("workflows/" + path, safe="")
        old = request(url)
        new = upgrade_pose_workflow(old)
        if old == new:
            continue
        if args.apply:
            import hashlib
            backup(hashlib.sha256(path.encode()).hexdigest()[:12] + ".json", {"path": path, "workflow": old})
            if request(url) != old:
                raise RuntimeError(f"Workflow changed during migration: {path}")
            request(url + "?overwrite=true", new)
            if request(url) != new:
                raise RuntimeError(f"Verification failed: {path}")
        changed += 1
        print(("Updated " if args.apply else "Would update ") + path, flush=True)

    for studio, url in (("image", "/promptstudio/prompt-studio/workflows"), ("video", "/promptstudio-video/workflows")):
        old = request(url)
        store = copy.deepcopy(old)
        count = 0
        for template in store.get("templates", []):
            name = PurePosixPath(str(template.get("path", "")).replace("\\", "/")).name
            if not (is_pose_edit_workflow(name) or is_pose_edit_workflow(template.get("name", ""))):
                continue
            snapshot = template.get("snapshot", {})
            upgraded = upgrade_pose_snapshot(snapshot)
            if upgraded != snapshot:
                template["snapshot"] = upgraded
                template.pop("cacheIdentity", None)
                count += 1
        if count and args.apply:
            backup(studio + "-workflow-store.json", old)
            result = request(url, {"version": 4, "revision": old["revision"], "templates": store["templates"]}, "PUT")
            verified = request(url)
            if verified["revision"] != result["revision"]:
                raise RuntimeError(f"{studio} workflow cache changed during verification")
            expected = {t["id"]: t.get("snapshot") for t in store["templates"]}
            if any(t.get("snapshot") != expected[t["id"]] for t in verified["templates"]):
                raise RuntimeError(f"{studio} cached workflow verification failed")
        print(f"{'Updated' if args.apply else 'Would update'} {count} {studio} cached profiles.", flush=True)
    print(f"{'Updated' if args.apply else 'Would update'} {changed} installed workflow files.")


if __name__ == "__main__":
    main()
