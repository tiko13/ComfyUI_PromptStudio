"""Conservative serialized-workflow migration; never changes model choices."""
import copy

VERSION = 1
ROLES = "custom,subject,clothing,pose,background,style,object"


def upgrade_reference_workflow(value):
    flow = copy.deepcopy(value)
    nodes, links = flow.get("nodes", []), flow.get("links", [])
    if not isinstance(nodes, list) or not isinstance(links, list):
        return flow
    # Existing declarations belong to their author, including disabled features.
    if any(n.get("type", "").startswith("PS_") for n in nodes):
        return flow
    if any(not isinstance(link, list) or len(link) < 6 for link in links):
        return flow
    encoders = [n for n in nodes if n.get("type") == "TextEncodeQwenImage21"]
    sources = [n for n in nodes if n.get("type") == "KCPP_ChatImageInput"]
    prompts = [n for n in nodes if n.get("type") in ("KCPP_PromptSlot", "KCPP_PromptAmplify")]
    decoders = [n for n in nodes if n.get("type") == "VAEDecode"]
    samplers = [n for n in nodes if n.get("type") in ("KCPP_PromptStudioSampler", "KCPP_QwenImage21TurboSampler", "KCPP_QwenImage21OfficialTurboSampler")]
    if not encoders:
        # Preserve the existing single-reference Krea edit path explicitly.
        refs = [n for n in nodes if n.get("type") == "KCPP_ChatImageReference"]
        if len(refs) == 1 and len(sources) == 1 and any(n.get("type", "").startswith("Krea2Edit") for n in nodes):
            ref = refs[0]
            ref["widgets_values"] = list(ref.get("widgets_values", ["", "Reference image"]))[:2] + [False, "grounded_edit"]
            ref.setdefault("widgets_values_named", {}).update(required=False, reference_mode="grounded_edit")
        return flow
    if len(encoders) != 1 or len(prompts) != 1 or len(decoders) != 1 or len(samplers) != 1 or len(sources) > 1:
        return flow
    encoder, prompt, decoder, sampler = encoders[0], prompts[0], decoders[0], samplers[0]
    by_id = {n["id"]: n for n in nodes}

    def socket(node, name):
        return next((s for s in node.get("inputs", []) if s["name"] == name), None)

    def upstream(node, name):
        s = socket(node, name)
        return next((link for link in links if s and link[0] == s.get("link")), None)

    prompt_link, vae_link, model_link = upstream(encoder, "prompt"), upstream(decoder, "vae"), upstream(sampler, "model")
    if not prompt_link or prompt_link[1] != prompt["id"] or not vae_link or not model_link:
        return flow
    editing = bool(sources)
    first, maximum = (2, 9) if editing else (1, 10)
    if any(s["name"].startswith("images.image_") and s.get("link") is not None and (not editing or s["name"] != "images.image_1") for s in encoder.get("inputs", [])):
        return flow
    if any(n.get("type") in ("ZImageFunControlnet", "QwenImageDiffsynthControlnet") for n in nodes):
        return flow
    next_node = max([int(n["id"]) for n in nodes] + [0]) + 1
    next_link = max([int(link[0]) for link in links] + [0]) + 1

    def add(kind, inputs, outputs, values, pos):
        nonlocal next_node
        node = dict(id=next_node, type=kind, pos=pos, size=[300, 180], flags={}, order=len(nodes), mode=0,
                    inputs=[dict(name=name, type=typ, link=None) for name, typ in inputs],
                    outputs=[dict(name=name, type=typ, links=[]) for name, typ in outputs],
                    properties={"Node name for S&R": kind}, widgets_values=list(values.values()), widgets_values_named=dict(values))
        next_node += 1
        nodes.append(node); by_id[node["id"]] = node
        return node

    def connect(origin, origin_slot, target, name, typ):
        nonlocal next_link
        s = socket(target, name)
        if s is None:
            s = dict(name=name, type=typ, link=None)
            target.setdefault("inputs", []).append(s)
        old = upstream(target, name)
        if old:
            links.remove(old)
            origin_links = by_id[old[1]]["outputs"][old[2]].get("links") or []
            if old[0] in origin_links:
                origin_links.remove(old[0])
        s["link"] = next_link
        out = origin["outputs"][origin_slot]
        out["links"] = (out.get("links") or []) + [next_link]
        links.append([next_link, origin["id"], origin_slot, target["id"], target["inputs"].index(s), typ])
        next_link += 1

    collection = add("PS_ReferenceCollection", [], [("references", "PS_REFERENCES")],
                     dict(minimum=0, maximum=maximum, roles=ROLES, references_json="[]"), [-1000, -600])
    settings = add("PS_ReferencePrompt", [("prompt", "STRING"), ("references", "PS_REFERENCES")], [("prompt", "STRING")],
                   dict(prompt_mode="edit_instruction" if editing else "full_prompt", reference_token="<image{index}>",
                        first_reference_index=first, source_token="<image1>", instructions=""), [-620, -600])
    connect(prompt, 0, settings, "prompt", "STRING")
    connect(collection, 0, settings, "references", "PS_REFERENCES")
    connect(settings, 0, encoder, "prompt", "STRING")
    for index in range(1, maximum + 1):
        item = add("PS_ReferenceItem", [("references", "PS_REFERENCES")], [("image", "IMAGE"), ("mask", "MASK")],
                   dict(index=index), [-1000 + ((index - 1) % 5) * 330, -350 + ((index - 1) // 5) * 230])
        connect(collection, 0, item, "references", "PS_REFERENCES")
        connect(item, 0, encoder, f"images.image_{first + index - 1}", "IMAGE")
    # Qwen consumes VAE only when images are supplied. Create keeps its independent latent.
    if not upstream(encoder, "vae"):
        connect(by_id[vae_link[1]], vae_link[2], encoder, "vae", "VAE")
    guide = add("PS_StructureInput", [("width", "INT"), ("height", "INT")], [("guide", "IMAGE"), ("strength", "FLOAT")],
                dict(width=1024, height=1024, reference_json=""), [-1000, 200])
    for name, slot in (("width", 2), ("height", 3)):
        socket(guide, name)["widget"] = {"name": name}
        connect(prompt, slot, guide, name, "INT")
    control = add("PS_ApplyQwenStructure", [("model", "MODEL"), ("vae", "VAE"), ("guide", "IMAGE"), ("strength", "FLOAT")], [("model", "MODEL")],
                  dict(strength=0.0, control_model="Qwen-Image-2.1-Fun-Controlnet-Union.safetensors"), [-620, 200])
    socket(control, "strength")["widget"] = {"name": "strength"}
    connect(by_id[model_link[1]], model_link[2], control, "model", "MODEL")
    connect(by_id[vae_link[1]], vae_link[2], control, "vae", "VAE")
    connect(guide, 0, control, "guide", "IMAGE")
    connect(guide, 1, control, "strength", "FLOAT")
    connect(control, 0, sampler, "model", "MODEL")
    if editing:
        # Only graphs that previously offered exact preservation receive a mask node.
        sinks = [n for n in nodes if n.get("type") in ("SaveImage", "PreviewImage", "Save_as_webp_cond")
                 and (upstream(n, "images") or [None, None])[1] == decoder["id"]]
        if len(sinks) == 1:
            mask = add("PS_EditMask", [("generated", "IMAGE"), ("source", "IMAGE")], [("IMAGE", "IMAGE")],
                       dict(mask_json=""), [-240, 200])
            connect(decoder, 0, mask, "generated", "IMAGE")
            connect(sources[0], 0, mask, "source", "IMAGE")
            connect(mask, 0, sinks[0], "images", "IMAGE")
    flow["last_node_id"], flow["last_link_id"] = next_node - 1, next_link - 1
    flow.setdefault("extra", {})["promptstudio_reference_version"] = VERSION
    return flow
