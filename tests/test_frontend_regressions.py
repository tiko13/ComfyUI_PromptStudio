import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


class FrontendRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = (REPO_ROOT / "web" / "js" / "prompt_studio.js").read_text(encoding="utf-8")
        cls.shell = (
            REPO_ROOT / "web" / "js" / "prompt_studio_shell.js"
        ).read_text(encoding="utf-8")
        cls.constants = (
            REPO_ROOT / "web" / "js" / "prompt-studio" / "core" / "constants.js"
        ).read_text(encoding="utf-8")
        cls.state = (
            REPO_ROOT / "web" / "js" / "prompt-studio" / "core" / "state.js"
        ).read_text(encoding="utf-8")
        cls.background_activity = (
            REPO_ROOT / "web" / "js" / "prompt-studio" / "ui" / "background-activity.js"
        ).read_text(encoding="utf-8")
        cls.video_bridge = (
            REPO_ROOT
            / "web"
            / "js"
            / "prompt-studio"
            / "integrations"
            / "video-studio-bridge.js"
        ).read_text(encoding="utf-8")
        cls.settings_storage = (
            REPO_ROOT / "web" / "js" / "prompt-studio" / "settings" / "storage.js"
        ).read_text(encoding="utf-8")
        cls.llm_profile_store = (
            REPO_ROOT
            / "web"
            / "js"
            / "prompt-studio"
            / "settings"
            / "llm-profile-store.js"
        ).read_text(encoding="utf-8")
        cls.llm_status = (
            REPO_ROOT / "web" / "js" / "prompt-studio" / "llm" / "status.js"
        ).read_text(encoding="utf-8")
        cls.id_source = (
            REPO_ROOT / "web" / "js" / "prompt-studio" / "core" / "id.js"
        ).read_text(encoding="utf-8")
        cls.generation_state = (
            REPO_ROOT / "web" / "js" / "prompt-studio" / "chat" / "generation-state.js"
        ).read_text(encoding="utf-8")
        cls.image_reference = (
            REPO_ROOT / "web" / "js" / "prompt-studio" / "chat" / "image-reference.js"
        ).read_text(encoding="utf-8")
        cls.chat_model = (
            REPO_ROOT / "web" / "js" / "prompt-studio" / "chat" / "model.js"
        ).read_text(encoding="utf-8")
        cls.chat_store = (
            REPO_ROOT / "web" / "js" / "prompt-studio" / "chat" / "store-controller.js"
        ).read_text(encoding="utf-8")
        cls.consult_model = (
            REPO_ROOT / "web" / "js" / "prompt-studio" / "consult" / "model.js"
        ).read_text(encoding="utf-8")
        cls.workflow_profile = (
            REPO_ROOT
            / "web"
            / "js"
            / "prompt-studio"
            / "generation"
            / "workflow-profile.js"
        ).read_text(encoding="utf-8")
        cls.model_name = (
            REPO_ROOT
            / "web"
            / "js"
            / "prompt-studio"
            / "generation"
            / "model-name.js"
        ).read_text(encoding="utf-8")
        cls.workflow_template = (
            REPO_ROOT
            / "web"
            / "js"
            / "prompt-studio"
            / "generation"
            / "workflow-template.js"
        ).read_text(encoding="utf-8")
        cls.prompt_studio_input = (
            REPO_ROOT
            / "web"
            / "js"
            / "prompt-studio"
            / "generation"
            / "prompt-studio-input.js"
        ).read_text(encoding="utf-8")
        cls.plot_model = (
            REPO_ROOT / "web" / "js" / "prompt-studio" / "plot" / "model.js"
        ).read_text(encoding="utf-8")
        cls.styles = (REPO_ROOT / "web" / "css" / "prompt_studio.css").read_text(encoding="utf-8")

    def function_source(self, name, next_name=None, source=None):
        module_source = self.source if source is None else source
        start = module_source.index(f"function {name}")
        if next_name is None:
            return module_source[start:]
        end = min(
            index
            for marker in ("function", "async function", "export function", "export async function")
            if (index := module_source.find(f"\n{marker} {next_name}", start)) >= 0
        )
        return module_source[start:end]

    def test_frontend_modules_keep_an_inward_dependency_direction(self):
        self.assertIn('from "./prompt-studio/core/constants.js"', self.source)
        self.assertIn('from "./prompt-studio/core/state.js"', self.source)
        self.assertIn('from "./prompt-studio/ui/background-activity.js"', self.source)
        self.assertIn('from "./prompt-studio/integrations/video-studio-bridge.js"', self.source)
        self.assertIn('from "./prompt-studio/llm/status.js"', self.source)
        self.assertIn('from "./prompt-studio/settings/llm-profile-store.js"', self.source)
        self.assertIn('from "./prompt-studio/settings/storage.js"', self.source)
        self.assertIn('from "./prompt-studio/core/id.js"', self.source)
        self.assertIn('from "./prompt-studio/chat/generation-state.js"', self.source)
        self.assertIn('from "./prompt-studio/chat/image-reference.js"', self.source)
        self.assertIn('from "./prompt-studio/chat/model.js"', self.source)
        self.assertIn('from "./prompt-studio/chat/store-controller.js"', self.source)
        self.assertIn('from "./prompt-studio/consult/model.js"', self.source)
        self.assertIn('from "./prompt-studio/generation/workflow-profile.js"', self.source)
        self.assertIn('from "./prompt-studio/generation/workflow-template.js"', self.source)
        self.assertIn('from "./prompt-studio/generation/prompt-studio-input.js"', self.source)
        self.assertIn('from "./prompt-studio/generation/model-name.js"', self.source)
        self.assertIn('from "./prompt-studio/plot/model.js"', self.source)
        self.assertIn("hasPendingStudioGenerations,", self.source)
        self.assertNotIn("from ", self.constants)
        self.assertNotIn("from ", self.state)
        self.assertNotIn("prompt_studio.js", self.background_activity)
        self.assertNotIn("prompt_studio.js", self.video_bridge)
        self.assertIn('from "../core/constants.js"', self.background_activity)
        self.assertIn('from "../core/state.js"', self.background_activity)
        self.assertIn("export function hasPendingStudioGenerations()", self.background_activity)
        self.assertIn('from "../core/constants.js"', self.video_bridge)
        self.assertIn('from "../core/state.js"', self.video_bridge)
        for module_source in (self.settings_storage, self.llm_profile_store, self.llm_status):
            self.assertNotIn("prompt_studio.js", module_source)
        self.assertIn('from "../core/constants.js"', self.settings_storage)
        self.assertIn('from "../core/constants.js"', self.llm_profile_store)
        self.assertNotIn("from ", self.llm_status)
        for module_source in (self.id_source, self.image_reference):
            self.assertNotIn("from ", module_source)
            self.assertNotIn("prompt_studio.js", module_source)
        self.assertNotIn("prompt_studio.js", self.generation_state)
        self.assertIn('from "./image-reference.js"', self.generation_state)
        self.assertIn('from "../generation/model-name.js"', self.generation_state)
        self.assertNotIn("prompt_studio.js", self.consult_model)
        self.assertIn('from "../core/constants.js"', self.consult_model)
        self.assertIn('from "../core/id.js"', self.consult_model)
        self.assertIn('from "../chat/generation-state.js"', self.consult_model)
        self.assertIn('from "../chat/image-reference.js"', self.consult_model)
        self.assertNotIn("prompt_studio.js", self.chat_model)
        self.assertIn('from "../core/constants.js"', self.chat_model)
        self.assertIn('from "../consult/model.js"', self.chat_model)
        self.assertIn('from "../generation/model-name.js"', self.chat_model)
        self.assertIn('from "../settings/storage.js"', self.chat_model)
        self.assertNotIn("prompt_studio.js", self.chat_store)
        self.assertIn('from "../core/state.js"', self.chat_store)
        self.assertIn('from "../consult/model.js"', self.chat_store)
        self.assertNotIn("prompt_studio.js", self.workflow_profile)
        self.assertIn('from "../core/constants.js"', self.workflow_profile)
        self.assertIn('from "./model-name.js"', self.workflow_profile)
        self.assertNotIn("prompt_studio.js", self.workflow_template)
        self.assertIn('from "../core/constants.js"', self.workflow_template)
        self.assertIn('from "./model-name.js"', self.workflow_template)
        self.assertIn('from "./workflow-profile.js"', self.workflow_template)
        self.assertIn('from "./prompt-studio-input.js"', self.workflow_template)
        self.assertNotIn("prompt_studio.js", self.prompt_studio_input)
        self.assertNotIn("from ", self.model_name)
        self.assertNotIn("prompt_studio.js", self.model_name)
        self.assertNotIn("prompt_studio.js", self.plot_model)
        self.assertIn('from "../core/constants.js"', self.plot_model)

    def test_prompt_studio_input_is_adaptive_durable_and_replay_safe(self):
        self.assertIn('PROMPT_STUDIO_INPUT_TYPE = "PromptStudioInput"', self.prompt_studio_input)
        self.assertIn('PROMPT_STUDIO_INPUT_TITLE = "Prompt Studio Input"', self.prompt_studio_input)
        self.assertIn("extends PrimitiveNode", self.prompt_studio_input)
        self.assertIn('new Set(["INT", "FLOAT", "BOOLEAN", "STRING", "COMBO"])', self.prompt_studio_input)
        self.assertIn("this.outputs?.[slot]?.links?.length", self.prompt_studio_input)
        self.assertIn("DEFAULT_NODE_TITLES.has(title)", self.prompt_studio_input)
        self.assertIn("defaultValue: output[targetNodeId].inputs[targetInputName]", self.prompt_studio_input)
        self.assertIn("schemaFingerprint", self.prompt_studio_input)
        self.assertIn("extractSerializedSubgraphInputs", self.prompt_studio_input)
        self.assertIn("PROMPT_STUDIO_INPUT_PROFILE_VERSION", self.source)
        self.assertIn("applyPromptStudioInputValues", self.source)
        self.assertIn('id="promptstudio-additional-inputs-details"', self.source)
        self.assertIn("frozenSettings.additional_input_selections", self.source)
        queue = self.function_source("queueGeneration", "queueUpscale")
        self.assertIn("if (!replayExactGeneration)", queue)
        self.assertIn("state.additionalInputSelections", queue)

    def test_xyz_plot_uses_explicit_targets_and_durable_recovery(self):
        self.assertIn("export function snapshotForPlotCell", self.plot_model)
        self.assertIn("export function orderPlotCellsForExecution", self.plot_model)
        self.assertIn("model: 0", self.plot_model)
        self.assertIn("lora: 1", self.plot_model)
        self.assertIn("lora_strength: 1", self.plot_model)
        self.assertIn("seed: 3", self.plot_model)
        self.assertIn("SAMPLER_CONTROL_TYPE", self.plot_model)
        self.assertIn("Two axes cannot control the same workflow field", self.plot_model)
        self.assertIn("PLOT_MAX_CELLS = 512", self.plot_model)
        self.assertIn("Start XY(Z) plot", self.source)
        self.assertIn(".promptstudio-plot-z-toggle > input", self.styles)
        self.assertIn("width: auto;", self.styles)
        self.assertIn("await persistPlotRun(plot)", self.function_source("submitPlotCells", "watchPlotCell"))
        self.assertIn(
            "const cells = orderPlotCellsForExecution(",
            self.function_source("submitPlotCells", "watchPlotCell"),
        )
        self.assertIn("resumePlotRun(data)", self.function_source("loadPlotRun", "persistPlotRun"))
        self.assertIn("Retry failed", self.function_source("renderPlotRun", "renderPlotWorkspace"))

    def test_xyz_plot_retains_comfy_queue_workflow_metadata_and_repairs_old_runs(self):
        preparation = self.function_source("preparePlotBase", "startPlotRun")
        submission = self.function_source("submitPlotCells", "watchPlotCell")
        self.assertIn("workflowSnapshot: structuredClone(context.snapshot)", preparation)
        self.assertNotIn("normalizeGenerationSnapshot(structuredClone(context.snapshot))", preparation)
        self.assertIn("if (!plot.base?.workflowSnapshot?.workflow)", submission)
        self.assertIn("plot.base.workflowSnapshot.workflow = structuredClone(context.snapshot.workflow)", submission)

    def test_xyz_plot_identity_survives_chat_normalization_and_cross_tab_merges(self):
        self.assertIn('chat?.sessionMode === "plot" || chat?.plotId', self.chat_model)
        self.assertIn("const plotChat = localChat.plotId ? localChat : remoteChat.plotId", self.chat_store)
        self.assertIn('return Boolean(chat && (chat.sessionMode === "plot" || chat.plotId))', self.source)

    def test_xyz_plot_load_and_progress_refresh_the_history_sidebar(self):
        load = self.function_source("loadPlotRun", "persistPlotRun")
        persist = self.function_source("persistPlotRun", "artifactLink")
        self.assertIn("state.plotRuns.set(id, data);\n    renderChatList();", load)
        self.assertIn("state.plotRuns.set(id, current);\n    renderChatList();", persist)

    def test_xyz_plot_rerenders_preserve_the_live_grid_viewport(self):
        cell = self.function_source("renderPlotCell", "plotCellRenderKey")
        refresh = self.function_source("refreshPlotGridScroller", "renderPlotGrid")
        render_run = self.function_source("renderPlotRun", "capturePlotViewport")
        capture = self.function_source("capturePlotViewport", "restorePlotViewport")
        restore = self.function_source("restorePlotViewport", "renderPlotWorkspace")
        workspace = self.function_source("renderPlotWorkspace", "plotLlmControlValues")
        history = self.function_source("renderChatHistory", "updateComposeMode")

        self.assertIn("shell.dataset.plotId", render_run)
        self.assertIn("button.dataset.renderKey = plotCellRenderKey(cell)", cell)
        self.assertIn("button.replaceWith(renderPlotCell(plot, cell))", refresh)
        self.assertIn("gridScroller", render_run)
        self.assertIn("grid?.scrollLeft", capture)
        self.assertIn("grid?.scrollTop", capture)
        self.assertIn("tabs?.scrollLeft", capture)
        self.assertIn("grid.scrollLeft = viewport.gridLeft", restore)
        self.assertIn("grid.scrollTop = viewport.gridTop", restore)
        self.assertIn("tabs.scrollLeft = viewport.tabsLeft", restore)
        self.assertIn("const viewport = capturePlotViewport(history, chat.plotId)", workspace)
        self.assertIn("renderPlotRun(next, plot, { gridScroller })", workspace)
        self.assertIn("restorePlotViewport(history, plot.id, viewport)", workspace)
        self.assertLess(history.index("if (isPlotChat())"), history.index("history.replaceChildren()"))

    def test_xyz_plot_history_uses_durable_summary_before_plot_is_opened(self):
        self.assertIn("plotSummary:", self.chat_model)
        self.assertIn("const summaries = [remoteChat.plotSummary, localChat.plotSummary]", self.chat_store)
        sidebar = self.function_source("renderChatList", "historyShouldStickToEnd")
        self.assertIn("plotProgressSummaryText(chat.plotSummary)", sidebar)
        self.assertIn('"Plot · details unavailable"', sidebar)
        summary = self.function_source("plotProgressSummaryText", "artifactLink")
        self.assertIn("plotProgressCountsText(summary?.counts || {}, Number(summary?.total || 0))", summary)

    def test_xyz_plot_llm_mode_exposes_prompt_axes_and_reuses_rendered_groups(self):
        self.assertIn('{ id: "style_preset", label: "Style", kind: "llm_catalog"', self.plot_model)
        self.assertIn('{ id: "framing_preset", label: "Framing", kind: "llm_catalog"', self.plot_model)
        self.assertIn('{ id: "additional_instructions", label: "Additional instructions", kind: "text"', self.plot_model)
        self.assertIn("export function plotControlOverridesForCell", self.plot_model)
        self.assertIn("export function plotPromptGroupKey", self.plot_model)
        self.assertIn('promptNode.inputs.prompt = String(cell.finalPrompt)', self.plot_model)
        self.assertIn("Enable LLM mode", self.source)
        preparation = self.function_source("prepareExistingPlot", "submitPlotCells")
        self.assertIn("const groups = new Map()", preparation)
        self.assertIn("plotPromptGroupKey(plot, cell)", preparation)
        self.assertIn("plot.controlSettings = structuredClone(controlSettings)", preparation)
        self.assertIn("plot.preparationProgress.completed += 1", preparation)
        self.assertIn("reusableFinalPrompt", preparation)

    def test_xyz_plot_inspector_hides_llm_controls_and_marks_axis_owned_controls(self):
        inspector = self.function_source("syncPlotInspectorControls", "plotProfile")
        self.assertIn("generation.hidden = plotMode && !llmMode", inspector)
        self.assertIn("additional.hidden = plotMode && !llmMode", inspector)
        self.assertIn("Applied to every plot generation", inspector)
        self.assertIn("Passed unchanged to every plot generation", inspector)
        self.assertIn("Set by ${axis.name.toUpperCase()} plot axis", self.source)
        self.assertIn("label.insertBefore(note, control)", self.source)
        self.assertIn('display: inline;\n  margin-left: 5px;', self.styles)
        self.assertIn("These LoRAs apply to every plot generation", self.source)
        self.assertIn("state.plotPreparationControllers.get(plotId)?.abort()", self.source)

    def test_relocated_brand_icons_resolve_from_the_nested_core_module(self):
        self.assertIn('new URL("../../../prompt-studio-icon.svg", import.meta.url)', self.constants)
        self.assertIn('new URL("../../../prompt-studio-activity-icon.svg", import.meta.url)', self.constants)
        self.assertTrue((REPO_ROOT / "web" / "prompt-studio-icon.svg").is_file())
        self.assertTrue((REPO_ROOT / "web" / "prompt-studio-activity-icon.svg").is_file())

    def test_workflow_template_validation_stays_in_the_generation_domain(self):
        self.assertIn("export function createWorkflowTemplateBuilder", self.workflow_template)
        self.assertIn("bridgeWorkflowSubgraphs", self.workflow_template)
        self.assertIn('dispatch("subgraph-created"', self.workflow_template)
        self.assertIn("Workflow must have exactly one image output", self.workflow_template)
        self.assertNotIn("function buildWorkflowTemplate", self.source)

    def test_empty_consult_history_refreshes_prompt_agent_mode(self):
        render = self.function_source("renderConsultHistory", "selectConsultResponse")
        self.assertLess(
            render.index("updateConsultExperimentUi();"),
            render.index("if (!messages.length && !agent)"),
        )

    def test_pending_llm_messages_show_phase_and_live_token_count(self):
        activity = self.function_source(
            "llmActivityLabel",
            "llmGeneratedTokenCount",
            self.llm_status,
        )
        consult = self.source[
            self.source.index("function consultJobStatusText"):
            self.source.index("async function pollConsultJob")
        ]
        poll = self.source[
            self.source.index("async function pollConsultJob"):
            self.source.index("function appendConsultJobFailure")
        ]
        consult_render = self.function_source("renderConsultHistory", "selectConsultResponse")
        progress = self.function_source("renderGenerationProgress", "studioControlChangeLabels")
        operation_progress = self.source[
            self.source.index("function updateActiveLlmOperationProgress"):
            self.source.index("async function stopLlmGeneration")
        ]

        self.assertIn('return "Thinking"', activity)
        self.assertIn('return "Processing"', activity)
        self.assertIn('return "Thinking / processing"', activity)
        self.assertNotIn("with ${", consult)
        self.assertIn("llmGeneratedTokenCount(job.provider_status", poll)
        self.assertIn("promptstudio-llm-token-count", consult_render)
        self.assertIn("llmTokenCount.toLocaleString()", progress)
        self.assertNotIn("with ${", operation_progress)
        self.assertIn(".promptstudio-llm-token-count", self.styles)
        self.assertIn("bottom: 13px", self.styles)

    def test_new_sessions_explicitly_disable_prompt_agent_mode(self):
        create = self.function_source("createChat", "deleteChat")
        exported = self.function_source(
            "exportPromptAgentIterationToNewSession",
            "promotePromptAgentBest",
        )
        self.assertIn("consultAgentMode: false", create)
        self.assertIn("consultAgentMode: false", exported)

    def test_new_chat_reuses_the_only_empty_session(self):
        model = self.function_source(
            "isEmptyChat",
            "deduplicateEmptyChats",
            self.chat_model,
        )
        deduplicate = self.function_source(
            "deduplicateEmptyChats",
            "studioSettingsFromControlsFingerprint",
            self.chat_model,
        )
        create = self.function_source("createChat", "deleteChat")

        self.assertIn("if (!chat || chat.initialized) return false", model)
        self.assertIn("chat.versions", model)
        self.assertIn("chat.consultClearedAt", model)
        self.assertIn("emptyChats.length <= 1", deduplicate)
        self.assertIn("preferredChatId", deduplicate)
        self.assertIn("if (isEmptyChat(activeChat())) return", create)
        self.assertIn("const reusable = state.chats.find(isEmptyChat)", create)
        self.assertIn("reusable.createdAt = promotedAt", create)
        self.assertIn("activateChat(reusable.id)", create)
        self.assertIn(
            "deduplicateEmptyChats([...merged.values()], activeChatId)",
            self.chat_store,
        )
        self.assertIn(
            "deduplicateEmptyChats(normalizedChats, stored.activeChatId)",
            self.chat_store,
        )

    def test_llamacpp_uses_config_owned_generation_settings_instead_of_profile_ui(self):
        selected = self.function_source("selectedLlmProfile", "selectedLlamacppGenerationSettings")
        providers = self.function_source("syncLlmProviderControls", "loadConfig")
        configs = self.function_source("loadLlamacppConfigProfiles", "applyLlamacppAutostartStatus")
        builder = (REPO_ROOT / "llamacpp_config_builder.ps1").read_text(encoding="utf-8")

        self.assertIn('selectedLlmProvider() === "llamacpp"', selected)
        self.assertIn("state.llamacppConfigLlmProfiles.get", selected)
        self.assertIn('profileControl.hidden = provider === "llamacpp"', providers)
        self.assertIn("llamacpp_config_profile: selected", configs)
        self.assertIn("data.llm_profile", configs)
        self.assertIn('llm_profile = [ordered]@{', builder)
        self.assertIn('thinking_temperature = [double] $llmThinkingTemperature.Value', builder)
        self.assertIn('presence_penalty = [double] $llmPresencePenalty.Value', builder)
        self.assertIn('$qwen38ThinkingModesText = "XHigh, Medium, Low, Disabled"', builder)
        self.assertIn("Qwen 3.8 uses XHigh, Medium, and Low", builder)
        self.assertIn('Normalize-DeviceList "CUDA devices" $cudaDevices.Text', builder)
        self.assertIn('Normalize-DeviceList "MTP device" $mtpDevice.Text', builder)

    def test_new_chats_reset_generation_controls_except_thinking_and_embellishment(self):
        fresh = self.function_source(
            "newChatStudioSettings",
            "studioSettingsFromControlsFingerprint",
            self.chat_model,
        )
        create = self.function_source("createChat", "deleteChat")
        load_start = self.chat_store.index("async function loadChats")
        load = self.chat_store[load_start:self.chat_store.index("\n\n  return {", load_start)]
        delete = self.function_source("deleteChat", "activateChat")

        self.assertIn("...SETTINGS_DEFAULTS", fresh)
        self.assertIn("thinking_mode: previous.thinking_mode", fresh)
        self.assertIn("embellishment_level: previous.embellishment_level", fresh)
        self.assertIn("lora_selections: previous.lora_selections", fresh)
        self.assertIn("model_selections: previous.model_selections", fresh)
        self.assertNotIn("style_preset: previous.style_preset", fresh)
        self.assertNotIn("framing_preset: previous.framing_preset", fresh)
        self.assertNotIn("additional_instructions: previous.additional_instructions", fresh)
        self.assertIn("studioSettings: newChatStudioSettings(captureStudioSettings())", create)
        self.assertIn("studioSettings: newChatStudioSettings()", load)
        self.assertIn("studioSettings: newChatStudioSettings(captureStudioSettings())", delete)

    def test_remembered_llm_provider_overrides_stale_session_settings(self):
        remembered = self.function_source("applyRememberedLlmConnection", "saveSettings")
        applied = self.function_source("applyStudioSettings", "syncActiveChatSettings")

        self.assertIn('localStorage.getItem(STORAGE_KEY)', remembered)
        self.assertIn('Object.hasOwn(remembered, "llm_provider")', remembered)
        self.assertIn("normalizeLlmProvider(remembered.llm_provider)", remembered)
        self.assertIn("kobold_url:", remembered)
        self.assertIn("ollama_url:", remembered)
        self.assertIn("ollama_model:", remembered)
        self.assertIn("llamacpp_url:", remembered)
        self.assertIn("llamacpp_model:", remembered)
        self.assertIn("llamacpp_executable:", remembered)
        self.assertIn("llamacpp_config_profile:", remembered)
        self.assertIn("llamacpp_autostart:", remembered)
        self.assertIn("keep_models_loaded:", remembered)
        self.assertIn("applyRememberedLlmConnection(", applied)

    def test_ollama_is_default_and_advanced_providers_warn_once(self):
        defaults = self.constants[
            self.constants.index("const SETTINGS_DEFAULTS"):
            self.constants.index("const LLM_THINKING_MODE_OPTIONS")
        ]
        normalizer = self.function_source("normalizeLlmProvider", "confirmAdvancedLlmProvider")
        confirmation = self.function_source("confirmAdvancedLlmProvider", "handleLlmProviderChange")
        change = self.function_source("handleLlmProviderChange", "llmProviderDisplayName")

        self.assertIn('llm_provider: "ollama"', defaults)
        self.assertIn(': "ollama";', normalizer)
        self.assertIn("ADVANCED_LLM_ACK_STORAGE_KEY", confirmation)
        self.assertIn("localStorage.getItem", confirmation)
        self.assertIn("localStorage.setItem", confirmation)
        self.assertIn("view?.confirm", confirmation)
        self.assertIn('select.value = "ollama"', change)
        self.assertIn('addEventListener("change", handleLlmProviderChange)', self.source)
        self.assertLess(
            self.source.index('<option value="ollama"'),
            self.source.index('<option value="koboldcpp"'),
        )

    def test_llamacpp_provider_exposes_models_monitoring_and_process_controls(self):
        provider = self.function_source("normalizeLlmProvider", "llmProviderDisplayName")
        connection = self.function_source("llmConnectionPayload", "comfyUiIsProcessing")
        status = self.source[
            self.source.index("function renderLlmStatus"):
            self.source.index("async function restartComfyUIFromStatus")
        ]
        launcher_configured = self.function_source("llamacppLauncherConfigured", "comfyUiIsProcessing")
        process_control = self.function_source("controlLlamacppServer", "startLlmStatusMonitor")
        autostart_load = self.function_source(
            "loadLlamacppAutostartPreference",
            "saveLlamacppAutostartPreference",
        )
        autostart_save = self.function_source(
            "saveLlamacppAutostartPreference",
            "syncLlmProviderControls",
        )
        file_picker = self.function_source("browseLlamacppPath", "startLlmStatusMonitor")
        config_builder = self.function_source("openLlamacppConfigBuilder", "startLlmStatusMonitor")

        self.assertIn('"llamacpp"', provider)
        self.assertIn("llamacpp_url:", connection)
        self.assertIn("llamacpp_model:", connection)
        self.assertIn("llamacpp_executable:", connection)
        self.assertIn("llamacpp_config_profile:", connection)
        self.assertIn("llmGeneratedTokenCount(status)", status)
        self.assertIn("server_process", status)
        self.assertIn("process.config_changed === true", status)
        self.assertIn("llamacpp_executable", launcher_configured)
        self.assertIn("llamacpp_config_profile", launcher_configured)
        self.assertIn("!launcherConfigured", status)
        self.assertIn("LLAMACPP_SERVER_ENDPOINT", process_control)
        self.assertIn("!llamacppLauncherConfigured(payload)", process_control)
        self.assertIn('option value="llamacpp"', self.source)
        self.assertIn('id="promptstudio-llamacpp-start" type="button" title="Start Llama.cpp server" disabled', self.source)
        self.assertIn('id="promptstudio-llamacpp-server-stop"', self.source)
        self.assertIn('id="promptstudio-llamacpp-restart"', self.source)
        self.assertIn('id="promptstudio-browse-llamacpp-executable"', self.source)
        self.assertNotIn('id="promptstudio-browse-llamacpp-config-directory"', self.source)
        self.assertIn('id="promptstudio-llamacpp-config-profile"', self.source)
        self.assertIn('id="promptstudio-llamacpp-autostart"', self.source)
        self.assertIn("Start with ComfyUI", self.source)
        self.assertIn("LLAMACPP_AUTOSTART_ENDPOINT", autostart_load)
        self.assertIn("LLAMACPP_AUTOSTART_ENDPOINT", autostart_save)
        self.assertIn("llamacpp_executable:", autostart_save)
        self.assertIn("llamacpp_config_profile:", autostart_save)
        self.assertIn("loadLlamacppAutostartPreference();", self.source)
        self.assertIn("Profiles are stored in config/LlamaCPP", self.source)
        self.assertIn('id="promptstudio-refresh-llamacpp-configs"', self.source)
        self.assertIn('id="promptstudio-build-llamacpp-config"', self.source)
        self.assertIn('id="promptstudio-new-llamacpp-config"', self.source)
        self.assertIn("LLAMACPP_FILE_PICKER_ENDPOINT", file_picker)
        self.assertIn("LLAMACPP_CONFIG_BUILDER_ENDPOINT", config_builder)
        self.assertIn("LLAMACPP_CONFIG_PROFILES_ENDPOINT", self.source)
        self.assertIn('browseLlamacppPath("executable")', self.source)
        self.assertNotIn('browseLlamacppPath("config_directory")', self.source)
        self.assertIn("openLlamacppConfigBuilder({ createNew: true })", self.source)
        self.assertIn(".promptstudio-path-field", self.styles)
        self.assertIn(".promptstudio-config-profile-field", self.styles)
        self.assertIn(".promptstudio-system-status-actions[hidden]", self.styles)
        self.assertIn("grid-template-columns: repeat(3, minmax(0, 1fr))", self.styles)
        self.assertIn("white-space: nowrap", self.styles)

    def test_backend_specific_controls_live_in_backend_settings_dialog(self):
        self.assertIn('id="promptstudio-open-backend-settings"', self.source)
        self.assertIn('id="promptstudio-backend-settings-dialog"', self.source)
        self.assertIn('id="promptstudio-close-backend-settings"', self.source)
        self.assertIn("function openBackendSettings()", self.source)
        self.assertIn("function closeBackendSettings(", self.source)
        self.assertIn(".promptstudio-backend-settings-dialog", self.styles)

    def test_prompt_agent_export_updates_visible_main_prompt(self):
        exported = self.function_source(
            "promotePromptAgentIteration",
            "exportPromptAgentIterationToNewSession",
        )
        self.assertIn("updateMainPromptEditor(effectiveGoal);", exported)
        self.assertNotIn("state.mainPrompt = effectiveGoal;", exported)
        self.assertIn("chat.mainPromptDirty = false;", exported)
        self.assertIn("chat.controlsFingerprint = exportedControlsFingerprint;", exported)
        self.assertIn("chat.pendingGeneration = null;", exported)

    def test_direct_main_prompt_edits_are_rendered_before_generation(self):
        sync = self.function_source("syncMainPromptEditor", "syncCanonicalEditor")
        render_state = self.function_source("mainPromptNeedsRender", "promptNeedsRender")
        revise = self.source[
            self.source.index("async function reviseAndMaybeGenerate"):
            self.source.index("async function createNewFromCurrentPrompt")
        ]

        self.assertIn("chat.mainPrompt = prompt;", sync)
        self.assertIn('prompt !== String(chat.renderedMainPrompt ?? "")', sync)
        self.assertIn('chat.mainPrompt !== String(chat.renderedMainPrompt ?? "")', render_state)
        self.assertIn("mainPrompt = previousMainPrompt;", revise)
        self.assertIn('payloadFor(mainPrompt, "render", "", previousFinalPrompt)', revise)

    def test_first_request_is_semantically_converted_to_a_main_prompt_before_rendering(self):
        revise = self.source[
            self.source.index("async function reviseAndMaybeGenerate"):
            self.source.index("async function createNewFromCurrentPrompt")
        ]

        create_main = 'payloadFor(revision, "create_main", "", "")'
        render_main = 'payloadFor(mainPrompt, "render", "", "")'
        self.assertIn(create_main, revise)
        self.assertIn(render_main, revise)
        self.assertLess(revise.index(create_main), revise.index(render_main))
        self.assertNotIn("mainPrompt = revision;", revise)

    def test_info_pill_is_derived_from_current_prompt_and_control_state(self):
        changed_controls = self.function_source("changedRenderControlLabels", "useLlmAmplification")
        status = self.function_source("currentStudioStatus", "refreshStudioStatus")
        control_handler = self.function_source("markControlsChanged", "chatTitle")
        operation = self.function_source("updateStudioOperation", "createStudioOperation")

        self.assertIn("baseline[index] !== current[index]", changed_controls)
        self.assertIn("mainPromptNeedsRender()", status)
        self.assertIn("changedRenderControlLabels(chat)", status)
        self.assertIn("activeStudioOperationStatus(chat)", status)
        self.assertIn("refreshStudioStatus();", control_handler)
        self.assertIn("refreshStudioStatus();", operation)
        self.assertNotIn("Generation controls changed.", self.source)

    def test_legacy_control_fingerprints_are_normalized_before_comparison(self):
        normalizer = self.function_source(
            "normalizeStoredControlsFingerprint",
            "migratedStudioSettings",
            self.chat_model,
        )
        chat = self.function_source("normalizeChat", source=self.chat_model)

        self.assertIn("studioSettingsFromControlsFingerprint(value)", normalizer)
        self.assertIn("controlsFingerprintFromSettings(settings, parsed.values)", normalizer)
        self.assertIn("normalizeStoredControlsFingerprint(storedControlsFingerprint, studioSettings)", chat)
        self.assertIn("renderedMainPrompt", chat)

    def test_main_prompt_known_references_use_a_synchronized_highlight_layer(self):
        ranges = self.function_source(
            "knownReferenceHighlightRanges",
            "renderKnownReferenceHighlights",
        )
        render = self.function_source(
            "renderKnownReferenceHighlights",
            "updatePromptEditor",
        )
        update = self.function_source("updateMainPromptEditor", "knownReferenceTokenCharacter")

        self.assertIn("state.config?.known_reference_names", ranges)
        self.assertIn("right.end - right.start", ranges)
        self.assertIn("candidate.start < range.end", ranges)
        self.assertIn('document.createElement("mark")', render)
        self.assertIn("editor.scrollLeft", render)
        self.assertIn("editor.scrollTop", render)
        self.assertIn("renderKnownReferenceHighlights();", update)
        self.assertIn('class="promptstudio-main-prompt-editor"', self.source)
        self.assertIn('addEventListener("scroll", renderKnownReferenceHighlights)', self.source)
        self.assertIn('if ("ResizeObserver" in window)', self.source)
        self.assertIn("new ResizeObserver(renderKnownReferenceHighlights)", self.source)
        self.assertIn(".promptstudio-main-prompt-highlights mark", self.styles)
        self.assertIn("color: #b9a8ff", self.styles)

    def test_additional_instruction_template_uses_a_synchronized_highlight_layer(self):
        ranges = self.function_source(
            "additionalInstructionTemplateHighlightRanges",
            "renderAdditionalInstructionTemplateHighlights",
        )
        render = self.function_source(
            "renderAdditionalInstructionTemplateHighlights",
            "updatePromptEditor",
        )

        self.assertIn("state.config?.additional_instruction_template_names", ranges)
        self.assertIn('new RegExp(`^${escaped}$`, "iu")', ranges)
        self.assertIn('document.createElement("mark")', render)
        self.assertIn("editor.scrollLeft", render)
        self.assertIn("editor.scrollTop", render)
        self.assertIn(
            'class="promptstudio-main-prompt-editor promptstudio-additional-instructions-editor"',
            self.source,
        )
        self.assertIn(
            'addEventListener("input", renderAdditionalInstructionTemplateHighlights)',
            self.source,
        )
        self.assertIn(
            'addEventListener("scroll", renderAdditionalInstructionTemplateHighlights)',
            self.source,
        )
        self.assertIn("new ResizeObserver(renderAdditionalInstructionTemplateHighlights)", self.source)
        self.assertIn(".promptstudio-additional-instructions-editor[data-has-highlights]", self.styles)

    def test_prompt_agent_failure_does_not_leave_iteration_generating(self):
        normalizer = self.function_source(
            "normalizePromptAgentIteration",
            "normalizePromptAgentConversationContext",
            self.consult_model,
        )
        finish = self.source[
            self.source.index("function finishPromptAgent"):
            self.source.index("async function runConsultAgent")
        ]
        self.assertIn('"stopped", "error"', normalizer)
        self.assertIn('iteration.status = status === "error" ? "error" : "stopped";', finish)

    def test_chat_order_uses_proper_message_creation_time_only(self):
        activity = self.function_source("chatActivityAt", "compareChatsNewestFirst")
        self.assertIn('["user", "assistant"].includes(message?.role)', activity)
        self.assertIn("Number(message.createdAt)", activity)
        self.assertNotIn("message.updatedAt", activity)
        self.assertNotIn("chat.updatedAt", activity)
        self.assertNotIn("chat.consultAgent?.updatedAt", activity)

    def test_chat_history_loads_twenty_sessions_then_fetches_older_pages_on_scroll(self):
        loader = self.function_source("loadOlderChats", "loadChats", self.chat_store)
        writer = self.function_source("writeChatStore", "persistChats", self.chat_store)
        build = self.function_source("buildPanel", source=self.source)
        chat_list = self.function_source("renderChatList", "scrollHistoryToEnd")

        self.assertIn("const CHAT_PAGE_SIZE = 20;", self.chat_store)
        self.assertIn("chatPageUrl({ includeActive: true })", self.chat_store)
        self.assertIn("cursor: state.chatPageCursor", loader)
        self.assertIn("state.chatPageLoading", loader)
        self.assertIn("partial: true", writer)
        self.assertIn("deletedChatIds", writer)
        self.assertIn('chatList.addEventListener("scroll"', build)
        self.assertIn("if (remaining <= 160) loadOlderChats();", build)
        self.assertIn('loadOlder.textContent = state.chatPageLoading ? "Loading older sessions…" : "Load older sessions";', chat_list)
        self.assertIn("chatPageCursor: null", self.state)
        self.assertIn("chatDeletedIds: new Set()", self.state)
        self.assertIn(".promptstudio-chat-load-older", self.styles)

    def test_background_prompt_agent_is_visible_and_owns_its_session(self):
        chat_list = self.function_source("renderChatList", "scrollHistoryToEnd")
        updater = self.function_source("updateConsultAgent", "setConsultAgentGeneration")
        monitor = self.source[
            self.source.index("async function monitorPromptAgentPhase"):
            self.source.index("async function cancelPromptAgentLlmRequest")
        ]
        self.assertIn("Agent: ${promptAgentStatusLabel(agent)}", chat_list)
        self.assertIn("agent?.active", chat_list)
        self.assertIn("renderChatList();", updater)
        self.assertIn("status.generated_characters", monitor)
        self.assertIn("monitorPromptAgentPhase(", monitor)

    def test_prompt_agent_uses_the_raised_structured_response_floor(self):
        request = self.source[
            self.source.index("async function requestPromptAgentPhase"):
            self.source.index("async function cancelPromptAgentLlmRequest")
        ]
        self.assertIn("Math.max(1400", request)
        self.assertNotIn("Math.max(1200", request)

    def test_llm_context_carries_forbidden_checks_and_real_control_options(self):
        normalize = self.function_source(
            "normalizePromptAgentEvaluation",
            "normalizePromptAgentIteration",
            self.consult_model,
        )
        controls = self.function_source(
            "applicableStudioControlOptions",
            "studioDiscussionTarget",
        )
        discussion = self.source[
            self.source.index("function studioDiscussionRequestMessages"):
            self.source.index("async function requestStudioDiscussion")
        ]
        payload = self.function_source(
            "promptAgentEvaluationPayload",
            "promptAgentReferencesPayload",
        )

        self.assertIn("forbidden:", normalize)
        self.assertIn("normalized.forbidden.map", payload)
        self.assertIn("state.config?.profiles", controls)
        self.assertIn("state.config?.styles", controls)
        self.assertIn("allowed_control_options: applicableStudioControlOptions()", discussion)

    def test_prompt_agent_stop_survives_a_page_refresh(self):
        normalizer = self.function_source(
            "normalizeConsultAgent",
            "normalizeConsultMessage",
            self.consult_model,
        )
        request = self.source[
            self.source.index("async function requestPromptAgentPhase"):
            self.source.index("async function cancelPromptAgentLlmRequest")
        ]
        cancel = self.source[
            self.source.index("async function cancelPromptAgentLlmRequest"):
            self.source.index("function promptAgentCompletedIterations")
        ]
        stop = self.function_source("stopConsultAgent", "promotePromptAgentIteration")

        self.assertIn('requestId: String(value.requestId || "")', normalizer)
        self.assertIn("current.requestId = requestId;", request)
        self.assertIn("agent_id: agent.id", request)
        self.assertIn("agent_id: ownerId", cancel)
        self.assertIn("state.consultAgentRequestId || agent.requestId", stop)
        self.assertIn("promptAgentGenerationPromptId(agent)", stop)

    def test_prompt_agent_rereads_chat_state_after_sync_replaces_it(self):
        run = self.source[
            self.source.index("async function runConsultAgent"):
            self.source.index("async function startConsultAgent")
        ]

        self.assertIn("const currentAgent = () =>", run)
        self.assertIn("state.chats.find((item) => item.id === agentChatId)", run)
        self.assertIn("|| !currentAgent()?.active", run)
        self.assertIn("agent = currentAgent();", run)
        self.assertNotIn("agent = activeConsultAgent(agentChat)", run)
        self.assertNotIn("const current = activeConsultAgent(agentChat)", run)

    def test_chat_sync_cannot_overwrite_a_generation_started_during_fetch(self):
        sync = self.function_source(
            "refreshChatsFromServer",
            "setupChatSync",
            self.chat_store,
        )
        self.assertIn("const syncMutationVersion = state.chatMutationVersion;", sync)
        self.assertIn("if (state.chatMutationVersion !== syncMutationVersion) return;", sync)
        self.assertLess(
            sync.index("const syncMutationVersion = state.chatMutationVersion;"),
            sync.index("await api.fetchApi"),
        )
        self.assertGreater(
            sync.index("if (state.chatMutationVersion !== syncMutationVersion) return;"),
            sync.index("await response.json"),
        )

    def test_generation_images_update_the_live_message_after_async_enrichment(self):
        append = self.function_source("appendGenerationImages", "updateMainPromptEditor")
        self.assertGreater(
            append.index("const record = studioGenerationRecord(promptId);"),
            append.index("await Promise.all"),
        )
        self.assertIn("renderImageGallery(element, stored.images, stored);", append)
        self.assertIn("keepHistoryViewportStable(history, wasNearEnd, previousScrollTop);", append)
        self.assertNotIn("renderChatHistory();", append)

    def test_chat_auto_scroll_tracks_user_distance_across_rapid_appends(self):
        scroll = self.function_source("scrollElementToEnd", "scrollHistoryToEnd")
        render = self.function_source("renderMessage", "appendMessage")
        build = self.function_source("buildPanel", "updatePopoutButton")
        activate = self.function_source("activateChat", "nodeClassName")
        history_render = self.function_source("renderChatHistory", "updateComposeMode")

        self.assertIn("const CHAT_SCROLL_STICK_THRESHOLD = 450;", self.constants)
        self.assertIn("historyShouldStickToEnd(history)", scroll)
        self.assertIn("setHistoryShouldStickToEnd(history, true);", scroll)
        self.assertIn("const wasNearEnd = historyShouldStickToEnd(history);", render)
        self.assertIn("scrollHistoryToEnd({ instant: true });", render)
        self.assertIn('history.addEventListener("scroll"', build)
        self.assertIn('consultHistory.addEventListener("scroll"', build)
        self.assertIn("state.historyWasNearEnd = true;", activate)
        self.assertIn("renderChatHistory({ forceEnd: true });", activate)
        self.assertNotIn("scrollHistoryToEnd", activate)
        self.assertIn("if (forceEnd) placeHistoryAtEnd(history);", history_render)
        self.assertIn('image.loading = "lazy";', self.source)

    def test_generation_status_updates_do_not_rebuild_image_history(self):
        text_update = self.function_source("updateStudioGenerationText", "setStudioGenerationState")
        state_update = self.function_source("setStudioGenerationState", "setupGenerationProgressEvents")

        self.assertIn('element?.querySelector(".promptstudio-message-text")', text_update)
        self.assertNotIn("renderChatHistory();", text_update)
        self.assertIn("renderGenerationProgress(element, record.message);", state_update)
        self.assertNotIn("renderChatHistory();", state_update)

    def test_generated_image_urls_are_scoped_to_the_generation(self):
        gallery = self.function_source("renderImageGallery", "directVideoStudioTarget")
        image_url = self.function_source("imageReferenceUrl", "latestConversationImage")

        self.assertIn("generationData?.promptId || generationData?.id", gallery)
        self.assertIn('params.set("promptstudio_version", String(version))', image_url)

    def test_chat_images_preserve_their_aspect_ratio(self):
        self.assertNotIn("object-fit: cover", self.styles)
        self.assertIn("--promptstudio-chat-image-max-size: 180px", self.styles)
        self.assertIn("max-height: var(--promptstudio-chat-image-max-size)", self.styles)

    def test_llm_is_released_immediately_before_diffusion_queueing(self):
        queue = self.source[
            self.source.index("async function queueGeneration"):
            self.source.index("async function queueUpscale", self.source.index("async function queueGeneration"))
        ]
        self.assertLess(
            queue.index("llmHandoffToken = await releaseLlmBeforeGeneration();"),
            queue.index("await api.queuePrompt(-1, context.snapshot);"),
        )
        self.assertLess(
            queue.index("await api.queuePrompt(-1, context.snapshot);"),
            queue.index("await completeLlmHandoff(llmHandoffToken);"),
        )

    def test_keep_models_loaded_defaults_off_and_is_documented_for_multi_gpu_only(self):
        connection = self.function_source("llmConnectionPayload", "comfyUiIsProcessing")
        revision_payload = self.function_source("collectRevisionPayload", "captureGenerationQueueSettings")
        release = self.source[
            self.source.index("async function releaseLlmBeforeGeneration"):
            self.source.index("function llmConnectionPayload")
        ]

        self.assertIn("keep_models_loaded: false", self.constants)
        self.assertIn('id="promptstudio-keep-models-loaded"', self.source)
        self.assertIn("Enable only when they use separate GPUs", self.source)
        self.assertIn("keep_models_loaded:", connection)
        self.assertIn("keep_models_loaded:", revision_payload)
        self.assertIn("if (connection.keep_models_loaded) {", release)
        self.assertIn("LLM_RELEASE_ENDPOINT", release)
        self.assertIn("updateLlmHandoffStatus(message)", release)
        summary = self.function_source("renderSystemStatusSummary", "renderLlmStatus")
        llm_status_start = self.source.index("function renderLlmStatus")
        llm_status_end = self.source.index("\nasync function restartComfyUIFromStatus", llm_status_start)
        llm_status = self.source[llm_status_start:llm_status_end]
        self.assertIn("Boolean(llm?.handoff_error)", summary)
        self.assertIn("status.handoff_error || status.message", llm_status)
        execution_success = self.source[
            self.source.index('api.addEventListener("execution_success"'):
            self.source.index('for (const eventName of ["execution_error"', self.source.index('api.addEventListener("execution_success"'))
        ]
        self.assertNotIn("releaseLlmBeforeGeneration", execution_success)

    def test_comfyui_update_reports_progress_and_completion(self):
        summary = self.function_source("renderSystemStatusSummary", "renderLlmStatus")
        update = self.function_source("updateComfyUIFromStatus", "managerResultSucceeded")
        finish = self.function_source("finishComfyUpdate", "handleManagerQueueStatus")
        queue_start = self.source.index("function handleManagerQueueStatus")
        queue = self.source[queue_start:self.source.index("\nasync function refreshLlmStatus", queue_start)]

        self.assertIn('id="promptstudio-comfy-update-progress"', self.source)
        self.assertIn("comfyUpdateDoneCount", summary)
        self.assertIn("comfyUpdateTotalCount", summary)
        self.assertIn("PROMPTSTUDIO_COMFY_UPDATE_ENDPOINT", update)
        self.assertIn("coreUpdate.steps", update)
        self.assertIn("ComfyUI core and Python packages checked", update)
        self.assertIn('state.comfyUpdateMessage = "Updates queued', update)
        self.assertIn("status.target", queue)
        self.assertIn("updatedCount", finish)
        self.assertIn("state.comfyUpdateResults.values()", finish)
        self.assertIn("failedCount", finish)
        self.assertIn("failedLabels", finish)
        self.assertIn("Failed:", finish)
        self.assertIn("setStatus(state.comfyUpdateMessage", finish)
        self.assertIn("control.open = true", finish)
        self.assertIn('status.status === "all-done"', queue)
        self.assertIn('api.addEventListener("cm-task-started", handleManagerTaskStarted)', self.source)
        self.assertIn('api.addEventListener("cm-task-completed", handleManagerTaskCompleted)', self.source)
        self.assertIn("counts.done >= counts.total", self.source)
        self.assertIn('"/promptstudio/prompt-studio/update-comfyui"', self.constants)
        self.assertIn("promptstudio-update-pulse", self.styles)
        self.assertIn(".promptstudio-comfy-update-progress", self.styles)

    def test_ollama_routing_fallback_warning_is_visible(self):
        route = self.function_source("requestStudioTurnRoute", "studioDiscussionRequestMessages")
        turn = self.source[
            self.source.index("async function handleStudioTurn"):
            self.source.index("async function reviseAndMaybeGenerate")
        ]
        self.assertIn('warning: String(data.warning || "").trim()', route)
        self.assertIn("if (routed.warning)", turn)
        self.assertIn('appendMessage("system", routed.warning', turn)

    def test_mutation_settings_expose_five_focused_managers(self):
        self.assertEqual(self.source.count('data-mutation-category="'), 5)
        for category in (
            "protected_words",
            "additional_instruction_templates",
            "known_references",
            "additional_style_templates",
            "additional_framing_templates",
        ):
            self.assertIn(f'data-mutation-category="{category}"', self.source)
            self.assertIn(f'data-mutation-count="{category}"', self.source)
        self.assertIn(".promptstudio-mutation-config-card", self.styles)
        self.assertIn("grid-column: 1 / -1", self.styles)

    def test_mutation_manager_preserves_drafts_during_external_file_edits(self):
        load = self.source[
            self.source.index("async function loadMutationConfig"):
            self.source.index("function startMutationConfigMonitor")
        ]
        monitor = self.function_source("startMutationConfigMonitor", "stopMutationConfigMonitor")
        save = self.source[
            self.source.index("async function saveMutationCategory"):
            self.source.index("async function submitMutationEditor")
        ]

        self.assertIn("state.mutationEditorDirty", load)
        self.assertIn("state.mutationConfigPending = data", load)
        self.assertIn("Your unsaved edit is preserved", load)
        self.assertIn("Keeping the last valid view and retrying", load)
        self.assertIn("MUTATION_CONFIG_POLL_MS", monitor)
        self.assertIn("revision: state.mutationConfig.revision", save)
        self.assertIn('method: "PUT"', save)

    def test_llm_profiles_share_complete_sampler_settings_across_requests(self):
        settings = self.function_source("llmProfileGenerationSettings", "renderLlmProfileOptions")
        revision = self.function_source("collectRevisionPayload", "captureGenerationQueueSettings")
        consultation = self.function_source("collectConsultGenerationSettings", "selectedConsultVariant")

        for key in (
            "thinking_mode", "max_response_tokens", "llamacpp_reasoning_budget_tokens",
            "temperature", "top_p", "top_k", "min_p",
            "presence_penalty", "rep_pen", "rep_pen_range", "sampler_seed", "request_timeout",
            "stop_sequence",
        ):
            self.assertIn(f"{key}:", settings)
        self.assertIn("...llmProfileGenerationSettings()", revision)
        self.assertIn("return llmProfileGenerationSettings();", consultation)
        self.assertIn("const thinkingMode = selectedLlmThinkingMode();", settings)
        self.assertIn("thinkingModeEnablesReasoning(thinkingMode)", settings)
        for key in (
            "thinking_temperature", "thinking_top_p", "thinking_top_k", "thinking_min_p",
            "thinking_presence_penalty", "thinking_rep_pen", "thinking_rep_pen_range",
        ):
            self.assertIn(f"profile.{key}", settings)

    def test_llm_profile_editor_supports_defaults_add_delete_and_safe_fallback(self):
        available = self.function_source("availableLlmProfiles", "persistLlmProfiles")
        editor = self.function_source("openLlmProfileEditor", "closeLlmProfileEditor")
        restore = self.function_source("restoreLlmProfileEditorDefaults", "submitLlmProfileEditor")
        delete = self.function_source("deleteLlmProfile", "applyRememberedLlmConnection")

        self.assertIn('id: "qwen3.5",\n  name: "Default"', self.constants)
        self.assertIn('name: "Qwen 3.8 (27B)"', self.constants)
        self.assertIn('id: "qwen3.8-27b"', self.constants)
        self.assertIn("presence_penalty: 1.5", self.constants)
        self.assertIn("top_p: 0.8", self.constants)
        self.assertIn("top_k: 20", self.constants)
        self.assertIn("thinking_temperature: 1.0", self.constants)
        self.assertIn("thinking_top_p: 0.95", self.constants)
        self.assertIn("thinking_presence_penalty: 0", self.constants)
        self.assertIn('thinking_modes: Object.freeze(["XHigh", "Medium", "Low", "Disabled"])', self.constants)
        self.assertIn('thinking_mode: "XHigh"', self.constants)
        self.assertIn("LLM_PROFILE_STORAGE_VERSION = 6", self.constants)
        self.assertIn("Llama.cpp reasoning cap", self.source)
        self.assertIn('name="llamacpp_reasoning_budget_tokens"', self.source)
        self.assertIn('profile?.name === "Qwen3.5"', self.llm_profile_store)
        self.assertIn("storageVersion < LLM_PROFILE_STORAGE_VERSION", self.llm_profile_store)
        self.assertIn("storageVersion < 2", self.llm_profile_store)
        self.assertIn('id: "__default__", name: "Default"', available)
        self.assertIn('profile.id === "__default__"', editor)
        self.assertIn('"Add LLM profile"', editor)
        self.assertIn("LLM_PROFILE_PRESETS.find", restore)
        self.assertIn("state.llmProfiles.filter", delete)
        self.assertIn("immutable Default profile is now active", delete)
        self.assertIn("Only change these parameters if you understand", self.source)
        self.assertIn('id="promptstudio-add-llm-profile"', self.source)
        self.assertIn('id="promptstudio-delete-llm-profile"', self.source)
        self.assertIn("Non-thinking sampler", self.source)
        self.assertIn("Thinking sampler", self.source)
        self.assertIn("Available thinking modes", self.source)
        self.assertIn('name="thinking_modes" type="checkbox"', self.source)
        self.assertIn("Select at least one available thinking mode", self.source)

        profile_editor_markup = self.source[
            self.source.index('id="promptstudio-llm-profile-editor"'):
            self.source.index('id="promptstudio-consult"')
        ]
        self.assertNotIn('name="thinking_mode"', profile_editor_markup)
        self.assertIn('<label id="promptstudio-thinking-control">Thinking<select id="promptstudio-thinking">', self.source)
        self.assertIn('id="promptstudio-consult-thinking" aria-hidden="true" hidden', self.source)
        self.assertIn('panel.querySelector("#promptstudio-thinking").addEventListener("change"', self.source)

    def test_llm_profile_editor_keeps_actions_visible_while_settings_scroll(self):
        self.assertIn("grid-template-rows: auto minmax(0, 1fr) auto", self.styles)
        fields = self.styles[
            self.styles.index(".promptstudio-llm-profile-editor-fields {"):
            self.styles.index(".promptstudio-llm-profile-warning {")
        ]
        self.assertIn("min-height: 0", fields)
        self.assertIn("overflow-y: auto", fields)
        self.assertIn("overscroll-behavior: contain", fields)

    def test_system_status_popover_occludes_sidebar_drag_handles(self):
        header = self.styles[
            self.styles.index(".promptstudio-header {"):
            self.styles.index(".promptstudio-mobile-header,")
        ]
        popover = self.styles[
            self.styles.index(".promptstudio-kobold-popover {"):
            self.styles.index(".promptstudio-kobold-popover strong {")
        ]

        self.assertIn("z-index: 10", header)
        self.assertIn("background: var(--ps-panel)", popover)

    def test_transient_status_and_settings_have_complete_dismissal_paths(self):
        install = self.function_source("installTypeAnywhereFocus", "setPanelDrawer")
        close_status = self.function_source("closeSystemStatus", "trapDialogFocus")

        self.assertIn('statusControl?.open && !statusControl.contains(event.target)', install)
        self.assertIn('closeSystemStatus({ restoreFocus: true })', install)
        self.assertIn('control.open = false', close_status)
        self.assertIn('id="promptstudio-close-studio-settings"', self.source)
        self.assertIn('role="dialog" aria-labelledby="promptstudio-studio-settings-title"', self.source)
        self.assertIn('!popover.hidden && !openPromptStudioDialog()', self.source)

    def test_modal_focus_is_trapped_and_upscale_restores_its_trigger(self):
        trap = self.function_source("trapDialogFocus", "insertTypedCharacter")
        close_upscale = self.function_source("closeUpscaleDialog", "requestImageUpscale")
        open_upscale = self.function_source("requestImageUpscale", "imageReferenceKey")

        self.assertIn('event.key !== "Tab"', trap)
        self.assertIn('last.focus({ preventScroll: true })', trap)
        self.assertIn('first.focus({ preventScroll: true })', trap)
        self.assertIn('dialog._upscaleTrigger = dialog.ownerDocument.activeElement', open_upscale)
        self.assertIn('trigger?.focus({ preventScroll: true })', close_upscale)

    def test_each_studio_message_has_guarded_delete_with_image_file_choice(self):
        render = self.function_source("renderMessage", "appendMessage")
        delete = self.function_source("messageImageReferences", "renderGenerationProgress")
        store = self.chat_store

        self.assertIn("renderMessageDeleteAction(message, data)", render)
        self.assertIn('button.textContent = "×"', delete)
        self.assertIn('button.className = "promptstudio-message-delete"', delete)
        self.assertIn("Do you really want to delete this message?", self.source)
        self.assertIn(">Delete message</button>", self.source)
        self.assertIn(">Delete message and file</button>", self.source)
        self.assertIn('/promptstudio/prompt-studio/delete-image-files', delete)
        self.assertIn("chatDeletedMessageIds: new Map()", self.state)
        self.assertIn("deletedMessageIds", store)
        self.assertIn("withoutDeletedMessages", store)
        self.assertIn(".promptstudio-message-delete", self.styles)
        self.assertIn("right: 42px", self.styles)

    def test_hidden_modals_do_not_block_native_comfyui_keybindings(self):
        lifecycle = self.function_source("setModalOpen", "openPromptStudioDialog")
        self.assertIn('dialog.setAttribute("aria-modal", "true")', lifecycle)
        self.assertIn('dialog.removeAttribute("aria-modal")', lifecycle)
        self.assertLess(
            lifecycle.index('dialog.removeAttribute("aria-modal")'),
            lifecycle.index("dialog.hidden = true"),
        )

        for dialog_id in (
            "promptstudio-backend-settings-dialog",
            "promptstudio-mutation-editor",
            "promptstudio-llm-profile-editor",
            "promptstudio-lightbox",
            "promptstudio-upscale-dialog",
            "promptstudio-video-handoff-dialog",
            "promptstudio-message-delete-dialog",
            "promptstudio-generation-failure-dialog",
        ):
            start = self.source.index(f'id="{dialog_id}"')
            opening_tag = self.source[start:self.source.index(">", start)]
            self.assertIn('role="dialog"', opening_tag)
            self.assertIn("hidden", opening_tag)
            self.assertNotIn('aria-modal="true"', opening_tag)

        self.assertGreaterEqual(self.source.count("setModalOpen("), 15)

    def test_accessibility_and_cleanup_basics_are_kept_release_ready(self):
        self.assertIn("button:focus-visible", self.styles)
        self.assertIn("prefers-reduced-motion: reduce", self.styles)
        self.assertIn("cursor: not-allowed", self.styles)
        for label in (
            'aria-label="Prompt revision"',
            'aria-label="Main prompt"',
            'aria-label="Final prompt"',
            'aria-label="Local model message"',
        ):
            self.assertIn(label, self.source)
        self.assertNotIn("â†»", self.source)
        for dead_name in (
            "KOBOLD_STATUS_ENDPOINT",
            "KOBOLD_ABORT_ENDPOINT",
            "llmProfileEditorIsOpen",
            "activeTrackedGenerationPromptIds",
            "setConsultProgress",
        ):
            self.assertNotIn(dead_name, self.source)

    def test_cancelled_refresh_does_not_detach_the_standalone_panel(self):
        self.assertFalse((REPO_ROOT / "web" / "js" / "prompt_studio_standalone.js").exists())
        for source in (self.source, self.shell):
            self.assertNotIn('addEventListener("beforeunload"', source)
            self.assertIn('addEventListener("pagehide"', source)

    def test_llm_history_pruning_keeps_turn_and_image_context_consistent(self):
        consult = self.function_source("consultRequestMessages", "collectConsultGenerationSettings")
        discussion = self.function_source("studioDiscussionHistory", "compactGenerationContextValue")

        self.assertIn('while (bounded.length && bounded[0].role === "assistant")', consult)
        self.assertIn("attached_images.slice(0, retainedCount)", consult)
        self.assertIn('while (bounded.length && bounded[0].role === "assistant")', discussion)


if __name__ == "__main__":
    unittest.main()
