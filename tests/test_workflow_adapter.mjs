import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {videoTestOptions} from './integration-mode.mjs';
import {createHash} from 'node:crypto';
import {sha256Fallback} from '../web/js/prompt-studio/generation/sha256.js';
import {createWorkflowAdapter, workflowCacheIdentity, workflowResultOutputs, discoverWorkflowFiles} from '../web/js/prompt-studio/generation/workflow-adapter.js';
import {serializedWorkflowNodes, PROMPT_STUDIO_INPUT_TYPE} from '../web/js/prompt-studio/generation/prompt-studio-input.js';
import {createWorkflowTemplateBuilder} from '../web/js/prompt-studio/generation/workflow-template.js';

class Events extends EventTarget {dispatch(name,detail){this.dispatchEvent(new CustomEvent(name,{detail}));}}
class Graph {
  constructor(){this.events=new Events();this.subgraphs=new Map();this._nodes=[];}
  configure(data){
    this.data=data;
    for(const def of data.definitions?.subgraphs||[]) this.events.dispatch('subgraph-created',{subgraph:def,data:def});
    this._nodes=data.nodes.map(node=>({...node,constructor:globalThis.LiteGraph.registered_node_types[node.type]||{},isSubgraphNode:()=>true}));
    return [];
  }
  getNodeById(id){return this._nodes.find(node=>String(node.id)===String(id));}
  clear(){this._nodes=[];this.cleared=true;}
}
function setup(){
  class Output {}
  Output.nodeData={output_node:true,input:{required:{images:['IMAGE']}}};
  globalThis.LiteGraph={registered_node_types:{RenamedImageOutput:Output}};
  const root=new Graph();root.openSentinel={keep:true};
  root.events.addEventListener('subgraph-created',event=>{
    root.subgraphs.set(event.detail.data.id,event.detail.subgraph);
    globalThis.LiteGraph.registered_node_types[event.detail.data.id]=class Temporary {};
  });
  let conversions=0, active=0, maximum=0;
  const app={graph:root,rootGraph:root,registerExtension(){throw Error('conversion registered extension');},
    async graphToPrompt(graph){
      assert.notEqual(graph,root);conversions++;active++;maximum=Math.max(maximum,active);
      await new Promise(resolve=>setTimeout(resolve,2));active--;
      if(graph.data.fail) throw Error('conversion failed');
      return {workflow:structuredClone(graph.data),output:structuredClone(graph.data.executable),extra:{keep:'envelope'}};
    }};
  return {app,root,get conversions(){return conversions;},get maximum(){return maximum;}};
}
const file={path:'workflows/[PS] Nested.json',modified:1};
function nested(){return {nodes:[{id:30,type:'outer'}],definitions:{subgraphs:[
  {id:'outer',nodes:[{id:10,type:'inner'}]},
  {id:'inner',nodes:[{id:1,type:'KCPP_PromptSlot',title:'Renamed prompt'},
    {id:2,type:'RenamedImageOutput',title:'My delivery'},
    {id:3,type:'KCPP_PromptStudioLoraLoader'},{id:4,type:'KCPP_PromptStudioModelLoader'}]},
]},executable:{'30:10:1':{class_type:'KCPP_PromptSlot',inputs:{prompt:'saved prompt'}},
  '30:10:2':{class_type:'RenamedImageOutput',inputs:{images:['30:10:1',0]}},
  '30:10:3':{class_type:'KCPP_PromptStudioLoraLoader',inputs:{lora_type:'Style'}},
  '30:10:4':{class_type:'KCPP_PromptStudioModelLoader',inputs:{model_type:'Base',unet_name:'model.safetensors'}}}};}

test('Image nested IDs, renamed nodes and model/LoRA descriptors preserve the full envelope',async()=>{
  const env=setup();const workflow=nested();const before=structuredClone(workflow);
  const build=createWorkflowTemplateBuilder({app:env.app,nodeClassName:node=>node.type}).buildWorkflowTemplate;
  const result=await build(file,workflow);
  assert.equal(result.promptNodeId,'30:10:1');assert.deepEqual(result.resultNodeIds,['30:10:2']);
  assert.equal(result.modelNodes[0].id,'30:10:4');assert.equal(result.loraNodes[0].loraType,'Style');
  assert.deepEqual(result.snapshot.workflow,before);assert.deepEqual(result.snapshot.extra,{keep:'envelope'});
  assert.deepEqual(workflow,before);assert.deepEqual(env.root.openSentinel,{keep:true});
  assert.equal(env.root.subgraphs.size,0);assert.equal(globalThis.LiteGraph.registered_node_types.outer,undefined);
  const replay=await build(file,workflow,result);replay.snapshot.output['30:10:1'].inputs.prompt='changed';
  assert.equal(result.snapshot.output['30:10:1'].inputs.prompt,'saved prompt');assert.equal(env.conversions,1);
});

test('cache invalidates same-mtime content, schema and adapter capabilities; stale caches rebuild',async()=>{
  const env=setup(),workflow=nested();
  const make=version=>createWorkflowAdapter({app:env.app,adapterId:'image',adapterVersion:version,capabilities:{outputRule:version},build:({snapshot})=>({snapshot})});
  let result=await make(1)(file,workflow);await make(1)(file,workflow,result);assert.equal(env.conversions,1);
  workflow.nodes[0].title='renamed';result=await make(1)(file,workflow,result);assert.equal(env.conversions,2);
  globalThis.LiteGraph.registered_node_types.RenamedImageOutput.nodeData.changed=true;
  result=await make(1)(file,workflow,result);assert.equal(env.conversions,3);
  result=await make(2)(file,workflow,result);assert.equal(env.conversions,4);
  await make(2)(file,workflow,{...result,stale:true});assert.equal(env.conversions,5);
  const legacy={...result};delete legacy.cacheIdentity;await make(2)(file,workflow,legacy);assert.equal(env.conversions,6);
});

test('temporary subgraphs restore after errors and Image/Video conversion serializes',async()=>{
  const env=setup(),original={id:'outer',asSerialisable:()=>({id:'outer'})};
  class Existing{};env.root.subgraphs.set('outer',original);globalThis.LiteGraph.registered_node_types.outer=Existing;
  const image=createWorkflowAdapter({app:env.app,adapterId:'image',build:({snapshot})=>({snapshot})});
  const video=createWorkflowAdapter({app:env.app,adapterId:'minimax_h3',build:({snapshot})=>({snapshot})});
  await assert.rejects(image(file,{...nested(),fail:true}),/conversion failed/);
  assert.equal(env.root.subgraphs.get('outer'),original);assert.equal(globalThis.LiteGraph.registered_node_types.outer,Existing);
  await Promise.all([image(file,nested()),video(file,nested())]);assert.equal(env.maximum,1);
  assert.equal(env.root.subgraphs.get('outer'),original);assert.equal(globalThis.LiteGraph.registered_node_types.outer,Existing);
});

test('Video retains native Director/SaveVideo rules with flattened IDs',videoTestOptions,async()=>{
  const shared = new URL('../web/js/prompt-studio/generation/workflow-adapter.js', import.meta.url).href;
  const videoSource = readFileSync(new URL('../../PromptStudio_Video/web/js/workflow-adapter.js',import.meta.url),'utf8').replaceAll('/extensions/ComfyUI_PromptStudio/js/prompt-studio/generation/workflow-adapter.js',shared);
  const {createVideoWorkflowTemplateBuilder} = await import(`data:text/javascript;base64,${Buffer.from(videoSource).toString('base64')}`);
  const env=setup();const workflow=nested();workflow.definitions.subgraphs[1].nodes=[{id:1,type:'PSV_MiniMaxH3Director'},{id:2,type:'SaveVideo'}];
  workflow.executable={'30:10:1':{class_type:'PSV_MiniMaxH3Director',inputs:{}},'30:10:2':{class_type:'SaveVideo',inputs:{}}};
  const build=createVideoWorkflowTemplateBuilder({app:env.app});const result=await build(file,workflow);
  assert.equal(result.director_node_id,'30:10:1');assert.deepEqual(result.result_node_ids,['30:10:2']);
  assert.deepEqual(result.additionalInputs,[]);assert.equal(result.cacheIdentity.adapterId,'minimax_h3');
  workflow.executable['30:10:2'].class_type='ThirdPartyVideoCombine';await assert.rejects(build(file,workflow),/native Save Video/);
});

test('ambiguous or recursive serialized node IDs reject instead of silently targeting another node',()=>{
  assert.throws(()=>serializedWorkflowNodes({nodes:[{id:1},{id:1}]}),/duplicate/i);
  assert.throws(()=>serializedWorkflowNodes({nodes:[{id:1,type:'loop'}],definitions:{subgraphs:[{id:'loop',nodes:[{id:2,type:'loop'}]}]}}),/recursive/i);
  assert.throws(()=>serializedWorkflowNodes({nodes:[],definitions:{subgraphs:[{id:'a'},{id:'a'}]}}),/duplicate/i);
});

test('both adapters expose identical nested configurable inputs across repeated subgraph instances',async()=>{
  const env=setup(),workflow=nested();
  class Sampler{};Sampler.nodeData={input:{required:{steps:['INT',{min:1,max:100,step:1}]}}};
  globalThis.LiteGraph.registered_node_types.Sampler=Sampler;
  const definition=workflow.definitions.subgraphs[1];
  definition.nodes.push({id:7,type:PROMPT_STUDIO_INPUT_TYPE,title:'Render steps',outputs:[{links:[99]}]},
    {id:8,type:'Sampler',inputs:[{name:'steps',widget:{name:'steps'}}]});
  definition.links=[[99,7,0,8,0,'INT']];
  workflow.nodes.push({id:31,type:'outer'});
  workflow.executable['30:10:8']={class_type:'Sampler',inputs:{steps:24}};
  workflow.executable['31:10:8']={class_type:'Sampler',inputs:{steps:12}};
  // Repeated groups may share a definition while keeping independent input IDs.
  const make=adapterId=>createWorkflowAdapter({app:env.app,adapterId,build:({snapshot,additionalInputs})=>({snapshot,additionalInputs})});
  const image=await make('image')(file,workflow),video=await make('minimax_h3')(file,workflow);
  assert.deepEqual(image.additionalInputs,video.additionalInputs);
  assert.deepEqual(image.additionalInputs.map(input=>[input.id,input.targetNodeId,input.defaultValue]),
    [['30:10:7','30:10:8',24],['31:10:7','31:10:8',12]]);
});

test('discovery and result extraction normalize paths, deduplicate and isolate returned output metadata',()=>{
  assert.deepEqual(discoverWorkflowFiles([{path:'workflows\\[PS] Z.JSON'},{path:'x.json'},{path:5}], '[PS]').map(file=>file.path),['workflows/[PS] Z.JSON']);
  const output={filename:'a.png',type:'output',extra:{value:1}};
  const history={outputs:{'30:2':{images:[output],gifs:[output]},other:{images:[{filename:'other.png'}]}}};
  const results=workflowResultOutputs(history,['30:2'],['images','gifs']);assert.equal(results.length,1);
  results[0].extra.value=2;assert.equal(output.extra.value,1);
  const legacy={outputs:{one:{images:output},two:{videos:[{filename:'b.mp4'}]},three:{text:'ignore'}}};
  assert.deepEqual(workflowResultOutputs(legacy,[],[]).map(item=>item.filename),['a.png','b.mp4']);
});

test('SHA256 fallback matches standard vectors and works without secure-context crypto.subtle',async()=>{
  for(const value of ['', 'abc', 'A'.repeat(55), 'A'.repeat(56), 'A'.repeat(64), 'é'.repeat(1000)]) {
    const bytes=new TextEncoder().encode(value);
    assert.equal(sha256Fallback(bytes),createHash('sha256').update(bytes).digest('hex'));
  }
  const workflow=nested();const secure=await workflowCacheIdentity(workflow,{adapterId:'image'});
  const original=Object.getOwnPropertyDescriptor(globalThis,'crypto');
  try {
    Object.defineProperty(globalThis,'crypto',{configurable:true,value:{}});
    assert.deepEqual(await workflowCacheIdentity(workflow,{adapterId:'image'}),secure);
  } finally {Object.defineProperty(globalThis,'crypto',original);}
});
