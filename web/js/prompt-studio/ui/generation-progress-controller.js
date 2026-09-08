import { createFeatureController } from "./feature-controller.js";

/** Application-owned event projection. Chat/view switches do not dispose it. */
export function createImageGenerationProgressController({ state, studioGenerationRecord,
  setStudioGenerationState, updatePlotPromptState, updateGenerationProgress,
  executionFailureMessage, failTrackedGeneration }) {
  return createFeatureController({
    mount(api, scope) {
      const eventPromptId = (event) => String(
        event?.detail?.prompt_id || event?.detail?.promptId || state.activeGenerationPromptId || "",
      );
      scope.listen(api, "execution_start", (event) => {
        const promptId = eventPromptId(event);
        if (studioGenerationRecord(promptId)) {
          state.activeGenerationPromptId = promptId;
          setStudioGenerationState(promptId, "generating");
        }
        updatePlotPromptState(promptId, "generating");
        updateGenerationProgress(promptId, { phase: "generating" });
      });
      scope.listen(api, "executing", (event) => {
        updateGenerationProgress(eventPromptId(event), {
          phase: event?.detail == null ? "finalizing" : "generating",
        });
      });
      scope.listen(api, "progress", (event) => {
        updateGenerationProgress(eventPromptId(event), {
          phase: "generating",
          value: Number(event?.detail?.value),
          max: Number(event?.detail?.max),
        });
      });
      scope.listen(api, "progress_state", (event) => {
        const running = Object.values(event?.detail?.nodes || {})
          .filter((node) => node?.state === "running");
        if (!running.length) return;
        updateGenerationProgress(eventPromptId(event), {
          phase: "generating",
          value: running.reduce((total, node) => total + Number(node?.value || 0), 0),
          max: running.reduce((total, node) => total + Number(node?.max || 0), 0),
        });
      });
      scope.listen(api, "execution_success", (event) => {
        updateGenerationProgress(eventPromptId(event), { phase: "finalizing" });
      });
      for (const eventName of ["execution_error", "execution_interrupted"]) {
        scope.listen(api, eventName, (event) => {
          const promptId = eventPromptId(event);
          const message = executionFailureMessage(eventName, event?.detail);
          failTrackedGeneration(promptId, message);
          updatePlotPromptState(promptId, "failed", message);
        });
      }
    },
  });
}
