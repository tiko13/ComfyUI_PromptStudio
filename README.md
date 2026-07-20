# ComfyUI_LLLM

Chat-first image generation for ComfyUI, powered by a local KoboldCpp model.

ComfyUI_LLLM adds **Prompt Studio**, an interactive workspace where you can describe an image, generate it with the active ComfyUI workflow, and refine it conversationally:

```text
"A rain-soaked market at night"
        ↓
Create & Generate
        ↓
"Move the camera lower and make the signs less prominent"
        ↓
Revise & Generate
```

The extension keeps a complete canonical prompt behind the conversation. Each message changes that prompt, writes it into the selected workflow node, and can immediately queue a new image. KoboldCpp runs locally and is called by the ComfyUI backend, not by the browser.

## Quick start: generate images through chat

1. Install this repository in `ComfyUI/custom_nodes/ComfyUI_LLLM` and restart ComfyUI.
2. Add a **KoboldCpp Prompt Slot** node to an image-generation workflow.
3. Connect its `prompt` output to the positive prompt input or text encoder used by the workflow.
4. Make sure the rest of the workflow can be queued normally and ends in an image output.
5. Use one of the launchers at the lower-right of ComfyUI:
   - **Prompt chat** opens the embedded interface.
   - **Prompt Studio** opens the same interface in its own tab.
6. Select the workflow prompt node in the right inspector, then describe the image you want.
7. Click **Create & Generate**. After the first result, ask for changes such as `use a wider composition`, `replace the coat with a red rain jacket`, or `make the lighting softer`.

Prompt Studio uses `http://localhost:5001` as the default KoboldCpp endpoint. Change **KoboldCpp URL** in the generation controls if your server uses another local address. For safety, the backend accepts loopback hosts only by default; see [Remote KoboldCpp hosts](#remote-koboldcpp-hosts) before connecting to another machine.

Prompt rewriting uses KoboldCpp's OpenAI-compatible Chat Completions endpoint and the model's native GGUF chat template. Enable **Use Jinja** in KoboldCpp and restart its server after changing that setting. The backend checks this capability and stops with a clear error instead of silently using generic chat formatting. KoboldCpp 1.117.1 or newer is recommended and is the version used for integration testing.

> Want to use the chat UI without an LLM? Turn off **Use LLM amplification**. The composer becomes a direct canonical-prompt editor and **Generate** sends that text straight to ComfyUI.

## The interactive workflow

### Create, revise, and inspect

The first message in a new chat creates a complete prompt. Later messages are treated as revisions to that prompt rather than as a transcript for the model. Prompt Studio sends KoboldCpp only the current canonical prompt, the requested change, and the active generation controls.

Revisions use the smallest edit scope implied by the request. References that conflict with the requested change are replaced, while unrelated clauses and tags are preserved where possible. Style and framing constrain the edit; embellishment controls detail within the edited scope.

The **Canonical prompt** panel shows the current complete target prompt. You can edit it manually, restore an earlier version with **Undo**, or inspect and restore the prompt recorded with any generated-image message. In an editing workflow's **Text only** mode, the workflow intentionally receives the latest edit instruction instead of the complete target prompt.

### Generate and reroll

With **Generate after revision** enabled, creating or revising a prompt immediately queues an API-format snapshot of the active ComfyUI workflow. Turn it off to create or revise the canonical prompt without queueing an image; **Generate** can queue it later. Generated images appear in the chat, can be opened at full size, and can be scaled down in the conversation with the interface **Image scale** setting.

Prompt changes keep the current ComfyUI seed, making before-and-after comparisons easier. **New seed on reroll** randomizes widgets named `seed` or `noise_seed` only when **Reroll**, or an unchanged **Generate**, queues the same prompt and controls again. Turn it off to keep the current seed on rerolls too.

If you change the model profile, style, framing, modifiers, or embellishment level, **Reroll** or an empty **Revise & Generate** first asks KoboldCpp to apply those controls to the canonical prompt. A direct ComfyUI reroll is used when the controls already match.

### Sessions and persistence

The **Sessions** sidebar creates, switches, and deletes independent prompt conversations. Each session remembers its canonical prompt, prompt versions, messages, selected workflow prompt node, and the generation controls last applied by KoboldCpp.

Chats are stored in `prompt_studio_chats.json` beside the extension's Python files. The file is excluded from Git and is shared by browsers connected to the same ComfyUI installation. Saves use revision checks so an older browser cannot silently overwrite a newer save. A conflicting client stops saving and asks for a reload. Before replacing a store, the backend keeps the previous valid copy as a `.bak` file.

The standalone page is available at:

```text
/extensions/ComfyUI_LLLM/prompt_studio.html
```

On direct navigation or refresh, it reconnects to an open ComfyUI tab when possible and otherwise starts a hidden same-origin workflow host.

## Choosing a workflow prompt node

Prompt Studio can attach to either of these nodes:

| Node | Interactive Prompt Studio generation | Normal ComfyUI queue |
| --- | --- | --- |
| **KoboldCpp Prompt Slot** | Passes the canonical prompt into the workflow | Passes its `prompt` input through unchanged |
| **KoboldCpp Prompt Amplify** | Temporarily behaves like Prompt Slot in the queued Studio snapshot | Rewrites its `text` input through KoboldCpp before passing it on |

Using Prompt Amplify as the attachment point does not cause double amplification. Prompt Studio converts it to a Prompt Slot only in the temporary workflow snapshot it submits. The saved workflow and ordinary ComfyUI runs retain the node's normal amplification behavior.

Both nodes return two strings. The first is the image prompt. The optional `secondary_instructions` input is returned unchanged from the second output and is never sent to KoboldCpp. This keeps downstream wiring compatible whether Studio uses a Slot or bypasses an Amplify node.

Use `slot_name` on **KoboldCpp Prompt Slot** to give each attachment point a recognizable name when a workflow contains multiple prompts.

## Creation and image-editing workflows

Prompt Studio can capture multiple queue-ready workflow profiles while keeping **Current canvas** available for the original behavior. Creation and editing profiles are selected independently, so every generation can explicitly choose **Create new** or **Edit selected** without changing the chat into a permanent mode.

To register a creation workflow:

1. Open and test the workflow normally in ComfyUI.
2. Open **Workflow profile library** and click **Refresh canvas nodes** after switching to the workflow canvas.
3. Start a **New profile**, enter a name, choose **Creation**, and select that canvas's **KoboldCpp Prompt Slot** or **Prompt Amplify** node under **Current canvas prompt**.
4. Select the primary result node when desired. Custom output nodes such as `SaveAsWebpConditional` are supported by node ID; use automatic discovery when they return normal `images` or `gifs` history fields.
5. Click **Save as new**. This always creates a separate profile and never overwrites an existing one.

To register an editing workflow:

1. Replace the workflow's normal **Load Image** node with **Prompt Studio Image Source** and connect its `image` output to the editing pipeline.
2. Keep the workflow's prompt input connected through a Prompt Slot or Prompt Amplify node.
3. Capture the workflow as **Editing** and select either **Full target prompt** or **Edit instruction** prompting.
4. Select the image-source node and the primary final-output node.

Generated images have an **Edit this image** action. The selected chat image is injected into the saved editing workflow as a small JSON reference containing `filename`, `subfolder`, and `type`. If no image was explicitly selected, **Edit** automatically uses the last image in the active conversation. The image-source node loads that existing file directly from ComfyUI's `output`, `temp`, or `input` storage; it never copies a generated image into `input`.

When **Edit** is selected, a second switch controls the workflow prompt payload. **Text only** sends the current revision text as the editing instruction, while **Full prompt** sends the complete revised target prompt. An editing profile's **Default edit payload** initializes this switch when that workflow is selected, but the switch can be changed per chat before any operation.

The interface can automatically advance the editing source to the newest result, while still allowing any earlier image to be selected at any time. **Reroll** repeats the previous execution prompt and source image while both the Create/Edit action and selected workflow are unchanged. Switching either control before rerolling routes through the newly selected workflow instead. Workflow seeds change only when seed randomization is enabled.

Workflow routing and profile management are deliberately separate. The **Create workflow** and **Edit workflow** dropdowns only choose what a chat runs. To change a saved profile, select it under **Workflow profile library** and click the named **Update** button; Prompt Studio asks for confirmation before replacing its snapshot. **Save as new** always creates a new profile, and duplicate names within the same profile type are rejected.

Workflow profiles are stored in the ignored runtime file `prompt_studio_workflows.json`. Each profile contains the captured executable snapshot, prompt and image entry points, result-node filters, configurable history fields, and any literal widget values present in that snapshot. Review workflows before capturing them if custom nodes can contain credentials or other secrets. Updating a workflow in ComfyUI does not silently alter a profile. Workflow saves use the same revision checks and `.bak` recovery copy as chat saves.

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
- `embellishment_level`: controls expansion after style conversion. **Minimal** stays short; **Clean** lightly polishes; **Detailed** adds useful visible detail; **Rich** produces a denser description; **Maximum** and **Ultra Maximum** allow progressively more expansion. Tag-based profiles increase tag density instead of prose length.
- `additional_instructions`: adds one-run task guidance without changing the profile files.
- `thinking_mode`: selects KoboldCpp native reasoning effort from **Disabled** through **High**. Native thinking is kept in Chat Completions' separate `reasoning_content` field; only the final `content` is used as the image prompt.
- `secondary_instructions`: passes through unchanged to the second output and is not part of the LLM request.

The remaining controls configure the KoboldCpp request: URL, final-answer token allowance, temperature, `top_p`, `top_k`, `min_p`, repetition penalty and range, sampler seed, stop sequences, and request timeout. Set `max_response_tokens` to `0` to use the selected profile's default. The backend adds a reasoning allowance, measures the fully Jinja-formatted prompt with `/api/extra/tokencount`, and caps the combined completion against `/api/extra/true_max_context_length` without treating KoboldCpp's unrelated Horde `config/max_length` value as a server limit. Use one custom stop sequence per line; when native thinking is enabled, the backend does not add legacy textual continuation stops because labels such as `Response:` may occur during the analysis-to-final transition. `sampler_seed: -1` lets KoboldCpp choose the seed.

KoboldCpp counts reasoning and final text inside one completion. To preserve approximately the configured final-answer allowance, the backend requests a larger combined completion for reasoning modes:

| Thinking mode | Native reasoning budget | Combined completion request |
| --- | --- | --- |
| Disabled | 0 | final-answer allowance |
| Minimal | up to 10% | allowance divided by 0.9 |
| Low | up to 25% | allowance divided by 0.75 |
| Medium | up to 50% | twice the allowance |
| High | up to 4,096 tokens | allowance plus 4,096 reasoning tokens |

The server context window remains the hard upper bound, so the High reasoning budget is reduced only when necessary to preserve the final-answer allowance inside that window. A completion that ends with `finish_reason: length`, or returns reasoning without final content, is rejected rather than passing a truncated prompt into the image workflow or silently retrying with thinking disabled.

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

### Remote KoboldCpp hosts

The backend rejects non-loopback KoboldCpp URLs by default to prevent a saved workflow or browser request from making arbitrary outbound HTTP calls. To permit a known remote server, set `LLLM_KOBOLD_ALLOWED_HOSTS` before starting ComfyUI. It accepts a comma-separated list of exact hostnames or IP addresses:

```text
LLLM_KOBOLD_ALLOWED_HOSTS=192.168.1.25,kobold.example.internal
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
POST /lllm/prompt-studio/revise
```

KoboldCpp requests remain on the Python side, so the browser does not need direct access to the local model server.

## Updating and troubleshooting

- Restart ComfyUI after changing Python files or updating this extension.
- Refresh the browser after frontend-only changes.
- If Prompt Studio cannot find a workflow prompt, add or refresh a **KoboldCpp Prompt Slot** or **KoboldCpp Prompt Amplify** node.
- If prompt creation fails, confirm that KoboldCpp is running and that its URL is correct. The default is `http://localhost:5001`.
- If prompt creation succeeds but no image appears, queue the workflow normally in ComfyUI and fix any disconnected or invalid generation nodes first.
- If Prompt Studio reports a save conflict, reload it to obtain the newest chat or workflow-profile revision before making further changes.

## Development checks

Run these checks from the repository root after making changes:

```powershell
python -c "from pathlib import Path; [compile(Path(p).read_text(encoding='utf-8'), p, 'exec') for p in ('nodes.py', 'routes.py')]"
node --check web/js/prompt_studio.js
node --check web/js/prompt_studio_standalone.js
python -m unittest discover -s tests -v
git diff --check
```
