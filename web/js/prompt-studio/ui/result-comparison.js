import {exportGenerationProvenance, resolvedSnapshotSeeds} from '../generation/provenance.js';
import {snapshotForPlotCell, pairedLoraAxis, plotControlOverridesForCell} from '../plot/model.js';
import {installDialogFocus} from './dialog-focus.js';

const clone = value => structuredClone(value);
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function controls(value) {
  if (typeof value !== 'string') return value || {};
  try {return JSON.parse(value);} catch {return value ? {recordedFingerprint:value} : {};}
}
function record(value) {
  const copy = clone(value);
  copy.seeds = resolvedSnapshotSeeds(copy.snapshot);
  return freeze(copy);
}

/** Adapters read saved records only; never read active UI controls or normalize in place. */
export function imageComparisonRecord(saved) {
  const finalOrigin = saved.generationSnapshot?.promptStudioInspection?.finalOrigin;
  const manualFinal = saved.intentProvenance?.manual_final?.text === saved.canonicalPrompt;
  const derivedFinal = saved.intentProvenance?.source_tags?.some(tag => ['style','framing','secondary','embellishment'].includes(tag.source));
  return record({id:String(saved.id),label:saved.label || saved.workflowName || String(saved.id),product:'image',
    main:String(saved.mainPrompt ?? ''),final:String(saved.canonicalPrompt ?? ''),execution:String(saved.executionPrompt ?? saved.canonicalPrompt ?? ''),
    finalOrigin:manualFinal || finalOrigin === 'manual' || saved.finalPromptManuallyEdited === true ? 'Manual Final edit'
      : derivedFinal || finalOrigin === 'controls' || saved.finalPromptManuallyEdited === false ? 'Control-derived Final' : 'Final origin not recorded',
    settings:{controls:controls(saved.controlsFingerprint),models:saved.modelState || [],loras:saved.loraState || []},
    restoreUnavailable:saved.generationAction === 'upscale' ? 'Upscale results can be inspected and exported. Use the existing upscale controls for another upscale.' : '',
    snapshot:saved.generationSnapshot || null,provenance:saved.provenance || saved.generationSnapshot?.provenance || null,
    media:(saved.images || []).map(reference=>({kind:'image',reference})),saved});
}

export function videoComparisonRecord(saved) {
  return record({id:String(saved.id || saved.prompt_id),label:saved.workflow_name || String(saved.id),product:'video',
    main:String(saved.document?.main_description ?? ''),final:String(saved.compiled_prompt ?? ''),execution:String(saved.compiled_prompt ?? ''),
    finalOrigin:saved.document?.prompt_override ? 'Authored prompt override' : 'Compiled from saved video document',
    settings:{document:saved.document || {},mode:saved.resolved_mode},snapshot:saved.workflow_snapshot || null,
    provenance:saved.provenance || saved.workflow_snapshot?.provenance || null,
    lineage:{parent:saved.parent_generation_id || '',root:saved.root_generation_id || '',depth:saved.depth || 0},
    timing:{authoredSeconds:saved.document?.duration_seconds ?? null,effectiveSeconds:saved.effective_duration ?? null,
      cumulativeSeconds:saved.total_effective_duration ?? null,frames:saved.frame_count ?? null},
    media:(saved.outputs || []).map(reference=>({kind:'video',reference})),saved});
}

export function plotComparisonRecord(plot, cell) {
  const snapshot = snapshotForPlotCell(plot, cell);
  const axes = plot.axes.map((axis,index)=>({axis:axis.name,label:axis.label,type:axis.type,
    value:axis.values[cell.coordinate[index]]?.value,labelValue:axis.values[cell.coordinate[index]]?.label,
    targetNode:axis.targetNodeId,targetName:axis.targetName,
    pairedAxis:axis.type === 'lora_strength' ? pairedLoraAxis(plot.axes,axis)?.name || null : null}));
  const saved = {id:cell.id,mainPrompt:cell.mainPrompt ?? plot.base.mainPrompt,canonicalPrompt:cell.finalPrompt ?? plot.base.finalPrompt,
    executionPrompt:cell.finalPrompt ?? plot.base.finalPrompt,generationAction:plot.action || 'create',
    workflowProfileId:plot.workflowProfileId,workflowName:plot.workflowName,llmAmplified:plot.llmEnabled === true,
    controlsFingerprint:JSON.stringify({...plot.controlSettings,...plotControlOverridesForCell(plot,cell)}),
    loraState:(plot.base.loraState || []).map(loader=>({...loader,
      selections:JSON.parse(snapshot.output?.[loader.nodeId]?.inputs?.lora_stack_json || JSON.stringify(loader.selections || []))})),
    modelState:(plot.base.modelState || []).map(loader=>({...loader,
      modelName:snapshot.output?.[loader.nodeId]?.inputs?.unet_name ?? loader.modelName})),
    generationSnapshot:snapshot,provenance:cell.provenance,images:cell.images || [],axisOverrides:axes,
    plotId:plot.id,cellId:cell.id,resultNodeIds:plot.base.resultNodeIds,resultFields:plot.base.resultFields};
  return record({...imageComparisonRecord(saved),label:axes.map(axis=>`${axis.label}: ${axis.labelValue ?? ''}`).join(' · '),
    finalOrigin:'Saved plot prompt',settings:{axisOverrides:axes,controls:plotControlOverridesForCell(plot,cell)},saved});
}

/** Lossless tokens retain tags, whitespace and punctuation; no prompt reformatting. */
export function diffPrompt(before, after) {
  const tokenize = value => String(value ?? '').match(/<[^>]*>|\s+|[^<\s]+|</g) || [];
  const a=tokenize(before),b=tokenize(after),result=[];
  const add=(kind,text)=>{if(!text)return;const last=result.at(-1);if(last?.kind===kind)last.text+=text;else result.push({kind,text});};
  let prefix=0;while(prefix<a.length&&prefix<b.length&&a[prefix]===b[prefix])prefix++;
  let endA=a.length,endB=b.length;while(endA>prefix&&endB>prefix&&a[endA-1]===b[endB-1]){endA--;endB--;}
  add('equal',a.slice(0,prefix).join(''));
  const left=a.slice(prefix,endA),right=b.slice(prefix,endB);
  if(left.length*right.length>250000) {add('removed',left.join(''));add('added',right.join(''));}
  else {
    const width=right.length+1,table=new Uint32Array((left.length+1)*width);
    for(let i=left.length-1;i>=0;i--)for(let j=right.length-1;j>=0;j--)
      table[i*width+j]=left[i]===right[j]?1+table[(i+1)*width+j+1]:Math.max(table[(i+1)*width+j],table[i*width+j+1]);
    let i=0,j=0;
    while(i<left.length||j<right.length) {
      if(i<left.length&&j<right.length&&left[i]===right[j]){add('equal',left[i++]);j++;}
      else if(i<left.length&&(j===right.length||table[(i+1)*width+j]>=table[i*width+j+1]))add('removed',left[i++]);
      else add('added',right[j++]);
    }
  }
  add('equal',a.slice(endA).join(''));return result;
}

export function diffSavedInputs(before, after, path='') {
  if(JSON.stringify(before)===JSON.stringify(after))return [];
  if(before&&after&&typeof before==='object'&&typeof after==='object'&&Array.isArray(before)===Array.isArray(after)) {
    return [...new Set([...Object.keys(before),...Object.keys(after)])].sort().flatMap(key=>
      diffSavedInputs(before[key],after[key],`${path}/${key.replaceAll('~','~0').replaceAll('/','~1')}`));
  }
  return [{path:path||'/',before:clone(before),after:clone(after)}];
}

/** This surface owns its dialog only. Restoring is an explicit injected action. */
export function createResultComparison({container,getItems,onRestore,restoreLabel='Restore candidate inputs',mediaUrl=reference=>reference.url || '',onExport=null}) {
  let dialog=null;
  const dispose=()=>{const current=dialog;dialog=null;if(current){current.close();current.remove();}};
  function open(candidateId,trigger=null) {
    dispose();
    const items=getItems().map(item=>record(item));
    if(!items.length)return null;
    const doc=container.ownerDocument;
    if(!doc.querySelector('link[data-result-comparison]')) {
      const link=doc.createElement('link');link.rel='stylesheet';link.dataset.resultComparison='';
      link.href=new URL('../../../css/result-comparison.css',import.meta.url).href;doc.head.append(link);
    }
    dialog=doc.createElement('dialog');const current=dialog;
    current.className='ps-result-comparison';current.setAttribute('aria-label','Compare saved results');
    installDialogFocus(current);
    const element=(tag,text='',className='')=>{const node=doc.createElement(tag);node.textContent=text;if(className)node.className=className;return node;};
    const button=(label,run)=>{const node=element('button',label);node.type='button';node.addEventListener('click',run);return node;};
    const title=element('h2','Compare saved results');
    const close=button('Close',dispose);const header=element('header');header.append(title,close);
    const hint=element('p','Inspect saved inputs. Selecting results does not change current settings.');
    const selectors=element('div','','ps-comparison-toolbar');
    const selectedIndex=Math.max(0,items.findIndex(item=>item.id===String(candidateId)));
    const select=(name,index)=>{
      const label=element('label',`${name} `),control=element('select');control.setAttribute('aria-label',name);
      items.forEach((item,i)=>{const option=element('option',`${item.label} · ${item.id}`);option.value=String(i);control.append(option);});
      control.value=String(index);label.append(control);selectors.append(label);return control;
    };
    const baseline=select('Baseline',selectedIndex>0?selectedIndex-1:Math.min(1,items.length-1));
    const candidate=select('Candidate',selectedIndex);
    const media=element('div','','ps-comparison-media');
    const views=element('div','','ps-comparison-toolbar');
    const zoom=element('input');zoom.type='range';zoom.min='1';zoom.max='4';zoom.step='.25';zoom.value='1';zoom.setAttribute('aria-label','Linked image zoom');
    const zoomLabel=element('label','Linked zoom ');zoomLabel.append(zoom);
    const fallback=element('input');fallback.type='checkbox';fallback.setAttribute('aria-label','Unzoomed side-by-side view');
    const fallbackLabel=element('label','Unzoomed side-by-side view ');fallbackLabel.append(fallback);
    const zoomStatus=element('output','100%');zoomStatus.setAttribute('aria-live','polite');
    views.append(zoomLabel,zoomStatus,fallbackLabel);
    const pan={x:0,y:0};let surfaces=[];
    const applyView=()=>{
      const scale=fallback.checked?1:Number(zoom.value);zoom.disabled=fallback.checked;
      zoomStatus.textContent=`${Math.round(scale*100)}%`;
      for(const surface of surfaces) {
        surface.querySelector('img,video')?.style.setProperty('transform',`translate(${fallback.checked?0:pan.x}px,${fallback.checked?0:pan.y}px) scale(${scale})`);
      }
    };
    const reset=button('Reset view',()=>{zoom.value='1';pan.x=0;pan.y=0;applyView();});views.append(reset);
    zoom.addEventListener('input',applyView);fallback.addEventListener('change',applyView);
    const detail=element('div','','ps-comparison-differences');
    const status=element('p');status.setAttribute('role','status');
    const restore=button(restoreLabel,async()=>{
      restore.disabled=true;baseline.disabled=true;candidate.disabled=true;
      try {await onRestore(clone(items[Number(candidate.value)]));status.textContent='Saved inputs restored. Generation has not been started.';}
      catch(error){status.textContent=error.message||'Inputs could not be restored.';}
      finally{restore.disabled=!onRestore||!items[Number(candidate.value)].snapshot?.output||Boolean(items[Number(candidate.value)].restoreUnavailable);baseline.disabled=false;candidate.disabled=false;}
    });restore.disabled=!onRestore;
    const exportButton=button('Export saved comparison',()=>{
      const exported=exportGenerationProvenance({baseline:items[Number(baseline.value)].saved,candidate:items[Number(candidate.value)].saved});
      if(onExport){onExport(exported);return;}
      const url=URL.createObjectURL(new Blob([JSON.stringify(exported,null,2)],{type:'application/json'}));
      const link=element('a');link.href=url;link.download='prompt-studio-comparison.json';link.click();
      doc.defaultView.setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
    const actions=element('footer');actions.append(restore,exportButton);
    function render() {
      const a=items[Number(baseline.value)],b=items[Number(candidate.value)];
      restore.disabled=!onRestore||!b.snapshot?.output||Boolean(b.restoreUnavailable);
      status.textContent=b.restoreUnavailable || (b.snapshot?.output?'':'This result has no saved executable inputs to restore.');
      media.replaceChildren();detail.replaceChildren();surfaces=[];
      for(const [label,item] of [['Baseline',a],['Candidate',b]]) {
        const column=element('section');column.append(element('h3',`${label} · ${item.label}`));
        const seeds=item.seeds.map(seed=>`${seed.node_id}.${seed.input} = ${seed.value}`).join(' · ');
        column.append(element('p',seeds?`Saved seeds: ${seeds}`:'Saved seed unavailable'));
        const parameters=[];
        for(const [id,node] of Object.entries(item.snapshot?.output || {}))for(const [name,value] of Object.entries(node.inputs || {})) {
          if(/^(unet_name|ckpt_name|model_name|lora_stack_json|sampler_name|scheduler|cfg|steps|width|height)$/.test(name))
            parameters.push(`${id}.${name} = ${typeof value==='string'?value:JSON.stringify(value)}`);
        }
        if(parameters.length)column.append(element('p',`Saved settings: ${parameters.join(' · ')}`));
        if(item.lineage)column.append(element('p',`Lineage: parent ${item.lineage.parent||'none'} · root ${item.lineage.root||item.id} · depth ${item.lineage.depth}`));
        if(item.timing)column.append(element('p',`Authored ${item.timing.authoredSeconds??'unknown'}s · effective ${item.timing.effectiveSeconds??'unknown'}s · cumulative ${item.timing.cumulativeSeconds??'unknown'}s · ${item.timing.frames??'unknown'} frames`));
        const surface=element('div','','ps-comparison-surface');surface.tabIndex=0;
        surface.setAttribute('aria-label',`${label} media. Arrow keys pan linked images; Home resets view.`);
        const output=item.media[0];
        if(output) {
          const node=element(output.kind==='video'?'video':'img');node.src=mediaUrl(output.reference,item);
          if(output.kind==='video'){node.controls=true;node.preload='metadata';}
          else {node.alt=`${label}: ${item.label}`;node.loading='lazy';node.decoding='async';node.draggable=false;}
          surface.append(node);
        } else surface.append(element('p','No saved media for this result.'));
        surface.addEventListener('keydown',event=>{
          if(fallback.checked||event.target!==surface)return;
          const step=event.shiftKey?80:20;
          const delta={ArrowLeft:[step,0],ArrowRight:[-step,0],ArrowUp:[0,step],ArrowDown:[0,-step]}[event.key];
          if(delta){event.preventDefault();pan.x+=delta[0];pan.y+=delta[1];applyView();}
          else if(event.key==='Home'){event.preventDefault();reset.click();}
        });
        let drag=null;
        surface.addEventListener('pointerdown',event=>{
          if(fallback.checked||event.target.tagName!=='IMG'||event.button!==0)return;
          drag={x:event.clientX,y:event.clientY};surface.setPointerCapture(event.pointerId);event.preventDefault();
        });
        surface.addEventListener('pointermove',event=>{if(!drag)return;pan.x+=event.clientX-drag.x;pan.y+=event.clientY-drag.y;drag={x:event.clientX,y:event.clientY};applyView();});
        for(const type of ['pointerup','pointercancel','lostpointercapture'])surface.addEventListener(type,()=>{drag=null;});
        surfaces.push(surface);column.append(surface,element('p',item.finalOrigin));media.append(column);
      }
      for(const [title,key] of [['Main prompt','main'],['Final prompt','final'],['Workflow execution prompt','execution']]) {
        const section=element('section');section.append(element('h3',title));
        const text=element('pre','','ps-comparison-prompt');
        for(const part of diffPrompt(a[key],b[key])) {
          const span=element(part.kind==='added'?'ins':part.kind==='removed'?'del':'span',part.text);
          if(part.kind!=='equal')span.setAttribute('aria-label',part.kind==='added'?'Added text':'Removed text');text.append(span);
        }
        if(a[key]===b[key])section.append(element('small','Unchanged'));
        section.append(text);detail.append(section);
      }
      for(const [title,before,after] of [['Saved controls and settings',a.settings,b.settings],['Executable workflow inputs',a.snapshot?.output,b.snapshot?.output]]) {
        const section=element('section');section.append(element('h3',title));
        const changes=diffSavedInputs(before,after);
        if(!changes.length)section.append(element('p','Unchanged'));
        else {
          const table=element('table');const heading=element('tr');
          for(const value of ['Input','Baseline','Candidate']){const th=element('th',value);th.scope='col';heading.append(th);}const thead=element('thead');thead.append(heading);table.append(thead);
          const body=element('tbody');for(const change of changes){const row=element('tr');for(const value of [change.path,change.before===undefined?'(absent)':JSON.stringify(change.before),change.after===undefined?'(absent)':JSON.stringify(change.after)])row.append(element('td',value));body.append(row);}table.append(body);section.append(table);
        }
        detail.append(section);
      }
      const advanced=element('details');advanced.append(element('summary','Full saved inputs'));
      const exact=element('pre',JSON.stringify({baseline:{main:a.main,final:a.final,settings:a.settings,snapshot:a.snapshot},candidate:{main:b.main,final:b.final,settings:b.settings,snapshot:b.snapshot}},null,2));
      advanced.append(exact);detail.append(advanced);applyView();
    }
    baseline.addEventListener('change',render);candidate.addEventListener('change',render);
    current.append(header,hint,selectors,views,media,detail,actions,status);
    current.addEventListener('close',()=>{const target=typeof trigger==='function'?trigger():trigger;if(target?.isConnected)target.focus({preventScroll:true});current.remove();if(dialog===current)dialog=null;},{once:true});
    container.append(current);render();current.showModal();baseline.focus();return current;
  }
  return {open,dispose};
}
