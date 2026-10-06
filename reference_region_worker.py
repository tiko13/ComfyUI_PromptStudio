"""CPU-only optional inference process. No network, downloads or global host changes."""
import json
import sys
import time


def main(request):
    import numpy as np
    import torch
    from PIL import Image,ImageOps,ImageFilter
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    started=time.perf_counter()
    with Image.open(request["path"]) as raw:
        if raw.width*raw.height>64*1024*1024:raise ValueError("Image too large")
        image=ImageOps.exif_transpose(raw).convert("RGB")
    w,h=image.size; region=request.get("region")
    bounds=(0,0,w,h) if not region else (int(region["x"]*w),int(region["y"]*h),min(w,max(int(region["x"]*w)+1,round((region["x"]+region["width"])*w))),min(h,max(int(region["y"]*h)+1,round((region["y"]+region["height"])*h))))
    if request.get("query") is not None:
        from transformers import AutoProcessor,AutoModelForZeroShotObjectDetection
        processor=AutoProcessor.from_pretrained(request["model"],local_files_only=True,trust_remote_code=False)
        model=AutoModelForZeroShotObjectDetection.from_pretrained(request["model"],local_files_only=True,trust_remote_code=False).eval()
        crop=image.crop(bounds)
        inputs=processor(images=crop,text=request["query"].strip().rstrip(".")+".",return_tensors="pt")
        with torch.inference_mode():outputs=model(**inputs)
        import inspect
        method=processor.post_process_grounded_object_detection
        threshold="threshold" if "threshold" in inspect.signature(method).parameters else "box_threshold"
        results=method(outputs,inputs.input_ids,**{threshold:.25,"text_threshold":.25,"target_sizes":[crop.size[::-1]]})[0]
        boxes=[]
        for coords,score in zip(results["boxes"],results["scores"]):
            x1,y1,x2,y2=coords.tolist()
            x1,x2=np.clip([x1+bounds[0],x2+bounds[0]],0,w);y1,y2=np.clip([y1+bounds[1],y2+bounds[1]],0,h)
            if x2>x1 and y2>y1:
                boxes.append({"label":request["query"],"score":float(score),"region":dict(x=float(x1/w),y=float(y1/h),width=float((x2-x1)/w),height=float((y2-y1)/h))})
        boxes.sort(key=lambda b:b["region"]["x"])
        return {"available":True,"model":"grounding-dino-tiny","boxes":boxes[:32],"elapsed_ms":round((time.perf_counter()-started)*1000)}
    from segment_anything import sam_model_registry,SamPredictor
    sam=sam_model_registry["vit_b"](checkpoint=request["model"]).to("cpu").eval()
    predictor=SamPredictor(sam)
    with torch.inference_mode():
        predictor.set_image(np.asarray(image))
        masks,scores,_=predictor.predict(box=np.asarray(bounds),multimask_output=True)
    chosen=masks[int(np.argmax(scores))]
    # Clamp to the explicit region, then feather inward only. Pixels outside it
    # remain exactly zero; SAM must not expand edits to neighbouring subjects.
    restricted=np.zeros((h,w),dtype=np.uint8);x1,y1,x2,y2=bounds
    restricted[y1:y2,x1:x2]=chosen[y1:y2,x1:x2]*255
    if not restricted.any():raise ValueError("No segmentation within the selected region")
    mask=Image.fromarray(restricted)
    smooth=np.minimum(np.asarray(mask.filter(ImageFilter.GaussianBlur(2))),restricted)
    Image.fromarray(smooth).save(request["output"],format="PNG")
    return {"available":True,"model":"sam-vit-b","score":float(max(scores)),"width":w,"height":h,"elapsed_ms":round((time.perf_counter()-started)*1000)}


if __name__=="__main__":
    print(json.dumps(main(json.load(sys.stdin))))
