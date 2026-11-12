import {app} from "/scripts/app.js";

// The backend exposes a bounded schema; the canvas shows exactly the configured options.
app.registerExtension({
  name: "PromptStudio.IntermediateChoice",
  beforeRegisterNodeDef(Node, data) {
    if (data.name !== "PS_IntermediateChoice") return;
    const sync = node => {
      const options = String(node.widgets?.find(w => w.name === "options")?.value || "Refine")
        .split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 32);
      while (node.outputs?.length > options.length) node.removeOutput(node.outputs.length - 1);
      options.forEach((label, index) => {
        if (!node.outputs?.[index]) node.addOutput(label, "IMAGE");
        node.outputs[index].name = label;
      });
      node.setDirtyCanvas?.(true, true);
    };
    const created = Node.prototype.onNodeCreated;
    Node.prototype.onNodeCreated = function(...args) {
      const result = created?.apply(this, args);
      const internal = this.inputs?.findIndex(input => input.name === "_choice_token");
      if (internal >= 0) this.removeInput(internal);
      const widget = this.widgets?.find(w => w.name === "options"), callback = widget?.callback;
      if (widget) widget.callback = (...values) => { callback?.apply(this, values); sync(this); };
      sync(this);
      return result;
    };
    const configured = Node.prototype.onConfigure;
    Node.prototype.onConfigure = function(...args) { const result = configured?.apply(this, args); sync(this); return result; };
  },
});
