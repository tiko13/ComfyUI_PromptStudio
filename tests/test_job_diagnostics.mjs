import assert from "node:assert/strict";
import test from "node:test";
import { fetchJobActivity, isActiveJob, jobActivityText, jobRetryText, recoveredJobError } from "../web/js/prompt-studio/ui/job-diagnostics.js";

test("activity uses captured origin after switching the active chat or studio", () => {
  const job = { studio: "image", origin: { chat_id: "old" }, state: "queued", phase: "queued", queue_position: 2 };
  const context = { chats: [{ id: "new", title: "Current chat" }, { id: "old", title: "Original chat" }] };
  assert.equal(jobActivityText(job, context), "Image chat: Original chat · Queued · position 2");
  assert.equal(isActiveJob(job), true);
  assert.equal(isActiveJob({ ...job, state: "interrupted" }), false);
  assert.match(jobActivityText({ ...job, studio: "video", state: "interrupted" }), /Video project · Interrupted by server restart/);
});

test("recovery tells users what retry does without claiming continuation", () => {
  const interrupted = recoveredJobError({ code: "server_restarted", job: { retry_action: "replan" } });
  assert.match(interrupted.message, /restarted.*new plan/);
  assert.equal(interrupted.retryAction, "replan");
  assert.match(recoveredJobError({ code: "result_unavailable" }).message, /Check its saved output/);
  assert.match(jobRetryText({ retry_action: "rerun_inference" }), /does not resume/);
  assert.equal(recoveredJobError({ code: "something_else" }), null);
});

test("activity endpoint data is bounded and version checked", async () => {
  const data = { version: 1, durable: true, jobs: [] };
  assert.deepEqual(await fetchJobActivity(async () => ({ ok: true, json: async () => data })), data);
  await assert.rejects(fetchJobActivity(async () => ({ ok: true, json: async () => ({ version: 1, jobs: Array(129).fill({}) }) })), /incompatible/);
});
