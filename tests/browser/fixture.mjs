// Actual application modules, isolated host and storage, no live runtime.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
export const root = resolve(import.meta.dirname, '../..');
const video = resolve(root, '../PromptStudio_Video');
const apiSource = `export const api = Object.assign(new EventTarget(), {
 fetchApi: (url, options) => fetch(url, options), apiURL: p => p,
 getQueue: async () => ({queue_running: [], queue_pending: []}),
 getHistory: async () => ({}), getNodeDefs: async () => ({})});`;
const appSource = `export const extensions = [];
export const app = {registerExtension: x => extensions.push(x),
 graph: {_nodes: [], links: {}, serialize: () => ({nodes: [], links: []})},
 canvas: {setDirty() {}}, extensionManager: {setting: {get: () => null}},
 ui: {settings: {getSettingValue: () => null}}, graphToPrompt: async () => ({workflow: {}, output: {}})};`;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/extensions/PromptStudio_Video/css/promptstudio_video_studio.css"></head><body class="promptstudio-popout-body">
<main id="promptstudio-popout-mount" class="promptstudio-popout-mount"><section id="promptstudio-image-mount" class="promptstudio-studio-view" data-studio-mode="image"><div class="promptstudio-popout-loading"><strong>Prompt Studio</strong><span>Connecting to ComfyUI…</span></div></section><section id="promptstudio-video-mount" class="promptstudio-studio-view" data-studio-mode="video" hidden></section></main>
<script type="module">
import {extensions} from '/scripts/app.js';
try {
 await import('/extensions/ComfyUI_PromptStudio/js/prompt_studio.js');
 await import('/extensions/PromptStudio_Video/js/promptstudio_video_studio.js');
 for (const extension of extensions) await extension.setup();
 await window.__promptstudioPromptStudioHost.attach(window);
 window.studioReady = true;
} catch (error) {window.bootError = error.stack;}
</script></body></html>`;
export const config = {profiles: ['Default'], styles: ['None'], framings: ['None'],
 embellishment_levels: ['None'], known_references: [], additional_instruction_templates: [],
 task_modes: ['t2v'], defaults: {}, capabilities: {}, camera_types: ['Static Shot'],
 default_document: {version:1,mode:'auto',duration_seconds:5,width:1344,height:768,target_megapixels:1.032192,canvas_reference_id:'',ref_image_size:'match',main_description:'',prompt_override:'',style:'Live-action, cinematic',shots:[{id:'shot-1',start:0,transition:'the camera cuts to',composition:'A medium-wide shot establishes the scene.',subjects:'',environment:'',lighting:'',camera:{type:'Static Shot',amplitude:'default',speed:'default',target:''},steps:[],visible_text:[],sounds:[],sound_cues:[],audio_clips:[],notes:''}],references:[],overall_soundscape:'',non_diegetic_music:'N/A',complete_silence:false,task_types:[],subject_definitions:[],summary:'',retention_analysis:[],resolved_mode:'t2va'}};

export async function startFixture() {
let chats = {revision: 1, chats: [], activeChatId: null, deletedChatIds: []};
let projects = {revision: 1, projects: [], activeProjectId: null, deletedProjectIds: []};
const requests = [];
const server = createServer(async (req, res) => {
 try {
  const path = new URL(req.url, 'http://fixture').pathname;
  const requestRecord = {path, method: req.method};
  requests.push(requestRecord);
  if (path === '/') {res.setHeader('Content-Type', 'text/html'); return res.end(html);}
  if (path === '/scripts/api.js' || path === '/scripts/app.js') {
   res.setHeader('Content-Type', 'text/javascript'); return res.end(path.includes('api.js') ? apiSource : appSource);
  }
  for (const [prefix, dir] of [['/extensions/ComfyUI_PromptStudio/', root], ['/extensions/PromptStudio_Video/', video]]) {
   if (!path.startsWith(prefix)) continue;
   const target = resolve(dir, 'web', path.slice(prefix.length));
   assert.ok(target.startsWith(resolve(dir, 'web') + sep));
   res.setHeader('Content-Type', {'.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.html':'text/html', '.json':'application/json'}[extname(target)] || 'application/octet-stream');
   return res.end(await readFile(target));
  }
  let body = '';
  for await (const chunk of req) {body += chunk; if (body.length > 2_000_000) throw new Error('Fixture request too large');}
  const input = body ? JSON.parse(body) : {};
  requestRecord.bytes = Buffer.byteLength(body);
  if (input.projects) requestRecord.projectIds = input.projects.map(project=>project.id);
  if (input.chats) requestRecord.chatIds = input.chats.map(chat=>chat.id);
  const mergeRecords = (before, updates, deleted=[]) => [...new Map([...before,...updates].map(record=>[record.id,record])).values()].filter(record=>!deleted.includes(record.id));
  let data = {};
  if (path.endsWith('/chats')) {
   if (['POST','PUT'].includes(req.method)) chats = {...chats, ...input, chats:input.partial ? mergeRecords(chats.chats,input.chats||[],input.deletedChatIds) : input.chats, revision: chats.revision + 1};
   data = {...chats, total: chats.chats.length, hasMore: false};
  } else if (path.endsWith('/projects')) {
   if (req.method === 'PUT' && input.revision !== projects.revision) {
    res.statusCode = 409; res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({error:'Projects changed in another browser.'}));
   }
   if (req.method === 'PUT') projects = {...projects, ...input, projects:input.partial ? mergeRecords(projects.projects,input.projects||[],input.deletedProjectIds) : input.projects, revision: projects.revision + 1};
   data = projects;
   const query = new URL(req.url,'http://fixture').searchParams;
   if (req.method === 'GET' && query.has('limit')) {
    let ordered=[...projects.projects].sort((a,b)=>b.updated_at-a.updated_at||b.created_at-a.created_at||a.id.localeCompare(b.id));
    if (query.has('before_id')) ordered=ordered.slice(ordered.findIndex(item=>item.id===query.get('before_id'))+1);
    const page=ordered.slice(0,Number(query.get('limit')));
    const last=page.at(-1);
    const active=projects.projects.find(item=>item.id===projects.active_project_id);
    data={...projects,projects:page,total:projects.projects.length,hasMore:page.length<ordered.length,nextCursor:last?{updated_at:last.updated_at,created_at:last.created_at,id:last.id}:null};
    if(active&&!page.some(item=>item.id===active.id))data.projects=[...page,active];
   }
  } else if (path.endsWith('/config')) data = config;
  else if (path.endsWith('/workflows')) data = {templates: [], workflows: [], revision: 1};
  else if (path === '/userdata') data = [];
  else if (path.endsWith('/default-setup')) data = {status:'idle', installed: true, available: true};
  else if (path.endsWith('/default-workflows')) data = {workflows: []};
  else if (path.endsWith('/runtime-health')) data = {connected: true};
  else if (path.endsWith('/status')) data = {status: 'idle', connected: true, available: true};
  else if (path.endsWith('/models')) data = {models: []};
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data));
 } catch (error) {res.statusCode = 500; res.end(JSON.stringify({error: error.message}));}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

 const browser = await chromium.launch({headless:true, ...(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {})});
 const context = await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 const origin = 'http://127.0.0.1:' + server.address().port;
 const errors=[];
 await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
 const newPage=async () => {const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message)); await page.goto(origin); await page.waitForFunction(()=>window.studioReady||window.bootError); assert.equal(await page.evaluate(()=>window.bootError),undefined); return page;};
 return {browser,context,origin,errors,requests,newPage,
  get chats(){return chats;},set chats(value){chats=value;},get projects(){return projects;},set projects(value){projects=value;},
  async close(){await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
 };
}
export const attachVideo = page => page.evaluate(async()=>{window.__promptstudioPromptStudioHost.setStandaloneVisibility(false);document.querySelector('#promptstudio-image-mount').hidden=true;document.querySelector('#promptstudio-video-mount').hidden=false;document.body.dataset.studioMode='video';await window.__promptstudioVideoStudioHost.attach(window);});
