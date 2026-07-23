# ComfyUI_PromptStudio

![ComfyUI Prompt Studio](docs/images/example1.png)

Chat-first image generation for ComfyUI, powered by a local KoboldCpp or Ollama model.

ComfyUI_PromptStudio adds **Prompt Studio**, an interactive workspace where you can describe an image, generate it with a selected `[PS]` workflow saved in ComfyUI, and refine it conversationally:

```text
"A rain-soaked market at night"
        ↓
Create & Generate
        ↓
"Move the camera lower and make the signs less prominent"
        ↓
Revise & Generate
```

The extension keeps a model-neutral **main prompt** alongside the detailed **final prompt** sent to the selected workflow. Ordinary revision messages precision-edit both representations, while prompt-shaping control changes rebuild the final prompt from the stable main prompt. The selected local LLM service is called by the ComfyUI backend, not by the browser.

## Quick start: generate images through chat

1. Install this repository in `ComfyUI/custom_nodes/ComfyUI_PromptStudio` and restart ComfyUI.
2. Add a **KoboldCpp Prompt Slot** or **KoboldCpp Prompt Amplify** node to an image-generation workflow.
3. Connect its `prompt` output to the positive prompt input or text encoder used by the workflow.
4. Make sure the rest of the workflow can be queued normally and has exactly one image output.
5. Save it in ComfyUI with a filename beginning `[PS]`, such as `[PS] Flux Create`.
6. Use one of the launchers at the lower-right of ComfyUI:
   - **Prompt chat** opens the embedded interface.
   - **Prompt Studio** opens the same interface in its own tab.
7. Select the saved workflow under **ComfyUI workflows** in Prompt Studio settings, then describe the image you want.
8. Click **Create & Generate**. After the first result, ask for changes such as `use a wider composition`, `replace the coat with a red rain jacket`, or `make the lighting softer`.

Prompt Studio uses KoboldCpp at `http://localhost:5001` by default. Open Prompt Studio settings to select **KoboldCpp** or **Ollama** as the LLM provider. Ollama defaults to `http://localhost:11434`; select one of the locally installed models discovered from `/api/tags`. For safety, both providers accept loopback hosts only by default.

Prompt rewriting uses KoboldCpp's OpenAI-compatible Chat Completions endpoint and the model's native GGUF chat template. Enable **Use Jinja** in KoboldCpp and restart its server after changing that setting. The backend checks this capability and stops with a clear error instead of silently using generic chat formatting. KoboldCpp 1.117.1 or newer is recommended and is the version used for integration testing.

With Ollama selected, Prompt Studio uses Ollama's native, non-streaming `/api/chat` endpoint. Sampling controls are translated to Ollama options, and the Thinking control uses Ollama's separate `think` response channel. **Minimal** and **Low** both request Ollama's `low` thinking level. The ComfyUI canvas nodes remain named KoboldCpp Prompt Slot/Amplify for workflow compatibility; in interactive Prompt Studio, they act as prompt handoff nodes and the provider selected in settings performs the rewrite.

> Want to use the chat UI without an LLM? Turn off **Use LLM amplification**. The composer becomes a direct-prompt editor, the main and final prompts stay identical, and **Generate** sends that text straight to ComfyUI.

## The interactive workflow

### Create, revise, and inspect

The first message becomes the main prompt and is rendered into a complete final prompt. Later messages are treated as revisions rather than as a transcript for the model. Prompt Studio precision-revises the model-neutral main prompt and the existing detailed final prompt separately, preserving unrelated established detail.

Revisions use the smallest edit scope implied by the request. References that conflict with the requested change are replaced, while unrelated clauses and tags are preserved where possible. Removing an automatic detail that is absent from the main prompt changes only the final prompt; Prompt Studio does not add negative wording to the main prompt.

The inspector displays the stable **Main prompt** and editable **Final prompt**. Manual final-prompt edits are used for generation and preserved by later precision revisions. **Undo** restores the main and final prompt together, and every generated-image message records both plus the complete executable workflow inputs that were queued. Its **i** panel shows the workflow, LoRAs and strengths, and every saved node input. **Use these prompts** restores the prompt, routing, LoRAs, source image when applicable, and arms the saved executable snapshot; generating without making a change reuses every stored input, including seeds, to reproduce the original queue as closely as the installed nodes and runtime allow. In an editing workflow's **Text only** mode, the workflow intentionally receives the latest edit instruction instead of the complete final prompt.

### Generate and reroll

With **Generate after revision** enabled, creating or revising a prompt immediately queues an API-format snapshot of the selected saved `[PS]` workflow. Turn it off to update the main and final prompts without queueing an image; **Generate** can queue the final prompt later. Generated images appear in the chat, can be opened at full size, and can be scaled down in the conversation with the interface **Image scale** setting.

Prompt changes keep the current ComfyUI seed, making before-and-after comparisons easier. **New seed on reroll** randomizes widgets named `seed` or `noise_seed` only when **Reroll**, or an unchanged **Generate**, queues the same prompt and controls again. Turn it off to keep the current seed on rerolls too.

If you change the model profile, style, framing, modifiers, or embellishment level, **Reroll** or an empty **Revise & Generate** rebuilds the final prompt from the main prompt. This clean render prevents details from an older control setting from leaking into the new result. Endpoint, thinking, token, and temperature changes do not mark the final prompt stale. A direct ComfyUI reroll is used when the prompt-shaping controls already match.

### Sessions and persistence

The **Sessions** sidebar creates, switches, and deletes independent prompt conversations. Each session remembers its main and final prompts, paired prompt versions, messages, selected creation and editing workflows, and the prompt-shaping controls last applied by the selected LLM provider.

Chats are stored in `prompt_studio_chats.json` beside the extension's Python files. The file is excluded from Git and is shared by browsers connected to the same ComfyUI installation. Saves use revision checks so an older browser cannot silently overwrite a newer save. A conflicting client stops saving and asks for a reload. Before replacing a store, the backend keeps the previous valid copy as a `.bak` file.

The standalone page is available at the short URL:

```text
/PromptStudio
```

The original extension URL remains available for compatibility:

```text
/extensions/ComfyUI_PromptStudio/prompt_studio.html
```

On direct navigation or refresh, it reconnects to an open ComfyUI tab when possible and otherwise starts a hidden same-origin workflow host.

### Password-protected LAN access

Prompt Studio can be opened from another device on the same private network. Because the standalone interface uses ComfyUI's workflow, queue, history, image, and WebSocket APIs, LAN mode protects the complete remotely reachable ComfyUI server rather than only the Prompt Studio HTML page. Requests from the machine running ComfyUI continue to work without a password.

Set a password of at least 12 characters before starting ComfyUI, then listen on all local interfaces:

```powershell
$env:PROMPT_STUDIO_LAN_PASSWORD = "replace-with-a-long-unique-password"
C:\EasyDiffusion\ComfyUI\venv\Scripts\python.exe C:\EasyDiffusion\ComfyUI\main.py --listen 0.0.0.0 --port 8188
```

Open Prompt Studio from a LAN device by replacing the example address with the ComfyUI machine's private IPv4 or IPv6 address:

```text
http://192.168.1.25:8188/PromptStudio
```

Private IPv4 ranges (`10/8`, `172.16/12`, and `192.168/16`), IPv4 link-local addresses, and IPv6 unique-local/link-local addresses are accepted. Public, carrier-grade NAT, invalid, and missing client addresses are rejected. Authentication uses an HTTP-only, same-site signed cookie that expires after 12 hours or whenever ComfyUI restarts. Five failed sign-in attempts from one address trigger a five-minute throttle.

Keep this deployment LAN-only:

- Use the operating system firewall's private-network profile to allow TCP port `8188`; do not create a public-network rule.
- Do not forward port `8188` on the router, expose it through a tunnel, or put it behind a public reverse proxy. A reverse proxy on the LAN appears to the server as a private client and defeats source-address enforcement.
- Prefer a trusted home network. The password is submitted over ordinary HTTP, so it is not encrypted on the wire; use a local TLS reverse proxy only if you understand and preserve the LAN boundary.
- Remove `PROMPT_STUDIO_LAN_PASSWORD` and return ComfyUI to its default loopback listen address to disable LAN mode.

## Choosing a workflow prompt node

Prompt Studio can use either of these nodes in a saved `[PS]` workflow:

| Node | Interactive Prompt Studio generation | Normal ComfyUI queue |
| --- | --- | --- |
| **KoboldCpp Prompt Slot** | Passes the final prompt into the workflow | Passes its `prompt` input through unchanged |
| **KoboldCpp Prompt Amplify** | Temporarily behaves like Prompt Slot in the queued Studio snapshot | Rewrites its `text` input through KoboldCpp before passing it on |

Using Prompt Amplify as the prompt input does not cause double amplification. Prompt Studio converts it to a Prompt Slot only in the temporary workflow snapshot it submits. The saved workflow and ordinary ComfyUI runs retain the node's normal amplification behavior.

Both nodes return the image prompt and unchanged `secondary_instructions` as their first two outputs, followed by optional integer `width` and `height` outputs. Prompt Studio supplies the resolution from its **Resolution** controls whenever it queues either node. Prompt Amplify also exposes the same controls on the ComfyUI canvas for normal workflow runs; Prompt Slot keeps them Studio-only. The aspect-ratio presets, megapixel range, multiple range, defaults, and rounding match ComfyUI's built-in **Resolution Selector**.

If a `[PS]` workflow contains more than one compatible prompt node, Prompt Studio uses the first executable one in graph order.

## Prompt Studio LoRA Loader

Add **Prompt Studio LoRA Loader** anywhere in the model path of a saved `[PS]` workflow. It accepts and returns `MODEL`, so it can replace a model-only LoRA loader or sit between the checkpoint loader and the rest of the model pipeline.

Set its **LoRA Type** to the name of a top-level folder under any ComfyUI LoRA directory. For example, `flux` exposes files under `<LoRA directory>/flux`, including nested folders, and matches the folder name case-insensitively (`flux`, `Flux`, and `FLUX` are equivalent). LoRAs outside that top-level folder are not exposed.

LoRA filenames beginning with `_` are reserved for internal use and are never shown in Prompt Studio. For example, `flux/_internal.safetensors` is hidden while `flux/styles/_internal.safetensors` is also hidden.

When the active workflow contains this loader, the inspector shows a **LoRA** section. Add any number of the available LoRAs, set an independent model strength for each one, and remove them without editing the saved workflow. Prompt Studio injects the ordered selection only into the temporary queued snapshot. Each generated-image message records the ordered LoRA selections and strengths used by its workflow; the image's **i** panel displays them, and selecting that image or choosing **Use these prompts** restores them. Older history entries without a LoRA snapshot leave the current selection unchanged. Normal ComfyUI queues of the saved workflow remain pass-through unless a stack was explicitly supplied through the API.

## Creation, image-editing, and upscaling workflows

Prompt Studio uses normal workflows saved in ComfyUI's workflow library. Prefix a workflow's filename with `[PS]` to make it visible to Prompt Studio; other saved workflows remain available for manual use without cluttering Studio's selectors.

A `[PS]` workflow is accepted only when:

- its filename starts with `[PS]` and ends in `.json`;
- creation and editing workflows contain an executable **KoboldCpp Prompt Slot** or **KoboldCpp Prompt Amplify** node;
- it contains exactly one executable image-output node;
- editing workflows contain an executable **Prompt Studio Image Source** node;
- upscaling workflows contain an executable **Prompt Studio Upscale** node.

Workflows with **Prompt Studio Upscale** are listed as upscaling templates. Otherwise, workflows with **Prompt Studio Image Source** are listed as editing templates and workflows without an image input are listed as creation templates. Saving, renaming, or deleting a `[PS]` workflow through ComfyUI refreshes Prompt Studio immediately after the operation succeeds. The refresh button remains available, and the selected workflow is checked again immediately before it is queued. Widget values and other workflow settings therefore stay owned by ComfyUI and automatically flow into Prompt Studio.

To prepare an editing workflow:

1. Replace the workflow's normal **Load Image** node with **Prompt Studio Image Source** and connect its `image` output to the editing pipeline.
2. Keep the workflow's prompt input connected through a Prompt Slot or Prompt Amplify node.
3. Ensure only the intended final image-output node is active.
4. Save it in ComfyUI with a name such as `[PS] Kontext Edit`.

Generated images have an **Edit this image** action. The selected chat image is injected into the saved editing workflow as a small JSON reference containing `filename`, `subfolder`, and `type`. If no image was explicitly selected, **Edit** automatically uses the last image in the active conversation. The image-source node loads that existing file directly from ComfyUI's `output`, `temp`, or `input` storage; it never copies a generated image into `input`.

Prompt Studio records each result's actual pixel dimensions. Editing an image injects those exact dimensions into the Prompt Slot or bypassed Prompt Amplify outputs, preserving the source size even when it does not match a Resolution Selector preset. Switching back to **Create** for a revised new image uses the aspect ratio, megapixels, and multiple currently selected in Prompt Studio again.

To prepare an upscaling workflow, add **Prompt Studio Upscale**, connect its `image` output to the upscaling pipeline, and use its `width`, `height`, or `upscale_factor` outputs wherever the model requires target sizing. Its `prompt` and `secondary_instructions` outputs can be connected to conditioning nodes when needed. Keep exactly one final image output active and save the workflow with a `[PS]` prefix.

Every generated image has a compact **Upscale** action beside **Edit this image**. Prompt Studio asks for an upscale factor (default `2`) and injects the selected image reference, factor, optional final prompt, and secondary instructions into the dedicated node. The node loads the image and outputs target width and height calculated from the source dimensions. **Use prompt when upscaling** controls whether the final prompt output is populated.

When **Edit** is selected, a second switch controls the workflow prompt payload. **Text only** sends the current revision text as the editing instruction, while **Full prompt** sends the complete revised target prompt. The switch is remembered per chat.

The interface can automatically advance the editing source to the newest result, while still allowing any earlier image to be selected at any time. **Reroll** repeats the previous execution prompt and source image while both the Create/Edit action and selected workflow are unchanged. Switching either control before rerolling routes through the newly selected workflow instead. Workflow seeds change only when seed randomization is enabled.

The ignored runtime file `prompt_studio_workflows.json` is now only a last-known-good cache. If a changed `[PS]` workflow becomes invalid or cannot be converted, Prompt Studio marks it as **cached**, reports why the live update was rejected, and continues using the previous working snapshot. Correct and save the ComfyUI workflow, then refresh or generate again to replace the cache. Cache writes keep the existing revision checks and `.bak` recovery copy.

## Amplification nodes

The node suite also supports prompt rewriting directly inside a ComfyUI graph, without using Prompt Studio.

### KoboldCpp Prompt Amplify

**KoboldCpp Prompt Amplify** turns a short or rough `text` input into a model-ready image prompt and returns it as `amplified_text`.

Typical graph:

```text
primitive text → KoboldCpp Prompt Amplify → positive text encoder → sampler
```

Its prompt controls are:

- `model_profile`: selects the target prompt grammar, examples, token default, and optional exact prefix or suffix from `model_profiles.json`.
- `style_preset`: selects reusable aesthetic guidance from `style_templates.json`.
- `style_modifier`: supplies freeform style guidance for this run. When present, it becomes the target style and replaces conflicting medium, rendering, camera, or quality language.
- `framing_preset`: selects composition, viewpoint, shot type, angle, and placement guidance from `framing_templates.json`.
- `framing_modifier`: supplies freeform framing guidance for this run and takes precedence over the preset when non-empty.
- `embellishment_level`: controls expansion after style conversion. **None** adds no new visible detail; **Minimal** stays short; **Clean** lightly polishes; **Detailed** adds useful visible detail; **Rich** produces a denser description; **Maximum** and **Ultra Maximum** allow progressively more expansion. Tag-based profiles increase tag density instead of prose length.
- `additional_instructions`: adds one-run task guidance without changing the profile files.
- `thinking_mode`: selects KoboldCpp native reasoning effort from **Disabled** through **High**. Native thinking is kept in Chat Completions' separate `reasoning_content` field; only the final `content` is used as the image prompt.
- `secondary_instructions`: passes through unchanged to the second output and is not part of the LLM request.
- `aspect_ratio`, `megapixels`, and `multiple`: calculate the optional `width` and `height` outputs using the same settings and rounding as ComfyUI's **Resolution Selector**.

The remaining controls configure the KoboldCpp request: URL, final-answer token allowance, temperature, `top_p`, `top_k`, `min_p`, repetition penalty and range, sampler seed, stop sequences, and request timeout. Set `max_response_tokens` to `0` to use the selected profile's default. The backend adds a reasoning allowance, measures the fully Jinja-formatted prompt with `/api/extra/tokencount`, and caps the combined completion against `/api/extra/true_max_context_length` without treating KoboldCpp's unrelated Horde `config/max_length` value as a server limit. Use one custom stop sequence per line; when native thinking is enabled, the backend does not add legacy textual continuation stops because labels such as `Response:` may occur during the analysis-to-final transition. `sampler_seed: -1` lets KoboldCpp choose the seed.

KoboldCpp counts reasoning and final text inside one completion. To preserve approximately the configured final-answer allowance, the backend requests a larger combined completion for reasoning modes:

| Thinking mode | Native reasoning budget | Combined completion request |
| --- | --- | --- |
| Disabled | 0 | final-answer allowance |
| Minimal | up to 200 tokens | allowance plus 200 reasoning tokens |
| Low | up to 500 tokens | allowance plus 500 reasoning tokens |
| Medium | up to 1,000 tokens | allowance plus 1,000 reasoning tokens |
| High | unrestricted | available context window |

The server context window remains the hard upper bound. Prompt Studio supplies Minimal, Low, and Medium to the Jinja template separately and uses KoboldCpp's explicit `thinking_budget_tokens` field, avoiding KoboldCpp's percentage-based caps. High uses KoboldCpp's unrestricted native effort and the remaining context window. A completion that ends with `finish_reason: length`, or returns reasoning without final content, is rejected rather than passing a truncated prompt into the image workflow or silently retrying with thinking disabled.

The node preserves the input subject, action, setting, and concrete visible details while applying the selected prompt grammar, style, framing, and detail level. If an expansive setting produces an output that is still too sparse, it may make a second KoboldCpp request and keep the denser result.

### Ideogram4-KoboldCPP

**Ideogram4-KoboldCPP** is a structure-preserving amplifier for an Ideogram v4-style JSON object. It extracts selected prompt strings, rewrites each one in a separate KoboldCpp request, and returns updated JSON.

Processed fields, controlled by the corresponding `process_*` switches:

```text
high_level_description
compositional_deconstruction.background
compositional_deconstruction.elements[*].desc  (except elements with type "text")
```

It preserves bounding boxes, element types, literal text elements, unknown keys, and unselected fields. The model sees only one prompt fragment at a time—not the JSON structure, field name, other regions, or bounding boxes—so details do not bleed between regions.

`seed_mode` either offsets a fixed seed for each processed field or reuses the same seed. `on_error` can stop the workflow or retain the original field, and `pretty_json` controls formatted versus compact output. Model profile, style, framing, embellishment, thinking, additional instructions, and KoboldCpp request controls behave like Prompt Amplify.

## General local-LLM node

### KoboldCpp Apply

**KoboldCpp Apply** sends its `text` input directly to KoboldCpp as the complete prompt/context and returns the generated text. It does not add image-prompt profiles, style guidance, framing guidance, embellishment rules, or amplification instructions.

Use it when you want a raw local-LLM call inside a workflow rather than an image-prompt rewrite. This node intentionally remains on KoboldCpp's native `/api/v1/generate` endpoint so its `text` input continues to mean the complete raw prompt/context. Its token setting is therefore a total raw-generation limit, not the final-answer allowance used by the Chat Completions-based rewriting nodes. Native reasoning separation is most reliable in Prompt Amplify, Ideogram4-KoboldCPP, and Prompt Studio.

### Remote Ollama hosts

Ollama URLs use the same loopback-only protection as KoboldCpp. To permit a known remote Ollama server, set `PROMPT_STUDIO_OLLAMA_ALLOWED_HOSTS` before starting ComfyUI. It accepts a comma-separated list of exact hostnames or IP addresses:

```powershell
$env:PROMPT_STUDIO_OLLAMA_ALLOWED_HOSTS = "192.168.1.30,ollama.example.internal"
```

Do not include URL schemes or ports in the allowlist. `*` permits every host and should be used only in a trusted environment. Prompt Studio currently targets the local Ollama API and does not send Ollama cloud credentials.

### Remote KoboldCpp hosts

The backend rejects non-loopback KoboldCpp URLs by default to prevent a saved workflow or browser request from making arbitrary outbound HTTP calls. To permit a known remote server, set `PROMPT_STUDIO_KOBOLD_ALLOWED_HOSTS` before starting ComfyUI. It accepts a comma-separated list of exact hostnames or IP addresses:

```text
PROMPT_STUDIO_KOBOLD_ALLOWED_HOSTS=192.168.1.25,kobold.example.internal
```

Use `*` only in a trusted environment when arbitrary remote hosts are intentionally allowed. URLs containing embedded credentials are rejected; configure authentication at a trusted proxy instead.

## Profiles and presets

### Model profiles

Edit `model_profiles.json` to add prompt formats for different image models:

```json
{
  "name": "Tag-Based Anime Model",
  "style": "comma_tags",
  "default_max_response_tokens": 300,
  "example_prompts": [
    "person, umbrella, small_building, trees, outdoors, standing, full_body",
    "robot, workbench, bicycle_wheel, garage, repairing, tools, sitting"
  ],
  "instruction": "Rewrite the user's prompt as concise comma-separated tags.",
  "notes": "Optional model-specific syntax, ordering, weighting, or trigger guidance.",
  "final_prompt_prefix": "",
  "final_prompt_suffix": ""
}
```

`default_max_response_tokens` is the final-answer allowance used when the node or Prompt Studio sends `0`; reasoning allowance is added automatically. `example_prompts` teach format only; their subjects should not be copied into the result. Older profiles containing one `example_prompt` string remain supported. `notes` may be an empty string, a string, or a list of strings. Exact `final_prompt_prefix` and `final_prompt_suffix` values are applied after rewriting.

### Style presets

Edit `style_templates.json` to add reusable aesthetics:

```json
{
  "name": "Casual Snapshot",
  "instruction": "Make the result feel candid, ordinary, and natural. Prefer everyday wording. Avoid polished cinematic, editorial, commercial, or studio-style language."
}
```

### Framing presets

Edit `framing_templates.json` to add reusable compositions and viewpoints:

```json
{
  "name": "Selfie",
  "instruction": "Show the finished selfie from the subject's front-facing phone-camera viewpoint, as the captured image itself. The viewer occupies the phone camera's position; do not show the phone or an outside observer's view."
}
```

## Backend API

Prompt Studio revisions are served by ComfyUI at:

```text
POST /promptstudio/prompt-studio/revise
```

The browser uses `revise_main` to precision-edit model-neutral intent, `revise` to precision-edit the existing final prompt, and `render` to build a fresh final prompt after prompt-shaping controls change. Ordinary revisions run the two precision edits independently; a control change renders only from the updated main prompt.

KoboldCpp and Ollama requests remain on the Python side, so the browser does not need direct access to the local model server.

## Updating and troubleshooting

- Restart ComfyUI after changing Python files or updating this extension.
- Refresh the browser after frontend-only changes.
- If Prompt Studio does not list a workflow, make sure its saved ComfyUI filename starts with `[PS]` and that it meets all four validation rules above.
- If a workflow is marked **cached**, hover the workflow status for the validation error, correct the saved workflow in ComfyUI, and refresh it.
- If prompt creation fails, confirm that the selected LLM provider is running, its endpoint is correct, and an Ollama model is selected when using Ollama. The defaults are `http://localhost:5001` for KoboldCpp and `http://localhost:11434` for Ollama.
- If prompt creation succeeds but no image appears, queue the workflow normally in ComfyUI and fix any disconnected or invalid generation nodes first.
- If Prompt Studio reports a save conflict, reload it to obtain the newest chat or workflow-cache revision before making further changes.

## Development checks

Run these checks from the repository root after making changes:

```powershell
python -c "from pathlib import Path; [compile(Path(p).read_text(encoding='utf-8'), p, 'exec') for p in ('nodes.py', 'routes.py')]"
node --check web/js/prompt_studio.js
node --check web/js/prompt_studio_standalone.js
python -m unittest discover -s tests -v
git diff --check
```
