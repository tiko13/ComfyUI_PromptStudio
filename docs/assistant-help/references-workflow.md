---
{"id":"references.workflow","topic":"references","studio":"image","summary":"Node-configured reference collections and editing conventions.","when":{"reference_mode":"workflow"}}
---
Open {reference_label} to add, drop or paste images. Limit: {reference_limit}; attached: {reference_count}. Roles: {reference_roles}. Custom requires an instruction. Correct unsupported roles or excess entries before generating; switching workflows keeps saved images.
Connected nodes define count, roles and prompt conventions. Edit-instruction mode keeps Main/Final unchanged; full-prompt mode uses normal preparation. Guides and exact edit masks require their own nodes. See reference-workflow-nodes for wiring and model requirements.
In Edit, paste one image in the chat composer and describe its use. Amplification plus a vision LLM assigns a supported role and scoped instruction. The actual image enters the reference collection. Questions stay discussion; ambiguity asks for clarification. Review the item in References. Chat assignments last for this edit and rerolls; Keep for future edits makes them persistent. Full slots require removing an item; unsupported workflows cannot use this shortcut.
