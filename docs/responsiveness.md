# Responsiveness audit

Scope: Image Studio, model chat, shared persistence and workflow services, and
Video Studio's project, Director and submission paths. Changes require a browser
refresh. No runtime dependencies or generation-node contracts changed.

| Interaction | Finding | Change |
| --- | --- | --- |
| Create new / new seed | Image reread every saved workflow before each submission. | Clone the selected executable cache and apply current variables. Rebuild after a detected workflow edit or explicit refresh. |
| Workflow refresh | Full graph serialization and cache saving prolonged refresh. | Compare compact content/capability identities and save through background tasks and a worker. |
| Rapid submissions | Independent preparation could finish in reverse order. Equal creation timestamps could also sort by random IDs. | Reserve FIFO submission positions before asynchronous preparation and assign increasing message timestamps. Failures/cancellation release reservations. |
| Queue acceptance | Image and Video waited for full server history writes; the initial background-save fix still awaited a complete local history draft. | Checkpoint only the pending generation and owner metadata in an isolated browser journal, then queue independently of archive workers and server saves. |
| Typing | Repeated editor decoration, sidebar rebuilds and consultation retention scans occurred in interaction handlers. | Keep text/state changes immediate, coalesce decoration/status to a frame, avoid the per-key sidebar rebuild and move retention work to periodic save maintenance. |
| Preferences | Controls synchronously read, encode and write localStorage. | Read current in-memory values; coalesce writes after interaction. Flush pending small preferences on page exit and invalidate the memory cache on cross-tab storage events. |
| Long conversations | Progress redraws serialized immutable saved execution graphs and measured every preceding card to find the viewport anchor. | Use snapshot identity in render signatures and binary-search the visible anchor. Preserve keyed cards, selection, scroll, open details and media playback. |
| Large histories | Draft comparison, encoding, size checks and IndexedDB writes ran on the UI thread. Video also wrote a second complete localStorage archive. | Perform draft comparison/storage and save-payload encoding in workers; remove duplicate Video project/Director archives. Post draft checkpoints before awaiting worker replies, including on page exit. |
| Replay metadata | Hashing and canonicalization traversed complete graphs on the UI thread. | Capture and compare provenance in the shared data worker. |
| Large dropdowns | Every keystroke recreated all matching options, and positioning rewrote layout every frame. | Index searchable text once, initially render 80 options, append on scroll/keyboard navigation, and update placement only when geometry changes. Search still covers the entire catalog. |
| Background refresh | Shared polling and backend history paging were already bounded. | Retain their existing behavior and regression coverage. |
| Generation/LLM progress during editing | Each tick could scan historical messages and replace progress controls; Video rebuilt its generation archive. | Update transient state immediately, paint only affected progress elements once per visible frame, retain Cancel/focus, and avoid redundant phase saves. |
| Hidden host frame / popouts | Scheduling could use the hidden ComfyUI frame instead of the document containing the controls. | Schedule against the current owner window and discard stale callbacks after adoption. |
| Dropdown geometry and keyboard wrap | Open menus polled layout every frame; wrapping to the final option could materialize the entire catalog. | Observe actual geometry changes and render a bounded window for large keyboard jumps. |
| Plot prompt/title typing | Every key normalized both axes and rebuilt the sidebar/inspector. | Update draft text directly; normalize and rebuild only for structural changes. |
| Reference instructions and strength | Every input requested an immediate archive save and refreshed presentation. | Retain immediate reference values, debounce persistence, and coalesce presentation. Brush strokes retain every point but repaint once per frame. |
| Prompt scrolling / instruction highlights | Scroll events replaced the full highlighted text and repeatedly wrote dimensions. | Retain matching text nodes, read geometry before writes, update only changed geometry, and coalesce scroll/resize/input decoration. |
| Video title / production text | Renaming rebuilt the project list and serialized the document. Every text input recorded full undo JSON and checked replay fingerprints. | Patch the title only; coalesce continuous document checkpoints/presence, validate replay on submission, and flush typing before Undo or discrete panel actions. |
| Video zoom / preset search | Bursts could repeatedly rebuild the same presentation before paint. | Keep values current and coalesce rendering to the visible document's next frame. |
| Storage overhead after edits | Saves cloned immutable historical graphs before worker transfer; draft writes sent entire archives back and repeatedly resent unchanged baselines. | Copy editable metadata while retaining immutable graph references, return small durable receipts, and send only baseline changes to the draft worker. |

The queue still waits for required validation, replay approval when applicable,
GPU-memory handoff, the local recovery checkpoint, and ComfyUI acceptance. Those
are asynchronous prerequisites, not reasons to freeze editing. A failed local
checkpoint prevents an untrackable submission; a slow server history save does
not. Exact replay continues to use saved inputs and provenance checks.

Image shows separate submission-checkpoint and ComfyUI-acceptance statuses.
The submission journal restores missing pending records on reload without
resubmitting; it retains existing history and newer accepted/cancelled states.
It reads an off-page owner before merging and respects confirmed deletion of
previously saved owners. Successful later history writes remove checkpoints.
Normal full draft recovery continues separately, including unsent composer text.

Cache freshness follows observed ComfyUI workflow saves/moves/deletes and explicit
refresh. Files edited outside ComfyUI require Refresh workflows. A selected cache
is cloned before seed/model/LoRA/prompt/reference changes; historical snapshots
are never modified by the next request.

`tests/browser/responsiveness-stress.spec.mjs` exercises two rapid Create new calls
with reversed preparation completion and stalled local/server history writes; 1,000 messages
with saved graphs; typing; a 10,000-item dropdown; and workflow-cache reuse and
invalidation. On the development Windows/Chromium environment, input handlers
were below 0.3 ms and median 1,000-message updates were approximately 15–21 ms.
These are fixture measurements, not GPU-generation benchmarks or a guarantee
for every machine/history size. Existing suites additionally cover 500-message
selection/viewport/media stability, draft reloads, failed storage, cross-tab
conflicts, and lost queue responses.

The second audit adds `generation-interaction.spec.mjs`: 1,000 Image messages,
300 Video generations, a 10,000-option menu, and repeated progress/LLM updates
while typing and navigating. Image event-dispatch batches fell from about 26 ms
to 1.3–1.7 ms median in the local fixture; Video batches were about 0.1 ms.
Historical content reads and persistence requests from progress ticks were zero.
`input-audit.spec.mjs` checks actual Plot, prompt-scroll, Video title and production
brief controls, plus immediate Undo/Redo before the next frame. Fifty synchronous
input events took about 0.3–0.6 ms locally and did not scan Video document shots.
These timings measure handlers, not end-to-end input latency or whole-frame cost.

Reviewed paths also include model/LoRA selections, provider settings, numeric
controls, source/reference changes, consultation/Director progress, shot editing,
timeline dragging, chat switching, reload and storage failure recovery. Discrete
structural edits still validate and render their affected views. Assistant-help
procedures remain the same apart from documenting grouped Video typing undo.

Browsers without workers retain the original IndexedDB implementation; JSON
worker tasks fall back to scheduled main-thread work. DOM rendering and the browser's structured-clone message transfer
remain on the main thread; arbitrary archive sizes are not cost-free. Hosted
Ubuntu verification is separate from local Windows checks.

## Local validation, 2026-11-03

Windows, ComfyUI VENV Python 3.14.6, Node 24.18.0 and lockfile-pinned Playwright
Chromium. All required modes passed:

- Image standalone: 733 Python tests (two intentional Video-only skips),
  165 JavaScript tests (three intentional Video-only skips), type checks,
  and 88 browser suites (five intentional Video-only skips).
- Video integration: 478 Python tests and 41 JavaScript tests, no skips.
- Shared integration: 733 Python tests, 165 JavaScript tests, type checks,
  and all 93 browser suites, no skips.
- Both help catalogs and their combinations passed; all 103 frontend JavaScript
  files passed syntax checks; both repositories passed patch/whitespace checks.

Replay invalidation remains immediate for discrete edits. Continuous typing
checkpoints flush before discrete controls and Undo/Redo, including controls in
the global settings dialog. Browser tests cover these boundaries explicitly.
No live GPU render benchmark, commit, push or hosted CI run was performed.
