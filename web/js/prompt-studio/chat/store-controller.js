import { api } from "/scripts/api.js";
import { requireHistoryIndex, prepareHistoryIndex } from "../ui/history-maintenance.js";
import { createDraftOutbox, createDraftScheduler, draftTabKey, exportDraft, showDraftStorageFailure, clearDraftStorageFailure } from "./draft-outbox.js";
import { archiveDraft, showDraftReviews, draftDifferences, applyDraftDifference, draftChatLabel } from './draft-review.js';

import { CHAT_SYNC_CHANNEL } from "../core/constants.js";
import { state } from "../core/state.js";
import { consultMessagesAfterClear } from "../consult/model.js";

import { validateStoreResponse } from "./store-response.js";
import { newChatWorkflowSelections } from "../settings/workflow-defaults.js";

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
  recoverStudioSubmissions,
  setStatus,
}) {
const acknowledgedChats = new Map();
const draftOutbox = createDraftOutbox();
let draftMutation = 0;
let restoredComposerText = null;
let draftChatsVersion = -1;
let draftChats = [];
let draftReviewInFlight = false;
let savedMutationVersion = state.chatMutationVersion;
const draftScheduler = createDraftScheduler(writeDraft);
function draftContainer() { return state.panel?.querySelector('.promptstudio-chat-sidebar'); }
function showChatFailure(error, loading = false) {
  setStatus(error.message || "Chat history could not be saved.", "warning");
  const container = draftContainer();
  if (!container) return;
  const attribute = loading ? 'data-chat-load-failure' : 'data-chat-save-failure';
  let notice = container.querySelector('[' + attribute + ']');
  if (!notice) {
    notice = container.ownerDocument.createElement('div');
    notice.setAttribute(attribute, 'true');
    notice.setAttribute('role', 'alert');
    container.prepend(notice);
  }
  const text = container.ownerDocument.createElement('p');
  text.textContent = (error.message || error) + ' ' + (loading
    ? 'History is unavailable; new edits stay local until loading succeeds.'
    : 'Your edits remain in this tab. Retry saving or export them before closing.');
  const retry = container.ownerDocument.createElement('button');
  retry.type = 'button';
  retry.dataset.promptstudioAllowDisconnected = 'true';
  retry.textContent = loading ? 'Retry loading history' : 'Retry save';
  retry.addEventListener('click', async () => {
    retry.disabled = true;
    try {
      if (loading) await loadChats();
      else { saveChats({ immediate: true }); await state.chatSaveChain; }
    } finally { retry.disabled = false; }
  });
  const download = container.ownerDocument.createElement('button');
  download.type = 'button';
  download.dataset.promptstudioAllowDisconnected = 'true';
  download.textContent = 'Export unsaved draft';
  download.addEventListener('click', async () => exportDraft(await writeDraft(), container.ownerDocument));
  notice.replaceChildren(text, retry, download);
}
async function writeDraft({ throwOnFailure = false } = {}) {
  draftScheduler.cancel();
  if (draftChatsVersion !== state.chatMutationVersion) {
    draftChats = structuredClone(state.chats.filter(chat => acknowledgedChats.get(chat.id) !== JSON.stringify(chat)));
    draftChatsVersion = state.chatMutationVersion;
  }
  const record = {
    mutation: ++draftMutation, revision: state.chatRevision,
    activeChatId: state.activeChatId,
    chats: draftChats,
    baseChats: draftChats.map(chat => acknowledgedChats.has(chat.id) ? JSON.parse(acknowledgedChats.get(chat.id)) : null).filter(Boolean),
    deletedChatIds: [...state.chatDeletedIds], deletedMessageIds: deletedMessageIdsPayload(),
    composerText: state.panel?.querySelector('#promptstudio-revision')?.value || '',
  };
  try {
    if (record.chats.length || record.composerText || record.deletedChatIds.length || Object.keys(record.deletedMessageIds).length) {
      await draftOutbox.put(draftTabKey('image'), record);
    } else {
      await draftOutbox.acknowledge(draftTabKey('image'), record.mutation);
    }
    if (record.mutation === draftMutation) clearDraftStorageFailure(draftContainer(), record);
  }
  catch (error) {
    if (record.mutation === draftMutation) showDraftStorageFailure(draftContainer(),record,error.message);
    if (throwOnFailure) throw error;
  }
  return record;
}
function acknowledgeChats(chats) {
  for (const chat of chats || []) acknowledgedChats.set(chat.id, JSON.stringify(chat));
  draftChatsVersion = -1;
}

async function readDraftReviewStore() {
  const response = await api.fetchApi('/promptstudio/prompt-studio/chats');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'History could not be loaded. Try again.');
  validateStoreResponse(data, 'chats');
  return { ...data, chats: data.chats.map(normalizeChat) };
}

async function reviewDifferences(draft) {
  const current = await readDraftReviewStore();
  const local = { chats: (draft.chats || []).map(normalizeChat) };
  const base = Array.isArray(draft.baseChats) ? { chats: draft.baseChats.map(normalizeChat) } : undefined;
  const items = draftDifferences(local, current, base);
  for (const id of draft.deletedChatIds || []) {
    const chat = current.chats.find(chat => chat.id === id);
    for (let index = items.length - 1; index >= 0; index--) if (items[index].path[1]?.id === id) items.splice(index, 1);
    if (chat) items.push({ id: `delete-chat:${id}`, path: ['chats', { id }], title: `${draftChatLabel(chat)} → Delete chat`, current: chat, value: undefined });
  }
  for (const [id, ids] of Object.entries(draft.deletedMessageIds || {})) {
    const chat = current.chats.find(chat => chat.id === id);
    for (const messageId of ids) {
      const message = chat?.messages?.find(message => message.id === messageId);
      if (message) {
        const path = ['chats', { id }, 'messages', { id: messageId }];
        const duplicate = items.findIndex(item => item.id === JSON.stringify(path));
        if (duplicate >= 0) items.splice(duplicate, 1);
        items.push({ id: JSON.stringify(path), path, title: `${draftChatLabel(chat)} → Delete message`, current: message, value: undefined });
      }
    }
  }
  if (draft.composerText) {
    const chat = current.chats.find(chat => chat.id === draft.activeChatId);
    const currentText = state.activeChatId === draft.activeChatId ? state.panel?.querySelector('#promptstudio-revision')?.value || '' : '';
    if (currentText !== draft.composerText) items.push({ id: 'composer', path: ['composerText'], title: `${draftChatLabel(chat)} → Unsent message`, current: currentText, value: draft.composerText });
  }
  return items;
}

async function applyReviewedDraft(item, draft) {
  if (state.busy || state.chatSyncInFlight) throw new Error('Wait for current work to finish, then apply this change.');
  if (item.id === 'composer') {
    const chat = state.chats.find(chat => chat.id === draft.activeChatId)
      || (await readDraftReviewStore()).chats.find(chat => chat.id === draft.activeChatId);
    if (!chat) throw new Error('Restore the original chat from this draft first.');
    const input = state.panel?.querySelector('#promptstudio-revision');
    if (input.value !== item.current && input.value !== item.value) throw new Error('The unsent message changed. Open its original chat and refresh differences first.');
    if (!state.chats.some(saved => saved.id === chat.id)) state.chats.push(chat);
    state.activeChatId = chat.id;
    restoreChatState(chat); renderChatHistory(); renderConsultHistory(); renderChatList();
    input.value = item.value;
    await writeDraft({ throwOnFailure: true });
    return;
  }
  clearTimeout(state.chatSaveTimer); state.chatSaveTimer = null;
  const operation = state.chatSaveChain.catch(() => {}).then(async () => {
    draftReviewInFlight = true;
    try { await applyReviewedChatDifference(item); }
    finally { draftReviewInFlight = false; }
  });
  state.chatSaveChain = operation.catch(() => {});
  return operation;
}

async function applyReviewedChatDifference(item) {
  // Check the reviewed value before flushing local saves, which may themselves merge history.
  applyDraftDifference(await readDraftReviewStore(), item);
  if (state.chatMutationVersion !== savedMutationVersion) await persistChats();
  const mutation = state.chatMutationVersion;
  const current = await readDraftReviewStore();
  const next = applyDraftDifference(current, item);
  if (mutation !== state.chatMutationVersion) throw new Error('History changed during review. Refresh differences and try again.');
  const id = item.path[1].id;
  const selectedChat = next.chats.find(chat => chat.id === id);
  const chat = selectedChat ? normalizeChat(selectedChat) : null;
  if (chat) chat.updatedAt = Date.now();
  const response = await api.fetchApi('/promptstudio/prompt-studio/chats', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: current.revision, partial: true, chats: chat ? [chat] : [], deletedChatIds: chat ? [] : [id] }),
  });
  const result = await response.json();
  if (response.status === 409) throw new Error('Server history changed. Refresh differences and review this item again.');
  if (!response.ok) throw new Error(result.error || 'The change could not be saved. Try again.');
  validateStoreResponse(result);
  state.chatRevision = result.revision;
  if (chat) acknowledgeChats([chat]);
  else acknowledgedChats.delete(id);
  if (mutation === state.chatMutationVersion) {
    const index = state.chats.findIndex(saved => saved.id === id);
    if (!chat) { if (index >= 0) state.chats.splice(index, 1); acknowledgedChats.delete(id); }
    else { if (index >= 0) state.chats[index] = chat; else state.chats.push(chat); acknowledgeChats([chat]); }
    if (!state.chats.some(saved => saved.id === state.activeChatId)) state.activeChatId = state.chats[0]?.id || null;
    if (activeChat()) restoreChatState(activeChat());
    renderChatHistory(); renderConsultHistory(); renderChatList();
    refreshWorkflowControls(); refreshSecondaryInstructionsControl(); refreshStudioStatus();
  } else {
    // Background completion may add messages during the request. Retain those edits
    // while incorporating the reviewed field if it has not independently changed.
    try { state.chats = applyDraftDifference({ chats: state.chats }, item).chats; }
    catch (_) { /* A newer local edit owns this value and its scheduled save. */ }
  }
  state.chatSyncChannel?.postMessage({ type: 'chat-store-updated', revision: result.revision });
}

function showRecoveredDrafts() {
  return showDraftReviews({ container: draftContainer(), outbox: draftOutbox, key: draftTabKey('image'), differences: reviewDifferences, apply: applyReviewedDraft });
}
function chatPageUrl({ limit = CHAT_PAGE_SIZE, cursor = null, revision = null, includeActive = false } = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: "0" });
  if (cursor?.id) {
    params.set("before_activity", String(cursor.activity || 0));
    params.set("before_created", String(cursor.createdAt || 0));
    params.set("before_id", String(cursor.id));
  }
  if (revision != null) params.set("revision", String(revision));
  if (includeActive) params.set("include_active", "1");
  if (includeActive) params.set("include_pending", "1");
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

function deletedMessageIdsPayload() {
  return Object.fromEntries(
    [...state.chatDeletedMessageIds.entries()]
      .map(([chatId, messageIds]) => [chatId, [...messageIds]])
      .filter(([chatId, messageIds]) => chatId && messageIds.length),
  );
}

function withoutDeletedMessages(store, deletedMessageIds) {
  const chats = (store?.chats || []).map((chat) => {
    const deleted = new Set(deletedMessageIds[chat?.id] || []);
    return deleted.size
      ? { ...chat, messages: (chat.messages || []).filter((message) => !deleted.has(message?.id)) }
      : chat;
  });
  return { ...store, chats };
}

function applyChatStoreSnapshot(stored, { preserveActive = true } = {}) {
  const previousActiveId = preserveActive ? state.activeChatId : null;
  const storedChats = Array.isArray(stored?.chats) ? stored.chats : [];
  state.chats = deduplicateEmptyChats(
    storedChats.map(normalizeChat),
    previousActiveId || stored?.activeChatId,
  );
  acknowledgeChats(storedChats);
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

async function writeChatStore(snapshot, revision, deletedChatIds = [], deletedMessageIds = {}) {
  return api.fetchApi("/promptstudio/prompt-studio/chats", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...snapshot,
      chats: snapshot.chats.filter(chat => acknowledgedChats.get(chat.id) !== JSON.stringify(chat)),
      revision,
      partial: true,
      deletedChatIds,
      deletedMessageIds,
    }),
  });
}

async function persistChats() {
  if (state.chatPersistenceBlocked || !state.chatStoreLoaded) return;
  const saveMutationVersion = state.chatMutationVersion;
  await writeDraft();
  const deletedChatIds = [...state.chatDeletedIds];
  const deletedMessageIds = deletedMessageIdsPayload();
  state.chatSaveInFlight = true;
  try {
    let snapshot = structuredClone({ activeChatId: state.activeChatId, chats: state.chats });
    let response = await writeChatStore(snapshot, state.chatRevision, deletedChatIds, deletedMessageIds);
    let data = await response.json().catch(() => ({}));
    if (response.status === 409) {
      const latestResponse = await api.fetchApi(chatPageUrl({
        limit: Math.min(CHAT_PAGE_MAX, Math.max(CHAT_PAGE_SIZE, state.chatPageOffset)),
        includeActive: true,
      }));
      const latest = await latestResponse.json().catch(() => ({}));
      requireHistoryIndex(latest, draftContainer(), '/promptstudio/prompt-studio/chats', loadChats);
      if (!latestResponse.ok) throw new Error(latest.error || `Chat synchronization failed (${latestResponse.status}).`);
      validateStoreResponse(latest, 'chats');
      acknowledgeChats(latest.chats || []);
      const deleted = new Set(deletedChatIds);
      const filteredLatest = withoutDeletedMessages({
        ...latest,
        chats: (latest.chats || []).filter((chat) => !deleted.has(chat?.id)),
      }, deletedMessageIds);
      snapshot = mergeChatStores(filteredLatest, {
        activeChatId: state.activeChatId,
        chats: structuredClone(state.chats),
      });
      const mergedMutationVersion = state.chatMutationVersion;
      response = await writeChatStore(snapshot, Number(latest.revision || 0), deletedChatIds, deletedMessageIds);
      data = await response.json().catch(() => ({}));
      if (response.ok) validateStoreResponse(data);
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
    validateStoreResponse(data);
    acknowledgeChats(snapshot.chats);
    savedMutationVersion = saveMutationVersion;
    if (state.chatMutationVersion === savedMutationVersion) draftContainer()?.querySelector('[data-chat-save-failure]')?.remove();
    state.chatRevision = Number(data.revision || state.chatRevision);
    if (state.chatMutationVersion === saveMutationVersion) {
      deletedChatIds.forEach((chatId) => state.chatDeletedIds.delete(chatId));
      for (const [chatId, messageIds] of Object.entries(deletedMessageIds)) {
        const pending = state.chatDeletedMessageIds.get(chatId);
        messageIds.forEach((messageId) => pending?.delete(messageId));
        if (!pending?.size) state.chatDeletedMessageIds.delete(chatId);
      }
    }
    state.chatSyncChannel?.postMessage({ type: "chat-store-updated", revision: state.chatRevision });
    // Refresh the recovery copy after acknowledgement: saved chat history no longer
    // belongs in it, but a newer edit or unsent composer must still be protected.
    await writeDraft();
  } finally {
    state.chatSaveInFlight = false;
  }
}

function saveChats({ immediate = false } = {}) {
  // Initialization must not replace an existing browser draft with an empty one.
  if (!state.chatStoreLoaded && !state.chats.length) return;
  const previousChatIds = new Set(state.chats.map((chat) => chat.id));
  state.chats = deduplicateEmptyChats(state.chats, state.activeChatId);
  const retainedChatIds = new Set(state.chats.map((chat) => chat.id));
  previousChatIds.forEach((chatId) => {
    if (!retainedChatIds.has(chatId)) state.chatDeletedIds.add(chatId);
  });
  if (pruneExpiredConsultMessages()) renderConsultHistory();
  state.chatMutationVersion += 1;
  draftScheduler.schedule();
  if (state.chatPersistenceBlocked || !state.chatStoreLoaded) return;
  if (state.chatSaveTimer) clearTimeout(state.chatSaveTimer);
  const persist = () => {
    state.chatSaveTimer = null;
    state.chatSaveChain = state.chatSaveChain
      .catch(() => {})
      .then(persistChats)
      .catch((error) => showChatFailure(error));
  };
  if (immediate) {
    persist();
    return state.chatSaveChain;
  }
  state.chatSaveTimer = setTimeout(persist, 150);
}

async function refreshChatsFromServer({ force = false } = {}) {
  if (!state.chatStoreLoaded || state.chatPersistenceBlocked || state.chatSyncInFlight || state.chatPageLoading || draftReviewInFlight) return;
  if (!force && (state.chatSaveTimer || state.chatSaveInFlight || state.busy)) return;
  // A failed save stays dirty after its timer and request have finished.
  if (state.chatMutationVersion !== savedMutationVersion) return;
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
    requireHistoryIndex(stored, draftContainer(), '/promptstudio/prompt-studio/chats', loadChats);
    validateStoreResponse(stored, 'chats');
    if (Number(stored.revision || 0) <= state.chatRevision) return;
    // A generation or other local action may have changed chat state while this request was in flight.
    // Keep that state authoritative; its pending save will merge against the newer server revision.
    if (state.chatMutationVersion !== syncMutationVersion || draftReviewInFlight) return;
    applyChatStoreSnapshot(stored, { preserveActive: true });
  } catch (error) {
    if (force) setStatus(error.message || "Chat history could not be synchronized.", "warning");
  } finally {
    state.chatSyncInFlight = false;
  }
}

function setupChatSync() {
  if (state.panel && !state.panel.dataset.draftInputAttached) {
    state.panel.dataset.draftInputAttached = 'true';
    state.panel.addEventListener('input', event => {
      if (event.target.id === 'promptstudio-revision') draftScheduler.schedule();
    });
  }
  if (!state.chatSyncTimer) {
    state.chatSyncTimer = window.setInterval(() => refreshChatsFromServer(), 1250);
    window.addEventListener("focus", () => refreshChatsFromServer());
    window.addEventListener("pagehide", () => draftScheduler.flush());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshChatsFromServer();
      else draftScheduler.flush();
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
    requireHistoryIndex(stored, draftContainer(), '/promptstudio/prompt-studio/chats', loadChats);
    validateStoreResponse(stored, 'chats');
    const existingIds = new Set(state.chats.map((chat) => chat.id));
    for (const chat of Array.isArray(stored.chats) ? stored.chats.map(normalizeChat) : []) {
      if (!existingIds.has(chat.id) && !state.chatDeletedIds.has(chat.id)) {
        state.chats.push(chat);
        acknowledgeChats([chat]);
        existingIds.add(chat.id);
      }
    }
    state.chatPageOffset += Number(stored.nextOffset || 0);
    state.chatPageCursor = stored.nextCursor || null;
    state.chatTotal = Number(stored.total ?? state.chatTotal);
    state.chatHasMore = Boolean(stored.hasMore) && state.chats.length < state.chatTotal;
    resumeSyncedGeneration();
  } catch (error) {
    setStatus(error.message || "Older chats could not be loaded.", "warning");
  } finally {
    state.chatPageLoading = false;
    renderChatList();
  }
}

async function loadChats() {
  let recoveredOrMigratedPromptState = false;
  // Preserve sessions written while initial history loading was unavailable.
  const pendingChats = !state.chatStoreLoaded ? state.chats.filter(chat => (
    chat.initialized || chat.mainPrompt || chat.finalPrompt || chat.messages?.length || chat.consultMessages?.length
  )) : [];
  const pendingActiveId = state.activeChatId;
  const pendingComposer = state.panel?.querySelector('#promptstudio-revision')?.value || '';
  try {
    let response = await api.fetchApi(chatPageUrl({ includeActive: true }));
    let stored = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(stored.error || `Chat load failed (${response.status}).`);
    if (await prepareHistoryIndex(stored, draftContainer(), '/promptstudio/prompt-studio/chats', loadChats)) {
      response = await api.fetchApi(chatPageUrl({ includeActive: true }));
      stored = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(stored.error || `Chat load failed (${response.status}).`);
    }
    requireHistoryIndex(stored, draftContainer(), '/promptstudio/prompt-studio/chats', loadChats);
    validateStoreResponse(stored, 'chats');
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
    acknowledgeChats(storedChats);
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
    savedMutationVersion = state.chatMutationVersion;
    state.activeChatId = state.chats.some((chat) => chat.id === stored.activeChatId)
      ? stored.activeChatId
      : state.chats[0]?.id || null;
    try {
      const draft = await draftOutbox.get(draftTabKey('image'));
      if (draft) {
        draftMutation = Math.max(draftMutation, Number(draft.mutation) || 0);
        if (Number(draft.revision) === state.chatRevision && Array.isArray(draft.chats)) {
          const deleted = new Set(draft.deletedChatIds || []);
          const merged = withoutDeletedMessages(mergeChatStores({chats:state.chats}, draft), draft.deletedMessageIds || {});
          state.chats = merged.chats.filter(chat=>!deleted.has(chat.id));
          for (const id of deleted) state.chatDeletedIds.add(id);
          for (const [id,ids] of Object.entries(draft.deletedMessageIds || {})) state.chatDeletedMessageIds.set(id,new Set(ids));
          if (state.chats.some(chat=>chat.id===draft.activeChatId)) state.activeChatId=draft.activeChatId;
          restoredComposerText = draft.composerText || null;
          recoveredOrMigratedPromptState ||= draft.chats.length > 0 || deleted.size > 0;
        } else if (draft.chats?.length || draft.deletedChatIds?.length || Object.keys(draft.deletedMessageIds || {}).length || draft.composerText) {
          await archiveDraft(draftOutbox, draftTabKey('image'), draft);
        }
      }
      await showRecoveredDrafts();
    } catch (error) { showDraftStorageFailure(draftContainer(),{chats:state.chats},error.message); }
    for (const chat of pendingChats) {
      if (!state.chats.some(saved => saved.id === chat.id)) {
        state.chats.push(chat);
        recoveredOrMigratedPromptState = true;
      }
    }
    if (pendingChats.some(chat => chat.id === pendingActiveId)) state.activeChatId = pendingActiveId;
    if (pendingComposer) restoredComposerText = pendingComposer;
  } catch (error) {
    // Keep any in-memory edits intact when a retry also fails.
    state.chatPageOffset = 0;
    state.chatPageCursor = null;
    state.chatTotal = 0;
    state.chatHasMore = false;
    state.chatStoreLoaded = false;
    state.chatPersistenceBlocked = true;
    showChatFailure(error, true);
  }
  if (!state.chats.length) {
    const chat = normalizeChat({ ...newChatWorkflowSelections(), studioSettings: newChatStudioSettings() });
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
  if (restoredComposerText !== null) {
    const input = state.panel?.querySelector('#promptstudio-revision');
    if (input) input.value = restoredComposerText;
    restoredComposerText = null;
  }
  if (recoveredOrMigratedPromptState) saveChats({ immediate: true });
  if (state.chatStoreLoaded) {
    draftContainer()?.querySelector('[data-chat-load-failure]')?.remove();
    recoverStudioSubmissions?.();
    resumeConsultJobs();
    resumeSyncedGeneration();
  }
}

  return {
    async flushChatStore() {
      if (!state.chatStoreLoaded || state.chatPersistenceBlocked) throw new Error("Resolve the history loading or saving error first.");
      clearTimeout(state.chatSaveTimer);
      state.chatSaveTimer = null;
      await state.chatSaveChain;
      await persistChats();
      if (savedMutationVersion !== state.chatMutationVersion) throw new Error("History is still changing. Wait for current work to finish.");
    },
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
