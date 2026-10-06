import assert from "node:assert/strict";
import {startFixture,attachVideo,config,videoEnabled} from "./fixture.mjs";
if (!videoEnabled) {console.log("Video reference integration requires STUDIO_TEST_VIDEO=1");}
else {
 const fixture=await startFixture();
 const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=","base64");
 try {
  const project={id:"reference-project",name:"References",document:structuredClone(config.default_document),generations:[],created_at:1,updated_at:1,workflow_id:"refs",additional_input_selections:{}};
  fixture.projects={revision:1,projects:[project],active_project_id:project.id};
  await fixture.context.route("**/js/promptstudio_video_studio.js",async route=>{const response=await route.fetch();await route.fulfill({response,body:await response.text()+"\nexport {state,renderHeader,generateProject};"});});
  await fixture.context.route("**/scripts/api.js",async route=>{const response=await route.fetch();await route.fulfill({response,body:await response.text()+'\napi.queuePrompt=async(_,snapshot)=>{window.videoQueued=structuredClone(snapshot);return {prompt_id:"video-reference-test"};};'});});
  let uploads=0;
  await fixture.context.route("**/upload/image",route=>route.fulfill({json:{name:"video-ref-"+(++uploads)+".png",subfolder:"refs",type:"input"}}));
  await fixture.context.route("**/view?*",route=>route.fulfill({contentType:"image/png",body:png}));
  await fixture.context.route("**/promptstudio-video/document/compile",r=>r.fulfill({json:{document:r.request().postDataJSON().document,prompt:"A scene"}}));
  const page=await fixture.newPage();await attachVideo(page);
  await page.evaluate(async()=>{
   const m=await import("/extensions/PromptStudio_Video/js/promptstudio_video_studio.js");window.videoReferenceTest=m;
   m.state.workflows=[{id:"refs",name:"[PSV] References",director_node_id:"d",result_node_ids:["save"],result_fields:["videos"],snapshot:{workflow:{nodes:[],links:[]},output:{
     d:{class_type:"PSV_MiniMaxH3Director",inputs:{}},save:{class_type:"SaveVideo",inputs:{video:["d",0]}},
     a:{class_type:"KCPP_ChatImageReference",inputs:{image_ref:""},_meta:{title:"Poster"}},
     b:{class_type:"KCPP_ChatImageReference",inputs:{image_ref:"",source_name:"Upscale guide"}},
     extra:{class_type:"Custom",inputs:{a:["a",0],b:["b",0]}}
   }}}];m.state.activeProjectId="reference-project";m.state.projects.find(p=>p.id==="reference-project").workflow_id="refs";m.state.apiConnected=true;m.renderHeader();
  });
  const tile=page.locator(".psvstudio-workflow-reference");assert.ok(await tile.isVisible());
  await tile.getByRole("button",{name:"References",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"References",exact:true});
  for(const name of ["Poster","Upscale guide"]){
   const chooser=page.waitForEvent("filechooser");await dialog.getByRole("button",{name:"Choose image for "+name}).click();
   await (await chooser).setFiles({name:"reference.png",mimeType:"image/png",buffer:png});
   await page.waitForFunction(()=>document.querySelector(".psvstudio-workflow-reference").getAttribute("aria-busy")==="false");
  }
  assert.equal(await dialog.getByRole("combobox").count(),0,"Universal inputs have no Qwen prompt controls");
  const preparation=dialog.locator(".ps-reference-preparation").first();
  await preparation.locator("summary").click();
  await preparation.getByRole("button",{name:"Hide all",exact:true}).click();
  await preparation.getByRole("button",{name:"Use prepared reference",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector(".psvstudio-workflow-reference").getAttribute("aria-busy")==="false");
  await dialog.getByRole("button",{name:"Done"}).click();
  await page.evaluate(() => {
    const m = window.videoReferenceTest;
    const plain = structuredClone(m.state.workflows[0]);
    plain.id = "plain"; plain.name = "[PSV] No reference inputs";
    for (const id of ["a", "b", "extra"]) delete plain.snapshot.output[id];
    m.state.workflows.push(plain); m.renderHeader();
  });
  await page.locator("#psvstudio-workflow").selectOption("plain");
  assert.equal(await tile.isVisible(), false, "Switching workflows immediately hides unsupported references");
  assert.match(await page.locator("#psvstudio-run-summary").textContent(), /No reference inputs/);
  await page.locator("#psvstudio-workflow").selectOption("refs");
  assert.equal(await tile.isVisible(), true, "Switching back immediately restores workflow references");
  assert.match(await tile.locator("small").textContent(), /References \(2\)/);
  await page.evaluate(()=>window.videoReferenceTest.generateProject());
  const result=await page.evaluate(()=>({snapshot:window.videoQueued,project:window.videoReferenceTest.state.projects.find(p=>p.id==="reference-project")}));
  assert.ok(result.snapshot,JSON.stringify(result.project.generations));
  assert.equal(JSON.parse(result.snapshot.output.a.inputs.image_ref).filename,"video-ref-3.png");
  assert.equal(JSON.parse(result.snapshot.output.b.inputs.image_ref).filename,"video-ref-2.png");
  await page.waitForFunction(()=>document.querySelector("#psvstudio-save-state")?.textContent==="Saved");
  await page.reload();await page.waitForFunction(()=>window.studioReady);await attachVideo(page);
  const restored=await page.evaluate(async()=>{const {state}=await import("/extensions/PromptStudio_Video/js/promptstudio_video_studio.js");return state.projects.find(p=>p.id==="reference-project").workflowReferences;});
  assert.equal(restored.refs.b.filename,"video-ref-2.png");
  assert.equal(restored.refs.a.filename,"video-ref-3.png");
  assert.deepEqual(fixture.errors,[]);
  console.log("Video workflow inputs: shared popup, independent queue binding, and persistence passed.");
 }finally{await fixture.close();}
}
