"""Explicit upgrade of the bundled transparency workflows and their saved copies."""
import copy
import re

WIDGETS = ("filename_prefix", "mode", "compression", "save", "format",
           "png_compression", "png_optimize", "webp_method", "force")
DEFAULTS = ("ComfyUI", "lossy", 80, "yes", "webp", 4, False, 6, False)


def is_transparency_workflow(name):
    return bool(re.match(r"\[PS\] - QwenImage21 (?:RGBA|Background Removal)(?:\s|\.)", str(name)))


def force_transparent_png(workflow):
    result = copy.deepcopy(workflow)
    scopes = [result, *result.get("definitions", {}).get("subgraphs", [])]
    for scope in scopes:
        for node in scope.get("nodes", []):
            if node.get("type") == "Save_as_webp_cond":
                values = node.get("widgets_values", [])
                named = dict(zip(WIDGETS, DEFAULTS))
                named.update(zip(WIDGETS, values))
                named.update(node.get("widgets_values_named", {}))
                named.update(format="png", mode="lossless", force=True)
                node["widgets_values"] = [named[key] for key in WIDGETS]
                if "widgets_values_named" in node:
                    node["widgets_values_named"] = named
                for key, kind in (("format", "COMBO"), ("png_compression", "INT"),
                                  ("png_optimize", "BOOLEAN"), ("webp_method", "INT"), ("force", "BOOLEAN")):
                    if not any(item.get("name") == key for item in node.get("inputs", [])):
                        node.setdefault("inputs", []).append({"name": key, "type": kind, "widget": {"name": key}, "link": None})
                node["size"] = [max(340, node.get("size", [340, 320])[0]), max(320, node.get("size", [340, 320])[1])]
            elif node.get("type") == "MarkdownNote":
                def update(text):
                    return text.replace("WebP output (Save as WebP Conditional).", "Forced lossless PNG output with transparency (Save as WebP Conditional).") if isinstance(text, str) else text
                node["widgets_values"] = [update(value) for value in node.get("widgets_values", [])]
                if "widgets_values_named" in node:
                    node["widgets_values_named"] = {key: update(value) for key, value in node["widgets_values_named"].items()}
    return result
