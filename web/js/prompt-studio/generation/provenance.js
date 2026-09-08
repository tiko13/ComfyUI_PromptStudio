import {sha256} from './sha256.js';

export const PROVENANCE_VERSION = 1;
// Only these top-level fields are transport/capture metadata. Executable inputs
// and the complete saved workflow envelope always participate in the hashes.
const EPHEMERAL_SNAPSHOT_FIELDS = new Set(['provenance', 'transport']);
const HASH = /^[0-9a-f]{64}$/;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
const hash = value => sha256(new TextEncoder().encode(JSON.stringify(canonical(value))));
function snapshotPayload(snapshot) {
  if (!snapshot?.output || typeof snapshot.output !== 'object' || Array.isArray(snapshot.output)) throw new Error('Saved executable snapshot is unavailable.');
  return Object.fromEntries(Object.entries(snapshot).filter(([key])=>!EPHEMERAL_SNAPSHOT_FIELDS.has(key)));
}

export function resolvedSnapshotSeeds(snapshot) {
  const seeds=[];
  for(const [nodeId,node] of Object.entries(snapshot?.output||{})) for(const [input,value] of Object.entries(node?.inputs||{})) {
    if (!/^(seed|noise_seed)$/i.test(input)) continue;
    if ((typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && /^\d+$/.test(value))) seeds.push({node_id:nodeId,input,value});
  }
  return seeds;
}

function safeAsset(value) {
  const result={};
  for(const key of ['node_id','input','category','name','status','hash_state','size','metadata_token','sha256']) {
    if(value?.[key] !== undefined) result[key]=structuredClone(value[key]);
  }
  return result;
}

export function normalizeProvenance(value) {
  if(value?.version!==PROVENANCE_VERSION || !HASH.test(value.snapshotHash) || !HASH.test(value.executableHash)) return null;
  return {
    version:PROVENANCE_VERSION,snapshotHash:value.snapshotHash,executableHash:value.executableHash,
    capturedAt:Number(value.capturedAt)||0,runtimeAvailable:value.runtimeAvailable===true,
    versions:structuredClone(value.versions||{}),assets:Array.isArray(value.assets)?value.assets.map(safeAsset):[],
    resolvedSeeds:Array.isArray(value.resolvedSeeds)?structuredClone(value.resolvedSeeds):[],
    lineage:structuredClone(value.lineage||{}),
  };
}

/** Capture only after all seed/control/prompt changes; never modify snapshot. */
export async function captureProvenance(snapshot,{runtime=null,versions={},lineage={}}={}) {
  const payload=snapshotPayload(snapshot);
  return {
    version:PROVENANCE_VERSION,snapshotHash:await hash(payload),executableHash:await hash(payload.output),
    capturedAt:Date.now(),runtimeAvailable:runtime?.version===1,
    versions:{...structuredClone(versions),...structuredClone(runtime?.versions||{})},
    assets:Array.isArray(runtime?.assets)?runtime.assets.map(safeAsset):[],
    resolvedSeeds:resolvedSnapshotSeeds(snapshot),lineage:structuredClone(lineage),
  };
}

/** This only reports drift. The caller chooses Cancel or replay saved inputs. */
export async function compareReplayProvenance(saved,snapshot,options={}) {
  saved=normalizeProvenance(saved);
  if(!saved) return {status:'metadata_unavailable',warnings:[{code:'metadata_unavailable',message:'This older generation has no reproducibility metadata. Its saved inputs can still be replayed.'}]};
  const current=await captureProvenance(snapshot,options),warnings=[];
  const warn=(code,message,extra={})=>warnings.push({code,message,...extra});
  if(saved.executableHash!==current.executableHash) warn('executable_changed','The saved executable inputs changed. Restore the original snapshot to replay its inputs exactly.');
  else if(saved.snapshotHash!==current.snapshotHash) warn('snapshot_changed','The saved workflow envelope changed while executable inputs stayed the same.');
  for(const key of new Set([...Object.keys(saved.versions),...Object.keys(current.versions)])) {
    if(saved.versions[key]!==current.versions[key]) warn('version_changed',`${key} changed from ${saved.versions[key]??'unavailable'} to ${current.versions[key]??'unavailable'}. Restore that version or continue with the current runtime.`,{dependency:key});
  }
  const assetKey=asset=>JSON.stringify([asset.node_id,asset.input,asset.category,asset.name]);
  const available=new Map(current.assets.map(asset=>[assetKey(asset),asset]));
  for(const old of saved.assets) {
    const now=available.get(assetKey(old));available.delete(assetKey(old));
    const label=`${old.category||'Asset'} '${old.name}'`;
    if(!now || now.status!=='available') warn('asset_unavailable',`${label} is missing or cannot be identified. Restore the saved dependency or choose another generation.`,{asset:old.name});
    else if(old.status!=='available') warn('asset_metadata_unavailable',`${label} had no identity recorded for the original generation.`,{asset:old.name});
    else if(old.sha256 && now.sha256 ? old.sha256!==now.sha256 : old.metadata_token!==now.metadata_token) {
      warn('asset_changed',`${label} was replaced or changed at the same filename. Restore the original file or replay with the replacement.`,{asset:old.name});
    }
  }
  for(const added of available.values()) warn('asset_added',`The runtime now resolves an additional dependency: ${added.category} '${added.name}'.`,{asset:added.name});
  if(!saved.runtimeAvailable || !current.runtimeAvailable) warn('runtime_metadata_unavailable','Runtime dependency metadata could not be captured. Saved executable inputs remain replayable.');
  const metadataOnly=warnings.every(item=>item.code.includes('metadata_unavailable'));
  return {status:warnings.length?(metadataOnly?'metadata_unavailable':'drift'):'unchanged',warnings,
    identityAssurance:saved.assets.every(old=>old.sha256&&current.assets.find(now=>assetKey(old)===assetKey(now))?.sha256)?'content':'filesystem_metadata'};
}

/** Clone for queueing; warnings and transport calls must never mutate history. */
export function replaySnapshot(snapshot) {
  snapshotPayload(snapshot);
  return structuredClone(snapshot);
}

const absolutePath = value => /^[A-Za-z]:[\\/]|^[\\/]{2}|^\/|^file:\/\//i.test(value);
const authoredTextKey = /^(prompt|mainPrompt|canonicalPrompt|executionPrompt|main_description|compiled_prompt|text|content|brief|finalPrompt)$/;
/** Export a separate clone. Relative model names remain useful for replay. */
export function exportGenerationProvenance(generation) {
  const redactedPaths=[];
  const visit=(value,path=[],key='')=>{
    if(Array.isArray(value))return value.map((item,index)=>visit(item,[...path,index],key));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,visit(item,[...path,name],name)]));
    if(typeof value==='string'&&['lora_stack_json','document_json'].includes(key)) {
      try { return JSON.stringify(visit(JSON.parse(value),path,key)); } catch { return value; }
    }
    if(typeof value==='string'&&absolutePath(value)&&!authoredTextKey.test(key)) {
      redactedPaths.push(path.join('.'));return value.replaceAll('\\','/').split('/').filter(Boolean).at(-1)||'[private path]';
    }
    return value;
  };
  const result=visit(generation);
  if(result&&typeof result==='object')result.exportMetadata={version:1,privatePathsRedacted:redactedPaths};
  return result;
}
