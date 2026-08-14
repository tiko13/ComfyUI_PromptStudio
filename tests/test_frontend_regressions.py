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
        self.assertIn('remembered.llm_provider === "ollama"', remembered)
        self.assertIn("kobold_url:", remembered)
        self.assertIn("ollama_url:", remembered)
        self.assertIn("ollama_model:", remembered)
        self.assertIn("applyRememberedLlmConnection(", applied)

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

    def test_ollama_is_unloaded_immediately_before_diffusion_queueing(self):
        queue = self.source[
            self.source.index("async function queueGeneration"):
            self.source.index("async function queueUpscale", self.source.index("async function queueGeneration"))
        ]
        self.assertLess(
            queue.index("await unloadOllamaBeforeGeneration();"),
            queue.index("await api.queuePrompt(-1, context.snapshot);"),
        )

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


if __name__ == "__main__":
    unittest.main()
