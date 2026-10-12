"""Lossless startup migration of extension-owned runtime files into user-data."""

from pathlib import Path


IMAGE_STATE = (
    "prompt_studio_chats.json", "prompt_studio_chats",
    "prompt_studio_workflows.json", "prompt_studio_plots",
    "prompt_studio_model_metadata", "reference_models",
    "prompt_studio_llamacpp_process.json", "prompt_studio_llamacpp_autostart.json",
)
VIDEO_STATE = (
    "promptstudio_video_projects.json", "promptstudio_video_projects",
    "promptstudio_video_workflows.json",
)


def migrate_legacy_state(root, names):
    """Run before stores open. Rename on the same filesystem; never merge/overwrite.

    A partially completed move can be retried. Conflicts are checked before any
    moves so an older installation cannot silently replace a newer store.
    """
    root = Path(root).resolve()
    destination = root / "user-data"
    if destination.is_symlink() or destination.resolve().parent != root:
        raise ValueError("Runtime storage must remain inside the extension")
    pending = []
    for name in names:
        if not name or Path(name).name != name or "/" in name or "\\" in name or name in {".", "..", "user-data"}:
            raise ValueError("Runtime storage names must be plain filenames")
        for suffix in ("", ".bak", ".tmp"):
            source, target = root / (name + suffix), destination / (name + suffix)
            if not source.exists() and not source.is_symlink():
                continue
            if target.exists() or target.is_symlink():
                raise FileExistsError(f"Runtime migration conflict: {source} and {target}; both were preserved")
            pending.append((source, target))
    if pending:
        destination.mkdir(exist_ok=True)
    for source, target in pending:
        source.rename(target)

