"""Small, model-independent Image Studio reference and edit attachment nodes."""
import json

MAX_REFERENCES = 64
DEFAULT_ROLES = "custom,subject,clothing,pose,background,style,object"


class ReferenceCollection:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "minimum": ("INT", {"default": 0, "min": 0, "max": MAX_REFERENCES, "tooltip": "Fewest semantic reference images required before generating. 0 makes references optional. Structure-only guides do not count. Set equal to maximum if your model requires every image input to be filled."}),
            "maximum": ("INT", {"default": 4, "min": 0, "max": MAX_REFERENCES, "tooltip": "Most entries allowed in Studio's References panel, including an attached structure guide. Set this to your model's supported capacity and wire Reference Items 1 through this number. Increasing it does not add image support to the model."}),
            "roles": ("STRING", {"default": DEFAULT_ROLES, "tooltip": "Comma-separated lowercase role identifiers offered in Studio, e.g. subject,style,texture. Roles tell prompt preparation which attributes to use; they do not change image wiring or add model capabilities. The custom role requires a user instruction."}),
        }, "optional": {"references_json": ("STRING", {"default": "[]", "multiline": True, "tooltip": 'Filled by Image Studio with ordered semantic references; normally leave []. For manual canvas use, supply a JSON list such as [{"image":{"filename":"ref.png","subfolder":"","type":"input"},"role":"style"}]. This stores image references, not pixel data.'})}}

    RETURN_TYPES = ("PS_REFERENCES",)
    RETURN_NAMES = ("references",)
    FUNCTION = "collect"
    CATEGORY = "Prompt Studio/References"
    DESCRIPTION = ("Declares reference capacity and roles for Image Studio. Connect references to Reference Prompt Settings and to Reference Item nodes numbered 1 through maximum. "
                   "Each Item converts one entry to ordinary IMAGE/MASK sockets for your model's existing encoder or conditioning nodes. The collection itself is PS_REFERENCES, not an IMAGE. "
                   "This pattern works with native ComfyUI and custom model nodes; it does not require a Prompt Studio encoder. Keep one connected collection per workflow, reaching the image output. "
                   "Studio fills the collection from its References panel; manual canvas runs use references_json. A compatible custom node may consume the collection directly.")
    OUTPUT_TOOLTIPS = ("Ordered PS_REFERENCES collection. Fan out to Reference Item nodes and the references input of Reference Prompt Settings; do not connect directly to an IMAGE socket.",)

    def collect(self, minimum=0, maximum=4, roles=DEFAULT_ROLES, references_json="[]"):
        if not 0 <= minimum <= maximum <= MAX_REFERENCES:
            raise ValueError("Reference minimum must not exceed maximum")
        value = json.loads(references_json)
        if not isinstance(value, list) or not minimum <= len(value) <= maximum:
            raise ValueError(f"Workflow requires between {minimum} and {maximum} references")
        if any(not isinstance(entry, dict) or not isinstance(entry.get("image"), dict) for entry in value):
            raise ValueError("Every reference needs an image")
        return (value,)


class ReferenceItem:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"references": ("PS_REFERENCES", {"tooltip": "Connect the references output of Reference Collection. Several Items can read the same collection."}),
                             "index": ("INT", {"default": 1, "min": 1, "max": MAX_REFERENCES, "tooltip": "One-based position in the collection: 1 selects the first reference, 2 the second. This is not the model's image-token number. In Qwen Edit, Item 1 goes to image_2 because image_1 is the edit source. An unfilled position returns None for both outputs."})}}

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "load"
    CATEGORY = "Prompt Studio/References"
    DESCRIPTION = ("Adapts one collection entry to standard IMAGE/MASK outputs. Use it to connect Studio references to an existing model's image inputs, or to process individual references separately. "
                   "Connect Collection -> Item -> the model's encoder/conditioning image input; repeat for each advertised slot. For Qwen Edit, wire Image Source to image_1, Item index 1 to image_2, and index 2 to image_3. "
                   "For Qwen Create, Item index 1 goes to image_1. Other models follow their own input conventions. Empty optional items return None: downstream nodes must accept absence, or require every reference using Collection minimum.")
    OUTPUT_TOOLTIPS = ("Selected reference as a standard IMAGE. Connect to the model's reference-image input or an image preprocessor. None when this collection position is empty.",
                       "Mask from the reference image's transparency: 1 for transparent pixels, 0 for opaque pixels; opaque images return an all-zero mask. This is not Studio's painted edit mask. None for an empty position.")

    def load(self, references, index):
        if type(index) is not int or not 1 <= index <= MAX_REFERENCES:
            raise ValueError("Reference Item index must be between 1 and 64")
        if index > len(references):
            return (None, None)
        from .nodes import KCPP_ChatImageInput
        return KCPP_ChatImageInput().load_image(json.dumps(references[index - 1]["image"]))

    @classmethod
    def IS_CHANGED(cls, references, index):
        if index > len(references):
            return "no-reference"
        from .nodes import KCPP_ChatImageInput
        return KCPP_ChatImageInput.IS_CHANGED(json.dumps(references[index - 1]["image"]))


class ReferencePrompt:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "prompt": ("STRING", {"forceInput": True, "tooltip": "Connect Studio Prompt Slot or Prompt Amplify, then connect this node's prompt output to your model's text encoder. Canvas execution passes this text through unchanged."}),
            "prompt_mode": (["edit_instruction", "full_prompt"], {"tooltip": "edit_instruction: in Edit mode, prepare an instruction from the selected source, references and request while keeping Main/Final unchanged. full_prompt: use the normal scene-prompt pipeline and append reference guidance. These settings configure Image Studio; this node does not call an LLM on the canvas."}),
            "reference_token": ("STRING", {"default": "<image{index}>", "tooltip": "How reference images are named in the prepared prompt. Must contain {index}, e.g. <image{index}> or [ref-{index}]. Choose the syntax your model understands. This changes prompt labels, not graph wiring."}),
            "first_reference_index": ("INT", {"default": 2, "min": 0, "max": 1000, "tooltip": "Number substituted for {index} for the first semantic reference, increasing by one thereafter. Qwen Edit uses 2 (source is image1); Qwen Create uses 1. Reference Item indices still start at 1. Structure-only guides are not numbered."}),
            "source_token": ("STRING", {"default": "<image1>", "tooltip": "Name for the image being edited in prepared reference instructions, e.g. <image1> or [canvas]. Match your model's source convention; this does not select or connect the source. Single-image assisted edits may refer naturally to 'the image'."}),
            "instructions": ("STRING", {"default": "", "multiline": True, "tooltip": "Optional model-specific prompt guidance, such as concise editing commands or attribute-transfer rules. Studio supplies it during assisted preparation or appends it in direct/full-prompt mode. Leave empty for the normal behavior; it cannot add model capabilities."}),
        }, "optional": {"references": ("PS_REFERENCES", {"tooltip": "Connect the same Reference Collection used by your Reference Item nodes. Declares which collection these prompt conventions describe. Leave disconnected only for a workflow with no semantic reference collection, such as guide-only editing."})}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "configure"
    CATEGORY = "Prompt Studio/References"
    DESCRIPTION = ("Declares how Image Studio prepares prompts for your model. Wire Prompt Slot/Amplify -> this node -> the model's text encoder, and connect the same Reference Collection used by Reference Items. "
                   "Configure prompt mode, image-token syntax and numbering to match the actual image connections. These are Studio preparation settings: standalone canvas execution passes prompt unchanged and does not call an LLM. "
                   "This node neither encodes images nor wires them into a model; Reference Item outputs provide those IMAGE/MASK connections. Use one connected settings node per workflow.")
    OUTPUT_TOOLTIPS = ("Prompt passed through unchanged by this node. Connect to the model's text encoder; Image Studio prepares the text before running the graph.",)

    def configure(self, prompt, prompt_mode, reference_token, first_reference_index, source_token, instructions, references=None):
        return (prompt,)


class StructureInput:
    @classmethod
    def INPUT_TYPES(cls):
        schema = {"required": {"width": ("INT", {"default": 1024, "min": 64, "max": 8192, "tooltip": "Prepared guide width in pixels. Usually connect Prompt Slot's width output so the guide matches the generation canvas."}),
                             "height": ("INT", {"default": 1024, "min": 64, "max": 8192, "tooltip": "Prepared guide height in pixels. Usually connect Prompt Slot's height output. Framing, crop and target placement are taken from the Studio guide settings."})},
                "optional": {"reference_json": ("STRING", {"default": "", "tooltip": "Filled by Studio with the selected image, guide type, strength, framing, targeting and edited pose data. Normally leave empty. Empty or zero strength disables the guide. For manual canvas use, supply a saved Studio guide entry."})}}
        schema["optional"].update(source=("IMAGE",),
            preserve_background=("BOOLEAN", {"default": True, "tooltip": "Pose edits require a reviewed mask when enabled. Off allows scene changes; it does not remove the background."}),
            edit_mask=("MASK", {"tooltip": "Manual canvas mask: white regenerates, black preserves. Otherwise uses Studio's reviewed mask."}))
        return schema

    RETURN_TYPES = ("IMAGE", "FLOAT", "IMAGE", "MASK")
    RETURN_NAMES = ("guide", "strength", "inpaint_image", "inpaint_mask")
    FUNCTION = "prepare"
    CATEGORY = "Prompt Studio/References"
    DESCRIPTION = ("Prepares one optional structure guide independently of the image model. Connect width/height from Prompt Slot, then guide and strength to your model's compatible ControlNet or guide-application node. "
                   "For Qwen, use Apply Qwen Structure. Other models need their own application node. Photo extraction requires the corresponding installed extractor; prepared maps need no extraction. "
                   "For pose background preservation, connect the original source and a reviewed edit mask (Studio record or manual MASK). Wire inpaint_image/inpaint_mask to Apply Qwen Structure and the same mask to Edit Mask. White regenerates; black preserves. "
                   "No active guide returns None and strength 0. Preservation off leaves both inpaint outputs empty. Use one connected Structure Input per workflow.")
    OUTPUT_TOOLTIPS = ("Prepared guide IMAGE at the requested dimensions, including Studio's framing and targeting. None when no guide is active. This output does not apply conditioning by itself.",
                       "Studio guide strength from 0 to 1. Zero means disabled; wire to a compatible application node that passes the model through when inactive.",
                       "Source image for native pose inpainting, or None when disabled.",
                       "Reviewed mask for Apply Qwen Structure and Edit Mask. White regenerates; black preserves.")

    def prepare(self, width, height, reference_json="", source=None, preserve_background=True, edit_mask=None):
        if not reference_json:
            return (None, 0.0, None, None)
        entry = json.loads(reference_json)
        guide = entry.get("guide", {})
        strength = float(guide.get("strength", 0.8))
        if not 0 <= strength <= 1:
            raise ValueError("Guide strength must be between zero and one")
        if strength == 0:
            return (None, 0.0, None, None)
        from .nodes import KCPP_ChatImageInput
        from .controlnet import QwenStructureGuide
        edited = entry.get("pose", {}).get("image") if guide.get("type") == "pose" else None
        image = KCPP_ChatImageInput().load_image(json.dumps(edited or entry["image"]))[0]
        targeting = dict(entry.get("targeting") or {})
        if edited:
            targeting["reference"] = None
        prepared = QwenStructureGuide().prepare(image, guide.get("type", "edges"),
            "prepared" if edited else guide.get("input", "photo"), guide.get("fit", "fit"),
            width, height, json.dumps(targeting) if targeting else "")[0]
        keep = guide.get("preserve_background", preserve_background)
        if type(keep) is not bool:
            raise ValueError("Preserve background must be a checkbox value")
        if source is not None and guide.get("type") == "pose" and keep:
            from .pose_inpaint import reviewed_mask
            mask = edit_mask if edit_mask is not None else reviewed_mask(entry.get("editMask"), source)
            if mask.ndim != 3 or tuple(mask.shape[-2:]) != tuple(source.shape[1:3]):
                raise ValueError("Inpainting mask must match the source dimensions")
            return (prepared, strength, source, mask)
        return (prepared, strength, None, None)

    @classmethod
    def IS_CHANGED(cls, width, height, reference_json="", source=None, preserve_background=True, edit_mask=None):
        if not reference_json:
            return "no-guide"
        entry = json.loads(reference_json)
        from .nodes import KCPP_ChatImageInput
        image = entry.get("pose", {}).get("image") if entry.get("guide", {}).get("type") == "pose" else None
        digest = KCPP_ChatImageInput.IS_CHANGED(json.dumps(image or entry["image"]))
        mask = entry.get("editMask") or {}
        if source is not None and entry.get("guide", {}).get("preserve_background", preserve_background) and mask.get("image"):
            digest += KCPP_ChatImageInput.IS_CHANGED(json.dumps(mask["image"]))
            digest += KCPP_ChatImageInput.IS_CHANGED(json.dumps(mask["sourceImage"]))
        return digest


class ApplyQwenStructure:
    @classmethod
    def INPUT_TYPES(cls):
        schema = {"required": {"model": ("MODEL", {"tooltip": "Qwen diffusion MODEL to condition. Insert this node before the sampler; connect the output to the sampler's model input."}),
            "vae": ("VAE", {"tooltip": "VAE compatible with the Qwen model, normally the same one used for encoding references and decoding the result."}),
            "guide": ("IMAGE", {"tooltip": "Connect Structure Input's guide output or a compatible prepared guide image. None passes the model through without loading a control patch."}),
            "strength": ("FLOAT", {"default": 0.0, "min": 0, "max": 1, "tooltip": "Usually connect Structure Input's strength output. 0 disables ControlNet; increasing toward 1 strengthens structural conditioning. Zero or a missing guide returns the original model without loading the patch."}),
            "control_model": ("STRING", {"default": "Qwen-Image-2.1-Fun-Controlnet-Union.safetensors", "tooltip": "Installed compatible Qwen union ControlNet patch in model_patches. Use its exact registered name including subfolder, or an unambiguous filename. Settings > Setup can install the default. Loaded only when a guide is active."})}}
        schema["optional"] = {"inpaint_image": ("IMAGE",), "inpaint_mask": ("MASK",)}
        return schema

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "apply"
    CATEGORY = "Prompt Studio/References"
    DESCRIPTION = ("Qwen-specific application step for a prepared structure guide. Connect the Qwen model and VAE, plus Structure Input's guide and strength; send the output MODEL to the sampler. "
                   "An active guide loads the configured union ControlNet patch. Optional inpaint_image and inpaint_mask must be connected together: these feed native Qwen control plus inpainting. No guide or zero strength passes the original model through unchanged. "
                   "Use another model family's compatible application node for that family; Reference Collection, Reference Item and Structure Input are reusable independently of this Qwen-specific step.")
    OUTPUT_TOOLTIPS = ("Qwen MODEL with active guide conditioning, or the original MODEL if the guide is disabled. Connect to the sampler.",)

    def apply(self, model, vae, guide, strength, control_model, inpaint_image=None, inpaint_mask=None):
        if not strength or guide is None:
            return (model,)
        import folder_paths
        from nodes import NODE_CLASS_MAPPINGS
        names = folder_paths.get_filename_list("model_patches")
        matches = [name for name in names if name == control_model or name.replace("\\", "/").split("/")[-1] == control_model]
        if len(matches) != 1:
            raise ValueError("Select an installed, unambiguous Qwen structure model; use Settings > Setup to install the default")
        loader = NODE_CLASS_MAPPINGS["ModelPatchLoader"]
        patch = getattr(loader(), loader.FUNCTION)(matches[0])
        patch = (patch["result"] if isinstance(patch, dict) else patch)[0]
        apply = NODE_CLASS_MAPPINGS["ZImageFunControlnet"]
        if (inpaint_image is None) != (inpaint_mask is None):
            raise ValueError("Connect both inpaint image and mask for background preservation")
        options = dict(inpaint_image=inpaint_image, mask=inpaint_mask) if inpaint_image is not None else {}
        result = getattr(apply(), apply.FUNCTION)(model=model, model_patch=patch, vae=vae, image=guide, strength=strength, **options)
        return result["result"] if isinstance(result, dict) else result


class EstimatePoseMask:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "source_pose_json": ("STRING", {"default": "", "multiline": True}),
            "target_pose_json": ("STRING", {"default": "", "multiline": True}),
            "source_width": ("INT", {"default": 1024, "min": 1, "max": 8192}),
            "source_height": ("INT", {"default": 1024, "min": 1, "max": 8192}),
            "guide_width": ("INT", {"default": 1024, "min": 1, "max": 8192}),
            "guide_height": ("INT", {"default": 1024, "min": 1, "max": 8192}),
            "fit": (["fit", "crop"],),
            "padding": ("FLOAT", {"default": 10, "min": 0, "max": 100, "step": 1}),
            "all_people": ("BOOLEAN", {"default": False})},
            "optional": {"targeting": ("STRING", {"default": ""})}}

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("preview", "mask")
    FUNCTION = "estimate"
    CATEGORY = "Prompt Studio/References"
    DESCRIPTION = ("Estimates a reviewable mask covering original and target OpenPose bodies. Source joints must describe the full original image. "
                   "Target joints use the same fit/crop and placement as the pose guide. Padding is a percentage of body scale. "
                   "Review clothing, hair, objects and shadows before using the MASK for inpainting; this is not subject segmentation.")

    def estimate(self, source_pose_json, target_pose_json, **kwargs):
        from .pose_mask_estimate import estimate
        return estimate(json.loads(source_pose_json), json.loads(target_pose_json), **kwargs)


class EditMask:
    @classmethod
    def INPUT_TYPES(cls):
        schema = {"required": {"generated": ("IMAGE", {"tooltip": "Decoded result of the edit. Connect the decoder or final image-processing output here, then connect this node's output to Save/Preview Image."}),
                             "source": ("IMAGE", {"tooltip": "Original image being edited, from Studio Image Source. With an active mask, pixels outside the painted area are taken from this image at source resolution."})},
                "optional": {"mask_json": ("STRING", {"default": "", "tooltip": "Filled by Studio with the painted mask image and its source identity/digest. Normally leave empty; no mask passes generated through unchanged. This is a saved Studio mask record, not a plain image filename."})}}
        schema["optional"]["inpaint_mask"] = ("MASK",)
        return schema

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "composite"
    CATEGORY = "Prompt Studio/References"
    DESCRIPTION = ("Preserves pixels outside Studio's painted edit mask by compositing after generation. Wire the decoded edit to generated, the original Image Source to source, and this output to the save/preview node. "
                   "An active mask is checked against its saved source and applied at source resolution. No mask passes generated through unchanged. "
                   "Connect Structure Input's inpaint_mask here to composite with the same mask used for native pose inpainting. This node itself only composites; Apply Qwen Structure supplies model conditioning. Use lossless output to retain exact pixels. Use one connected Edit Mask per workflow.")
    OUTPUT_TOOLTIPS = ("Edited image with the original source preserved outside the active mask. Without a mask, the generated input is returned unchanged.",)

    def composite(self, generated, source, mask_json="", inpaint_mask=None):
        if inpaint_mask is not None:
            from .pose_inpaint import composite
            return (composite(generated, source, inpaint_mask),)
        if not mask_json:
            return (generated,)
        from .reference_regions import ReferenceRegionComposite
        mask = json.loads(mask_json)
        return ReferenceRegionComposite().composite(generated, source, json.dumps(mask["image"]),
            json.dumps(mask["sourceImage"]), mask["sourceDigest"])


NODE_CLASS_MAPPINGS = {
    "PS_ReferenceCollection": ReferenceCollection, "PS_ReferenceItem": ReferenceItem,
    "PS_ReferencePrompt": ReferencePrompt, "PS_StructureInput": StructureInput,
    "PS_ApplyQwenStructure": ApplyQwenStructure, "PS_EditMask": EditMask,
    "PS_EstimatePoseMask": EstimatePoseMask,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "PS_ReferenceCollection": "Prompt Studio Reference Collection",
    "PS_ReferenceItem": "Prompt Studio Reference Item",
    "PS_ReferencePrompt": "Prompt Studio Reference Prompt Settings",
    "PS_StructureInput": "Prompt Studio Structure Input",
    "PS_ApplyQwenStructure": "Prompt Studio Apply Qwen Structure",
    "PS_EditMask": "Prompt Studio Edit Mask",
    "PS_EstimatePoseMask": "Prompt Studio Estimate Pose Mask",
}
