import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


class FrontendRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = (REPO_ROOT / "web" / "js" / "prompt_studio.js").read_text(encoding="utf-8")
        cls.styles = (REPO_ROOT / "web" / "css" / "prompt_studio.css").read_text(encoding="utf-8")

    def function_source(self, name, next_name):
        start = self.source.index(f"function {name}")
        end = self.source.index(f"\nfunction {next_name}", start)
        return self.source[start:end]

    def test_empty_consult_history_refreshes_prompt_agent_mode(self):
        render = self.function_source("renderConsultHistory", "selectConsultResponse")
        self.assertLess(
            render.index("updateConsultExperimentUi();"),
            render.index("if (!messages.length && !agent)"),
        )

    def test_pending_llm_messages_show_phase_and_live_token_count(self):
        activity = self.function_source("llmActivityLabel", "llmGeneratedTokenCount")
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
        self.assertIn('return "Generating"', activity)
        self.assertIn('return "Thinking / generating"', activity)
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

    def test_new_chats_reset_generation_controls_except_thinking_and_embellishment(self):
        fresh = self.function_source("newChatStudioSettings", "studioSettingsFromControlsFingerprint")
        create = self.function_source("createChat", "deleteChat")
        load = self.source[
            self.source.index("async function loadChats"):
            self.source.index("function restoreChatState")
        ]
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
        self.assertIn("keep_models_loaded:", remembered)
        self.assertIn("applyRememberedLlmConnection(", applied)

    def test_ollama_is_default_and_advanced_providers_warn_once(self):
        defaults = self.source[
            self.source.index("const SETTINGS_DEFAULTS"):
            self.source.index("const LLM_PROFILE_DEFAULTS")
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
        file_picker = self.function_source("browseLlamacppPath", "startLlmStatusMonitor")
        config_builder = self.function_source("openLlamacppConfigBuilder", "startLlmStatusMonitor")

        self.assertIn('"llamacpp"', provider)
        self.assertIn("llamacpp_url:", connection)
        self.assertIn("llamacpp_model:", connection)
        self.assertIn("llamacpp_executable:", connection)
        self.assertIn("llamacpp_config_profile:", connection)
        self.assertIn("llmGeneratedTokenCount(status)", status)
        self.assertIn("server_process", status)
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
        self.assertIn("chat.mainPromptDirty = true;", sync)
        self.assertIn("chat?.initialized && chat.mainPromptDirty", render_state)
        self.assertIn("mainPrompt = previousMainPrompt;", revise)
        self.assertIn('payloadFor(mainPrompt, "render", "", previousFinalPrompt)', revise)

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

    def test_prompt_agent_failure_does_not_leave_iteration_generating(self):
        normalizer = self.function_source(
            "normalizePromptAgentIteration",
            "normalizePromptAgentConversationContext",
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

    def test_prompt_agent_stop_survives_a_page_refresh(self):
        normalizer = self.function_source(
            "normalizeConsultAgent",
            "normalizeConsultMessage",
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
        sync = self.function_source("refreshChatsFromServer", "setupChatSync")
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

        self.assertIn("const CHAT_SCROLL_STICK_THRESHOLD = 450;", self.source)
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

        self.assertIn("keep_models_loaded: false", self.source)
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
        self.assertIn('state.comfyUpdateMessage = "ComfyUI queued', update)
        self.assertIn('state.comfyUpdateMessage = "Updates queued', update)
        self.assertIn("status.target", queue)
        self.assertIn("updatedCount", finish)
        self.assertIn("failedCount", finish)
        self.assertIn("failedLabels", finish)
        self.assertIn("Failed:", finish)
        self.assertIn("setStatus(state.comfyUpdateMessage", finish)
        self.assertIn("control.open = true", finish)
        self.assertIn('status.status === "all-done"', queue)
        self.assertIn('api.addEventListener("cm-task-started", handleManagerTaskStarted)', self.source)
        self.assertIn('api.addEventListener("cm-task-completed", handleManagerTaskCompleted)', self.source)
        self.assertIn("counts.done >= counts.total", self.source)
        self.assertIn('"/v2/manager/queue/update_comfyui"', self.source)
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

        self.assertIn('id: "qwen3.5",\n  name: "Default"', self.source)
        self.assertIn('name: "Qwen 3.8 (27B)"', self.source)
        self.assertIn('id: "qwen3.8-27b"', self.source)
        self.assertIn("presence_penalty: 1.5", self.source)
        self.assertIn("top_p: 0.8", self.source)
        self.assertIn("top_k: 20", self.source)
        self.assertIn("thinking_temperature: 1.0", self.source)
        self.assertIn("thinking_top_p: 0.95", self.source)
        self.assertIn("thinking_presence_penalty: 0", self.source)
        self.assertIn('thinking_modes: Object.freeze(["XHigh", "Medium", "Low", "Disabled"])', self.source)
        self.assertIn('thinking_mode: "XHigh"', self.source)
        self.assertIn("LLM_PROFILE_STORAGE_VERSION = 6", self.source)
        self.assertIn("Llama.cpp reasoning cap", self.source)
        self.assertIn('name="llamacpp_reasoning_budget_tokens"', self.source)
        self.assertIn('profile?.name === "Qwen3.5"', self.source)
        self.assertIn("storageVersion < LLM_PROFILE_STORAGE_VERSION", self.source)
        self.assertIn("storageVersion < 2", self.source)
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


if __name__ == "__main__":
    unittest.main()
