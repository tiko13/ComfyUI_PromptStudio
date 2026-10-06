# Internal assistant help

The turn router classifies `help_domain` as `none`, `prompting`, `app`, or `both`.
It never receives the documentation catalog. Only `app`/`both` runs a second,
bounded topic selection over titles/summaries. The resolver loads matching cards
for the current studio and capabilities, then attaches them to that answer only.
Main/Final generation, stored chat messages and ordinary creative turns must not
receive documentation. Pure app help does not need vision or create a proposal.

## Add or change a feature

1. Add/edit a short Markdown file under `assistant-help/`. Video-only documents
   belong in `PromptStudio_Video/assistant-help/`. Discovery is automatic.
2. Begin with `---`, a JSON metadata object, and another `---` on their own lines:

   ```json
   {"id":"references.qwen","topic":"references","studio":"image","summary":"Add and manage reference images.","when":{"reference_mode":"qwen"}}
   ```

3. Write concise steps, prerequisites and limitations. Use an existing broad
   `topic` for related cards. Keep the common card's summary descriptive: it is
   the feature's retrieval description. No classifier/action registry changes
   are required. A new topic is discovered automatically too.
4. Add `when` conditions for capability-specific instructions. Conditions are
   exact matches; the common card and all applicable variants are composed.
   Keep variants mutually exclusive. Never infer capability from workflow names.
5. Use `{reference_limit}`, `{reference_roles}`, `{reference_inputs}` and other
   fields in `assistant_help.FACT_DEFAULTS` for changing facts. Add new facts to
   the shared contract and the adapter that owns them. Image workflow facts come
   from `generation/help-context.js`, using the same adapters as execution. UI
   labels come from current controls where available. Unknown facts stay unknown.
6. When UI navigation or behavior changes, update its card in the same change.
   Limits and labels can update automatically; written procedures still need
   review. Unsupported/undocumented behavior must produce a limitation, not a guess.

## Verification

Run the assistant help Python tests and `tests/test_assistant_help.mjs`. They
validate metadata, substitutions, capability variants, budgets, discovery and
answer-only isolation. Video has its own catalog and Director integration tests.
Add a representative question when introducing a different help behavior. Use
browser coverage when changing the request wiring. Mocked classifier results
verify routing contracts; they do not prove a particular LLM classifies correctly.

The catalog has no embeddings, external service, package dependency or manual
index. Source files are read for help requests, so documentation-only edits do
not require restarting ComfyUI. Python/schema changes do require a restart.

## Node and workflow authoring help

`nodes` is the shared suite inventory, including the frontend-only
`PromptStudioInput`; `video-nodes` adds the companion's registered nodes. Keep
display names and class IDs aligned with both repositories' node registrations.
Detail cards cover inputs, outputs, wiring and limitations. Give each small node
group its own topic and include its names/IDs in the summary so specific-node
questions and conversational follow-ups can retrieve details without loading
the entire inventory. Do not put every detail card under `nodes`: selection
composes all applicable cards for a topic into the same bounded answer packet.

`workflow-inputs` is shared by both studios. `workflow-stages` and `video-stages`
explain their different graph contracts and distinguish graph stages from UI
actions, sampling iterations and video shots. Describe canvas behavior separately
from Studio injection; availability of a shared node does not imply both studios
expose the same controls. Verify registrations, workflow adapters and execution
code when updating these cards. Tests check inventory/detail coverage and every
three-topic packet for both catalogs; live LLM selection remains a separate check.
