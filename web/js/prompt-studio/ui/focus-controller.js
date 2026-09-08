import { createFeatureController } from "./feature-controller.js";

/** Document-owned focus and transient overlays; never owns generation jobs. */
export function createImageFocusController({ state, closeSystemStatus, openPromptStudioDialog,
  toggleConsult, toggleStudioSettings, trapDialogFocus, closeMutationManager, closePanelDrawers,
  isEditableTarget, typeAnywhereInput, insertTypedCharacter }) {
  return createFeatureController({
    mount(ownerDocument, scope) {
      const view = ownerDocument?.defaultView;
      if (!view) return;
      scope.listen(view, "click", (event) => {
        if (
          !state.panel
          || state.panel.hidden
          || state.panel.ownerDocument !== ownerDocument
        ) return;
        const statusControl = state.panel.querySelector("#promptstudio-kobold-control");
        if (statusControl?.open && !statusControl.contains(event.target)) closeSystemStatus();

        // Let the active modal handle its own backdrop and controls without
        // dismissing an underlying consultation or settings layer first.
        if (openPromptStudioDialog()) return;

        const target = event.target;
        const consult = state.panel.querySelector("#promptstudio-consult");
        const consultToggles = state.panel.querySelectorAll(".promptstudio-consult-toggle");
        if (
          consult
          && !consult.hidden
          && !consult.contains(target)
          && ![...consultToggles].some((button) => button.contains(target))
        ) {
          toggleConsult(false);
        }

        const settings = state.panel.querySelector("#promptstudio-studio-settings");
        const settingsToggle = state.panel.querySelector("#promptstudio-toggle-studio-settings");
        if (
          settings
          && !settings.hidden
          && !settings.contains(target)
          && !settingsToggle?.contains(target)
        ) {
          toggleStudioSettings(false);
        }
      }, { capture: true });
      scope.listen(view, "keydown", (event) => {
        const dialog = openPromptStudioDialog();
        if (dialog && trapDialogFocus(dialog, event)) {
          event.stopPropagation();
          return;
        }
        if (
          !event.defaultPrevented
          && event.key === "Escape"
          && state.panel
          && !state.panel.hidden
          && state.panel.ownerDocument === ownerDocument
          && !openPromptStudioDialog()
        ) {
          if (closeSystemStatus({ restoreFocus: true })) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          const mutationManager = state.panel.querySelector("#promptstudio-mutation-manager");
          if (mutationManager && !mutationManager.hidden) {
            event.preventDefault();
            event.stopPropagation();
            closeMutationManager();
            return;
          }
          const settings = state.panel.querySelector("#promptstudio-studio-settings");
          if (settings && !settings.hidden) {
            event.preventDefault();
            event.stopPropagation();
            toggleStudioSettings(false);
            state.panel.querySelector("#promptstudio-toggle-studio-settings")?.focus();
            return;
          }
          const consult = state.panel.querySelector("#promptstudio-consult");
          if (consult && !consult.hidden) {
            event.preventDefault();
            event.stopPropagation();
            toggleConsult(false);
            state.panel.querySelector("#promptstudio-toggle-consult")?.focus();
            return;
          }
          if (
            state.panel.classList.contains("promptstudio-chats-open")
            || state.panel.classList.contains("promptstudio-inspector-open")
          ) {
            event.preventDefault();
            event.stopPropagation();
            closePanelDrawers();
            return;
          }
        }
        if (
          event.defaultPrevented
          || !state.panel
          || state.panel.hidden
          || state.panel.ownerDocument !== ownerDocument
          || openPromptStudioDialog()
          || isEditableTarget(event.target)
          || isEditableTarget(ownerDocument.activeElement)
        ) return;

        const input = typeAnywhereInput(ownerDocument);
        if (!input || input.disabled || input.readOnly) return;

        if (event.isComposing || event.key === "Dead" || event.key === "Process") {
          input.focus({ preventScroll: true });
          return;
        }

        const altGraph = event.getModifierState?.("AltGraph");
        if (
          event.metaKey
          || (!altGraph && (event.ctrlKey || event.altKey))
          || [...event.key].length !== 1
        ) return;

        event.preventDefault();
        event.stopPropagation();
        insertTypedCharacter(input, event.key);
      }, { capture: true });
    },
  });
}
