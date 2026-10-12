# Repository layout

Prompt Studio and Video Studio keep ComfyUI entrypoints and standard repository
metadata at the root. Application code, resources, and runtime data live in
dedicated folders.

| Folder | Contents |
| --- | --- |
| `backend/` | Image nodes, routes, shared services, migrations, and worker scripts |
| `web/` | Browser scripts, styles, icons, and standalone pages |
| `config/defaults/` | Tracked bundled preset resources |
| `config/user/` | Ignored editable prompt configuration |
| `config/LlamaCPP/` | Local Llama.cpp profiles and logs |
| `setup/` | Setup catalogs, asset definitions, and bundled Image workflows |
| `docs/assistant-help/` | Internal help cards, loaded only for app-help requests |
| `user-data/` | Ignored histories, workflow caches, plots, metadata, reference models, and process state |
| `tests/` | Automated checks and their TypeScript configuration |
| `test-results/` | Ignored test artifacts; loose historical logs are in `logs/` |
| `prompt_evals/` | Synthetic prompt evaluation command-line tool |

Video Studio keeps its node classes in `nodes/`, its implementation and routes
in `video/`, and bundled workflows in `workflows/`. Its help cards also live in
`docs/assistant-help/`, and its project/workflow stores live in `user-data/`.
Shared services are loaded from Prompt Studio's `backend/` package.

`__init__.py` remains the ComfyUI entrypoint. `README.md`, `LICENSE`,
`pyproject.toml`, Git configuration, and npm manifests retain their conventional
root locations for discovery and tooling. Additional user template files are
not part of this layout migration; their existing configuration behavior stays
the same.

On the next ComfyUI startup, each extension moves its known legacy runtime
files and directories into its own `user-data/` before opening any stores.
Names, contents, nested recovery files, and adjacent `.bak`/`.tmp` files are
preserved. The operation is repeatable and never combines or overwrites two
stores: a conflicting destination stops startup with both copies retained.
Do not move a live store manually while ComfyUI is running.

Back up `user-data/` together with `config/user/` and your local Llama.cpp
profiles. Generated images and videos remain in ComfyUI's existing media
directories. The shared job ledger remains in ComfyUI's user storage.
