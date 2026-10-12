const normalizeWord = word => word.trim().replace(/\s+/gu, " ").toLowerCase();

function triggerSpans(text, words) {
  const spans = [];
  for (const word of words) {
    const parts = word.trim().split(/\s+/u);
    if (!parts[0]) continue;
    const pattern = parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    // Literal triggers may contain punctuation or non-ASCII characters. Never
    // remove a matching substring from inside a longer word.
    const regex = new RegExp(`(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`, "giu");
    for (const match of text.matchAll(regex)) spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
}

export function removeTriggerWords(text, removedWords, retainedWords = []) {
  const retained = new Set(retainedWords.map(normalizeWord));
  const protectedSpans = triggerSpans(text, retainedWords);
  const spans = triggerSpans(text, removedWords.filter(word => !retained.has(normalizeWord(word))))
    .filter(([start, end]) => !protectedSpans.some(([left, right]) => start < right && end > left))
    .sort((a, b) => a[0] - b[0]);
  if (!spans.length) return text;
  let result = "", cursor = 0;
  for (const [start, end] of spans) {
    if (start > cursor) result += text.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  result += text.slice(cursor);
  return result.split(",").map(part => part.replace(/\s+/gu, " ").trim()).filter(Boolean).join(", ");
}

export async function cleanupRemovedLoraTriggers({ editor, name, getContext, loadWords }) {
  if (!editor?.value.trim()) return;
  const origin = getContext();
  const sameEditor = context => editor.isConnected
    && context.chatId === origin.chatId && context.profileId === origin.profileId;
  const removedWords = await loadWords(name);
  if (!removedWords.length) return;
  // Recheck selection after metadata loads: removals can overlap, or the user
  // can re-add a LoRA while its request is pending.
  while (true) {
    const context = getContext();
    if (!sameEditor(context) || context.names.includes(name)) return;
    const retainedWords = (await Promise.all([...new Set(context.names)].map(loadWords))).flat();
    const latest = getContext();
    if (!sameEditor(latest)) return;
    if (JSON.stringify(context.names) !== JSON.stringify(latest.names)) continue;
    const cleaned = removeTriggerWords(editor.value, removedWords, retainedWords);
    if (cleaned !== editor.value) {
      editor.value = cleaned;
      for (const type of ["input", "change"]) {
        editor.dispatchEvent(new editor.ownerDocument.defaultView.Event(type, { bubbles: true }));
      }
    }
    return;
  }
}
