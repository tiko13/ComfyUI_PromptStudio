# Prompt configuration

Edit files in **user/** or use Prompt Studio Settings. This folder is created
automatically and is ignored by Git. It contains:

| File | Items |
| --- | --- |
| `user/model_profiles.json` | Image prompt profiles and local overrides |
| `user/styles.json` | Additional style presets |
| `user/framing.json` | Additional framing presets |
| `user/instructions.json` | Additional instruction templates |
| `user/references.json` | Known reference definitions |
| `user/protected_words.json` | Protected words and phrases |
| `user/forbidden_words.json` | Forbidden phrases and replacement rules |

All files use UTF-8 JSON with the same structure:

```json
{"version": 1, "items": []}
```

Keep the `version` field. Protected-word items are strings; other items are
objects with their category's fields. For example:

```json
{"version": 1, "items": ["A protected phrase", "C++"]}
```

**defaults/** contains application-owned `.psc` resources (JSON inside a
distinct extension). Leave these files unchanged. Files ending in `.user.psc`
are starter examples copied only when creating a user file. Changing a user file
never writes to these resources. The extension discourages accidental editing;
it is not encryption or filesystem protection.

On first use, old root-level user files are converted into **user/**. Their exact
original bytes, including text comments, are retained under the Git-ignored
**migration-backups/** before the old files are removed. Existing new files take
precedence; any older copy is archived, never merged over them. Invalid files
stop migration with an error so they can be repaired. Deleting entries or keeping
an empty `items` array does not restore the starter examples.

The Settings editors use these same files. Valid edits are loaded on subsequent
requests. Reload model profiles in Settings after editing their file; refresh the
ComfyUI canvas to update node dropdowns.

`LlamaCPP/` contains managed server launch configurations with a separate server
schema; its bundled example is `defaults/llamacpp_server.psc`. Chat history, workflow snapshots, and browser preferences are runtime
state, not prompt preset files.
