// Read-only analysis of the opt-in live matrix. Writes a local review gallery.
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),dir=resolve(root,'test-results/pose-matrix');
const read=async name=>JSON.parse((await readFile(resolve(dir,name),'utf8')).replace(/^\uFEFF/,''));
const guides=await read('guides.json'),scenarios=await read('scenario-guides.json');
const cases=[];
const observations={
 'minimal-none':'Original pose retained; negative control.',
 'minimal-original':'Original pose retained; the original guide does not establish that edits will work.',
 'minimal-edited':'Edited arms and legs ignored; original pose retained.',
 'minimal-full':'Full normal control strength still retained the original pose.',
 'minimal-nocache':'Cache settings node bypassed, but auto caching can remain. See cache-off for an explicit disable.',
 'cache-off':'Explicitly disabling the cache did not change the pose failure.',
 'detailed-edited':'Arms followed the requested pose; legs remained inaccurate.',
 'visual-off':'Both moved legs appeared, but the old legs remained too.',
 'visual-control':'Malformed anatomy; the visual reference is not a reliable fix.',
 'direct-action':'Unwanted limbs remained despite the explicit movement instruction.',
 'create-off':'New-image negative control; no request to preserve the original person.',
 'create-original':'Broad pose followed in a fresh image.',
 'create-edited':'Arms and one leg followed the extreme pose; the other leg did not.',
 'inpaint-create':'Extra legs appeared with the union-of-limbs mask.',
 'inpaint-edit':'Source pose retained despite inpainting conditioning.',
 'inpaint-vision-create':'Broad mask still failed to move both legs reliably.',
 'inpaint-vision-edit':'Face/background retained more closely, but clothing changed and an extra leg appeared.',
 'vision-source':'Both legs followed the target more closely, but face, clothing and background changed.',
 'vision-pose':'Good broad pose adherence; identity and outfit drift remained.',
 'vision-detailed':'Good broad pose adherence; identity and outfit drift remained.',
 'pipeline-arms':'Arms changed successfully while retaining the scene.',
 'pipeline-arms-42':'Arms moved, but the background became transparent/colored; not a satisfactory overall edit.',
 'pipeline-arms-210923':'Arms moved, but the background became white with unwanted text; not a satisfactory overall edit.',
 'pipeline-knee':'The edited ankle remained near its original position.',
 'pipeline-knee-42':'The edited ankle remained near its original position.',
 'pipeline-knee-210923':'The edited ankle remained near its original position.',
 'pipeline-raised':'A third leg was added; a low keypoint error must not be treated as success.',
 'pipeline-raised-42':'A third leg was added.',
 'pipeline-raised-210923':'A third leg was added and the background was replaced with white and unwanted text.',
 'detailed-edited-42':'Old legs remained alongside a ghosted new leg.',
 'detailed-edited-210923':'Old legs remained with ghosted anatomy and changed background/lighting.',
 'turbo-raised':'A third leg was added, reproducing the base-workflow failure.',
 'square-edit':'The second subject successfully raised both arms.',
 'multi-targeted-edit':'The intended man changed pose, but fitting into the half-canvas selection shrank him substantially.',
 'portrait-create':'Broad default pose followed on a portrait canvas; hand positions remained approximate.',
 'male-leg-1470188345':'Extra leg and background/style corruption.',
 'male-leg-42':'Successful broad leg movement with two legs and the studio background retained.',
 'two-stage-0':'Pose remained, but the requested appearance was not restored and image quality degraded.',
 'two-stage-0.8':'Control did not repair the appearance-transfer failure; pose remained with the wrong outfit and degraded image quality.',
 'visual-arms-1470188345':'Original pose retained.',
 'visual-arms-42':'Arms followed the guide, but the background became transparent/colored.',
 'visual-arms-210923':'Arms followed the guide, but the background became white.',
 'visual-knee-1470188345':'Small knee edit ignored.',
 'visual-knee-42':'Small knee edit ignored.',
 'visual-knee-210923':'Knee edit followed, but the background became white.',
 'visual-raised-1470188345':'Extra leg added.',
 'visual-raised-42':'Extra leg and background/transparency changes.',
};
for(const file of await readdir(dir)){
 if(!file.endsWith('.json'))continue;
 const r=await read(file);if(!r.label||!r.pose)continue;
 const request=await read(r.label+'-request.json');
 const name=r.label.replace(/^(visual-|pipeline-)/,'').replace(/-\d+$/,'');
 const target=r.target||(r.label.endsWith('original')?guides.original.data:scenarios[name]?.data||guides.edited.data);
 const expected=target.people[0].pose_keypoints_2d;
 const e=r.score.errors?.[0];
 const visible=Array.from({length:18},(_,i)=>i).filter(i=>expected[i*3+2]>0);
 const missing=visible.filter(i=>!e?.joints.some(j=>j.i===i));
 const original=guides.original.data;
 const changed=visible.filter(i=>Math.hypot(expected[i*3]/target.canvas_width-original.people[0].pose_keypoints_2d[i*3]/original.canvas_width,expected[i*3+1]/target.canvas_height-original.people[0].pose_keypoints_2d[i*3+1]/original.canvas_height)>.005);
 const measured=(e?.joints||[]).filter(j=>changed.includes(j.i));
 cases.push({label:r.label,promptId:r.prompt_id,seed:request.prompt['10'].inputs.seed,
  strength:request.prompt.ps_structure_apply.inputs.strength,prompt:request.prompt['4'].inputs.prompt,
  body:e?.body,legs:e?.legs,arms:e?.arms,changedMean:measured.length?measured.reduce((v,j)=>v+j.error,0)/measured.length:null,
  missing:r.score.visualOnly?[]:missing,people:r.score.people,changed,visualOnly:!!r.score.visualOnly,observation:observations[r.label]||''});
}
cases.sort((a,b)=>a.label.localeCompare(b.label));
await writeFile(resolve(dir,'summary.json'),JSON.stringify({generatedAt:new Date().toISOString(),count:cases.length,cases},null,2));
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const pct=n=>n==null?'—':(n*100).toFixed(2)+'%';
const cards=cases.map(c=>`<article id="${esc(c.label)}"><h2>${esc(c.label)}</h2>
${c.observation?`<p class="note">${esc(c.observation)}</p>`:''}
<div class="pair"><figure><img loading="lazy" src="${esc(c.label)}-actual-guide.png"><figcaption>Submitted control map</figcaption></figure><figure><a href="${esc(c.label)}.png"><img loading="lazy" src="${esc(c.label)}.png"></a><figcaption>Generated result · click for full resolution</figcaption></figure></div>
<p>Seed ${c.seed} · control strength ${c.strength} · detected people ${c.people}</p>
<p>${c.visualOnly?'Visual review only; no target keypoint score.':`Mean joint error: body ${pct(c.body)}, legs ${pct(c.legs)}, arms ${pct(c.arms)}. Changed joints: ${pct(c.changedMean)}. Missing body joints: ${c.missing.length?c.missing.join(', '):'none'}.`}</p>
<details><summary>Exact instruction and execution evidence</summary><p>${esc(c.prompt)}</p><p>Prompt ID: ${esc(c.promptId)}</p><a href="${esc(c.label)}-request.json">Executable graph</a> · <a href="${esc(c.label)}.json">Detected joints</a> · <a href="${esc(c.label)}-detected.png">Detected skeleton</a></details></article>`).join('\n');
await writeFile(resolve(dir,'report.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pose comparison evidence</title><style>body{background:#151719;color:#e8eaec;font:16px/1.5 system-ui;margin:0 auto;max-width:1300px;padding:32px}h1{font-size:32px}h2{font-size:20px}a{color:#92d6c0}article{border:1px solid #394045;border-radius:14px;padding:20px;margin:24px 0;background:#202428}.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}figure{margin:0}img{width:100%;background:repeating-conic-gradient(#444 0% 25%,#666 0% 50%) 50%/18px 18px}figcaption{color:#bac1c6;font-size:13px}summary{cursor:pointer}details p{white-space:pre-wrap}.note{padding:18px;border-left:4px solid #d2aa62;background:#292724}select{padding:10px;background:#202428;color:inherit;border:1px solid #596169;border-radius:8px}p{max-width:100ch}@media(max-width:700px){body{padding:16px}.pair{grid-template-columns:1fr}}</style><h1>Pose comparison evidence</h1><p>${cases.length} completed renders. Exact graphs and instructions accompany each result. These trials evaluate alternatives; they do not change application defaults.</p><p class="note">Small joint error is not a pass: duplicated limbs, missing joints, altered clothing and replaced backgrounds can still produce a good detection score. Distances use normalized canvas coordinates, not a percentage of anatomical accuracy. Changed-joint measurements compare with the original test source. New-image cases do not test identity or scene preservation.</p><p><a href="../pose-leg-debug/source.webp">Original edit source</a> · <a href="summary.json">Machine-readable results</a> · <a href="environment.json">Runtime details</a></p><label>Jump to comparison <select onchange="location.hash=this.value"><option value="">Choose…</option>${cases.map(c=>`<option>${esc(c.label)}</option>`).join('')}</select></label>${cards}</html>`);
console.log(JSON.stringify({renders:cases.length,report:resolve(dir,'report.html')}));
const path=resolve(dir,'report.html');
const findings=`<section class="note"><h2>Decision</h2><p>A generic “apply this pose” instruction is not a validated replacement for the current edit prompt builder. The guide reaches ControlNet correctly, but preserving the source image can overpower the new geometry. Leg changes can succeed with one seed and produce extra limbs with another.</p><p>Keep scene prompts and edit instructions separate. Further work should improve small-joint descriptions and subject-scale alignment, and evaluate a dedicated pose-transfer workflow against both pose and appearance checks. Neither stronger control, visual guide references, tested inpainting variants nor the two-step appearance-restoration experiment has established a reliable general fallback.</p><p>The editor/graph checks passed independently: 23 JavaScript checks; 24 Python checks with the guide suite isolated from another suite's torch mock; four browser suites covering pose editing, rotation, queue wiring and shared Video inputs. No Linux or exhaustive model-quality claim is made. Application defaults were not changed by these experiments.</p><p>Upstream references: <a href="https://huggingface.co/alibaba-pai/Qwen-Image-2.1-Fun-Controlnet-Union/blob/main/README.md">ControlNet model card</a>; <a href="https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_qwen.py">native source-image encoding</a>.</p></section>`;
await writeFile(path,(await readFile(path,'utf8')).replace('<h1>Pose comparison evidence</h1>','<h1>Pose comparison evidence</h1>'+findings));
