---
{"id":"history","topic":"history","studio":"image","summary":"Saved chats, failed history loading, unsaved drafts, retry and export recovery."}
---
Chats save automatically. If a save fails, a notice in the chat sidebar offers Retry save and Export unsaved draft. Keep the tab open until saving succeeds, or export your edits before closing. An export preserves the draft as JSON; it does not submit generation.
If saved history cannot load, use Retry loading history. Edits made in the temporary local session are retained when loading succeeds. Invalid server responses are rejected instead of being treated as empty history or a successful save.
When a browser draft belongs to an older server revision, use Export unsaved draft to review it; it is not automatically applied over newer server history. If browser storage also fails, export before closing the tab.
