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

    def test_background_prompt_agent_is_visible_and_owns_its_session(self):
        activity = self.function_source("chatActivityAt", "compareChatsNewestFirst")
        chat_list = self.function_source("renderChatList", "scrollHistoryToEnd")
        updater = self.function_source("updateConsultAgent", "setConsultAgentGeneration")
        monitor = self.source[
            self.source.index("async function monitorPromptAgentPhase"):
            self.source.index("async function cancelPromptAgentLlmRequest")
        ]
        self.assertIn("chat.consultAgent?.updatedAt", activity)
        self.assertIn("chat.consultMessages", activity)
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


if __name__ == "__main__":
    unittest.main()
