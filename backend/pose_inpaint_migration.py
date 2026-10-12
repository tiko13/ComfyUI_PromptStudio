"""Wire reviewed pose inpainting into explicit Qwen edit workflows."""
import copy
import re


def is_pose_edit_workflow(name):
    return bool(re.match(r"\[PS\] - QwenImage21 (?:Edit|RGBA Edit)(?:\s|\.)", str(name)))


def upgrade_pose_workflow(value):
    flow = copy.deepcopy(value)
    nodes, links = flow.get("nodes", []), flow.get("links", [])
    groups = {kind: [n for n in nodes if n.get("type") == kind] for kind in
              ("KCPP_ChatImageInput", "PS_StructureInput", "PS_ApplyQwenStructure", "PS_EditMask")}
    if any(len(group) != 1 for group in groups.values()):
        return flow
    source, guide, control, composite = [g[0] for g in groups.values()]
    next_link = max([int(link[0]) for link in links] + [0]) + 1
    while len(guide["outputs"]) < 4:
        name, kind = (("inpaint_image", "IMAGE"), ("inpaint_mask", "MASK"))[len(guide["outputs"]) - 2]
        guide["outputs"].append(dict(name=name, type=kind, links=[]))

    def connect(origin, slot, target, name, kind):
        nonlocal next_link
        socket = next((i for i in target["inputs"] if i["name"] == name), None)
        if socket is None:
            socket = dict(name=name, type=kind, link=None)
            target["inputs"].append(socket)
        if socket.get("link") is not None:
            link = next(link for link in links if link[0] == socket["link"])
            if link[1:3] != [origin["id"], slot]:
                raise ValueError(f"Custom {name} wiring requires manual review")
            return
        socket["link"] = next_link
        origin["outputs"][slot].setdefault("links", []).append(next_link)
        links.append([next_link, origin["id"], slot, target["id"], target["inputs"].index(socket), kind])
        next_link += 1

    connect(source, 0, guide, "source", "IMAGE")
    connect(guide, 2, control, "inpaint_image", "IMAGE")
    connect(guide, 3, control, "inpaint_mask", "MASK")
    connect(guide, 3, composite, "inpaint_mask", "MASK")
    if not any(i["name"] == "preserve_background" for i in guide["inputs"]):
        guide["inputs"].append(dict(name="preserve_background", type="BOOLEAN", widget={"name": "preserve_background"}, link=None))
    if len(guide["widgets_values"]) < 4:
        guide["widgets_values"].append(True)
    guide.setdefault("widgets_values_named", {}).setdefault("preserve_background", guide["widgets_values"][3])
    flow["last_link_id"] = max(int(flow.get("last_link_id", 0)), next_link - 1)
    flow.setdefault("extra", {})["promptstudio_pose_inpaint_version"] = 1
    return flow


def upgrade_pose_snapshot(value):
    result = copy.deepcopy(value)
    output = result.get("output", {})
    groups = {kind: [(k, n) for k, n in output.items() if n.get("class_type") == kind] for kind in
              ("KCPP_ChatImageInput", "PS_StructureInput", "PS_ApplyQwenStructure", "PS_EditMask")}
    if any(len(group) != 1 for group in groups.values()):
        return result
    source, guide, control, composite = [g[0] for g in groups.values()]
    for node, key, link in ((guide, "source", [source[0], 0]), (control, "inpaint_image", [guide[0], 2]),
                            (control, "inpaint_mask", [guide[0], 3]), (composite, "inpaint_mask", [guide[0], 3])):
        inputs = node[1]["inputs"]
        if key in inputs and inputs[key] != link:
            raise ValueError(f"Custom {key} wiring requires manual review")
        inputs[key] = link
    guide[1]["inputs"].setdefault("preserve_background", True)
    if result.get("workflow"):
        result["workflow"] = upgrade_pose_workflow(result["workflow"])
    return result
