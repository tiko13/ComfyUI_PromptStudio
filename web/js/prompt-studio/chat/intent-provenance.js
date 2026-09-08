export const IMAGE_INTENT_VERSION = 1;
const SOURCES=new Set(['user','known_reference','style','framing','secondary','embellishment','manual_final']);
const KINDS=new Set(['visible_text','name','dialogue','literal']);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&Boolean(value.trim());

/** Missing/unsupported legacy metadata stays explicit; never derive Main from Final. */
export function normalizeIntentProvenance(value) {
  const revision=value?.revision??0;
  if(!object(value)||value.version!==IMAGE_INTENT_VERSION||!Number.isInteger(revision)||revision<0)return null;
  const result={version:IMAGE_INTENT_VERSION,revision,last_turn_id:String(value.last_turn_id||''),locked_literals:[],exclusions:[],source_tags:[],suppressed_sources:[],edit_scope:null,manual_final:null};
  for(const key of ['locked_literals','exclusions','source_tags']) {
    const list=value[key]??[];if(!Array.isArray(list)||list.length>128)return null;
    const ids=new Set();
    for(const record of list) {
      if(!object(record)||!text(record.id)||record.id.length>256||ids.has(record.id)||!text(record.text)||record.text.length>8192)return null;
      ids.add(record.id);
      if(key==='source_tags') {if(!SOURCES.has(record.source))return null;}
      else {
        if(!object(record.evidence)||record.evidence.source!=='user'||!text(record.evidence.quote)||record.evidence.quote.length>8192||!text(record.evidence.turn_id)||record.evidence.turn_id.length>256)return null;
        if(key==='locked_literals'&&!KINDS.has(record.kind))return null;
        const aliases=record.aliases??[];if(!Array.isArray(aliases)||aliases.length>16||aliases.some(alias=>!text(alias)||alias.length>512))return null;
      }
      result[key].push(structuredClone(record));
    }
  }
  const suppressed=value.suppressed_sources??[];
  if(!Array.isArray(suppressed)||suppressed.length>128||suppressed.some(item=>!object(item)||!SOURCES.has(item.source)||['user','manual_final'].includes(item.source)||typeof item.source_id!=='string'))return null;
  result.suppressed_sources=structuredClone(suppressed);
  if(value.edit_scope!=null) {
    const scope=value.edit_scope;
    if(!object(scope)||!['create','local','global','final_only'].includes(scope.kind)||!Array.isArray(scope.targets)||scope.targets.length>128||scope.targets.some(target=>!text(target)))return null;
    const spans=scope.spans??[];if(!Array.isArray(spans)||spans.length>128)return null;
    for(const span of spans)if(!object(span)||!['main','final'].includes(span.stage)||!scope.targets.includes(span.target)||typeof span.text!=='string'||!Number.isInteger(span.start)||!Number.isInteger(span.end)||span.start<0||span.end<span.start)return null;
    result.edit_scope=structuredClone(scope);
  }
  if(value.manual_final!=null) {
    if(!object(value.manual_final)||typeof value.manual_final.text!=='string')return null;
    result.manual_final=structuredClone(value.manual_final);
  }
  return result;
}

export function promptIntentVersion(mainPrompt,finalPrompt,intentProvenance=null) {
  return {mainPrompt:String(mainPrompt||''),finalPrompt:String(finalPrompt||''),intentProvenance:normalizeIntentProvenance(intentProvenance)};
}

export function restorePromptIntentVersion(value) {
  return promptIntentVersion(value?.mainPrompt,value?.finalPrompt,value?.intentProvenance);
}

/** Manual text is preserved as entered; it does not retroactively become Main. */
export function recordManualFinal(intentProvenance,finalPrompt) {
  const intent=normalizeIntentProvenance(intentProvenance)||{version:1,revision:0,last_turn_id:'',locked_literals:[],exclusions:[],source_tags:[],suppressed_sources:[],edit_scope:null,manual_final:null};
  intent.manual_final={source:'manual_final',text:String(finalPrompt??'')};
  return intent;
}

/** Replay reads the stored executable envelope without rebuilding prompts. */
export function intentReplayRecord(generation) {
  if(!object(generation))return null;
  return structuredClone(generation);
}

/** Request-local draft: callers publish it only when their entire prompt pair succeeds. */
export function createIntentSession(intentProvenance,{userText='',turnId,mainPrompt='',finalPrompt=''}={}) {
  let current=normalizeIntentProvenance(intentProvenance);
  if(!text(turnId))throw new TypeError('An image intent turn needs a stable ID');
  return {
    payload(value) {return {...value,intent_tracking:true,intent_provenance:structuredClone(current),intent_turn_id:turnId,intent_user_text:String(userText),current_main_prompt:String(mainPrompt),current_final_prompt:String(finalPrompt)};},
    accept(response) {
      // Missing metadata from an older server keeps the current sidecar intact.
      if(response?.intent_provenance!=null) {
        const next=normalizeIntentProvenance(response.intent_provenance);
        if(!next)throw new TypeError('The server returned invalid image intent metadata');
        current=next;
      }
    },
    snapshot() {return structuredClone(current);},
  };
}

export function effectiveSecondaryInstructions(intentProvenance,value) {
  const intent=normalizeIntentProvenance(intentProvenance);
  return intent?.suppressed_sources.some(item=>item.source_id==='secondary_instructions')?'':String(value??'');
}
