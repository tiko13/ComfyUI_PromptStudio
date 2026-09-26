# UX and resilience audit — 25 September 2026

## Assessment

This pass fixes concrete persistence and accessibility defects and expands the automated browser coverage across Image Studio and Video Studio. It is not a certification that every edge case is handled. Production sign-off still needs the live checks below: the usual ComfyUI URL refused connections during this audit.

Existing working-tree changes in both repositories were preserved. No parent ComfyUI files were changed, no real generations were queued, and no server was started or restarted. Changes from this pass are frontend code, help cards, tests and this report; applying them requires a browser refresh.

## Fixed in this pass

| Finding | Result |
| --- | --- |
| Image history with HTTP 200 but malformed JSON or a missing chat list could look like an empty store. | History responses must contain the expected list and a valid revision before being applied. A visible Retry loading history action preserves temporary local work through recovery. |
| A failed Image save stopped being treated as pending once its request finished. Background synchronization could replace unsaved in-memory records. | Unsaved mutations block background replacement until a save succeeds. A persistent notice offers Retry save and Export unsaved draft. |
| Image and Video accepted HTTP 200 save responses without a valid revision. | Both studios use shared acknowledgement validation before marking work saved or deleting its draft. |
| Initial history failure prevented normal draft checkpointing. | Local sessions can retain browser drafts while server persistence is blocked. Initialization with no sessions cannot overwrite an existing draft with an empty one. |
| Draft export could be frozen by Image Studio's disconnected state. | Export and recovery controls remain available while disconnected. |
| Video prompt previews had unlabelled text areas and unhandled clipboard rejection. | Both dialogs have accessible text-area names, inline copy feedback, and a selection fallback when clipboard access is missing or denied. The clipboard belongs to the editor's current window. |
| Recovery messages could become difficult to use in a narrow drawer. | Notices wrap long messages and their actions. The mobile history drawer was checked with the new controls. |
| The empty video preview exposed implementation terminology. | The instruction now says: Describe your video, refine each shot, then generate. |

History/recovery help cards were added to both catalogs. Prompt text, compilation, Main/Final separation and GPU behavior were not changed by this pass.

## Verification

The test fixture loads the actual frontend modules but supplies isolated storage and mocked ComfyUI/provider endpoints. It never submits real jobs.

- Paired browser run: 32 of 32 suites passed.
- Independent Image browser run: 27 suites passed; 5 Video-only suites explicitly skipped.
- Image Python suite with companion integration: 489 tests passed.
- Video Python suite: 410 tests passed.
- Image JavaScript suite with companion integration: 76 tests passed.
- Video persistence JavaScript suite: 16 tests passed.
- Wire-contract type checks, changed JavaScript syntax and patch whitespace checks passed.
- New history tests cover malformed initial responses, repeated loading failure, local edits before retry, invalid save acknowledgements, unsaved state during synchronization, successful retry and disconnected draft export.
- New dialog tests cover missing, denied and successful clipboard access, selection without text mutation, accessible names, Escape and narrow layouts.
- Existing browser coverage also exercises setup and license choices, references, Main/Final and Undo, cancellation, lost acknowledgements, resumable jobs, conflicts, paging, replay, plots, comparison, popup adoption, focus, scrolling, reduced motion and forced colors.
- Automated accessibility scans reported no violations in the tested scopes. This does not replace assistive-technology testing.
- Generated narrow-screen screenshots for Video Studio, prompt preview and history recovery were visually inspected.

Local evidence is in the ignored test-results-ux-*.log files and test-results/browser/ screenshots. New regressions live in tests/browser/history-failures.spec.mjs and tests/browser/dialog-clipboard.spec.mjs.

## Remaining release checks

1. Start ComfyUI through the normal user-owned launch session and exercise real Image and Video generation, cancellation, failure/retry and reload during an active job.
2. Verify actual provider disconnect/reconnect and shared-GPU handoff, including the strict Keep models loaded behavior. Fixture responses cannot prove VRAM or model lifecycle behavior.
3. Verify restart recovery through the status monitor's restart control, with an idle queue and fresh startup output in the existing terminal.
4. Test representative real workflows, missing models and optional-node incompatibilities. Validate generated output quality and reference preservation separately from frontend contracts.
5. Observe Linux CI on the final paired revisions. Local Windows checks do not certify Linux execution.
6. Exercise keyboard and screen-reader workflows with assistive technology and any additional browsers included in the supported release matrix; this pass used Edge/Chromium.

Release both repositories compatibly: the Video changes import the new shared response validator and clipboard helper from Prompt Studio.
