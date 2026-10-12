"""Read-only companion discovery, independent of whether its import succeeded."""

from pathlib import Path


def video_installation_status(roots, *, loaded=False):
    if loaded:
        return {"installed": True, "loaded": True, "state": "loaded"}
    uncertain = False
    for root in dict.fromkeys(Path(root) for root in roots):
        try:
            for candidate in root.iterdir():
                # Identify renamed checkouts too; never import companion code here.
                markers = (candidate / "__init__.py",
                           candidate / "video" / "contracts.py",
                           candidate / "web" / "js" / "promptstudio_video_studio.js")
                if all(path.is_file() for path in markers):
                    return {"installed": True, "loaded": False, "state": "not_loaded"}
        except OSError:
            uncertain = True
    return {"installed": None if uncertain else False, "loaded": False,
            "state": "unknown" if uncertain else "missing"}
