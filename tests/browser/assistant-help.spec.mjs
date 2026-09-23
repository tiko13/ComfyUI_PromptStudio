import assert from "node:assert/strict";
import {startFixture, videoEnabled, attachVideo} from "./fixture.mjs";

const fixture = await startFixture();
try {
  await fixture.context.route("**/js/prompt_studio.js", async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: await response.text() + "\nexport {handleStudioTurn,refreshWorkflowControls,updateComposeMode,restoreChatState,consultRequestPayload,normalizeChat};"});
  });
  const routes = [], answers = [];
  let visionCalls = 0;
  await fixture.context.route("**/prompt-studio/vision-capability", route => {
    visionCalls++; return route.fulfill({json:{available:true}});
  });
  await fixture.context.route("**/prompt-studio/route-turn", route => {
    const data = route.request().postDataJSON(); routes.push(data);
    return route.fulfill({json:{route:"discuss",confidence:1,resolved_instruction:"",reason:"Advice",
      help_domain: data.user_text.includes("sleeves") ? "prompting" : "app", app_help_query:""}});
  });
  await fixture.context.route("**/prompt-studio/discuss", route => {
    answers.push(route.request().postDataJSON());
    return route.fulfill({json:{message:"Help answer.",proposal:null,help_documents:["references.qwen"]}});
  });
  const page = await fixture.newPage();
  await page.evaluate(async () => {
    const m = await import("/extensions/ComfyUI_PromptStudio/js/prompt_studio.js");
    const {state} = await import("/extensions/ComfyUI_PromptStudio/js/prompt-studio/core/state.js");
    window.helpTest = {m,state};
    const chat = state.chats.find(c => c.id === state.activeChatId);
    Object.assign(chat,{initialized:true,selectedSource:{filename:"base.png",type:"output",subfolder:"",width:64,height:64},mainPrompt:"A shirt.",finalPrompt:"A shirt, daylight.",currentPrompt:"A shirt, daylight."});
    const base = {id:"qwen",path:"qwen",name:"Renamed edit graph",kind:"edit",imageNodeId:"base",promptNodeId:"p",modelNodes:[],loraNodes:[],resultNodeIds:[],snapshot:{workflow:{nodes:[],links:[]},output:{
      base:{class_type:"KCPP_ChatImageInput",inputs:{}},p:{class_type:"KCPP_PromptSlot",inputs:{}},
      enc:{class_type:"TextEncodeQwenImage21",inputs:{"images.image_1":["base",0],prompt:["p",0]}}
    }}};
    const single = structuredClone(base); single.id=single.path="single"; single.name="Renamed Krea edit";
    delete single.snapshot.output.enc;
    single.snapshot.output.ref={class_type:"KCPP_ChatImageReference",inputs:{source_name:"Jacket"}};
    single.snapshot.output.edit={class_type:"Krea2Edit",inputs:{source_image_b:["ref",0]}};
    state.workflowProfiles=[base,single];state.workflowBusy=true;state.apiConnected=true;
    m.refreshWorkflowControls();m.restoreChatState(chat);
    document.querySelector("#promptstudio-use-llm-amplification").checked=true;
    document.querySelector("#promptstudio-auto-generate").checked=false;
    document.querySelector('input[name="promptstudio-generation-action"][value="edit"]').checked=true;
    document.querySelector("#promptstudio-edit-workflow").value="qwen";
    m.updateComposeMode();
  });
  async function ask(text) {
    await page.evaluate(async text => {
      document.querySelector("#promptstudio-revision").value=text;
      await window.helpTest.m.handleStudioTurn();
    }, text);
  }
  await ask("How do I add references?");
  assert.equal(answers.length,1);
  assert.equal(answers[0].help_domain,"app");
  assert.equal(answers[0].help_context.reference_mode,"qwen");
  assert.equal(answers[0].help_context.reference_limit,9);
  assert.notEqual(answers[0].help_context.reference_label,"unavailable");
  assert.notEqual(answers[0].help_context.model_label,"unavailable");
  assert.notEqual(answers[0].help_context.workflow_label,"unavailable");
  assert.ok(answers[0].messages.every(m => !m.images && !m.context));
  assert.equal(visionCalls,0);
  const banner = page.locator("#promptstudio-discussion-context");
  assert.equal(await banner.locator("strong").textContent(), "App help");
  assert.equal(await banner.locator("small").textContent(), "Studio features and controls");
  assert.equal(await banner.locator("img").isVisible(), false);
  assert.equal(await banner.locator("button").getAttribute("aria-label"), "End app help");
  // Saved discussion metadata must survive normalization and restoring the chat.
  await page.evaluate(() => {
    const {m,state}=window.helpTest;
    const index=state.chats.findIndex(c=>c.id===state.activeChatId);
    state.chats[index]=m.normalizeChat(JSON.parse(JSON.stringify(state.chats[index])));
    m.restoreChatState(state.chats[index]);
    document.querySelector('input[name="promptstudio-generation-action"][value="edit"]').checked=true;
    document.querySelector("#promptstudio-auto-generate").checked=false;
  });
  assert.equal(await banner.locator("strong").textContent(), "App help");
  await page.evaluate(() => {document.querySelector("#promptstudio-edit-workflow").value="single";window.helpTest.m.updateComposeMode();});
  await ask("Where do I add it now?");
  assert.equal(answers[1].help_context.reference_mode,"single");
  assert.ok(routes[1].discussion_history.some(m=>m.text==="Help answer."));
  await ask("How do I make a shirt with tiny sleeves?");
  assert.equal(answers[2].help_domain,"prompting");
  assert.equal(await banner.locator("strong").textContent(), "Prompting advice");
  await ask("How to make an image?");
  assert.equal(await banner.locator("strong").textContent(), "App help");
  assert.equal(answers[3].help_context.auto_generate,false);
  assert.equal(answers[3].help_context.llm_amplification,true);
  assert.equal(answers[3].help_context.auto_generate_label,"Generate after revision");
  assert.notEqual(answers[3].help_context.send_label,"unavailable");
  await banner.locator("button").click();
  assert.equal(await banner.isVisible(),false);
  assert.equal(await page.locator("#promptstudio-status").textContent(),"App help ended without changing the prompt.");
  const preserved = await page.evaluate(() => {
    const {m,state}=window.helpTest, chat=state.chats.find(c=>c.id===state.activeChatId);
    return {main:chat.mainPrompt,final:chat.finalPrompt,chat:JSON.stringify(chat),consult:m.consultRequestPayload([{role:"user",text:"How to change model?",images:[]}],"help-test",false)};
  });
  assert.equal(preserved.main,"A shirt.");assert.equal(preserved.final,"A shirt, daylight.");
  assert.ok(!preserved.chat.includes("help_documents"));
  assert.equal(preserved.consult.help_context.reference_mode,"single");
  // Match a Create workflow without image inputs, as in the reported screenshot.
  await page.evaluate(() => {
    const {m,state}=window.helpTest;
    state.workflowProfiles.push({id:"create",path:"create",name:"Create without image inputs",kind:"create",promptNodeId:"p",modelNodes:[],loraNodes:[],resultNodeIds:[],snapshot:{output:{p:{class_type:"KCPP_PromptSlot",inputs:{}}}}});
    m.refreshWorkflowControls();
    document.querySelector('input[name="promptstudio-generation-action"][value="create"]').checked=true;
    document.querySelector("#promptstudio-create-workflow").value="create";
    m.updateComposeMode();
  });
  await ask("How do I add reference images?");
  assert.equal(answers.at(-1).help_context.reference_mode,"none");
  assert.equal(answers.at(-1).help_context.reference_label,"unavailable");
  assert.equal(answers.at(-1).help_context.llm_amplification,true);
  assert.equal(await page.locator("#promptstudio-edit-reference").isVisible(),false);
  assert.equal(await banner.locator("strong").textContent(),"App help");
  assert.equal(answers.at(-1).help_context.activity_label,"Recent activity");
  assert.equal(answers.at(-1).help_context.diagnostics_label,"Export diagnostics");
  await fixture.context.route("**/prompt-studio/import-image", route => route.fulfill({json:{image:{filename:"vision-reference.png",type:"input",subfolder:"",width:64,height:64}}}));
  await page.evaluate(() => {
    const {m,state}=window.helpTest, chat=state.chats.find(c=>c.id===state.activeChatId);
    // A help-only conversation has no created prompt yet, but supports paste.
    chat.initialized=false; chat.mainPrompt=""; chat.finalPrompt="";
    m.updateComposeMode();
    const clipboard=new DataTransfer();
    clipboard.items.add(new File([new Uint8Array([1,2,3])],"reference.png",{type:"image/png"}));
    document.querySelector("#promptstudio-revision").dispatchEvent(new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:clipboard}));
  });
  await page.waitForFunction(() => !document.querySelector("#promptstudio-pasted-image").hidden);
  assert.equal(await page.locator("#promptstudio-pasted-image small").textContent(),"vision-reference.png");
  assert.equal(await page.locator("#promptstudio-edit-reference").isVisible(),false);
  assert.equal(visionCalls,1);
  if (videoEnabled) {
    await fixture.context.route("**/js/promptstudio_video_studio.js", async route => {
      const response=await route.fetch();
      await route.fulfill({response,body:await response.text()+"\nexport {directorRequestPayload};"});
    });
    // A fresh page ensures the export instrumentation precedes module loading.
    const videoPage=await fixture.newPage(); await attachVideo(videoPage);
    const facts=await videoPage.evaluate(async()=>{
      const m=await import("/extensions/PromptStudio_Video/js/promptstudio_video_studio.js");
      const project={id:"help-project",name:"Help",document:{mode:"auto"}};
      return m.directorRequestPayload(project,null,"project",[],[{role:"user",content:"How to add media?"}],"help-job").help_context;
    });
    assert.equal(facts.studio,"video");assert.equal(facts.surface,"project");
  }
  assert.deepEqual(fixture.errors,[]);
  console.log("PASS assistant help browser routing, workflow switching, prompt preservation and consultation state");
} finally {await fixture.close();}
