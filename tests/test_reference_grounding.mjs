import assert from 'node:assert/strict';
import {test} from 'node:test';
import {referenceContextMatches, normalizeReferenceGrounding} from '../web/js/prompt-studio/generation/reference-grounding.js';
import {normalizePendingGeneration} from '../web/js/prompt-studio/chat/generation-state.js';

const sourceImage={filename:'base.png',type:'output',subfolder:''};
const referenceImage={filename:'reference.png',type:'promptstudio',subfolder:'imports'};
test('analyzed edits are bound to both images, independently of loaded dimension metadata',()=>{
  const saved={sourceImage,referenceImage};
  assert.equal(referenceContextMatches(saved,{sourceImage:{...sourceImage,width:1024,height:1024},referenceImage}),true);
  assert.equal(referenceContextMatches(saved,{sourceImage:{...sourceImage,filename:'different.png'},referenceImage}),false);
  assert.equal(referenceContextMatches(saved,{sourceImage,referenceImage:{...referenceImage,filename:'new.png'}}),false);
  assert.equal(referenceContextMatches(saved,{sourceImage,referenceImage:null}),false);
  assert.equal(referenceContextMatches(saved,null),false);
});
test('reference provenance is copied, persisted, and rejects incomplete analysis',()=>{
  const grounding={observations:'Green mug.',resolved_instruction:'Add a green mug next to the blue mug.',edit_instruction:'Add the mug from image 2 beside the blue mug in image 1.',uncertainty:'',needs_clarification:false,sourceImage,referenceImage,userText:'Place this mug next to the blue one.'};
  const saved=normalizePendingGeneration({action:'edit',referenceGrounding:grounding,sourceImage,referenceImage});
  grounding.sourceImage.filename='mutated.png';
  assert.equal(saved.referenceGrounding.sourceImage.filename,'base.png');
  assert.equal(saved.referenceGrounding.userText,'Place this mug next to the blue one.');
  assert.equal(normalizeReferenceGrounding({...grounding,needs_clarification:true}),null);
  assert.equal(normalizeReferenceGrounding({...grounding,observations:''}),null);
});
