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

Prompt Studio uses `http://localhost:5001` as the default KoboldCpp endpoint. Change **KoboldCpp URL** in the generation controls if your server uses another address.

> Want to use the chat UI without an LLM? Turn off **Use LLM amplification**. The composer becomes a direct canonical-prompt editor and **Generate** sends that text straight to ComfyUI.

## The interactive workflow

### Create, revise, and inspect

The first message in a new chat creates a complete prompt. Later messages are treated as revisions to that prompt rather than as a transcript for the model. Prompt Studio sends KoboldCpp only the current canonical prompt, the requested change, and the active generation controls.

Revisions use the smallest edit scope implied by the request. References that conflict with the requested change are replaced, while unrelated clauses and tags are preserved where possible. Style and framing constrain the edit; embellishment controls detail within the edited scope.

The **Canonical prompt** panel always shows the exact prompt that will be used next. You can edit it manually, restore an earlier version with **Undo**, or inspect and restore the prompt recorded with any generated-image message.

### Generate and reroll

With **Generate after revision** enabled, creating or revising a prompt immediately queues an API-format snapshot of the active ComfyUI workflow. Generated images appear in the chat, can be opened at full size, and can be scaled down in the conversation with the interface **Image scale** setting.

Prompt changes keep the current ComfyUI seed, making before-and-after comparisons easier. **New seed on reroll** randomizes widgets named `seed` or `noise_seed` only when **Reroll**, or an unchanged **Generate**, queues the same prompt and controls again. Turn it off to keep the current seed on rerolls too.

If you change the model profile, style, framing, modifiers, or embellishment level, **Reroll** or an empty **Revise & Generate** first asks KoboldCpp to apply those controls to the canonical prompt. A direct ComfyUI reroll is used when the controls already match.

### Sessions and persistence

The **Sessions** sidebar creates, switches, and deletes independent prompt conversations. Each session remembers its canonical prompt, prompt versions, messages, selected workflow prompt node, and the generation controls last applied by KoboldCpp.

Chats are stored in `prompt_studio_chats.json` beside the extension's Python files. The file is excluded from Git and is shared by browsers connected to the same ComfyUI installation.

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
- `thinking_mode`: selects KoboldCpp reasoning effort from **Disabled** through **High**. Reasoning wrappers and text before `Final prompt:` are removed from the node output.
- `secondary_instructions`: passes through unchanged to the second output and is not part of the LLM request.

The remaining controls configure the KoboldCpp request: URL, response-token limit, temperature, `top_p`, `top_k`, `min_p`, repetition penalty and range, sampler seed, stop sequences, and request timeout. Set `max_response_tokens` to `0` to use the selected profile's default. The value is clamped when KoboldCpp reports a lower server maximum. Use one stop sequence per line; `sampler_seed: -1` lets KoboldCpp choose the seed.

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

Use it when you want a raw local-LLM call inside a workflow rather than an image-prompt rewrite. It shares the connection, sampling, token-limit, timeout, stop-sequence, seed, and thinking controls used by the amplification nodes.

## Profiles and presets

### Model profiles

Edit `model_profiles.json` to add prompt formats for different image models:

```json
{
  "name": "Tag-Based Anime Model",
  "style": "comma_tags",
  "default_max_response_tokens": 120,
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

`example_prompts` teach format only; their subjects should not be copied into the result. Older profiles containing one `example_prompt` string remain supported. `notes` may be an empty string, a string, or a list of strings. Exact `final_prompt_prefix` and `final_prompt_suffix` values are applied after rewriting.

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
