// Compile-only fixtures; never imported by the application.
import { assertJobTransition, normalizeProviderSettings } from "./wire-contracts.js";
/** @type {import('./wire-contracts.js').ProviderSettings} */
const misspelled = { ...normalizeProviderSettings({}),
  // @ts-expect-error Unknown provider fields must be caught.
  llm_provder: "ollama",
};
/** @type {import('./wire-contracts.js').SnapshotWire} */
const missingOutput = { wire_version: 1, kind: "workflow_snapshot",
  // @ts-expect-error Both snapshot envelopes are required.
  snapshot: { workflow: {} },
};
/** @type {import('./wire-contracts.js').JobWire} */
// @ts-expect-error Complete jobs require a result.
const missingResult = { wire_version: 1, kind: "llm_job", job_id: "fixture", status: "complete" };
// @ts-expect-error Terminal jobs cannot restart under the same ID.
assertJobTransition("complete", "running");
// @ts-expect-error Queued jobs must run before completing.
assertJobTransition("queued", "complete");
assertJobTransition("queued", "running");
void [misspelled, missingOutput, missingResult];
