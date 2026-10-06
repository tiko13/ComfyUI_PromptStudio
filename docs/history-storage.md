# History storage and recovery

Prompt Studio and Video Studio use the same transactional history service.
At backend startup it automatically optimizes both complete installed libraries,
including sessions that are not open. New writes use gzip records immediately.
No dependencies or manual migration command are required.

The live `index.json` stays readable JSON. Record checksums cover uncompressed
bytes, preserving exact Unicode, workflow snapshots, IDs, settings and lineage.
Old plain JSON records and recovery indexes remain readable during migration.

Default recovery retention is three recent saves, one checkpoint per day for
seven days, and one per week for four weeks. Calendar buckets use UTC; the UI
displays checkpoint timestamps in the browser's local timezone. Overlapping
checkpoints count once and unchanged records are shared. Current sessions never
expire. The 256 MiB recovery budget retires oldest weekly, daily, then recent
checkpoints, preserving the newest verified fallback even when it exceeds budget.
This is a recovery policy, not permanent version history.

Migration verifies the current snapshot, compresses and verifies retained
records, publishes converted checkpoints, publishes the current index, and only
then retires obsolete manifests followed by unreferenced records. Readers and
writers share the maintenance lock; stale page reads retry the current manifest.
The durable revision high-water mark survives pruning and explicit recovery.
Interrupted migration resumes on the next startup/access. A damaged retained
snapshot prevents cleanup and exposes an actionable error in History storage.
Legacy backup files and redundant monoliths are compressed and retained for
seven days from migration, then removed by subsequent maintenance. Unknown files
and damaged-index artifacts are not swept. A successful migration marker and
maintenance timestamps prevent repeated full migration on every launch.

Maintenance runs in a background worker, separately from the save transaction,
at startup and at most every 30 minutes of subsequent history access. Reads and
saves can briefly wait for the initial whole-library optimization. The operation
does not touch output media, model files, or the parent ComfyUI checkout.

In Image Studio, open Settings → General → History storage. In Video Studio,
open Projects → History storage. Sizes separate current data, recovery,
and temporary/other files. Optimize now retries verification/cleanup immediately.
Choose a checkpoint and session to restore only that session. Restoration checks
the current revision, refuses unfinished work, saves the pre-restore state as a
recovery checkpoint, and leaves unrelated sessions intact. Media and external
plot data are referenced, not backed up here. A checkpoint cannot recreate
separately deleted images, videos, or plot files.

For diagnostics, run the shared `transactional_store.py` with the ComfyUI VENV
interpreter (never a different Python installation):

```text
transactional_store.py storage DIRECTORY --kind chat
transactional_store.py inspect DIRECTORY --kind chat
transactional_store.py export DIRECTORY OUTPUT.json --kind project
transactional_store.py optimize DIRECTORY --kind chat
transactional_store.py recover DIRECTORY --kind project
```

`inspect`, `storage`, and `export` do not prune history. Export produces portable
plain JSON. `optimize` applies the same verified retention policy as automatic
maintenance. `recover` explicitly publishes the newest complete fallback after
damage; inspect/export first. Restart through the status monitor after installing
this backend update, before running maintenance against a live store. Older
backend versions cannot read the new compressed records; use an export if a
downgrade is necessary.
