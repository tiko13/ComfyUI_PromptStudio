---
{"id":"history-storage","topic":"history-storage","studio":"shared","summary":"Chat and project disk usage, automatic compression and migration, recovery checkpoints, restoring an individual session and storage cleanup."}
---
Image: Settings → General → History storage. Video: Projects → History storage. This view shows current history, recovery storage, checkpoint dates, and the active retention policy.
Backend startup automatically migrates both entire libraries, including unopened sessions. Compression preserves contents; cleanup expires obsolete recovery copies, not current sessions. Temporary legacy backups expire on the date shown. Optimize now verifies and cleans immediately; errors preserve originals and can be retried.
To restore one session, choose a checkpoint and session, acknowledge replacing it, then Restore selected session. Other sessions stay intact. Save current edits first; Refresh if history changed. Unfinished work blocks restoration. Recovery preserves text, settings and workflow references, but cannot recreate separately deleted media or external plot files.
