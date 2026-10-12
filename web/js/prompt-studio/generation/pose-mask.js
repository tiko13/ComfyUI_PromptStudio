import {previewStructureGuide, normalizeGuide} from "./structure-guide.js";
import {normalizePose} from "./pose.js";

// Pose detection and mask geometry run in queued ComfyUI nodes, never in a
// generation-time browser rewrite. Keep detections only for this editor session.
export function poseMaskEstimator({entry, source, fetchApi, dimensions, signal}) {
  let poses;
  const detect = async activeSignal => {
    const guide = normalizeGuide(entry.guide);
    let target = normalizePose(entry.pose?.data);
    if (!target && guide.input !== "photo") throw Error("This prepared guide has no editable joints. Extract a pose from a photo, or paint the mask manually.");
    if (!target) target = normalizePose((await previewStructureGuide(entry, fetchApi, {width:512,height:512}, activeSignal, true)).data);
    // A donor's original pose is not the edited source's original body.
    const original = normalizePose((await previewStructureGuide({image:source, guide:{type:"pose",input:"photo",fit:"fit"}}, fetchApi, {width:512,height:512}, activeSignal, true)).data);
    if (!original || !target) throw Error("Pose detection did not return usable joints. Paint the mask manually.");
    return {original,target};
  };
  return async ({padding, width, height, signal:editorSignal}) => {
    const activeSignal=editorSignal || signal;
    if (!poses) poses = detect(activeSignal).catch(error => {poses=null;throw error;});
    const {original,target} = await poses, size = await dimensions?.(), guide = normalizeGuide(entry.guide);
    if (activeSignal?.aborted) throw Error("Mask editor closed");
    const prompt = {
      estimate:{class_type:"PS_EstimatePoseMask",inputs:{source_pose_json:JSON.stringify(original),target_pose_json:JSON.stringify(target),
        source_width:width,source_height:height,guide_width:size?.width || width,guide_height:size?.height || height,
        fit:guide.fit,padding,all_people:guide.scope==="whole",targeting:JSON.stringify(entry.targeting?.target ? {target:entry.targeting.target} : {})}},
      preview:{class_type:"PreviewImage",inputs:{images:["estimate",0]}}
    };
    if(size?.resolution){prompt.size={class_type:"KCPP_PromptSlot",inputs:{prompt:"",slot_name:"Pose mask estimate",secondary_instructions:"",...size.resolution}};
      prompt.estimate.inputs.guide_width=["size",2];prompt.estimate.inputs.guide_height=["size",3];}
    const response=await fetchApi("/prompt",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt}),signal:activeSignal});
    const queued=await response.json();
    if(!response.ok || !queued.prompt_id)throw Error("Could not estimate the pose mask. Restart ComfyUI to load Estimate Pose Mask, or paint manually.");
    const deadline=Date.now()+180000;
    while(!activeSignal?.aborted && Date.now()<deadline){
      const response=await fetchApi(`/history/${encodeURIComponent(queued.prompt_id)}`,{signal:activeSignal,cache:"no-store"});
      if(!response.ok)throw Error("Could not read mask estimate progress.");
      const record=(await response.json())[queued.prompt_id];
      if(record?.status?.status_str==="error")throw Error(record.status.messages?.find(([type])=>type==="execution_error")?.[1]?.exception_message || "Mask estimation failed. Paint manually.");
      const image=record?.outputs?.preview?.images?.[0];if(image)return image;
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw Error(activeSignal?.aborted ? "Mask editor closed" : "Mask estimation is still queued. Check ComfyUI's queue.");
  };
}
