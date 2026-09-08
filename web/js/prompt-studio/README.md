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
- `ui/feature-controller.js`: explicit `mount(target, context)`, `update(context)`, and `dispose()` ownership for listeners, timers, and cleanup callbacks; adoption preserves panel identity and the focused input's selection
- `ui/focus-controller.js`: Image document focus, modal keyboard behavior, and transient consultation/settings dismissal, with injected state and callbacks
- `ui/generation-progress-controller.js`: application-level Image/plot progress projection, with injected state and generation services
- `integrations/`: ComfyUI and companion-studio bridges

Video uses the shared lifecycle primitive through its dependency on Image. Its `web/js/controllers/generation-progress-controller.js` owns API event subscriptions and the disconnected-control observer; `document-interaction-controller.js` owns editor-document media input and transient dismissal. These modules never import either entry module or register an extension.

## Lifecycle boundaries

Repeated mounting on the same target updates the existing feature without duplicate registration. Mounting another document removes the old feature's listeners first. `dispose()` releases only resources registered through that feature's scope. Async UI work can check `scope.isCurrent()` before applying its result; it must not cancel a backend job merely because the user selected another chat/project.

Generation progress belongs to the application and remains mounted across session switches and hidden views. Focus and editor input belong to the panel's current document and remount when the panel moves between embedded and popup documents. Popup attachment owns its close-detection timer and `pagehide` listener; a cancelled `beforeunload` never detaches the panel. Adoption moves existing controls, plot containers, and video elements; it does not rebuild them.

Entry functions remain thin integration wrappers, including `setupGenerationProgressEvents`, `setupProgressEvents`, `installTypeAnywhereFocus`, `installMediaDrop`, and `installTransientUiDismissal`. Registration, shared persistence, queue execution, and cross-document bridge APIs remain in the composition roots. This extraction does not change generation polling ownership or backend cancellation semantics.

Checks: `node --test tests/test_feature_lifecycle.mjs` exercises injected resource/job ownership. `node tests/browser/lifecycle.spec.mjs` runs the real entry modules against synthetic transports, switches chats/projects during preparation/generation, and verifies popup focus, adoption, and listener registration behavior. It does not run live LLM/GPU work. Use the existing browser fixture's `BROWSER_EXECUTABLE` setting when a system Chromium browser is required.

## Next feature boundaries

- `generation/`: workflow discovery orchestration, queueing, progress, models, and LoRAs
- `consult/`: consultation request orchestration and rendering
- `ui/`: rendering, dialogs, and panel construction
- `integrations/`: ComfyUI Manager and standalone-mode composition

Prefer cohesive modules with one reason to change. Avoid files per individual function and avoid generic catch-all `utils.js` modules.
