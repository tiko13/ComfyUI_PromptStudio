import {createFeatureController} from './feature-controller.js';

// Width plus input capability also covers large iPads using desktop-size views.
export const COMPACT_COMPOSER_QUERY = '(min-width: 781px) and (orientation: landscape) and (max-width: 1400px), (min-width: 781px) and (orientation: landscape) and (any-pointer: coarse)';

export function createCompactComposer({panel: getPanel}) {
  return createFeatureController({mount(doc, scope) {
    const panel=getPanel(), view=doc.defaultView;
    const options=panel?.querySelector('.promptstudio-compose-options');
    if(!options)return;
    const input=panel.querySelector('#promptstudio-revision'), summary=options.querySelector('summary');
    const extras=doc.createElement('div');extras.className='promptstudio-compose-extras';options.append(extras);
    const nodes=['#promptstudio-undo','#promptstudio-stop','#promptstudio-reroll','#promptstudio-run-summary'].map(selector=>panel.querySelector(selector));
    const slots=nodes.map(node=>{const slot=doc.createComment('composer control position');node.before(slot);return slot;});
    const previousQuery=options.getAttribute('data-studio-disclosure-query');
    options.dataset.studioDisclosureQuery=`(max-width: 780px), (max-width: 900px) and (max-height: 600px), ${COMPACT_COMPOSER_QUERY}`;
    let compact=false, oldHeight='';
    const size=()=>{
      if(!compact)return;
      input.style.height='44px';
      if(doc.activeElement===input)input.style.height=`${Math.min(112,Math.max(44,input.scrollHeight+2))}px`;
    };
    const setCompact=next=>{
      if(next===compact)return;
      const focused=doc.activeElement, movingFocus=nodes.some(node=>node.contains(focused));
      compact=next;
      panel.toggleAttribute('data-compact-composer',compact);
      if(compact){
        oldHeight=input.style.height;
        nodes.forEach(node=>extras.append(node));
        summary.textContent='More';options.dataset.studioMenu='';options.open=movingFocus;
        size();
      }else{
        nodes.forEach((node,i)=>slots[i].after(node));
        summary.textContent='Options';delete options.dataset.studioMenu;
        input.style.height=oldHeight;
      }
      if(movingFocus)focused.focus({preventScroll:true});
    };
    const sync=()=>{setCompact(view.matchMedia(COMPACT_COMPOSER_QUERY).matches);size();};
    scope.listen(view,'resize',sync);
    scope.listen(input,'input',size);scope.listen(input,'focus',size);scope.listen(input,'blur',size);
    scope.own(()=>{
      setCompact(false);slots.forEach(slot=>slot.remove());extras.remove();
      if(previousQuery===null)options.removeAttribute('data-studio-disclosure-query');
      else options.setAttribute('data-studio-disclosure-query',previousQuery);
    });
    sync();
  }});
}
