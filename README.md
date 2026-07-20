# ComfyUI_LLLM

ComfyUI Local LLM custom nodes for using a local KoboldCpp instance from ComfyUI.

## Nodes

### KoboldCpp Prompt Amplify

Rewrites a plain text prompt through KoboldCpp and returns the amplified prompt as a `STRING`. Its optional `secondary_instructions` input is returned unchanged from a second output and is never sent to KoboldCpp.

### KoboldCpp Prompt Slot and Prompt Studio

`KoboldCpp Prompt Slot` is a pass-through `STRING` node used as a stable attachment point for the Prompt Studio frontend. Prompt Studio can also attach directly to a `KoboldCpp Prompt Amplify` node. Both node types expose a second `secondary_instructions` pass-through output so Studio generations retain the same output shape when Amplify is bypassed.

Prompt Studio is an iterative prompt editor that appears as a floating button in ComfyUI after this custom node package is loaded. It:

- Reads the current text from a selected Prompt Slot or Prompt Amplify node.
- Creates a complete initial prompt from the first message in each new chat.
- Sends the current complete prompt plus one requested revision to KoboldCpp.
- Writes the full replacement prompt back into the selected prompt node.
- Optionally queues the active ComfyUI workflow and displays its output images in an in-window preview with a separate new-tab action.
- Stores the exact canonical prompt used by each new generated-image message, with an info control to view or restore it.
- Offers an Image scale setting for more compact chat previews without changing the full-size lightbox.
- Keeps local prompt versions for Undo without sending the chat transcript to the LLM.
- Can reroll the current prompt without another LLM call.
- Can move the complete live interface into its own browser tab from the embedded ComfyUI header.
- Keeps a persistent Chats sidebar for creating, deleting, and switching between prompt sessions, opening each chat at its latest message.

To use it:

1. Restart ComfyUI after installing or updating the extension.
2. Add `KoboldCpp Prompt Slot` or reuse an existing `KoboldCpp Prompt Amplify` node.
3. Connect its `prompt` output to the positive prompt input or text encoder used by the workflow.
4. If Prompt Studio is attached to a Prompt Amplify node, generations queued from Studio automatically use that node as a pass-through Prompt Slot. Normal workflow runs still execute Prompt Amplify normally.
5. Open **Prompt Studio** using the button at the lower-right of the ComfyUI window.
6. Select the desired prompt node, choose the profile/style/framing settings, and describe the initial image. Later messages revise the resulting prompt, for example `make the background more varied`.

When **Generate after revision** is enabled, Prompt Studio submits an API-format snapshot of the active workflow to ComfyUI. **New seed** randomizes widgets named `seed` or `noise_seed` before that snapshot is created. Disable it to compare prompt changes using the current seed.

Disable **Use LLM amplification** to use Prompt Studio without KoboldCpp. In direct prompt mode, the LLM controls and sidebar canonical-prompt editor are hidden, the main composer becomes the canonical prompt editor, and **Generate** queues that text directly through ComfyUI. An attached Prompt Amplify node is converted to a Prompt Slot only in the queued Studio snapshot, so it does not call KoboldCpp. The saved workflow and normal ComfyUI runs keep the node's original behavior.

Each chat records the prompt-generation controls that were last applied by KoboldCpp. If those controls change, either **Reroll** or an empty **Revise & Generate** request first rewrites the current prompt through KoboldCpp with the new profile, style, framing, modifiers, and embellishment settings. A direct ComfyUI reroll is used only when the controls already match the current prompt.

Prompt Studio revisions use the smallest edit scope implied by the request. Conflicting references to the edited target are replaced everywhere, while unrelated clauses or tags are preserved in wording and order where possible. Embellishment controls how much detail may be added inside that scope only; style and framing settings constrain the edit without authorizing unrelated scene changes.

The revision API is served by ComfyUI at:

```text
POST /lllm/prompt-studio/revise
```

KoboldCpp calls remain on the Python side, so the browser does not need direct access to the KoboldCpp server.

Chats are stored by the custom node in `prompt_studio_chats.json` beside its Python files. The file is excluded from Git and shared by browsers that connect to the same ComfyUI installation. Chats are labeled with their creation timestamp. **New chat** starts empty: its first message creates the initial prompt through KoboldCpp, while later messages revise that prompt. Selecting an older chat restores its canonical prompt and writes it into that chat's remembered prompt node. The center column is reserved for chat history and the composer; workflow attachment, status, canonical prompt, and generation controls live in the right inspector.

The standalone page at `/extensions/ComfyUI_LLLM/prompt_studio.html` reconnects on direct navigation or refresh. It first uses an open ComfyUI tab when available, then starts a hidden same-origin ComfyUI workflow host as a reliable fallback.

### KoboldCpp Apply

Sends the text input directly to KoboldCpp as the full prompt/context and returns the generated text as a `STRING`. It uses the same KoboldCpp connection, sampler, response length, timeout, stop sequence, seed, and `thinking_mode` controls as Prompt Amplify, but does not add model-profile, style, embellishment, or prompt-amplification instructions.

### Ideogram4-KoboldCPP

Parses an Ideogram v4-style JSON object, rewrites selected prompt strings one at a time through KoboldCpp, and returns the updated JSON.

Processed fields:

```text
high_level_description
compositional_deconstruction.background
compositional_deconstruction.elements[*].desc when element type is not "text"
```

Preserved fields:

```text
compositional_deconstruction.elements[*].bbox
compositional_deconstruction.elements[*].type
compositional_deconstruction.elements[*].text
entire elements where type is "text"
unknown keys
```

Each extracted string is sent as its own LLM request so regional descriptions do not bleed into each other. The LLM is not shown the JSON structure, bounding boxes, or field names; it only sees the prompt fragment plus the selected model profile, style, embellishment, thinking, and additional-instruction settings.

The default server URL is:

```text
http://localhost:5001
```

Use `additional_instructions` for per-run task guidance without editing `model_profiles.json`. It can be left empty.

Use `style_preset` and `style_modifier` for aesthetic guidance without changing the target model profile. Style presets are configured in `style_templates.json`, while `style_modifier` is freeform per-run text and can be left empty.
When a style preset or modifier is present, it is treated as the target style for the whole rewritten prompt. Conflicting style, medium, quality, camera, or rendering terms in the input should be replaced while preserving the subject and concrete content.

Use `framing_preset` and `framing_modifier` for composition, viewpoint, shot type, angle, and subject placement. Framing presets are configured in `framing_templates.json`, while `framing_modifier` is freeform per-run text and can be left empty.
When a framing preset or modifier is present, it is treated as the target framing for the whole rewritten prompt. Conflicting framing, composition, viewpoint, shot type, or camera-angle terms in the input should be replaced while preserving the subject and concrete content.

Use `embellishment_level` to control how much the node expands the prompt after style conversion. `Minimal` keeps changes short, `Clean` lightly improves wording, `Detailed` adds useful visible details, `Rich` creates polished descriptive output, and `Maximum` allows the most elaborate prompt expansion. For tag-style profiles this controls tag density instead of prose length.

Use `thinking_mode` to control model reasoning support. `Disabled` sends `reasoning_effort: "none"` and asks for no visible reasoning. `Minimal`, `Low`, `Medium`, and `High` send that `reasoning_effort` value and start a `Reasoning:` section with increasing detail before the final prompt. The node asks the model to finish with `Final prompt:` and returns only the text after that marker. Visible thinking wrappers such as `<think>...</think>`, `<thinking>...</thinking>`, `<output>...</output>`, and KoboldCpp channel-thought markers are stripped from the final prompt output.

Model prompt styles are configured in `model_profiles.json`. Each profile can include an optional exact prefix and suffix that are added after the LLM finishes rewriting:

```json
{
  "name": "Tag-Based Anime Model",
  "style": "comma_tags",
  "default_max_response_tokens": 120,
  "example_prompts": [
    "person, umbrella, small_building, trees, outdoors, standing, full_body",
    "robot, workbench, bicycle_wheel, garage, repairing, tools, sitting",
    "cat, space_suit, moon, craters, standing, helmet, full_body"
  ],
  "instruction": "Rewrite the user's prompt as concise comma-separated tags.",
  "notes": "Optional model-specific syntax guidance, such as required trigger words, weighting syntax, ordering rules, or formatting constraints.",
  "final_prompt_prefix": "",
  "final_prompt_suffix": ""
}
```

Older profiles with a single `example_prompt` string still work, but `example_prompts` is preferred for multiple examples.
`notes` can be an empty string, a string, or a list of strings.

Set `max_response_tokens` to `0` to use the selected profile's `default_max_response_tokens`.

Style templates are configured separately:

```json
{
  "name": "Casual Snapshot",
  "instruction": "Make the result feel candid, ordinary, and natural. Prefer everyday wording. Avoid polished cinematic, editorial, commercial, or studio-style language."
}
```

Framing templates are configured separately:

```json
{
  "name": "Selfie",
  "instruction": "Frame the subject as a selfie taken by the subject with a phone held at arm's length or on a selfie stick."
}
```
