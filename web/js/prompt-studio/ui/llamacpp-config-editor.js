import { api } from "/scripts/api.js";
import { LLAMACPP_CONFIG_BUILDER_ENDPOINT } from "../core/constants.js";
import { installDialogFocus } from "./dialog-focus.js";

// Aliases follow the launcher's precedence. Saving replaces aliases with one canonical key.
const aliases = {
  model_gguf: ["model", "model_gguf"], mmproj_gguf: ["mmproj", "mmproj_gguf"],
  context_size: ["context_size", "ctx_size"], gpu_layers: ["gpu_layers", "n_gpu_layers"],
  parallel_slots: ["parallel_slots", "parallel"], main_gpu: ["main_gpu", "main_gpu_index"],
  auto_fit: ["auto_fit", "fit"], flash_attention: ["flash_attention", "flash_attn"],
  kv_cache_k: ["kv_cache_k", "cache_type_k"], kv_cache_v: ["kv_cache_v", "cache_type_v"],
  mtp_enabled: ["mtp_enabled", "mtp"], mtp_draft_tokens: ["mtp_draft_tokens", "spec_draft_n_max"],
  mtp_min_draft_tokens: ["mtp_min_draft_tokens", "spec_draft_n_min"],
  mtp_min_probability: ["mtp_min_probability", "spec_draft_p_min"],
  mtp_gpu_layers: ["mtp_gpu_layers", "spec_draft_gpu_layers"], mtp_device: ["mtp_device", "spec_draft_device"],
  mtp_kv_cache_k: ["mtp_kv_cache_k", "spec_draft_cache_type_k"], mtp_kv_cache_v: ["mtp_kv_cache_v", "spec_draft_cache_type_v"],
};
// key, label, default, choices or numeric range, help
const groups = [
  ["Model and server", false, [
    ["model_gguf", "Model GGUF", "", null, "Path on the ComfyUI computer."],
    ["mmproj_gguf", "MMProj GGUF", "", null, "Optional projector for vision models."],
    ["context_size", "Context size", 32768, [128, 16777216]],
    ["parallel_slots", "Parallel slots", 1, [1, 1024]],
    ["host", "Host", "127.0.0.1"], ["port", "Port", 8080, [1, 65535]],
  ]],
  ["GPU and memory", false, [
    ["gpu_layers", "GPU layers", "all", null, "all or a non-negative layer count."],
    ["cuda_devices", "CUDA devices", "", null, "Optional --device list, for example CUDA0,CUDA1."],
    ["cuda_visible_devices", "CUDA visible devices", "", null, "Optional CUDA_VISIBLE_DEVICES override."],
    ["split_mode", "Split mode", "layer", ["none", "layer", "row", "tensor"]],
    ["main_gpu", "Main GPU", 0, [0, 1024], "Physical CUDA index; translated when the device list is filtered."],
    ["tensor_split", "Tensor split", "", null, "Optional proportions, for example 2,1,1."],
    ["auto_fit", "Auto-fit", "default", ["default", "on", "off"]],
    ["flash_attention", "Flash attention", "auto", ["auto", "on", "off"]],
    ["kv_cache_k", "KV cache K", "f16"], ["kv_cache_v", "KV cache V", "q8_0"],
  ]],
  ["Multi-token prediction (MTP)", false, [
    ["mtp_enabled", "MTP", "off", ["off", "on"], "Requires an MTP-capable GGUF and compatible llama.cpp build."],
    ["mtp_draft_tokens", "MTP draft tokens", 3, [1, 1024]],
    ["mtp_min_draft_tokens", "MTP minimum tokens", 0, [0, 1024]],
    ["mtp_min_probability", "MTP minimum probability", 0, [0, 1, "any"]],
    ["mtp_gpu_layers", "MTP GPU layers", "auto", null, "auto, all or a non-negative layer count."],
    ["mtp_device", "MTP device", ""], ["mtp_kv_cache_k", "MTP KV cache K", "f16"],
    ["mtp_kv_cache_v", "MTP KV cache V", "f16"],
  ]],
  ["Modes and response", true, [
    ["thinking_modes", "Thinking modes", [], "modes", "Comma-separated: Minimal, Low, Medium, High, XHigh, Einstein, Spoon. Qwen 3.8 uses XHigh, Medium, and Low."],
    ["instruct_modes", "Instruct modes", [], "modes", "Comma-separated: Disabled, Low, Medium, XHigh, Einstein, Spoon. Disabled means Off; leave empty if unsupported."],
    ["thinking_mode", "Default mode", "Low", []],
    ["max_response_tokens", "Response tokens", 800, [0, 8192], "0 uses the request's automatic limit."],
    ["llamacpp_reasoning_budget_tokens", "Reasoning token cap", 0, [0, 262144], "0 leaves reasoning length to the model."],
    ["sampler_seed", "Sampler seed", -1, [-1, 999999]],
    ["request_timeout", "Inactivity timeout", 120, [5, 600], "Seconds without generation progress or confirmed server processing."],
    ["stop_sequence", "Stop sequences", "", "lines", "One per line."],
  ]],
  ...[false, true].map(thinking => [thinking ? "Thinking sampler" : "Instruct sampler", true,
    [["temperature", "Temperature", 0.7, [0, 5, "any"]], ["top_p", "Top P", 0.9, [0, 1, "any"]],
      ["top_k", "Top K", 100, [0, 200]], ["min_p", "Min P", 0, [0, 1, "any"]],
      ["presence_penalty", "Presence penalty", 0, [-2, 2, "any"]],
      ["rep_pen", "Repeat penalty", 1.05, [0.5, 3, "any"]], ["rep_pen_range", "Repeat range", 360, [0, 4096]]]
      .map(([key, ...rest]) => [thinking ? `thinking_${key}` : key, ...rest])]),
  ["Advanced", false, [["extra_args", "Extra arguments", [], "tokens", "One argument token per line; no shell quoting."]]],
];

async function request(data) {
  const response = await api.fetchApi(LLAMACPP_CONFIG_BUILDER_ENDPOINT, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not update the Llama.cpp config.");
  return result;
}

export function openLlamacppConfigEditor(container, { profile = "", createNew = false, onSaved } = {}) {
  if (container.querySelector(".promptstudio-config-editor")) return;
  const doc = container.ownerDocument;
  const trigger = doc.activeElement;
  const el = (tag, text = "", className = "") => Object.assign(doc.createElement(tag), { textContent: text, className });
  const dialog = el("dialog", "", "promptstudio-config-editor");
  dialog.setAttribute("aria-label", "Llama.cpp config builder");
  installDialogFocus(dialog);
  const form = el("form");
  const header = el("header");
  header.append(el("h2", createNew ? "New Llama.cpp config" : "Edit Llama.cpp config"));
  const content = el("div", "", "promptstudio-config-editor-content");
  const message = el("p", "Loading config…");
  message.setAttribute("role", "status");
  const footer = el("footer");
  const cancel = el("button", "Cancel"); cancel.type = "button";
  const save = el("button", "Save config"); save.type = "submit"; save.disabled = true;
  footer.append(message, cancel, save);
  form.append(header, content, footer); dialog.append(form);
  let busy = false;
  let loaded;
  let config;
  const controls = new Map();
  const name = el("input"); name.name = "profile_name"; name.required = true;
  name.value = createNew ? "" : profile; name.readOnly = !createNew; name.placeholder = "my-model.json";
  const nameLabel = el("label", "Profile filename"); nameLabel.append(name); content.append(nameLabel);
  const setBusy = value => {
    busy = value;
    form.querySelectorAll("input,select,textarea,button").forEach(node => { node.disabled = value; });
  };
  cancel.addEventListener("click", () => dialog.close());
  form.addEventListener("invalid", event => {
    const section = event.target.closest("details");
    if (section) section.open = true;
    message.textContent = event.target.validationMessage;
  }, true);
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("keydown", event => event.stopPropagation());
  dialog.addEventListener("close", () => { dialog.remove(); trigger?.focus({ preventScroll: true }); });
  function render() {
    config = structuredClone(loaded.config);
    const llm = config.llm_profile || {};
    // Legacy profiles keep precisely their supported modes, including intentionally missing Off.
    if (!Object.hasOwn(llm, "instruct_modes")) {
      llm.instruct_modes = (llm.thinking_modes || []).filter(v => v === "Disabled" || v.startsWith("Instruct ")).map(v => v.replace(/^Instruct /, ""));
      llm.thinking_modes = (llm.thinking_modes || []).filter(v => v !== "Disabled" && !v.startsWith("Instruct "));
    }
    config.llm_profile = llm;
    for (const [title, isLlm, fields] of groups) {
      const section = el("details"); section.open = title === "Model and server" || title === "Modes and response";
      section.append(el("summary", title));
      if (title === "Modes and response") section.append(el("p", "Check the model card for supported modes. Unsupported modes may fail or produce unpredictable results."));
      const grid = el("div", "", "promptstudio-config-fields"); section.append(grid);
      for (const [key, label, fallback, type, help] of fields) {
        const source = isLlm ? llm : config;
        const sourceKey = (isLlm ? [key] : aliases[key] || [key]).find(k => Object.hasOwn(source, k));
        let value = sourceKey ? source[sourceKey] : fallback;
        if (key === "mtp_enabled" && typeof value === "boolean") value = value ? "on" : "off";
        const numeric = typeof fallback === "number";
        const select = Array.isArray(type) && !numeric;
        const input = el(select ? "select" : ["tokens", "lines"].includes(type) ? "textarea" : "input");
        input.name = key;
        if (select) for (const option of new Set([...type, String(value)])) {
          const node = el("option", option === "Disabled" ? "Off" : option); node.value = option; input.append(node);
        }
        if (numeric) { input.type = "number"; [input.min, input.max, input.step] = [type[0], type[1], type[2] || 1]; }
        if (numeric || ["model_gguf", "host", "gpu_layers", "mtp_gpu_layers", "kv_cache_k", "kv_cache_v", "mtp_kv_cache_k", "mtp_kv_cache_v"].includes(key)) input.required = true;
        input.value = Array.isArray(value) ? value.join(type === "tokens" ? "\n" : ", ") : String(value);
        if (key === "stop_sequence") input.maxLength = 4096;
        const field = el("label", label); field.append(input);
        if (help) field.append(el("small", help));
        grid.append(field);
        controls.set(key, { input, isLlm, type, numeric });
        if (["model_gguf", "mmproj_gguf"].includes(key) && loaded.can_browse) {
          const browse = el("button", "Browse…"); browse.type = "button";
          browse.setAttribute("aria-label", `Browse ${label}`);
          // Keep the button outside the input's label.
          const wrapper = el("div"); field.replaceWith(wrapper); wrapper.append(field, browse);
          browse.addEventListener("click", async () => {
            setBusy(true); message.textContent = "Select a file on the ComfyUI computer…";
            try {
              const response = await api.fetchApi("/promptstudio/prompt-studio/llamacpp/pick-file", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ kind: key === "model_gguf" ? "model" : "mmproj", current_path: input.value }),
              });
              const result = await response.json();
              if (!response.ok) throw new Error(result.error || "File picker unavailable; enter the path manually.");
              if (result.path) { input.value = result.path; input.dispatchEvent(new Event("input")); }
              message.textContent = "";
            } catch (error) { message.textContent = error.message; }
            finally { setBusy(false); browse.focus(); }
          });
        }
      }
      content.append(section);
    }
    const modes = key => controls.get(key).input.value.split(/[,\r\n]+/).map(v => v.trim()).filter(Boolean);
    const updateModes = () => {
      const input = controls.get("thinking_mode").input;
      const previous = input.value;
      const values = [...modes("thinking_modes"), ...modes("instruct_modes").map(v => v === "Disabled" ? v : `Instruct ${v}`)];
      input.replaceChildren();
      for (const value of new Set(values)) { const option = el("option", value === "Disabled" ? "Off" : value); option.value = value; input.append(option); }
      if (values.includes(previous)) input.value = previous;
    };
    for (const key of ["thinking_modes", "instruct_modes"]) controls.get(key).input.addEventListener("input", updateModes);
    updateModes();
    message.textContent = "Save updates the shared profile. A running managed server applies it when LLM work is idle.";
    save.disabled = false;
    (createNew ? name : controls.get("model_gguf").input).focus();
  }
  form.addEventListener("submit", async event => {
    event.preventDefault(); if (busy || !loaded) return;
    const edited = structuredClone(config);
    for (const [key, { input, isLlm, type, numeric }] of controls) {
      const target = isLlm ? edited.llm_profile : edited;
      if (!isLlm) for (const alias of aliases[key] || []) delete target[alias];
      target[key] = numeric ? Number(input.value) : type === "modes" ? input.value.split(/[,\r\n]+/).map(v => v.trim()).filter(Boolean)
        : type === "tokens" ? input.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean) : input.value;
    }
    let filename = name.value.trim(); if (!/\.json$/i.test(filename)) filename += ".json";
    setBusy(true); message.textContent = "Saving config…";
    try {
      const result = await request({ action: "save", llamacpp_config_profile: filename, revision: loaded.revision, config: edited });
      loaded.revision = result.revision;
      name.value = filename; name.readOnly = true;
      await onSaved?.(result);
      dialog.close();
    } catch (error) { message.textContent = error.message; }
    finally { setBusy(false); }
  });
  container.append(dialog); dialog.showModal();
  request({ action: createNew ? "new" : "load", llamacpp_config_profile: profile }).then(result => {
    if (!dialog.isConnected) return;
    if (!result.native_editor || !result.config || typeof result.config !== "object") throw new Error("Restart ComfyUI to load the native config editor.");
    loaded = result; render();
  }).catch(error => { if (dialog.isConnected) message.textContent = error.message; });
}
