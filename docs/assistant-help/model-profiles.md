---
{"id":"model-profiles","topic":"model-profiles","studio":"image","summary":"Add, duplicate, edit, delete or restore image prompt model profiles in Settings without changing Git-tracked defaults."}
---
Open Settings > Model profiles. Select a profile, expand Edit profile, change fields and Save profile. New profile and Duplicate create personal profiles. Fields include prompt format, response token default, instruction, examples (one per line), notes, and exact final prefix/suffix.
Bundled profiles save as local overrides. Restore bundled default removes the override; Delete profile removes a local addition. Duplicate a bundled profile to rename it. Edit config/user/model_profiles.json; leave config/defaults/model_profiles.psc unchanged. All user configuration uses version 1 with an items array. A matching name overrides the bundled profile, ignoring case.
Reload profiles picks up file edits and resolves stale-save conflicts. Discarding unsaved edits requires confirmation. Saved changes update Generation controls immediately; select the desired Model profile there. Refresh the ComfyUI canvas for node dropdowns. Saved chats and workflows can still refer to deleted names.
These image prompt profiles are separate from the diffusion model, shared assistant LLM configurations, and Video Director prompts. They do not change Video's structured prompt system.
