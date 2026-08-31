import copy
import hashlib
import json
import math
import os
import re
import shutil
import textwrap
import time

from PIL import Image, ImageDraw, ImageFont, ImageOps

import folder_paths

from .nodes import _parse_chat_image_reference


BASE_DIR = os.path.dirname(os.path.realpath(__file__))
PLOT_STORE_DIR = os.path.join(BASE_DIR, "prompt_studio_plots")
PLOT_BACKUP_DIR = os.path.join(PLOT_STORE_DIR, "_backups")
PLOT_VERSION = 1
MAX_PLOT_CELLS = 512
MAX_PLOT_BYTES = 32 * 1024 * 1024
MAX_AXIS_VALUES = 128
MAX_COMPOSITE_SIDE = 16000
PLOT_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


class PlotConflictError(RuntimeError):
    pass


def _safe_plot_id(value):
    plot_id = str(value or "").strip()
    if not PLOT_ID_PATTERN.fullmatch(plot_id):
        raise ValueError("Plot id is invalid")
    return plot_id


def _plot_filename(plot_id):
    digest = hashlib.sha256(_safe_plot_id(plot_id).encode("utf-8")).hexdigest()
    return f"plot_{digest}.json"


def _plot_path(plot_id):
    return os.path.join(PLOT_STORE_DIR, _plot_filename(plot_id))


def _plot_backup_path(plot_id):
    return os.path.join(PLOT_BACKUP_DIR, _plot_filename(plot_id) + ".bak")


def _axis_values(axis, label):
    if not isinstance(axis, dict):
        raise ValueError(f"{label} axis must be an object")
    values = axis.get("values")
    if not isinstance(values, list) or not values:
        raise ValueError(f"{label} axis needs at least one value")
    if len(values) > MAX_AXIS_VALUES:
        raise ValueError(f"{label} axis supports at most {MAX_AXIS_VALUES} values")
    for index, value in enumerate(values):
        if not isinstance(value, dict):
            raise ValueError(f"{label} axis value {index + 1} must be an object")
        if not str(value.get("label") or "").strip():
            raise ValueError(f"{label} axis value {index + 1} needs a label")
    return values


def validate_plot(plot, expected_id=None):
    if not isinstance(plot, dict):
        raise ValueError("Plot must be an object")
    plot_id = _safe_plot_id(plot.get("id"))
    if expected_id is not None and plot_id != _safe_plot_id(expected_id):
        raise ValueError("Plot id does not match the requested resource")
    axes = plot.get("axes")
    if not isinstance(axes, list) or len(axes) not in {2, 3}:
        raise ValueError("Plot must contain X and Y axes and may contain one Z axis")
    expected_names = ["x", "y", "z"][:len(axes)]
    sizes = []
    targets = set()
    for axis, expected_name in zip(axes, expected_names):
        name = str(axis.get("name") or "").strip().lower()
        if name != expected_name:
            raise ValueError(f"Plot axis {expected_name.upper()} is missing or out of order")
        values = _axis_values(axis, expected_name.upper())
        sizes.append(len(values))
        target = str(axis.get("targetKey") or "").strip()
        if not target:
            raise ValueError(f"{expected_name.upper()} axis needs an injection target")
        if target in targets:
            raise ValueError("Two axes cannot control the same injection target")
        targets.add(target)
    cell_count = math.prod(sizes)
    if cell_count > MAX_PLOT_CELLS:
        raise ValueError(f"Plot supports at most {MAX_PLOT_CELLS} cells")
    cells = plot.get("cells")
    if not isinstance(cells, list) or len(cells) != cell_count:
        raise ValueError("Plot cells do not match the axis dimensions")
    coordinates = set()
    for cell in cells:
        if not isinstance(cell, dict):
            raise ValueError("Every plot cell must be an object")
        coordinate = cell.get("coordinate")
        if not isinstance(coordinate, list) or len(coordinate) != len(axes):
            raise ValueError("Every plot cell needs one coordinate per axis")
        try:
            key = tuple(int(value) for value in coordinate)
        except (TypeError, ValueError) as exc:
            raise ValueError("Plot coordinates must be integers") from exc
        if any(value < 0 or value >= sizes[index] for index, value in enumerate(key)):
            raise ValueError("Plot coordinate is outside its axis")
        if key in coordinates:
            raise ValueError("Plot contains duplicate coordinates")
        coordinates.add(key)
        if cell.get("status") not in {
            "pending", "submitting", "queued", "generating", "complete", "failed", "cancelled"
        }:
            raise ValueError("Plot cell has an invalid status")
        images = cell.get("images", [])
        if not isinstance(images, list):
            raise ValueError("Plot cell images must be a list")
    base = plot.get("base")
    if not isinstance(base, dict) or not isinstance(base.get("workflowSnapshot"), dict):
        raise ValueError("Plot must preserve one base workflow snapshot")
    return plot


def read_plot(plot_id):
    path = _plot_path(plot_id)
    try:
        with open(path, "r", encoding="utf-8") as file:
            plot = json.load(file)
    except FileNotFoundError:
        return None
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid Prompt Studio plot store: {exc}") from exc
    validate_plot(plot, plot_id)
    return plot


def plot_links_by_chat():
    """Return the newest durable plot associated with each surviving chat id."""
    links = {}
    try:
        filenames = os.listdir(PLOT_STORE_DIR)
    except FileNotFoundError:
        return links
    for filename in filenames:
        if not filename.startswith("plot_") or not filename.endswith(".json"):
            continue
        path = os.path.join(PLOT_STORE_DIR, filename)
        try:
            with open(path, "r", encoding="utf-8") as file:
                plot = json.load(file)
            validate_plot(plot)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        chat_id = str(plot.get("chatId") or "").strip()
        if not chat_id:
            continue
        current = links.get(chat_id)
        if current is None or int(plot.get("updatedAt") or 0) >= int(current.get("updatedAt") or 0):
            counts = {}
            for cell in plot.get("cells", []):
                status = str(cell.get("status") or "")
                counts[status] = counts.get(status, 0) + 1
            links[chat_id] = {
                "id": str(plot.get("id") or ""),
                "title": str(plot.get("title") or "XY(Z) plot"),
                "status": str(plot.get("status") or ""),
                "updatedAt": int(plot.get("updatedAt") or 0),
                "summary": {
                    "status": str(plot.get("status") or ""),
                    "total": len(plot.get("cells", [])),
                    "counts": counts,
                    "updatedAt": int(plot.get("updatedAt") or 0),
                },
                "mainPrompt": str(plot.get("base", {}).get("mainPrompt") or ""),
                "finalPrompt": str(plot.get("base", {}).get("finalPrompt") or ""),
            }
    return links


def write_plot(plot, expected_revision=None):
    validate_plot(plot)
    plot_id = _safe_plot_id(plot["id"])
    current = read_plot(plot_id)
    actual_revision = int(current.get("revision", 0)) if current else 0
    expected = int(plot.get("revision", 0) if expected_revision is None else expected_revision)
    if current is not None and expected != actual_revision:
        raise PlotConflictError("Plot changed in another browser. Reload it before saving again.")
    normalized = copy.deepcopy(plot)
    normalized["version"] = PLOT_VERSION
    normalized["revision"] = actual_revision + 1
    normalized["updatedAt"] = int(time.time() * 1000)
    encoded = json.dumps(normalized, ensure_ascii=False, indent=2).encode("utf-8")
    if len(encoded) > MAX_PLOT_BYTES:
        raise ValueError("Prompt Studio plot exceeds the 32 MB limit")
    os.makedirs(PLOT_STORE_DIR, exist_ok=True)
    path = _plot_path(plot_id)
    temporary = path + ".tmp"
    backup = _plot_backup_path(plot_id)
    try:
        with open(temporary, "wb") as file:
            file.write(encoded)
            file.flush()
            os.fsync(file.fileno())
        if os.path.isfile(path):
            os.makedirs(PLOT_BACKUP_DIR, exist_ok=True)
            shutil.copy2(path, backup)
        os.replace(temporary, path)
    finally:
        try:
            os.remove(temporary)
        except FileNotFoundError:
            pass
    return normalized


def _font(size, bold=False):
    names = [
        "arialbd.ttf" if bold else "arial.ttf",
        "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf",
    ]
    for name in names:
        try:
            return ImageFont.truetype(name, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def _draw_centered(draw, box, text, font, fill, max_lines=3):
    x0, y0, x1, y1 = box
    width = max(1, x1 - x0)
    average = max(4, int(width / max(6, font.size * 0.56))) if hasattr(font, "size") else 24
    lines = textwrap.wrap(str(text), width=average)[:max_lines] or [""]
    line_height = (font.size + 4) if hasattr(font, "size") else 14
    top = y0 + max(0, ((y1 - y0) - line_height * len(lines)) // 2)
    for line in lines:
        bounds = draw.textbbox((0, 0), line, font=font)
        draw.text((x0 + (width - (bounds[2] - bounds[0])) / 2, top), line, font=font, fill=fill)
        top += line_height


def _cell_image(cell):
    images = cell.get("images") if isinstance(cell, dict) else None
    if not isinstance(images, list) or not images:
        return None
    try:
        _reference, path = _parse_chat_image_reference(json.dumps(images[0]))
        with Image.open(path) as source:
            return ImageOps.exif_transpose(source).convert("RGB")
    except (OSError, ValueError):
        return None


def _slug(value):
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value or "plot").strip()).strip("-._")
    return (cleaned or "plot")[:80]


def _artifact_reference(path):
    root = os.path.realpath(folder_paths.get_output_directory())
    relative = os.path.relpath(os.path.realpath(path), root).replace(os.sep, "/")
    subfolder, filename = relative.rsplit("/", 1) if "/" in relative else ("", relative)
    return {"filename": filename, "subfolder": subfolder, "type": "output"}


def _render_slice(plot, z_index, output_path):
    axes = plot["axes"]
    x_values = axes[0]["values"]
    y_values = axes[1]["values"]
    x_count, y_count = len(x_values), len(y_values)
    label_width = 190
    header_height = 150
    tile = min(360, max(16, (MAX_COMPOSITE_SIDE - label_width) // max(1, x_count)))
    tile = min(tile, max(16, (MAX_COMPOSITE_SIDE - header_height) // max(1, y_count)))
    width = label_width + x_count * tile
    height = header_height + y_count * tile
    canvas = Image.new("RGB", (width, height), "#11151b")
    draw = ImageDraw.Draw(canvas)
    title_font = _font(24, bold=True)
    label_font = _font(max(12, min(19, tile // 13)), bold=True)
    small_font = _font(14)
    title = str(plot.get("title") or "Prompt Studio plot")
    z_text = ""
    if len(axes) == 3:
        z_value = axes[2]["values"][z_index]
        z_text = f" · {axes[2].get('label') or axes[2].get('type')}: {z_value.get('label')}"
    draw.text((18, 14), title + z_text, font=title_font, fill="#f4f7fb")
    prompt = str(plot.get("base", {}).get("finalPrompt") or "").replace("\n", " ").strip()
    if prompt:
        prompt = prompt if len(prompt) <= 180 else prompt[:177] + "..."
        draw.text((18, 50), prompt, font=small_font, fill="#aeb8c6")
    _draw_centered(draw, (0, 88, label_width, header_height), axes[1].get("label") or axes[1].get("type"), label_font, "#d7deea")
    for x, value in enumerate(x_values):
        box = (label_width + x * tile, 82, label_width + (x + 1) * tile, header_height)
        _draw_centered(draw, box, value.get("label", ""), label_font, "#e7edf6")
    cell_map = {tuple(cell["coordinate"]): cell for cell in plot["cells"]}
    for y, value in enumerate(y_values):
        box = (0, header_height + y * tile, label_width, header_height + (y + 1) * tile)
        _draw_centered(draw, box, value.get("label", ""), label_font, "#e7edf6")
        for x in range(x_count):
            coordinate = (x, y, z_index) if len(axes) == 3 else (x, y)
            cell = cell_map.get(coordinate, {})
            left = label_width + x * tile
            top = header_height + y * tile
            draw.rectangle((left, top, left + tile - 1, top + tile - 1), outline="#344050", width=1)
            image = _cell_image(cell)
            if image is not None:
                fitted = ImageOps.contain(image, (tile - 8, tile - 8), method=Image.Resampling.LANCZOS)
                canvas.paste(fitted, (left + (tile - fitted.width) // 2, top + (tile - fitted.height) // 2))
            else:
                status = str(cell.get("status") or "pending").upper()
                _draw_centered(draw, (left + 8, top + 8, left + tile - 8, top + tile - 8), status, label_font, "#8290a3")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    canvas.save(output_path, format="PNG", optimize=True)
    return canvas


def build_plot_artifacts(plot_id):
    plot = read_plot(plot_id)
    if plot is None:
        raise FileNotFoundError("Plot was not found")
    output_root = folder_paths.get_output_directory()
    folder_name = f"{time.strftime('%Y-%m-%d')}_{_slug(plot.get('title') or plot_id)}_{plot_id[:8]}"
    output_dir = os.path.join(output_root, "PromptStudio", "Plots", folder_name)
    os.makedirs(output_dir, exist_ok=True)
    z_count = len(plot["axes"][2]["values"]) if len(plot["axes"]) == 3 else 1
    composites = []
    rendered = []
    for z_index in range(z_count):
        filename = "plot.png" if z_count == 1 else f"plot_z_{z_index + 1:02d}.png"
        path = os.path.join(output_dir, filename)
        rendered.append(_render_slice(plot, z_index, path))
        composites.append(_artifact_reference(path))
    overview = None
    if len(rendered) > 1:
        target_width = min(2400, max(image.width for image in rendered))
        previews = []
        max_preview_height = max(16, MAX_COMPOSITE_SIDE // len(rendered))
        for image in rendered:
            ratio = min(1.0, target_width / image.width, max_preview_height / image.height)
            previews.append(image.resize((round(image.width * ratio), round(image.height * ratio)), Image.Resampling.LANCZOS))
        overview_image = Image.new("RGB", (target_width, sum(image.height for image in previews)), "#0b0e12")
        top = 0
        for image in previews:
            overview_image.paste(image, ((target_width - image.width) // 2, top))
            top += image.height
        overview_path = os.path.join(output_dir, "plot_overview.png")
        overview_image.save(overview_path, format="PNG", optimize=True)
        overview = _artifact_reference(overview_path)
    sidecar_plot = copy.deepcopy(plot)
    sidecar_plot["artifacts"] = {"composites": composites, "overview": overview}
    sidecar_path = os.path.join(output_dir, "plot.json")
    with open(sidecar_path + ".tmp", "w", encoding="utf-8") as file:
        json.dump(sidecar_plot, file, ensure_ascii=False, indent=2)
        file.flush()
        os.fsync(file.fileno())
    os.replace(sidecar_path + ".tmp", sidecar_path)
    plot["artifacts"] = {
        "composites": composites,
        "overview": overview,
        "manifest": _artifact_reference(sidecar_path),
    }
    return write_plot(plot, expected_revision=plot["revision"])
