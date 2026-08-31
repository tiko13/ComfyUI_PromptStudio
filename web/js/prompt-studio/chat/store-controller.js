import { api } from "/scripts/api.js";

import { CHAT_SYNC_CHANNEL } from "../core/constants.js";
import { state } from "../core/state.js";
import { consultMessagesAfterClear } from "../consult/model.js";

const CHAT_PAGE_SIZE = 20;
const CHAT_PAGE_MAX = 100;

export function createChatStoreController({
  activeChat,
  deduplicateEmptyChats,
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
function chatPageUrl({ limit = CHAT_PAGE_SIZE, cursor = null, revision = null, includeActive = false } = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: "0" });
  if (cursor?.id) {
    params.set("before_activity", String(cursor.activity || 0));
    params.set("before_created", String(cursor.createdAt || 0));
    params.set("before_id", String(cursor.id));
  }
  if (revision != null) params.set("revision", String(revision));
  if (includeActive) params.set("include_active", "1");
  return `/promptstudio/prompt-studio/chats?${params}`;
}

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
    const combined = {
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
    };
    // A durable plot id is monotonic for the lifetime of its chat. Do not let a
    // stale normal-chat view erase it while resolving a cross-tab revision.
    const plotChat = localChat.plotId ? localChat : remoteChat.plotId ? remoteChat : null;
    if (plotChat) {
      combined.sessionMode = "plot";
      combined.plotId = plotChat.plotId;
      combined.plotDraft = plotChat.plotDraft || combined.plotDraft;
      combined.initialized = true;
      const summaries = [remoteChat.plotSummary, localChat.plotSummary]
        .filter((summary) => summary && typeof summary === "object" && !Array.isArray(summary));
      if (summaries.length) {
        combined.plotSummary = structuredClone(summaries.reduce((latest, summary) => (
          Number(summary.updatedAt || 0) >= Number(latest.updatedAt || 0) ? summary : latest
        )));
      }
    }
    merged.set(localChat.id, combined);
  }
  const activeChatId = localStore?.activeChatId || remoteStore?.activeChatId || null;
  return {
    activeChatId,
    chats: deduplicateEmptyChats([...merged.values()], activeChatId),
  };
}

function applyChatStoreSnapshot(stored, { preserveActive = true } = {}) {
  const previousActiveId = preserveActive ? state.activeChatId : null;
  const storedChats = Array.isArray(stored?.chats) ? stored.chats : [];
  state.chats = deduplicateEmptyChats(
    storedChats.map(normalizeChat),
    previousActiveId || stored?.activeChatId,
  );
  state.chatRevision = Number(stored?.revision || state.chatRevision);
  state.chatPageOffset = Number(stored?.nextOffset ?? storedChats.length);
  state.chatPageCursor = stored?.nextCursor || null;
  state.chatTotal = Number(stored?.total ?? state.chats.length);
  state.chatHasMore = Boolean(stored?.hasMore) && state.chats.length < state.chatTotal;
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

async function writeChatStore(snapshot, revision, deletedChatIds = []) {
  return api.fetchApi("/promptstudio/prompt-studio/chats", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...snapshot,
      revision,
      partial: true,
      deletedChatIds,
    }),
  });
}

async function persistChats() {
  if (state.chatPersistenceBlocked || !state.chatStoreLoaded) return;
  const saveMutationVersion = state.chatMutationVersion;
  const deletedChatIds = [...state.chatDeletedIds];
  state.chatSaveInFlight = true;
  try {
    let snapshot = structuredClone({ activeChatId: state.activeChatId, chats: state.chats });
    let response = await writeChatStore(snapshot, state.chatRevision, deletedChatIds);
    let data = await response.json().catch(() => ({}));
    if (response.status === 409) {
      const latestResponse = await api.fetchApi(chatPageUrl({
        limit: Math.min(CHAT_PAGE_MAX, Math.max(CHAT_PAGE_SIZE, state.chatPageOffset)),
        includeActive: true,
      }));
      const latest = await latestResponse.json().catch(() => ({}));
      if (!latestResponse.ok) throw new Error(latest.error || `Chat synchronization failed (${latestResponse.status}).`);
      const deleted = new Set(deletedChatIds);
      const filteredLatest = {
        ...latest,
        chats: (latest.chats || []).filter((chat) => !deleted.has(chat?.id)),
      };
      snapshot = mergeChatStores(filteredLatest, {
        activeChatId: state.activeChatId,
        chats: structuredClone(state.chats),
      });
      const mergedMutationVersion = state.chatMutationVersion;
      response = await writeChatStore(snapshot, Number(latest.revision || 0), deletedChatIds);
      data = await response.json().catch(() => ({}));
      if (response.ok && state.chatMutationVersion === mergedMutationVersion) {
        applyChatStoreSnapshot({
          ...snapshot,
          revision: data.revision,
          total: latest.total,
          nextOffset: latest.nextOffset,
          nextCursor: latest.nextCursor,
          hasMore: latest.hasMore,
        }, { preserveActive: true });
      }
    }
    if (!response.ok) throw new Error(data.error || `Chat save failed (${response.status}).`);
    state.chatRevision = Number(data.revision || state.chatRevision);
    if (state.chatMutationVersion === saveMutationVersion) {
      deletedChatIds.forEach((chatId) => state.chatDeletedIds.delete(chatId));
    }
    state.chatSyncChannel?.postMessage({ type: "chat-store-updated", revision: state.chatRevision });
  } finally {
    state.chatSaveInFlight = false;
  }
}

function saveChats({ immediate = false } = {}) {
  if (state.chatPersistenceBlocked || !state.chatStoreLoaded) return;
  const previousChatIds = new Set(state.chats.map((chat) => chat.id));
  state.chats = deduplicateEmptyChats(state.chats, state.activeChatId);
  const retainedChatIds = new Set(state.chats.map((chat) => chat.id));
  previousChatIds.forEach((chatId) => {
    if (!retainedChatIds.has(chatId)) state.chatDeletedIds.add(chatId);
  });
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
  if (!state.chatStoreLoaded || state.chatPersistenceBlocked || state.chatSyncInFlight || state.chatPageLoading) return;
  if (!force && (state.chatSaveTimer || state.chatSaveInFlight || state.busy)) return;
  const syncMutationVersion = state.chatMutationVersion;
  state.chatSyncInFlight = true;
  try {
    const response = await api.fetchApi(chatPageUrl({
      limit: Math.min(CHAT_PAGE_MAX, Math.max(CHAT_PAGE_SIZE, state.chatPageOffset)),
      revision: state.chatRevision,
      includeActive: true,
    }));
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

async function loadOlderChats() {
  if (
    !state.chatStoreLoaded
    || state.chatPersistenceBlocked
    || state.chatPageLoading
    || state.chatSyncInFlight
    || !state.chatHasMore
    || !state.chatPageCursor
  ) return;
  state.chatPageLoading = true;
  renderChatList();
  try {
    const response = await api.fetchApi(chatPageUrl({ cursor: state.chatPageCursor }));
    const stored = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(stored.error || `Older chats could not be loaded (${response.status}).`);
    const existingIds = new Set(state.chats.map((chat) => chat.id));
    for (const chat of Array.isArray(stored.chats) ? stored.chats.map(normalizeChat) : []) {
      if (!existingIds.has(chat.id) && !state.chatDeletedIds.has(chat.id)) {
        state.chats.push(chat);
        existingIds.add(chat.id);
      }
    }
    state.chatPageOffset += Number(stored.nextOffset || 0);
    state.chatPageCursor = stored.nextCursor || null;
    state.chatTotal = Number(stored.total ?? state.chatTotal);
    state.chatHasMore = Boolean(stored.hasMore) && state.chats.length < state.chatTotal;
  } catch (error) {
    setStatus(error.message || "Older chats could not be loaded.", "warning");
  } finally {
    state.chatPageLoading = false;
    renderChatList();
  }
}

async function loadChats() {
  let recoveredOrMigratedPromptState = false;
  try {
    const response = await api.fetchApi(chatPageUrl({ includeActive: true }));
    const stored = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(stored.error || `Chat load failed (${response.status}).`);
    const storedChats = Array.isArray(stored.chats) ? stored.chats : [];
    const normalizedChats = storedChats.map(normalizeChat);
    recoveredOrMigratedPromptState = normalizedChats.some((chat, index) => {
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
    state.chatDeletedIds.clear();
    state.chats = deduplicateEmptyChats(normalizedChats, stored.activeChatId);
    const retainedIds = new Set(state.chats.map((chat) => chat.id));
    normalizedChats.forEach((chat) => {
      if (!retainedIds.has(chat.id)) state.chatDeletedIds.add(chat.id);
    });
    state.chatPageOffset = Number(stored.nextOffset ?? storedChats.length);
    state.chatPageCursor = stored.nextCursor || null;
    state.chatTotal = Number(stored.total ?? state.chats.length);
    state.chatHasMore = Boolean(stored.hasMore) && state.chats.length < state.chatTotal;
    recoveredOrMigratedPromptState ||= state.chats.length !== normalizedChats.length;
    state.chatStoreLoaded = true;
    state.chatPersistenceBlocked = false;
    state.activeChatId = state.chats.some((chat) => chat.id === stored.activeChatId)
      ? stored.activeChatId
      : state.chats[0]?.id || null;
  } catch (error) {
    state.chats = [];
    state.activeChatId = null;
    state.chatDeletedIds.clear();
    state.chatPageOffset = 0;
    state.chatPageCursor = null;
    state.chatTotal = 0;
    state.chatHasMore = false;
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
    loadOlderChats,
    mergeChatMessages,
    mergeChatStores,
    persistChats,
    refreshChatsFromServer,
    saveChats,
    setupChatSync,
    writeChatStore,
  };
}
