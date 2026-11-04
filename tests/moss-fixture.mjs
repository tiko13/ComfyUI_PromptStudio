import {readFileSync} from 'node:fs';
import {createWorkflowTemplateBuilder} from '../web/js/prompt-studio/generation/workflow-template.js';

export const mossCatalog = JSON.parse(readFileSync(new URL('../setup/catalog.json',import.meta.url))).packs.filter(p=>p.family==='MOSS Image');
export const mossWorkflow = pack => JSON.parse(readFileSync(new URL('../setup/workflows/'+pack.file,import.meta.url)));

export async function mossProfile(pack) {
 const workflow=mossWorkflow(pack), registry={}, previous=globalThis.LiteGraph;
 for(const node of workflow.nodes) {
  class Node {}
  Node.nodeData={output_node:['Save_as_webp_cond','CreateBoundingBoxes'].includes(node.type),input:{required:{}}};
  for(const input of node.inputs||[])Node.nodeData.input.required[input.name]=[input.type,{min:0,max:100}];
  registry[node.type]=Node;
 }
 class Graph {
  configure(data){this.data=data;this._nodes=data.nodes.map(n=>({...n,constructor:registry[n.type]}));this.links=Object.fromEntries(data.links.map(l=>[l[0],{target_id:l[3],target_slot:l[4]}]));return [];}
  getNodeById(id){return this._nodes.find(n=>String(n.id)===String(id));}
  clear(){}
 }
 const app={graph:new Graph(),async graphToPrompt(graph){
  const output={};
  for(const node of graph.data.nodes.filter(n=>!['MarkdownNote','PromptStudioInput'].includes(n.type))){
   const inputs={...node.widgets_values_named};
   for(const socket of node.inputs||[])if(socket.link!=null){
    const link=graph.data.links.find(l=>l[0]===socket.link),source=graph.getNodeById(link[1]);
    inputs[socket.name]=source.type==='PromptStudioInput'?source.widgets_values[0]:[String(link[1]),link[2]];
   }
   output[String(node.id)]={class_type:node.type,inputs};
  }
  return {workflow:graph.data,output};
 }};
 globalThis.LiteGraph={registered_node_types:registry};
 try{return await createWorkflowTemplateBuilder({app,nodeClassName:n=>n.type}).buildWorkflowTemplate({path:pack.file,modified:1},workflow);}
 finally{globalThis.LiteGraph=previous;}
}
