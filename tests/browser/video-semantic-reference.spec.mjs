import assert from "node:assert/strict";
import {startFixture, attachVideo, videoEnabled} from "./fixture.mjs";
if (!videoEnabled) process.exit(0);
const fixture = await startFixture();
try {
  await fixture.context.route("**/js/promptstudio_video_studio.js", async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: await response.text() + "\nwindow.semanticVideo={state,activeProject,openDirector,directorSession,sendDirectorMessage};"});
  });
  let status = "clarify", calls = [];
  await fixture.context.route("**/promptstudio/prompt-studio/semantic-reference", route => {
    calls.push(route.request().postDataJSON());
    return route.fulfill({json: status === "assigned"
      ? {status, role: "subject", instruction: "Use only the red dress from the attached reference for the woman in the existing shot. Preserve her identity and action.", message: ""}
      : {status, role: "", instruction: "", message: "Which woman should wear the dress?"}});
  });
  const page = await fixture.newPage(); await attachVideo(page);
  await page.locator("#psvstudio-new-project").click();
  await page.evaluate(() => {
    const t = window.semanticVideo;
    t.state.apiConnected = true; t.activeProject().document.shots[0].subjects = "Two women";
    t.openDirector("project");
    t.directorSession().draft_attachments = [{id: "dress", path: "imports/dress.png", name: "Dress", usage: "auto"}];
  });
  await page.locator("#psvstudio-director-input").fill("Make her wear this dress");
  await page.evaluate(() => window.semanticVideo.sendDirectorMessage());
  assert.equal(await page.evaluate(() => window.semanticVideo.activeProject().document.references.length), 0);
  assert.equal(await page.evaluate(() => window.semanticVideo.directorSession().semanticClarification.question), "Which woman should wear the dress?");
  status = "assigned";
  // Inspect the immutable request at submission; a Director generation is a separate existing pipeline.
  await fixture.context.route("**/director/chat", route => route.fulfill({json: {status: "completed", message: "Ready for review.", proposal: null}}));
  await page.locator("#psvstudio-director-input").fill("The woman on the left");
  await page.evaluate(() => window.semanticVideo.sendDirectorMessage());
  assert.match(calls.at(-1).user_text, /Make her wear this dress/);
  assert.match(calls.at(-1).user_text, /woman on the left/);
  assert.ok(calls.at(-1).supported_roles.subject.includes("garment"));
  const reference = await page.evaluate(() => window.semanticVideo.activeProject().document.references[0]);
  assert.deepEqual(reference.roles, ["subject"]);
  assert.equal(reference.path, "imports/dress.png");
  assert.match(reference.prompt, /only the red dress/);
  assert.equal(await page.evaluate(() => window.semanticVideo.activeProject().document.shots[0].subjects), "Two women");
  assert.deepEqual(fixture.errors, []);
  console.log("Video semantic reference: shared interpreter, clarification and scoped garment reference verified.");
} finally {await fixture.close();}
