import {installDialogFocus} from './dialog-focus.js';
import {normalizeIntentProvenance,addPromptConstraint,deletePromptConstraint} from '../chat/intent-provenance.js';

export function openPromptConstraints({ownerDocument=document,intentProvenance,onSave,makeId}) {
  let draft=normalizeIntentProvenance(intentProvenance);
  const make=(tag,text)=>{const el=ownerDocument.createElement(tag);if(text)el.textContent=text;return el;};
  const dialog=make('dialog');dialog.className='promptstudio-constraints-dialog';
  dialog.setAttribute('aria-label','Constraints');
  const title=make('h2','Constraints');
  const hint=make('p','Constraints belong to this chat. Style and framing adapt to them on each rebuild. Changes apply when you save; prompt text stays unchanged until the next revision or rebuild.');
  const list=make('ul');list.className='promptstudio-constraints-list';
  const form=make('form');form.className='promptstudio-constraint-form';
  const typeLabel=make('label','Constraint type');
  const type=make('select');type.setAttribute('aria-label','Constraint type');
  for(const [value,label] of [['exclude','Exclude detail'],['literal','Preserve exact text']]) {
    const option=make('option',label);option.value=value;type.append(option);
  }
  typeLabel.append(type);
  const textLabel=make('label','Constraint text');
  const input=make('textarea');input.rows=2;input.maxLength=8192;input.required=true;
  input.setAttribute('aria-label','Constraint text');input.placeholder='The detail to exclude, or the exact text to preserve';
  textLabel.append(input);
  const add=make('button','Add constraint');add.type='submit';
  form.append(typeLabel,textLabel,add);
  const status=make('p');status.setAttribute('role','status');
  const actions=make('div');actions.className='promptstudio-constraint-actions';
  const cancel=make('button','Cancel');cancel.type='button';
  const save=make('button','Save');save.type='button';save.className='promptstudio-primary';save.disabled=true;
  actions.append(cancel,save);
  const render=()=>{
    list.replaceChildren();
    const entries=[...(draft?.exclusions||[]).map(item=>({item,type:'exclude'})),...(draft?.locked_literals||[]).map(item=>({item,type:'literal'}))];
    if(!entries.length)list.append(make('li','No saved constraints.'));
    for(const {item,type} of entries) {
      const row=make('li');const content=make('div');
      content.append(make('strong',type==='exclude'?'Exclude detail':'Preserve exact text'),make('p',item.text));
      if(item.aliases?.length)content.append(make('small',`Also matches: ${item.aliases.join(', ')}`));
      const remove=make('button','Delete');remove.type='button';remove.setAttribute('aria-label',`Delete constraint: ${item.text}`);
      remove.addEventListener('click',()=>{
        draft=deletePromptConstraint(draft,{type,id:item.id});save.disabled=false;render();
        status.textContent='Constraint removed from draft. Save to apply, or Cancel to keep it.';
        (list.querySelector('button')||input).focus();
      });
      row.append(content,remove);list.append(row);
    }
  };
  form.addEventListener('submit',event=>{
    event.preventDefault();
    try {
      draft=addPromptConstraint(draft,{type:type.value,value:input.value,id:makeId()});
      input.value='';save.disabled=false;render();status.textContent='Constraint added to draft. Save to apply.';input.focus();
    } catch(error) {status.textContent=error.message;}
  });
  save.addEventListener('click',()=>{
    if(input.value.trim()){status.textContent='Add the typed constraint or clear it before saving.';input.focus();return;}
    try {onSave(draft);dialog.close();} catch(error) {status.textContent=error.message;}
  });
  cancel.addEventListener('click',()=>dialog.close());
  dialog.append(title,hint,list,form,status,actions);
  installDialogFocus(dialog);dialog.addEventListener('close',()=>dialog.remove());
  ownerDocument.body.append(dialog);render();dialog.showModal();
  return dialog;
}
