"""Opt-in real Qwen validation. Uses the existing queue and GPU handoff.

Artifacts and exact prompts are written under test-results/reference-edits.
Never changes user chats, workflow defaults or running processes.
"""
import argparse
import json
from pathlib import Path
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "test-results" / "reference-edits"
ORIGIN = "http://127.0.0.1:8188"
SETTINGS = {"llm_provider":"llamacpp", "llamacpp_url":"http://127.0.0.1:8080", "keep_models_loaded":False}


def api(path, payload=None):
    req = urllib.request.Request(ORIGIN+path, None if payload is None else json.dumps(payload).encode(),
                                 {"Content-Type":"application/json"})
    with urllib.request.urlopen(req, timeout=240) as response:
        return json.load(response)


def graph(prompt, source=None, reference=None, guide=None, mask=None):
    info = api("/object_info")
    def name(node, field, suffix):
        return next(n for n in info[node]["input"]["required"][field][0] if n.replace("\\","/").endswith(suffix))
    nodes = {
        "model":{"class_type":"KCPP_PromptStudioModelLoader","inputs":{"model_type":"QwenImage21","unet_name":name("KCPP_PromptStudioModelLoader","unet_name","qwen_image_2.1_int8_convrot.safetensors")}},
        "clip":{"class_type":"CLIPLoader","inputs":{"clip_name":name("CLIPLoader","clip_name","qwen3vl_8b_int8_convrot.safetensors"),"type":"qwen_image","device":"default"}},
        "vae":{"class_type":"VAELoader","inputs":{"vae_name":name("VAELoader","vae_name","qwen_image_2.1_vae_bf16.safetensors")}},
        "turbo":{"class_type":"KCPP_QwenImage21TurboLora","inputs":{"model":["model",0],"lora_name":name("KCPP_QwenImage21TurboLora","lora_name","_Qwen-Image-2.1-viggle-turbo-v0.3-6step-lora-r128.safetensors")}},
        "cache":{"class_type":"QwenImage21Cache","inputs":{"model":["turbo",0],"device":"auto","dtype":"default"}},
        "encode":{"class_type":"TextEncodeQwenImage21","inputs":{"clip":["clip",0],"vae":["vae",0],"prompt":prompt,"negative_prompt":"","resolution":1056}},
        "latent":{"class_type":"EmptySD3LatentImage","inputs":{"width":768,"height":768,"batch_size":1}},
        "sample":{"class_type":"KCPP_QwenImage21TurboSampler","inputs":{"model":["cache",0],"seed":210923,"positive":["encode",0],"latent_image":["encode",2] if source else ["latent",0]}},
        "decode":{"class_type":"VAEDecode","inputs":{"samples":["sample",0],"vae":["vae",0]}},
        "save":{"class_type":"SaveImage","inputs":{"images":["decode",0],"filename_prefix":"PromptStudio/Validation/reference-edits"}},
    }
    for key, ref in (("source",source),("reference",reference)):
        if ref:
            nodes[key] = {"class_type":"KCPP_ChatImageReference","inputs":{"image_ref":json.dumps(ref),"source_name":key}}
            nodes["encode"]["inputs"]["images.image_1" if key=="source" else "images.image_2"] = [key,0]
    if guide:
        nodes["guide_source"] = {"class_type":"KCPP_ChatImageReference","inputs":{"image_ref":json.dumps(guide["image"]),"source_name":"guide"}}
        nodes["guide"] = {"class_type":"KCPP_QwenStructureGuide","inputs":{"image":["guide_source",0],"guide_type":guide["type"],"input_mode":guide.get("input","photo"),"fit":"fit","width":1056,"height":1056,"targeting":json.dumps(guide.get("targeting")) if guide.get("targeting") else ""}}
        nodes["patch"] = {"class_type":"ModelPatchLoader","inputs":{"name":api("/promptstudio/controlnet/status")["model"]}}
        nodes["control"] = {"class_type":"ZImageFunControlnet","inputs":{"model":["cache",0],"model_patch":["patch",0],"vae":["vae",0],"image":["guide",0],"strength":.8}}
        nodes["sample"]["inputs"]["model"] = ["control",0]
    if mask:
        nodes["composite"]={"class_type":"KCPP_ReferenceRegionComposite","inputs":{"generated":["decode",0],"source":["source",0],"mask_ref":json.dumps(mask["mask"]),"source_ref":json.dumps(source),"source_digest":mask["source_digest"]}}
        nodes["save"]["inputs"]["images"]=["composite",0]
    return nodes


def render(label, prompt, *, workflow=None, output_suffix=".png", **kwargs):
    OUT.mkdir(parents=True,exist_ok=True)
    saved = OUT / (label+".json")
    if saved.is_file():
        result=json.loads(saved.read_text()); print(json.dumps({"reused":label,"image":result["image"]}),flush=True); return result["image"]
    q=api("/queue"); jobs=api("/promptstudio/jobs")
    if q["queue_running"] or q["queue_pending"] or any(j["state"] in ("running","queued") for j in jobs["jobs"]):
        raise RuntimeError("Existing user work is active; retry when idle")
    workflow=workflow or graph(prompt,**kwargs)
    release=api("/promptstudio/prompt-studio/llm/release",SETTINGS)
    try:
        result=api("/prompt",{"prompt":workflow,"client_id":"promptstudio-reference-validation"})
    finally:
        if release.get("handoff_token"):
            api("/promptstudio/prompt-studio/llm/handoff-complete",{"handoff_token":release["handoff_token"]})
    prompt_id=result["prompt_id"]; start=time.monotonic()
    print(json.dumps({"queued":label,"prompt_id":prompt_id}),flush=True)
    (OUT/(label+"-request.json")).write_text(json.dumps({"prompt_id":prompt_id,"prompt":workflow},indent=2))
    while time.monotonic()-start < 1200:
        history=api("/history/"+prompt_id).get(prompt_id)
        if history:
            if history.get("status",{}).get("status_str")=="error":
                raise RuntimeError(json.dumps(history["status"]))
            image=history["outputs"]["save"]["images"][0]
            with urllib.request.urlopen(ORIGIN+"/view?"+urllib.parse.urlencode(image),timeout=30) as response:
                (OUT/(label+output_suffix)).write_bytes(response.read())
            record={"label":label,"prompt":prompt,"image":image,"seconds":round(time.monotonic()-start,2),"prompt_id":prompt_id}
            saved.write_text(json.dumps(record,indent=2)); print(json.dumps(record),flush=True);return image
        time.sleep(3)
    raise TimeoutError("Validation still running; inspect its recorded prompt ID before retrying")


def run(stage):
    if stage=="ambiguity":
        for label,source_name,reference_name in (("two-to-one","source-two","pose-donor"),("one-to-two","source-single","donor-two")):
            source=json.loads((OUT/(source_name+".json")).read_text())["image"]
            reference=json.loads((OUT/(reference_name+".json")).read_text())["image"]
            request={**SETTINGS,"model":"qwen_image_2_1","source_image":source,"user_text":"","references":[{"image":reference,"role":"custom","use":"structure","guide":{"type":"pose","input":"photo","strength":.8,"fit":"fit"}}]}
            triage=api("/promptstudio/references/triage",request)
            assert triage.get("decision")=="deep",triage
            response=api("/promptstudio/prompt-studio/qwen-edit-prompt",request)
            (OUT/(label+"-ambiguity.json")).write_text(json.dumps({"triage":triage,"response":response},indent=2))
            print(json.dumps({"case":label,**response}),flush=True)
            assert response.get("clarification") and not response.get("prompt"),response
    if stage=="webp":
        source=json.loads((OUT/"source-two.json").read_text())["image"]
        generated=json.loads((OUT/"jacket-baseline.json").read_text())["image"]
        mask=json.loads((OUT/"mask.json").read_text())
        workflow={key:{"class_type":"KCPP_ChatImageReference","inputs":{"image_ref":json.dumps(ref),"source_name":key}} for key,ref in (("source",source),("generated",generated))}
        workflow["composite"]={"class_type":"KCPP_ReferenceRegionComposite","inputs":{"generated":["generated",0],"source":["source",0],"mask_ref":json.dumps(mask["mask"]),"source_ref":json.dumps(source),"source_digest":mask["source_digest"]}}
        workflow["save"]={"class_type":"Save_as_webp_cond","inputs":{"images":["composite",0],"filename_prefix":"PromptStudio/Validation/reference-mask","mode":"lossless","compression":80,"save":"yes"}}
        render("jacket-lossless","Existing edit composited and saved as lossless WebP",workflow=workflow,output_suffix=".webp")
        import numpy as np
        from PIL import Image
        original=np.asarray(Image.open(OUT/"source-two.png").convert("RGB"));edited=np.asarray(Image.open(OUT/"jacket-lossless.webp").convert("RGB"));coverage=np.asarray(Image.open(OUT/"mask.png").convert("L"))
        difference=np.abs(original.astype(int)-edited.astype(int))
        outside=int(difference[coverage==0].max());assert outside==0,outside
        print(json.dumps({"lossless_webp_outside_mask_max_channel_difference":outside}),flush=True)
    if stage=="fixtures":
        render("source-two", "Full-body studio photograph of exactly two adults standing well apart on a plain light gray backdrop. On the viewer's left, a dark-haired man wearing a plain blue bomber jacket, black trousers and black shoes, arms hanging down. On the viewer's right, a blonde woman wearing a plain green sweater, beige trousers and white shoes, arms hanging down. Both face the camera, feet visible, ample space around each person, natural realistic faces, soft even lighting, no text.")
        render("donor-two", "Full-body studio photograph of exactly two adults standing well apart on a plain light gray backdrop. On the viewer's left, a short-haired woman wearing a bright red leather jacket with a diagonal silver zipper, black jeans and boots. On the viewer's right, a dark-haired man wearing a yellow raincoat, dark trousers and white shoes. Both face the camera, feet visible, ample space around each person, soft even lighting, no text.")
    if stage=="edits":
        source=json.loads((OUT/"source-two.json").read_text())["image"]
        donor=json.loads((OUT/"donor-two.json").read_text())["image"]
        request={**SETTINGS,"model":"qwen_image_2_1","source_image":source,"references":[{"image":donor,"role":"clothing"}],
                 "user_text":"Make only the dark-haired man in the source wear the red jacket from the person on the left in the reference. Preserve the blonde woman, both faces, poses and background."}
        analysis=api("/promptstudio/prompt-studio/qwen-edit-prompt",request)
        (OUT/"jacket-analysis.json").write_text(json.dumps(analysis,indent=2))
        if not analysis.get("prompt"): raise RuntimeError(json.dumps(analysis))
        render("jacket-baseline",analysis["prompt"],source=source,reference=donor)
        for kind in ("depth","edges","sketch"):
            render("whole-"+kind, f"Edit the image. Follow the entire supplied ControlNet {kind} guide. Preserve the people's identity, clothing, colors and photographic style.",source=source,guide={"image":source,"type":kind})
    if stage=="regions":
        source=json.loads((OUT/"source-two.json").read_text())["image"]
        donor=json.loads((OUT/"donor-two.json").read_text())["image"]
        mapping=api("/promptstudio/references/map",{**SETTINGS,"source_image":source,"reference_image":donor,"user_text":"Put the red jacket from the left reference person on the dark-haired source man. Keep the blonde source woman unchanged."})
        (OUT/"mapping.json").write_text(json.dumps(mapping,indent=2));print(json.dumps(mapping),flush=True)
        assert mapping.get("targeting"),mapping
        assert mapping["targeting"]["target"]["x"]<.5 and mapping["targeting"]["reference"]["x"]<.5
        objects=api("/promptstudio/references/objects",{"image":source,"query":"jacket","region":mapping["targeting"]["target"]})
        (OUT/"objects.json").write_text(json.dumps(objects,indent=2));print(json.dumps(objects),flush=True)
        assert objects.get("boxes"),objects
        box=max(objects["boxes"],key=lambda b:b["score"])["region"]
        mask=api("/promptstudio/references/mask",{"image":source,"region":box})
        (OUT/"mask.json").write_text(json.dumps(mask,indent=2));print(json.dumps(mask),flush=True)
        assert mask.get("mask"),mask
        with urllib.request.urlopen(ORIGIN+"/promptstudio/prompt-studio/image?"+urllib.parse.urlencode({"filename":mask["mask"]["filename"]}),timeout=30) as response:(OUT/"mask.png").write_bytes(response.read())
        prompt=json.loads((OUT/"jacket-analysis.json").read_text())["prompt"]
        render("jacket-masked",prompt,source=source,reference=donor,mask=mask)
        import numpy as np
        from PIL import Image
        original=np.asarray(Image.open(OUT/"source-two.png").convert("RGB"));edited=np.asarray(Image.open(OUT/"jacket-masked.png").convert("RGB"));coverage=np.asarray(Image.open(OUT/"mask.png").convert("L"))
        assert original.shape==edited.shape
        difference=np.abs(original.astype(int)-edited.astype(int))
        outside=int(difference[coverage==0].max());assert outside==0,outside
        print(json.dumps({"outside_mask_max_channel_difference":outside,"inside_mean_difference":float(difference[coverage>0].mean())}),flush=True)
    if stage=="pose":
        source=json.loads((OUT/"source-two.json").read_text())["image"]
        pose=render("pose-donor","Full-body studio photograph of exactly one adult man standing in the middle of a plain light gray backdrop, facing the camera, both arms raised high diagonally in a wide V above his head, hands and feet visible with wide margins. Plain red T-shirt and dark trousers, natural soft even lighting, no text.")
        single=render("source-single","Full-body studio photograph of exactly one dark-haired adult man in a plain blue bomber jacket, black trousers and shoes, standing in the middle of a plain light gray backdrop, facing camera, arms hanging down, hands and feet visible, soft even lighting, no text.")
        render("pose-single","Edit the image. Make the man adopt the raised-arm body pose from the supplied ControlNet guide. Preserve his blue jacket, face, hair, trousers and the photographic style.",source=single,guide={"image":pose,"type":"pose"})
        render("pose-two-targeted","Edit the image. Only the dark-haired man on the left should adopt the raised-arm body pose in the ControlNet guide. Keep the blonde woman on the right unchanged. Preserve both identities, clothes, colors and photographic style.",source=source,guide={"image":pose,"type":"pose","targeting":{"reference":None,"target":{"x":0,"y":0,"width":.49,"height":1}}})
        render("whole-sketch-contours","Edit the image. Use the supplied control map only for spatial contours and geometry. Render a full-color studio photograph with the original realistic skin, blue jacket, green sweater and fabric textures. Keep the original photographic medium. Do not copy the line-art appearance of the guide.",source=source,guide={"image":source,"type":"sketch"})


if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("stage",choices=["fixtures","edits","regions","pose","webp","ambiguity"]);run(p.parse_args().stage)
