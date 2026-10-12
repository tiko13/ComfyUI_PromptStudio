"""Explicit node-setting upgrade for source-sized, lossless Qwen edit workflows.

This is an offline migration, never a generation-time prompt rewrite.
"""
import copy
import re

from .image_output_migration import DEFAULTS, WIDGETS

EDIT_NOTE = (
    "Qwen editing keeps each reference at its source dimensions (encoder resolution=0, "
    "rounded to multiples of 32). Keep the encoder latent connected to the sampler. "
    "The source controls edit dimensions, not the Create megapixel selector. "
    "The save node forces lossless PNG for further edits. Larger sources cost more memory and time. "
    "Whole-image edits still reconstruct details; use an explicit edit mask to preserve unchanged pixels."
)
SEED_NOTE = (
    "Use a different sampler seed from the image's generation seed, including between successive edits. "
    "At the same dimensions, reusing that seed can cause Qwen 2.1 noise replay (grain and halos). "
    "Seed settings remain explicit and are not silently overridden."
)


def is_qwen_edit_workflow(name):
    return bool(re.match(r"\[PS\] - QwenImage21 (?:Edit|RGBA Edit|Background Removal)(?:\s|\.)", str(name)))


def _note(text):
    if not isinstance(text, str):
        return text
    text = re.sub(r"Supply an edit target in Prompt Studio\. The encoder latent controls output size.*?Keep the Turbo shift resolution in sync\.", "", text)
    text = text.replace("WebP output (Save as WebP Conditional).", "Lossless PNG output (Save as WebP Conditional).")
    if EDIT_NOTE not in text:
        text = text.rstrip() + "\n\n" + EDIT_NOTE
    if SEED_NOTE not in text:
        text = text.rstrip() + "\n\n" + SEED_NOTE
    return text


def upgrade_qwen_edit_workflow(workflow):
    result = copy.deepcopy(workflow)
    for scope in [result, *result.get("definitions", {}).get("subgraphs", [])]:
        nodes = scope.get("nodes", [])
        if not any(n.get("type") == "KCPP_ChatImageInput" for n in nodes):
            continue
        encoders = [n for n in nodes if n.get("type") == "TextEncodeQwenImage21"]
        if not encoders:
            continue
        for node in encoders:
            if any(i.get("name") == "resolution" and i.get("link") is not None for i in node.get("inputs", [])):
                raise ValueError("Qwen encoder resolution is wired; review this custom workflow manually")
            values = node.setdefault("widgets_values", ["", "", 0])
            values[2] = 0
            if "widgets_values_named" in node:
                node["widgets_values_named"]["resolution"] = 0
        for node in nodes:
            if node.get("type") == "Save_as_webp_cond":
                if any(i.get("name") in {"format", "mode", "force"} and i.get("link") is not None for i in node.get("inputs", [])):
                    raise ValueError("Output settings are wired; review this custom workflow manually")
                named = dict(zip(WIDGETS, DEFAULTS))
                named.update(zip(WIDGETS, node.get("widgets_values", [])))
                named.update(node.get("widgets_values_named", {}))
                named.update(format="png", mode="lossless", force=True)
                node["widgets_values"] = [named[key] for key in WIDGETS]
                if "widgets_values_named" in node:
                    node["widgets_values_named"] = named
                for key, kind in (("format", "COMBO"), ("png_compression", "INT"), ("png_optimize", "BOOLEAN"), ("webp_method", "INT"), ("force", "BOOLEAN")):
                    if not any(i.get("name") == key for i in node.get("inputs", [])):
                        node.setdefault("inputs", []).append({"name": key, "type": kind, "widget": {"name": key}, "link": None})
            elif node.get("type") == "MarkdownNote":
                node["widgets_values"] = [_note(v) for v in node.get("widgets_values", [])]
                if "widgets_values_named" in node:
                    node["widgets_values_named"] = {k: _note(v) for k, v in node["widgets_values_named"].items()}
    return result


def upgrade_qwen_edit_snapshot(snapshot):
    result = copy.deepcopy(snapshot)
    output = result.get("output", {})
    if not any(n.get("class_type") == "KCPP_ChatImageInput" for n in output.values()):
        return result
    if not any(n.get("class_type") == "TextEncodeQwenImage21" for n in output.values()):
        return result
    for node in output.values():
        kind, inputs = node.get("class_type"), node.get("inputs", {})
        if kind == "TextEncodeQwenImage21":
            if isinstance(inputs.get("resolution"), list):
                raise ValueError("Qwen encoder resolution is wired; review manually")
            inputs["resolution"] = 0
        elif kind == "Save_as_webp_cond":
            if any(isinstance(inputs.get(k), list) for k in ("format", "mode", "force")):
                raise ValueError("Output settings are wired; review manually")
            inputs.update(format="png", mode="lossless", force=True)
    if result.get("workflow"):
        result["workflow"] = upgrade_qwen_edit_workflow(result["workflow"])
    return result
