import assert from 'node:assert/strict';
import test from 'node:test';
import {reconcileKeyedHistory,forgetKeyedHistory} from '../web/js/prompt-studio/ui/keyed-history.js';

class Node {
  constructor(text='') {this.text=text;this.childNodes=[];this.parentNode=null;this.scrollTop=0;}
  get children(){return this.childNodes;}
  get firstChild(){return this.childNodes[0]||null;}
  get nextSibling(){return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this)+1]||null;}
  querySelectorAll(){return [];}
  insertBefore(node,cursor){
    assert.ok(cursor===null||cursor.parentNode===this,'Insertion cursor must belong to this history');
    node.remove();const index=cursor?this.childNodes.indexOf(cursor):this.childNodes.length;
    this.childNodes.splice(index,0,node);node.parentNode=this;
  }
  remove(){if(this.parentNode){this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this),1);this.parentNode=null;}}
}
const options={namespace:'session',preserveViewport:false,create:item=>new Node(item.text),update:(node,item)=>{node.text=item.text;return node;}};

test('500-message update scans IDs but constructs/patches only one changed view',()=>{
  const history=new Node(),messages=Array.from({length:500},(_,i)=>({id:`m${i}`,text:`Message ${i}`}));
  assert.equal(reconcileKeyedHistory(history,messages,options).created,500);
  const nodes=[...history.children];
  messages[499].text='Pending response completed';
  assert.deepEqual(reconcileKeyedHistory(history,messages,options),{examined:500,created:0,updated:1,retained:499,removed:0,moved:0});
  assert.deepEqual(history.children,nodes);
  assert.equal(history.children[499].text,'Pending response completed');
  assert.equal(reconcileKeyedHistory(history,messages,options).updated,0);
});

test('deletion/reorder retain unchanged identities and exact message order',()=>{
  const history=new Node(),messages=['a','b','c'].map(id=>({id,text:id}));
  reconcileKeyedHistory(history,messages,options);const [a,b,c]=history.children;
  const changes=reconcileKeyedHistory(history,[messages[2],messages[0]],options);
  assert.deepEqual(history.children,[c,a]);assert.equal(b.parentNode,null);assert.equal(changes.removed,1);
  assert.equal(changes.created,0);assert.equal(changes.updated,0);
});

test('duplicate/missing IDs fail before touching DOM or the cache',()=>{
  const history=new Node();reconcileKeyedHistory(history,[{id:'a',text:'A'}],options);const a=history.firstChild;
  assert.throws(()=>reconcileKeyedHistory(history,[{id:'x'},{id:'x'}],options),/unique/);
  assert.throws(()=>reconcileKeyedHistory(history,[{text:'Missing ID'}],options),/unique/);
  assert.equal(history.firstChild,a);
});

test('session switch and explicit reset never reuse controls from another session',()=>{
  const history=new Node(),messages=[{id:'same',text:'First'}];
  reconcileKeyedHistory(history,messages,options);const a=history.firstChild;
  reconcileKeyedHistory(history,messages,{...options,namespace:'other'});assert.notEqual(history.firstChild,a);
  const b=history.firstChild;forgetKeyedHistory(history);reconcileKeyedHistory(history,messages,options);
  assert.notEqual(history.firstChild,b);assert.equal(history.children.length,1);
});

test('appended records and foreign placeholders reconcile without rebuilding retained cards',()=>{
  const history=new Node(),messages=[{id:'a',text:'A'}];
  reconcileKeyedHistory(history,messages,options);const a=history.firstChild;
  const placeholder=new Node('Loading');history.insertBefore(placeholder,null);
  const counts=reconcileKeyedHistory(history,[...messages,{id:'b',text:'B'}],options);
  assert.equal(history.firstChild,a);assert.equal(counts.created,1);assert.equal(counts.removed,1);
  assert.deepEqual(history.children.map(node=>node.text),['A','B']);
});
