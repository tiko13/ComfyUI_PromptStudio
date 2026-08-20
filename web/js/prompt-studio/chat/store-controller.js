import { api } from "/scripts/api.js";

import { CHAT_SYNC_CHANNEL } from "../core/constants.js";
import { state } from "../core/state.js";
import { consultMessagesAfterClear } from "../consult/model.js";

export function createChatStoreController({
  activeChat,
  imageReferenceKey,
  newChatStudioSettings,
  normalizeChat,
  pruneExpiredConsultMessages,
  refreshSecondaryInstructionsControl,
  refreshStudioStatus,
  refreshWorkflowControls,
  renderChatHistory,
  renderChatList,
  renderConsultHistory,
  restoreChatState,
  resumeConsultJobs,
  resumeSyncedGeneration,
  setStatus,
}) {
function mergeChatMessages(remoteMessages, localMessages) {
  const merged = new Map();
  for (const message of [...remoteMessages, ...localMessages]) {
    const current = merged.get(message.id);
    if (!current) {
      merged.set(message.id, message);
      continue;
    }
    const newer = Number(message.updatedAt || message.createdAt) >= Number(current.updatedAt || current.createdAt)
      ? message
      : current;
    const older = newer === message ? current : message;
    const images = new Map();
    for (const image of [...(older.images || []), ...(newer.images || [])]) {
      const key = imageReferenceKey(image);
      if (key) images.set(key, image);
    }
    const combined = { ...older, ...newer, images: [...images.values()] };
    if (Array.isArray(older.variants) || Array.isArray(newer.variants)) {
      const variants = new Map();
      for (const variant of [...(older.variants || []), ...(newer.variants || [])]) {
        if (variant?.id) variants.set(variant.id, variant);
      }
      combined.variants = [...variants.values()].sort((left, right) => (
        Number(left.createdAt || 0) - Number(right.createdAt || 0)
        || String(left.id).localeCompare(String(right.id))
      ));
      const selectedVariantId = newer.variants?.[newer.variantIndex]?.id;
      const selectedIndex = combined.variants.findIndex((variant) => variant.id === selectedVariantId);
      combined.variantIndex = selectedIndex >= 0 ? selectedIndex : combined.variants.length - 1;
      combined.text = combined.variants[combined.variantIndex]?.text || combined.text;
      combined.proposal = combined.variants[combined.variantIndex]?.proposal || null;
      combined.generation = combined.variants[combined.variantIndex]?.generation || null;
    }
    merged.set(message.id, combined);
  }
  return [...merged.values()].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

function mergeChatStores(remoteStore, localStore) {
  const remoteChats = Array.isArray(remoteStore?.chats) ? remoteStore.chats.map(normalizeChat) : [];
  const localChats = Array.isArray(localStore?.chats) ? localStore.chats.map(normalizeChat) : [];
  const merged = new Map(remoteChats.map((chat) => [chat.id, chat]));
  for (const localChat of localChats) {
    const remoteChat = merged.get(localChat.id);
    if (!remoteChat) {
      merged.set(localChat.id, localChat);
      continue;
    }
    const newer = localChat.updatedAt >= remoteChat.updatedAt ? localChat : remoteChat;
    const older = newer === localChat ? remoteChat : localChat;
    const consultClearedAt = Math.max(
      Number(remoteChat.consultClearedAt || 0),
      Number(localChat.consultClearedAt || 0),
    );
    merged.set(localChat.id, {
      ...older,
      ...newer,
      createdAt: Math.min(localChat.createdAt, remoteChat.createdAt),
      updatedAt: Math.max(localChat.updatedAt, remoteChat.updatedAt),
      messages: mergeChatMessages(remoteChat.messages, localChat.messages),
      consultClearedAt,
      consultMessages: consultMessagesAfterClear(
        mergeChatMessages(remoteChat.consultMessages, localChat.consultMessages),
        consultClearedAt,
      ),
    });
  }
  return {
    activeChatId: localStore?.activeChatId || remoteStore?.activeChatId || null,
    chats: [...merged.values()],
  };
}

function applyChatStoreSnapshot(stored, { preserveActive = true } = {}) {
  const previousActiveId = preserveActive ? state.activeChatId : null;
  const storedChats = Array.isArray(stored?.chats) ? stored.chats : [];
  state.chats = storedChats.map(normalizeChat);
  state.chatRevision = Number(stored?.revision || state.chatRevision);
  state.chatStoreLoaded = true;
  state.chatPersistenceBlocked = false;
  state.activeChatId = state.chats.some((chat) => chat.id === previousActiveId)
    ? previousActiveId
    : state.chats.some((chat) => chat.id === stored?.activeChatId)
      ? stored.activeChatId
      : state.chats[0]?.id || null;
  const chat = activeChat();
  if (chat) {
    restoreChatState(chat);
    refreshWorkflowControls();
    refreshSecondaryInstructionsControl();
    refreshStudioStatus();
  }
  renderChatHistory();
  renderConsultHistory();
  renderChatList();
  resumeConsultJobs();
  resumeSyncedGeneration();
}

async function writeChatStore(snapshot, revision) {
  return api.fetchApi("/promptstudio/prompt-studio/chats", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...snapshot, revision }),
  });
}

async function persistChats() {
  if (state.chatPersistenceBlocked || !state.chatStoreLoaded) return;
  state.chatSaveInFlight = true;
  try {
    let snapshot = structuredClone({ activeChatId: state.activeChatId, chats: state.chats });
    let response = await writeChatStore(snapshot, state.chatRevision);
    let data = await response.json().catch(() => ({}));
    if (response.status === 409) {
      const latestResponse = await api.fetchApi("/promptstudio/prompt-studio/chats");
      const latest = await latestResponse.json().catch(() => ({}));
      if (!latestResponse.ok) throw new Error(latest.error || `Chat synchronization failed (${latestResponse.status}).`);
      snapshot = mergeChatStores(latest, {
        activeChatId: state.activeChatId,
        chats: structuredClone(state.chats),
      });
      const mergedMutationVersion = state.chatMutationVersion;
      response = await writeChatStore(snapshot, Number(latest.revision || 0));
      data = await response.json().catch(() => ({}));
      if (response.ok && state.chatMutationVersion === mergedMutationVersion) {
        applyChatStoreSnapshot({ ...snapshot, revision: data.revision }, { preserveActive: true });
      }
    }
    if (!response.ok) throw new Error(data.error || `Chat save failed (${response.status}).`);
    state.chatRevision = Number(data.revision || state.chatRevision);
    state.chatSyncChannel?.postMessage({ type: "chat-store-updated", revision: state.chatRevision });
  } finally {
    state.chatSaveInFlight = false;
  }
}

function saveChats({ immediate = false } = {}) {
  if (state.chatPersistenceBlocked || !state.chatStoreLoaded) return;
  if (pruneExpiredConsultMessages()) renderConsultHistory();
  state.chatMutationVersion += 1;
  if (state.chatSaveTimer) clearTimeout(state.chatSaveTimer);
  const persist = () => {
    state.chatSaveTimer = null;
    state.chatSaveChain = state.chatSaveChain
      .catch(() => {})
      .then(persistChats)
      .catch((error) => setStatus(error.message || "Chat history could not be saved.", "warning"));
  };
  if (immediate) persist();
  else state.chatSaveTimer = setTimeout(persist, 150);
}

async function refreshChatsFromServer({ force = false } = {}) {
  if (!state.chatStoreLoaded || state.chatPersistenceBlocked || state.chatSyncInFlight) return;
  if (!force && (state.chatSaveTimer || state.chatSaveInFlight || state.busy)) return;
  const syncMutationVersion = state.chatMutationVersion;
  state.chatSyncInFlight = true;
  try {
    const response = await api.fetchApi(`/promptstudio/prompt-studio/chats?revision=${encodeURIComponent(state.chatRevision)}`);
    if (response.status === 204) return;
    const stored = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(stored.error || `Chat synchronization failed (${response.status}).`);
    if (Number(stored.revision || 0) <= state.chatRevision) return;
    // A generation or other local action may have changed chat state while this request was in flight.
    // Keep that state authoritative; its pending save will merge against the newer server revision.
    if (state.chatMutationVersion !== syncMutationVersion) return;
    applyChatStoreSnapshot(stored, { preserveActive: true });
  } catch (error) {
    if (force) setStatus(error.message || "Chat history could not be synchronized.", "warning");
  } finally {
    state.chatSyncInFlight = false;
  }
}

function setupChatSync() {
  if (!state.chatSyncTimer) {
    state.chatSyncTimer = window.setInterval(() => refreshChatsFromServer(), 1250);
    window.addEventListener("focus", () => refreshChatsFromServer());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshChatsFromServer();
    });
  }
  if (typeof BroadcastChannel !== "function" || state.chatSyncChannel) return;
  const channel = new BroadcastChannel(CHAT_SYNC_CHANNEL);
  channel.addEventListener("message", (event) => {
    if (event.data?.type !== "chat-store-updated") return;
    if (Number(event.data.revision || 0) <= state.chatRevision) return;
    refreshChatsFromServer();
  });
  state.chatSyncChannel = channel;
}

async function loadChats() {
  let recoveredOrMigratedPromptState = false;
  try {
    const response = await api.fetchApi("/promptstudio/prompt-studio/chats");
    const stored = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(stored.error || `Chat load failed (${response.status}).`);
    const storedChats = Array.isArray(stored.chats) ? stored.chats : [];
    state.chats = storedChats.map(normalizeChat);
    recoveredOrMigratedPromptState = state.chats.some((chat, index) => {
      const storedChat = storedChats[index];
      return (
        (!String(storedChat?.currentPrompt || "").trim() && Boolean(chat.currentPrompt.trim()))
        || typeof storedChat?.mainPrompt !== "string"
        || typeof storedChat?.finalPrompt !== "string"
        || !storedChat?.studioSettings
        || JSON.stringify(storedChat?.studioSettings) !== JSON.stringify(chat.studioSettings)
        || (Array.isArray(storedChat?.versions) && storedChat.versions.some((version) => typeof version !== "object"))
      );
    });
    state.chatRevision = Number(stored.revision || 0);
    state.chatStoreLoaded = true;
    state.chatPersistenceBlocked = false;
    state.activeChatId = state.chats.some((chat) => chat.id === stored.activeChatId)
      ? stored.activeChatId
      : state.chats[0]?.id || null;
  } catch (error) {
    state.chats = [];
    state.activeChatId = null;
    state.chatStoreLoaded = false;
    state.chatPersistenceBlocked = true;
    setStatus(error.message || "Chat history could not be loaded.", "warning");
  }
  if (!state.chats.length) {
    const chat = normalizeChat({ studioSettings: newChatStudioSettings() });
    state.chats.push(chat);
    state.activeChatId = chat.id;
    if (state.chatStoreLoaded) saveChats({ immediate: true });
  }
  const chat = activeChat();
  if (chat) {
    restoreChatState(chat);
    renderChatHistory();
    renderChatList();
  }
  if (recoveredOrMigratedPromptState) saveChats({ immediate: true });
}

  return {
    applyChatStoreSnapshot,
    loadChats,
    mergeChatMessages,
    mergeChatStores,
    persistChats,
    refreshChatsFromServer,
    saveChats,
    setupChatSync,
    writeChatStore,
  };
}
