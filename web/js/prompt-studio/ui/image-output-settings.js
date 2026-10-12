import { getImageOutputSettings, saveImageOutputSettings } from "../settings/image-output.js";

export function updateImageOutputWorkflowNotice(container, workflows = []) {
  const notice = container?.querySelector("[data-output-workflow-notice]");
  if (!notice) return;
  const lines = [];
  for (const workflow of workflows.filter(Boolean)) {
    for (const [id, node] of Object.entries(workflow.snapshot?.output || {})) {
      if (node.class_type !== "Save_as_webp_cond" || node.inputs?.force !== true) continue;
      const format = node.inputs.format === "png" ? "PNG (always lossless; preserves transparency)"
        : `WebP (${node.inputs.mode || "lossy"})`;
      lines.push(`${workflow.name || "Selected workflow"}: node ${id} forces ${format}. Uses node settings.`);
    }
  }
  notice.textContent = lines.join("\n");
  notice.hidden = !lines.length;
}

export function mountImageOutputSettings(container, workflows = []) {
  const doc = container.ownerDocument;
  const section = doc.createElement("section");
  section.className = "promptstudio-image-output-settings promptstudio-studio-settings-card";
  section.setAttribute("aria-label", "Image output");
  section.innerHTML = `
    <header class="promptstudio-studio-settings-card-header"><div><strong>Image output</strong><span>PNG and WebP · shared across studios</span></div></header>
    <div class="promptstudio-image-output-fields">
      <label>Format<select data-output="format"><option value="webp">WebP</option><option value="png">PNG</option></select></label>
      <label data-format="webp">Mode<select data-output="mode"><option value="lossy">Lossy</option><option value="lossless">Lossless</option></select></label>
      <label data-mode="lossy">Quality<input data-output="quality" type="number" min="1" max="100" step="1"></label>
      <label data-mode="lossless">Compression effort<input data-output="lossless_effort" type="number" min="1" max="100" step="1"></label>
      <label data-format="webp">Encoding effort<input data-output="webp_method" type="number" min="0" max="6" step="1"></label>
      <label data-format="png">Compression level<input data-output="png_compression" type="number" min="0" max="9" step="1"></label>
      <label data-format="png" class="promptstudio-image-output-check"><input data-output="png_optimize" type="checkbox">Optimize PNG</label>
    </div>
    <p data-output-help></p>
    <p data-output-workflow-notice role="status" hidden></p>
    <details class="promptstudio-image-output-about"><summary>How overrides work</summary><p>Saved automatically in this browser. Applies to Save as WebP Conditional nodes on future generations. Enable <strong>force</strong> on a node to keep its settings. Exact replays retain saved settings.</p></details>
    <p data-output-error role="status" hidden></p>`;
  function refresh() {
    const settings = getImageOutputSettings();
    for (const input of section.querySelectorAll("[data-output]")) {
      if (input.type === "checkbox") input.checked = settings[input.dataset.output];
      else input.value = String(settings[input.dataset.output]);
    }
    for (const row of section.querySelectorAll("[data-format]")) row.hidden = row.dataset.format !== settings.format;
    for (const row of section.querySelectorAll("[data-mode]")) row.hidden = settings.format !== "webp" || row.dataset.mode !== settings.mode;
    section.querySelector('[data-output="png_compression"]').disabled = settings.png_optimize;
    section.querySelector("[data-output-help]").textContent = settings.format === "png"
      ? "Always lossless, with transparency. Optimize overrides compression level."
      : settings.mode === "lossless"
        ? "Preserves pixels and transparency. More effort saves space but takes longer."
        : "Higher quality preserves detail; more effort saves space. Supports transparency.";
  }
  section.addEventListener("change", event => {
    const control = event.target.closest("[data-output]");
    if (!control) return;
    const error = section.querySelector("[data-output-error]");
    try {
      saveImageOutputSettings({ ...getImageOutputSettings(), [control.dataset.output]: control.type === "checkbox" ? control.checked : control.value });
      error.hidden = true;
      refresh();
    } catch (exception) {
      error.textContent = exception.message || "Image output settings could not be saved.";
      error.hidden = false;
    }
  });
  container.replaceChildren(section);
  refresh();
  updateImageOutputWorkflowNotice(container, workflows);
  return { refresh };
}
