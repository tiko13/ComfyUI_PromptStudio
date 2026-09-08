"""ComfyUI-hosted image setup: capability planning, verified assets and durable jobs.

No runtime provisioning. Host adapters supply registered paths, nodes and the
current user's storage. Browser selections are identifiers, never URLs or paths
to write. Downloads and checks run off the server's event loop.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import threading
import time
import uuid

try:
    from .asset_acquisition import acquire_asset, verified_file
except ImportError:  # Direct import in isolated tests.
    from asset_acquisition import acquire_asset, verified_file

ROOT = Path(__file__).resolve().parent / "setup"
ACTIVE = {"running", "pausing", "cancelling"}
RESUMABLE = {"paused", "interrupted", "failed", "needs_restart"}


def load_catalog():
    catalog = json.loads((ROOT / "catalog.json").read_text(encoding="utf-8-sig"))
    catalog["assets"] = json.loads((ROOT / "assets.json").read_text(encoding="utf-8-sig"))
    return catalog


def key(name):
    return str(name).replace("\\", "/").casefold()


def workflow_nodes(workflow):
    yield from workflow.get("nodes", [])
    for definition in workflow.get("definitions", {}).get("subgraphs", []):
        yield from workflow_nodes(definition)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def safetensors_header(path):
    """Read tensor metadata only, never deserialize weights or pickle content."""
    try:
        with Path(path).open("rb") as source:
            size = os.fstat(source.fileno()).st_size
            raw = source.read(8)
            if len(raw) != 8:
                return {}
            length = struct.unpack("<Q", raw)[0]
            if not 2 <= length <= min(16 * 1024 * 1024, size - 8):
                return {}
            header = json.loads(source.read(length))
            if not isinstance(header, dict):
                return {}
            tensors = [v for k, v in header.items() if k != "__metadata__"]
            if not tensors or any(not isinstance(v, dict) or not isinstance(v.get("data_offsets"), list)
                                  or len(v["data_offsets"]) != 2 for v in tensors):
                return {}
            if any(not all(isinstance(n, int) for n in v["data_offsets"])
                   or not 0 <= v["data_offsets"][0] <= v["data_offsets"][1] <= size - 8 - length
                   for v in tensors):
                return {}
            if max(v["data_offsets"][1] for v in tensors) != size - 8 - length:
                return {}
            return header
    except (OSError, ValueError, TypeError):
        return {}


def krea_compatibility(path, node_names):
    if Path(path).suffix.lower() != ".safetensors":
        return "", "Requires a supported safetensors Krea2 diffusion model"
    header = safetensors_header(path)
    if not any(name.endswith("txtfusion.projector.weight") for name in header):
        return "", "Krea2 architecture was not found in tensor metadata"
    int8 = any(isinstance(v, dict) and v.get("dtype") == "I8" for k, v in header.items()
               if k != "__metadata__")
    if int8 and "OTUNetLoaderW8A8" not in node_names:
        return "", "This INT8 model needs the ComfyUI-INT8-Fast loader"
    return ("Krea2 tensor metadata; INT8 loader available" if int8 else "Krea2 tensor metadata"), ""


class SetupStopped(Exception):
    pass


class SetupService:
    def __init__(self, folder_paths, nodes, *, catalog=None, install_node=None, manager_available=None):
        self.paths = folder_paths
        self.nodes = nodes
        self.catalog = catalog or load_catalog()
        self.assets = {a["id"]: a for a in self.catalog["assets"]}
        self.install_node = install_node
        self.manager_available = manager_available or (lambda: install_node is not None)
        self.lock = threading.RLock()
        self.states = {}
        self.workers = {}
        self.controls = {}
        self.scan_cache = {}

    def _state(self, user_root):
        root = str(Path(user_root).resolve())
        if root not in self.states:
            path = Path(root) / ".promptstudio-setup" / "state.json"
            if path.exists():
                state = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(state, dict) or state.get("version") != 1:
                    raise ValueError("Setup state needs repair; it was not overwritten")
            else:
                state = {"version": 1, "onboarding": "new", "installed": {}, "job": None}
            job = state.get("job")
            if job and job["status"] in ACTIVE:
                job.update(status="interrupted", phase="Interrupted", message="ComfyUI restarted. Resume to recheck files and continue.", speed=0, eta=None)
            self.states[root] = state
        return self.states[root]

    def _save(self, user_root):
        atomic_json(Path(user_root) / ".promptstudio-setup" / "state.json", self._state(user_root))

    def status(self, user_root):
        with self.lock:
            result = copy.deepcopy(self._state(user_root))
        job = result.get("job")
        if job:
            job["elapsed"] = max(0, time.time() - job["started_at"])
            job["waiting_for_data"] = job["status"] == "running" and job["phase"] == "Downloading" and time.time() - job.get("last_progress_at", time.time()) > 5
            if job["waiting_for_data"]:
                job.update(speed=0, eta=None)
        return result

    def dismiss(self, user_root):
        with self.lock:
            self._state(user_root)["onboarding"] = "deferred"
            self._save(user_root)
        return self.status(user_root)

    def _names(self, category):
        try:
            return sorted(self.paths.get_filename_list(category), key=key)
        except (KeyError, OSError):
            return []

    def _file(self, category, name):
        path = self.paths.get_full_path(category, name)
        return Path(path) if path else None

    def _target(self, asset):
        roots = self.paths.get_folder_paths(asset["category"])
        if not roots:
            raise ValueError(f"ComfyUI has no {asset['category']} model directory")
        root = Path(roots[0]).resolve()
        target = root.joinpath(*asset["relative_path"].replace("\\", "/").split("/")).resolve()
        if root not in target.parents:
            raise ValueError("Invalid catalog model destination")
        return target

    def candidates(self, requirement):
        assets = [self.assets[a] for a in [requirement["default_asset"], *requirement.get("alternatives", [])]]
        candidates, rejected = [], []
        for name in self._names(requirement["category"]):
            path = self._file(requirement["category"], name)
            if path is None or not path.is_file():
                continue
            matched = next((a for a in assets if key(name).split("/")[-1] in
                            {key(v).split("/")[-1] for v in [a["relative_path"], *a.get("aliases", [])]}), None)
            if requirement["id"] == "krea2":
                stamp = path.stat()
                cache_key = (str(path), stamp.st_size, stamp.st_mtime_ns, stamp.st_ctime_ns, "OTUNetLoaderW8A8" in self.nodes)
                if cache_key not in self.scan_cache:
                    self.scan_cache[cache_key] = krea_compatibility(path, self.nodes)
                evidence, error = self.scan_cache[cache_key]
                if not evidence:
                    if "krea" in key(name):
                        rejected.append({"name": name, "reason": error})
                    continue
                if matched and path.stat().st_size != matched["size"]:
                    matched = None  # Compatible user variant, not the published asset.
            elif matched and path.stat().st_size == matched["size"]:
                evidence = "Expected model name and size; checksum will be verified during setup"
            else:
                if matched:
                    rejected.append({"name": name, "reason": "File size differs from the published asset"})
                continue
            candidates.append({"name": name, "path": str(path), "asset_id": matched["id"] if matched else None,
                               "evidence": evidence, "size": path.stat().st_size})
        candidates.sort(key=lambda c: (c["asset_id"] != requirement["default_asset"], key(c["name"])))
        return candidates, rejected

    def plan(self, user_root, request=None):
        request = request or {}
        selected = request.get("packs", [p["id"] for p in self.catalog["packs"]])
        if not isinstance(selected, list) or not selected or not all(isinstance(p, str) for p in selected) or len(set(selected)) != len(selected):
            raise ValueError("Select at least one workflow")
        known = {p["id"] for p in self.catalog["packs"]}
        if not set(selected) <= known:
            raise ValueError("Unknown workflow selection")
        choices = request.get("choices", {})
        if not isinstance(choices, dict):
            raise ValueError("Model choices must be an object")
        packs = [copy.deepcopy(p) for p in self.catalog["packs"] if p["id"] in selected]
        for pack in packs:
            existing = Path(user_root) / "workflows" / pack["file"]
            pack["existing"] = existing.is_file()
            pack["existing_status"] = "Not saved yet"
            if pack["existing"]:
                try:
                    saved = json.loads(existing.read_text(encoding="utf-8-sig"))
                    pack["existing_status"] = "Saved workflow found; your copy will be preserved" if isinstance(saved, dict) and isinstance(saved.get("nodes"), list) else "Saved file has invalid workflow structure; your copy will be preserved"
                except (ValueError, OSError):
                    pack["existing_status"] = "Saved file could not be read; your copy will be preserved"
        rows, blockers = [], []
        for req in self.catalog["requirements"]:
            used = [p["name"] for p in packs if req["id"] in p["requirements"]]
            if not used:
                continue
            candidates, rejected = self.candidates(req)
            download_options = [self.assets[a] for a in [req["default_asset"], *req.get("alternatives", [])]]
            choice = choices.get(req["id"], candidates[0]["name"] if candidates else "__download__:" + req["default_asset"])
            candidate = next((c for c in candidates if c["name"] == choice), None)
            download_id = choice.partition(":")[2] if isinstance(choice, str) and choice.startswith("__download__:") else ""
            if candidate is None and download_id not in {a["id"] for a in download_options}:
                raise ValueError(f"Selected {req['name']} is no longer available; check again")
            asset = self.assets[download_id or req["default_asset"]]
            target = self._target(asset)
            row = {**req, "used_by": used, "candidates": candidates, "rejected": rejected,
                   "choice": choice, "status": "available" if candidate else "download",
                   "source": asset["url"], "destination": str(target),
                   "download_bytes": 0 if candidate else asset["size"], "default_name": asset["name"],
                   "download_asset": asset["id"], "download_options": [{"id": a["id"], "name": a["name"], "size": a["size"]} for a in download_options]}
            if candidate is None and target.exists():
                row["status"] = "blocked"
                blockers.append(f"{target.name} already exists but was not accepted. Choose an existing compatible file or move the conflicting file yourself.")
            rows.append(row)
        definitions = set()
        required_nodes = set()
        for pack in packs:
            flow = self.workflow_source(pack["id"])
            definitions.update(d["id"] for d in flow.get("definitions", {}).get("subgraphs", []))
            required_nodes.update(n["type"] for n in workflow_nodes(flow))
            for node in workflow_nodes(flow):
                # Presence alone is insufficient when an older host lacks the
                # selected Krea2 encoder type, sampler or attention backend.
                get_inputs = getattr(self.nodes.get(node["type"]), "INPUT_TYPES", None)
                if not callable(get_inputs):
                    continue
                try:
                    schema = get_inputs()
                    inputs = {**schema.get("required", {}), **schema.get("optional", {})}
                except Exception:
                    blockers.append(f"{pack['name']}: cannot read {node['type']} capabilities. Check ComfyUI's node import errors.")
                    continue
                for name in ("type", "attention", "sampler_name", "scheduler"):
                    value = node.get("widgets_values_named", {}).get(name)
                    entry = inputs.get(name)
                    connected = any(i.get("name") == name and i.get("link") is not None for i in node.get("inputs", []))
                    if value is not None and entry and isinstance(entry[0], (list, tuple)) and value not in entry[0] and not connected:
                        blockers.append(f"{pack['name']}: {node['type']} does not offer {name} = {value}. Update ComfyUI or the node pack and restart.")
        node_rows = []
        third_party = {name for p in self.catalog["node_packs"] for name in p["classes"]}
        for dep in self.catalog["node_packs"]:
            used = [p["name"] for p in packs if dep["id"] in p["nodes"]]
            if not used:
                continue
            missing = [n for n in dep["classes"] if n in required_nodes and n not in self.nodes]
            node_rows.append({**dep, "used_by": used, "missing": missing, "status": "install" if missing else "available"})
            if missing and not self.manager_available():
                blockers.append(f"Install {dep['name']} through ComfyUI Manager or from {dep['url']}, then restart ComfyUI.")
        missing_core = sorted(required_nodes - definitions - third_party - set(self.nodes))
        if missing_core:
            blockers.append("Update ComfyUI / Prompt Studio and restart to load: " + ", ".join(missing_core))
        # Aggregate required space by the actual destination volume, including
        # model partials. Downloads are published in place, with no second copy.
        disks = {}
        for row in rows:
            if not row["download_bytes"]:
                continue
            target = Path(row["destination"])
            parent = target.parent
            while not parent.exists():
                parent = parent.parent
            volume = parent.stat().st_dev
            disk = disks.setdefault(volume, {"path": str(parent), "free": shutil.disk_usage(parent).free, "required": 0})
            remaining = row["download_bytes"]
            partial = target.with_name(target.name + ".part")
            metadata = partial.with_name(partial.name + ".json")
            asset = self.assets[row["download_asset"]]
            try:
                saved = json.loads(metadata.read_text(encoding="utf-8"))
                if all(saved.get(k) == asset[k] for k in ("url", "size", "sha256")):
                    remaining -= min(remaining, partial.stat().st_size)
            except (OSError, ValueError):
                pass
            disk["required"] += remaining
            if not os.access(parent, os.W_OK):
                blockers.append(f"Model directory is not writable: {parent}")
        for disk in disks.values():
            if disk["free"] < disk["required"] + 64 * 1024 * 1024:
                blockers.append(f"Not enough free space at {disk['path']}")
        user_root = Path(user_root)
        parent = user_root
        while not parent.exists():
            parent = parent.parent
        if not os.access(parent, os.W_OK):
            blockers.append("ComfyUI user storage is not writable")
        return {"version": self.catalog["version"], "packs": packs, "requirements": rows, "node_packs": node_rows,
                "blockers": blockers, "disks": list(disks.values()), "download_bytes": sum(r["download_bytes"] for r in rows),
                "licenses": self.catalog.get("licenses", []), "workflow_directory": str(user_root / "workflows"),
                "checks": [{"name": "ComfyUI and Prompt Studio nodes", "status": "missing" if missing_core else "ready"},
                           {"name": "Workflow and setup storage", "status": "ready" if os.access(parent, os.W_OK) else "missing"}],
                "state": self.status(user_root)}

    def workflow_source(self, pack_id):
        pack = next((p for p in self.catalog["packs"] if p["id"] == pack_id), None)
        if not pack:
            raise ValueError("Unknown workflow")
        return json.loads((ROOT / "workflows" / pack["file"]).read_text(encoding="utf-8-sig"))

    def _update(self, root, *, event=None, persist=True, **changes):
        with self.lock:
            job = self._state(root)["job"]
            job.update(changes)
            if event:
                job["events"] = (job["events"] + [{"time": time.time(), "message": event}])[-150:]
                job["message"] = event
            if persist:
                self._save(root)

    def start(self, user_root, request, *, resume=False):
        root = str(Path(user_root).resolve())
        with self.lock:
            existing = self._state(root).get("job")
            if root in self.workers and self.workers[root].is_alive():
                return self.status(root)  # Duplicate clicks/tabs join the existing job.
            if existing and existing["status"] == "awaiting_validation":
                return self.status(root)
        plan = self.plan(root, request)
        if plan["blockers"]:
            raise ValueError("; ".join(plan["blockers"]))
        with self.lock:
            if root in self.workers and self.workers[root].is_alive():
                return self.status(root)
            request = {"packs": [p["id"] for p in plan["packs"]], "choices": {r["id"]: r["choice"] for r in plan["requirements"]}}
            previous = self._state(root).get("job") if resume else None
            self._state(root)["job"] = {"id": previous["id"] if previous else uuid.uuid4().hex, "status": "running", "phase": "Checking",
                "started_at": previous["started_at"] if previous else time.time(), "events": previous["events"] if previous else [], "request": request, "bytes": 0, "total": 0,
                "speed": 0, "eta": None, "downloaded": 0, "download_total": plan["download_bytes"],
                "message": "Checking selected dependencies", "workflows": [], "error": ""}
            self.controls[root] = threading.Event()
            self._save(root)
            worker = threading.Thread(target=self._run, args=(root, plan), name="PromptStudioSetup", daemon=True)
            self.workers[root] = worker
            worker.start()
        return self.status(root)

    def control(self, root, action):
        root = str(Path(root).resolve())
        with self.lock:
            job = self._state(root).get("job")
            if not job:
                raise ValueError("No setup job exists")
            if action == "resume":
                if job["status"] not in RESUMABLE:
                    raise ValueError("This job cannot be resumed")
                request = copy.deepcopy(job["request"])
            elif action in {"pause", "cancel"}:
                if job["status"] in ACTIVE:
                    if job["phase"] == "Installing nodes":
                        raise ValueError("Node installation must finish before setup can stop")
                    job["status"] = "pausing" if action == "pause" else "cancelling"
                    self.controls[root].set()
                else:
                    job["status"] = "paused" if action == "pause" else "cancelled"
                self._save(root)
                return self.status(root)
            else:
                raise ValueError("Unknown setup action")
        # Re-plan resumed downloads. A file installed before interruption is now
        # an existing choice; a user-selected alternative must remain unchanged.
        for req in list(request["choices"]):
            if request["choices"][req].startswith("__download__:"):
                requirement = next(r for r in self.catalog["requirements"] if r["id"] == req)
                wanted = request["choices"][req].partition(":")[2]
                candidates, _ = self.candidates(requirement)
                existing = next((c for c in candidates if c["asset_id"] == wanted), None)
                if existing:
                    request["choices"][req] = existing["name"]
        return self.start(root, request, resume=True)

    def _checkpoint(self, root):
        if self.controls[root].is_set():
            raise SetupStopped()

    def _progress(self, root, title, base_downloaded):
        sample = {"time": time.monotonic(), "bytes": 0, "stage": None, "saved": 0, "speed": 0}
        def report(done, total, stage):
            self._checkpoint(root)
            now = time.monotonic()
            if stage != sample["stage"] or done < sample["bytes"]:
                sample.update(time=now, bytes=done, stage=stage, speed=0)
            delta = now - sample["time"]
            if delta >= .5:
                speed = max(0, done - sample["bytes"]) / delta
                sample["speed"] = speed if not sample["speed"] else .3 * speed + .7 * sample["speed"]
                sample.update(time=now, bytes=done)
            rate = sample["speed"]
            updates = {"phase": stage, "item": title, "bytes": done, "total": total, "last_progress_at": time.time(),
                       "speed": rate, "eta": (total - done) / rate if rate else None}
            if stage == "Downloading":
                updates["downloaded"] = base_downloaded + done
            persist = now - sample["saved"] >= 1 or done == total
            if persist:
                sample["saved"] = now
            self._update(root, persist=persist, **updates)
        return report

    def _run(self, root, plan):
        try:
            replacements = {}
            downloaded = 0
            for row in plan["requirements"]:
                self._checkpoint(root)
                report = self._progress(root, row["name"], downloaded)
                if row["choice"].startswith("__download__:"):
                    asset = self.assets[row["download_asset"]]
                    target = self._target(asset)
                    self._update(root, event=f"Download {asset['name']} from {asset['url']} to {target}")
                    acquire_asset(asset, target, report)
                    downloaded += asset["size"]
                    # Refresh ComfyUI's name cache after publishing the file.
                    cache = getattr(self.paths, "filename_list_cache", {})
                    cache.pop(row["category"], None)
                    name = next((n for n in self._names(row["category"])
                                 if self._file(row["category"], n) and self._file(row["category"], n).resolve() == target.resolve()), None)
                    if name is None:
                        raise ValueError(f"ComfyUI cannot discover the downloaded {asset['name']}")
                else:
                    name = row["choice"]
                    path = self._file(row["category"], name)
                    candidate = next(c for c in row["candidates"] if c["name"] == name)
                    self._update(root, event=f"Reuse {name} for {', '.join(row['used_by'])}", phase="Checking", bytes=0, total=0, speed=0, eta=None)
                    if candidate["asset_id"]:
                        asset = self.assets[candidate["asset_id"]]
                        if not verified_file(path, asset["size"], asset["sha256"], report):
                            raise ValueError(f"Checksum verification failed for {name}; the existing file was preserved")
                    elif row["id"] == "krea2":
                        evidence, error = krea_compatibility(path, self.nodes)
                        if not evidence:
                            raise ValueError(error)
                replacements[row["id"]] = name
                self._update(root, event=f"{row['name']} ready", downloaded=downloaded)
            installed_nodes = False
            for dep in plan["node_packs"]:
                self._checkpoint(root)
                if dep["missing"]:
                    self._update(root, phase="Installing nodes", item=dep["name"], bytes=0, total=0, speed=0, eta=None,
                                 event=f"ComfyUI Manager: installing {dep['name']} from {dep['url']}. Waiting for Manager to finish.")
                    self.install_node(dep)
                    installed_nodes = True
                    self._update(root, event=f"{dep['name']} installed; restart required")
            self._checkpoint(root)
            self._update(root, phase="Installing workflows", bytes=0, total=len(plan["packs"]), speed=0, eta=None)
            results = []
            for pack in plan["packs"]:
                self._checkpoint(root)
                flow = self.workflow_source(pack["id"])
                for req in self.catalog["requirements"]:
                    if req["id"] not in pack["requirements"]:
                        continue
                    binding, value = req["binding"], replacements[req["id"]]
                    for node in workflow_nodes(flow):
                        if node["type"] != binding["type"]:
                            continue
                        node["widgets_values"][binding["index"]] = value
                        node.setdefault("widgets_values_named", {})[binding["field"]] = value
                        if req["id"] == "krea2":
                            # The loader's model_type constrains selection to a
                            # top-level folder. Root models require an empty type.
                            parts = value.replace("\\", "/").split("/")
                            model_type = parts[0] if len(parts) > 1 else ""
                            node["widgets_values"][0] = model_type
                            node["widgets_values_named"]["model_type"] = model_type
                        # Old upstream model URL annotations may describe a
                        # different precision. The setup catalog owns downloads.
                        node.get("properties", {}).pop("models", None)
                result = self._install_workflow(root, pack, flow)
                results.append(result)
                self._update(root, event=f"{pack['name']}: {result['disposition']} {result['path']}",
                             bytes=len(results), workflows=results)
            self._update(root, status="needs_restart" if installed_nodes else "awaiting_validation",
                         phase="Restart required" if installed_nodes else "Validating workflows", speed=0, eta=None,
                         event="Restart ComfyUI, then resume setup to validate the installed nodes." if installed_nodes else
                               "Files are ready. Checking workflow conversion in Prompt Studio.")
        except SetupStopped:
            with self.lock:
                status = self._state(root)["job"]["status"]
            self._update(root, status="cancelled" if status == "cancelling" else "paused", speed=0, eta=None,
                         event="Setup stopped. Verified files and resumable partial downloads were kept.")
        except Exception as exc:
            self._update(root, status="failed", phase="Needs attention", speed=0, eta=None,
                         error=str(exc), event=str(exc))

    def _install_workflow(self, root, pack, flow):
        directory = Path(root) / "workflows"
        directory.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256(canonical(flow).encode()).hexdigest()
        # Never overwrite a workflow with different content. Search the stable
        # setup suffixes before creating another copy, including after a crash.
        stem = Path(pack["file"]).stem
        for i in range(1000):
            name = pack["file"] if i == 0 else f"{stem} (Setup {i}).json"
            target = directory / name
            if target.exists():
                try:
                    if canonical(json.loads(target.read_text(encoding="utf-8-sig"))) == canonical(flow):
                        disposition = "reused"
                        break
                except (ValueError, OSError):
                    pass
                continue
            # Publish a fully flushed file without replacing a concurrent save.
            # A hard link is atomic and exclusive on Windows and Linux; both
            # files live in the same user directory / filesystem.
            temporary = directory / (".promptstudio-" + uuid.uuid4().hex + ".tmp")
            try:
                with temporary.open("x", encoding="utf-8") as stream:
                    stream.write(json.dumps(flow, ensure_ascii=False, indent=2) + "\n")
                    stream.flush()
                    os.fsync(stream.fileno())
                os.link(temporary, target)
                disposition = "installed"
                break
            except FileExistsError:
                continue
            finally:
                temporary.unlink(missing_ok=True)
        else:
            raise ValueError("No unused workflow filename is available")
        result = {"role": pack["id"], "path": name, "hash": digest, "disposition": disposition}
        with self.lock:
            self._state(root)["installed"][pack["id"]] = result
            self._save(root)
        return result

    def finish(self, root, job_id, results):
        with self.lock:
            job = self._state(root).get("job")
            if not job or job["id"] != job_id or job["status"] not in {"awaiting_validation", "complete"}:
                raise ValueError("Setup job is not awaiting validation")
            expected = {w["path"]: w["role"] for w in job["workflows"]}
            if not isinstance(results, list) or len(results) != len(expected) or not all(isinstance(r, dict) for r in results):
                raise ValueError("Every installed workflow must be validated")
            if {r.get("path"): r.get("role") for r in results} != expected:
                raise ValueError("Workflow validation results do not match this job")
            errors = [str(r.get("error"))[:1000] for r in results if r.get("error")]
            job["validation"] = [{"path": r["path"], "role": r["role"], "error": str(r.get("error") or "")[:1000]} for r in results]
            if errors:
                job.update(error="; ".join(errors), message="Workflow validation needs attention")
            else:
                job.update(status="complete", phase="Ready", message="Selected workflows validated. Ready to use.", error="")
                self._state(root)["onboarding"] = "complete"
            self._save(root)
        return self.status(root)
