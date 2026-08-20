# Prompt Studio frontend modules

`../prompt_studio.js` remains the single ComfyUI registration and composition root. Code under this directory is grouped by responsibility rather than by file size.

## Dependency direction

Dependencies point inward:

1. The entry module composes the application.
2. `ui/` and `integrations/` may depend on `core/`.
3. `core/` must not depend on UI, integrations, or the entry module.

Modules expose narrow named APIs. When a module needs behavior owned by a higher layer, accept that behavior through a factory argument instead of importing the higher layer and creating a cycle. Runtime registration and startup side effects belong in the entry module.

## Current modules

- `core/`: constants and initialized application state
- `chat/`: chat-model composition, legacy migration, image/generation normalization, persistence, and synchronization
- `consult/`: consultation, experiment, and Prompt-Agent data models
- `generation/`: workflow profile normalization and ComfyUI graph-to-template validation
- `settings/`: persisted general settings and LLM-profile normalization/migration
- `llm/`: provider-status interpretation and display helpers
- `ui/`: view lifecycles such as background activity
- `integrations/`: ComfyUI and companion-studio bridges

## Next feature boundaries

- `generation/`: workflow discovery orchestration, queueing, progress, models, and LoRAs
- `consult/`: consultation request orchestration and rendering
- `ui/`: rendering, dialogs, and panel construction
- `integrations/`: ComfyUI Manager and standalone-mode composition

Prefer cohesive modules with one reason to change. Avoid files per individual function and avoid generic catch-all `utils.js` modules.
