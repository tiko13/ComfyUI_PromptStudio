import assert from 'node:assert/strict';
import {startFixture} from './fixture.mjs';

const fixture = await startFixture();
try {
  const page = await fixture.newPage();
  const result = await page.evaluate(async () => {
    const {createWorkflowAdapter} = await import('/extensions/ComfyUI_PromptStudio/js/prompt-studio/generation/workflow-adapter.js');
    const {createVideoWorkflowTemplateBuilder} = await import('/extensions/PromptStudio_Video/js/workflow-adapter.js');
    class Events extends EventTarget {dispatch(name,detail){this.dispatchEvent(new CustomEvent(name,{detail}));}}
    class Graph {
      constructor(){this.events=new Events();this.subgraphs=new Map();this._nodes=[];}
      configure(data){this.data=data;this._nodes=data.nodes.map(node=>({...node,isSubgraphNode:()=>true}));
        for(const definition of data.definitions.subgraphs)this.events.dispatch('subgraph-created',{data:definition,subgraph:definition});return [];}
      clear(){this._nodes=[];}
    }
    const graph=new Graph(), original={id:'nested',asSerialisable:()=>({id:'nested'})};
    graph.subgraphs.set('nested',original);graph.selection=['user-selected-node'];
    globalThis.LiteGraph ||= {registered_node_types:{}};
    class Original{};const registry=globalThis.LiteGraph.registered_node_types;
    registry.nested=Original;
    graph.events.addEventListener('subgraph-created',event=>{graph.subgraphs.set(event.detail.data.id,event.detail.subgraph);registry[event.detail.data.id]=class Temporary{};});
    let active=0,maximum=0,conversions=0;
    const app={graph,rootGraph:graph,registerExtension(){throw Error('Unexpected registration');},async graphToPrompt(privateGraph){
      if(privateGraph===graph)throw Error('Native graph used');active++;conversions++;maximum=Math.max(maximum,active);
      await new Promise(resolve=>setTimeout(resolve,5));active--;
      return {workflow:structuredClone(privateGraph.data),output:{'5:1':{class_type:'PSV_MiniMaxH3Director',inputs:{}},'5:2':{class_type:'SaveVideo',inputs:{}}},metadata:{keep:true}};
    }};
    const data={nodes:[{id:5,type:'nested'}],definitions:{subgraphs:[{id:'nested',nodes:[{id:1,type:'PSV_MiniMaxH3Director'},{id:2,type:'SaveVideo'}]}]}};
    const image=createWorkflowAdapter({app,adapterId:'image',build:({snapshot})=>({snapshot})});
    const video=createVideoWorkflowTemplateBuilder({app});
    const file={path:'workflows/[PSV] nested.json',modified:1};
    const [saved]=await Promise.all([video(file,data),image(file,data)]);
    const replay=await video(file,data,saved);replay.snapshot.metadata.keep=false;
    const unchanged=conversions;
    data.nodes[0].title='Renamed';await video(file,data,saved);
    return {maximum,unchanged,conversions,restored:graph.subgraphs.get('nested')===original&&registry.nested===Original,
      selection:graph.selection,metadata:saved.snapshot.metadata.keep,director:saved.director_node_id,
      openGraphSame:app.graph===graph,resultIds:saved.result_node_ids};
  });
  assert.deepEqual(result,{maximum:1,unchanged:2,conversions:3,restored:true,selection:['user-selected-node'],metadata:true,director:'5:1',openGraphSame:true,resultIds:['5:2']});
  assert.deepEqual(fixture.errors,[]);
  console.log('Workflow browser adapter isolation, cache/replay and cross-studio conversion passed.');
} finally {await fixture.close();}
