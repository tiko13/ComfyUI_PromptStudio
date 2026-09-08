import {api} from '/scripts/api.js';
import {captureProvenance,compareReplayProvenance} from '../generation/provenance.js';
import {installDialogFocus} from './dialog-focus.js';

async function runtimeMetadata(snapshot,product) {
  try {
    const response=await api.fetchApi('/promptstudio/prompt-studio/provenance',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({snapshot,product}),signal:AbortSignal.timeout(5000),
    });
    if(!response.ok)return null;
    const result=await response.json();return result.version===1?result:null;
  } catch (_) { return null; }
}

export async function captureRuntimeProvenance(snapshot,product,lineage={}) {
  return captureProvenance(snapshot,{runtime:await runtimeMetadata(snapshot,product),lineage});
}

export async function reviewReplay(container,snapshot,provenance,product) {
  const comparison=await compareReplayProvenance(provenance,snapshot,{runtime:await runtimeMetadata(snapshot,product)});
  if(comparison.status==='unchanged')return true;
  const doc=container.ownerDocument;
  const dialog=doc.createElement('dialog');
  dialog.className=product==='video'?'psvstudio-replay-review':'promptstudio-replay-review';
  dialog.setAttribute('aria-label','Review saved replay');
  installDialogFocus(dialog);
  const heading=doc.createElement('h2');heading.textContent=comparison.status==='drift'?'Replay dependencies changed':'Replay metadata unavailable';
  const list=doc.createElement('ul');
  for(const warning of comparison.warnings) {const item=doc.createElement('li');item.textContent=warning.message;list.append(item);}
  const hint=doc.createElement('p');hint.textContent='Replay uses the saved prompts, workflow and seeds. Current controls do not replace them.';
  dialog.append(heading,list,hint);
  const proceed=await new Promise(resolve=>{
    for(const [label,value] of [['Cancel',false],['Replay saved inputs',true]]) {
      const button=doc.createElement('button');button.type='button';button.textContent=label;
      button.addEventListener('click',()=>{resolve(value);dialog.close();});dialog.append(button);
    }
    dialog.addEventListener('cancel',()=>resolve(false),{once:true});
    container.append(dialog);dialog.showModal();
  });
  dialog.remove();return proceed;
}
