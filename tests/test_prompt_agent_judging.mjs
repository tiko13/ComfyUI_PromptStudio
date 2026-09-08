import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalizePromptAgentEvaluation,normalizeConsultAgent,rankPromptAgentIterations,repeatedPromptAgentDefects,explainPromptAgentWinner} from '../web/js/prompt-studio/consult/model.js';
const iteration=(id,score,pass=false)=>({id,index:Number(id.replace(/\D/g,''))||1,evaluation:{score,pass,confidence:.9,defects:[]}});

test('stable candidate identity breaks exact ties independent of displayed order',()=>{
 const values=[iteration('c2',90),iteration('c1',90),iteration('c3',80,true)];
 const before=JSON.stringify(values);
 assert.deepEqual(rankPromptAgentIterations(values).map(item=>item.id),['c3','c1','c2']);
 assert.deepEqual(rankPromptAgentIterations([...values].reverse()).map(item=>item.id),['c3','c1','c2']);
 assert.equal(JSON.stringify(values),before);
 assert.match(explainPromptAgentWinner(values),/passed the required visual checks/);
 assert.match(explainPromptAgentWinner(values.slice(0,2)),/stable candidate ID/);
});

test('repeated confirmed defects stop only after three normal candidate assessments',()=>{
 const values=[1,2,3].map(index=>({...iteration(`c${index}`,50+index*5),evaluation:{...iteration('',50).evaluation,defects:[index===1?'Detached handle':'detached handle']}}));
 assert.deepEqual(repeatedPromptAgentDefects(values),['Detached handle']);
 assert.deepEqual(repeatedPromptAgentDefects(values.slice(0,2)),[]);
 assert.deepEqual(repeatedPromptAgentDefects(values.map((item,index)=>({...item,validation:index===2}))),[]);
});

test('pixel evidence, cost measurements and opt-in survive normalizing a saved agent',()=>{
 const raw={score:80,confidence:.8,pass:false,criteria:[{id:'face',status:'partial',score:80,evidence:'Candidate cheek visible',reference_evidence:'Reference cheek differs'}],metrics:{version:1,model_calls:2,elapsed_ms:1200,reference_comparison:true,calibration_measured:false},reference_comparison:{attached_pixels:true}};
 const normalized=normalizePromptAgentEvaluation(raw);
 assert.equal(normalized.criteria[0].referenceEvidence,'Reference cheek differs');
 assert.equal(normalized.metrics.model_calls,2);
 const agent=normalizeConsultAgent({id:'a',goal:'Match the face',referenceComparison:true,phaseMetrics:[{...raw.metrics,requestId:'req1',phase:'evaluate'}],iterations:[{id:'i',evaluation:raw}]});
 assert.equal(agent.referenceComparison,true);assert.equal(agent.phaseMetrics[0].elapsed_ms,1200);
 assert.equal(normalizeConsultAgent({goal:'Old run'}).referenceComparison,false);
 assert.equal(normalizePromptAgentEvaluation({...raw,metrics:{version:1,model_calls:Infinity,elapsed_ms:1}}).metrics,null);
});
