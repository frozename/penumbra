---
description: Begin a brainstorming session with prior specs and recent project memory pre-loaded. Triggered by /brainstorm slash.
---

Run penumbra workflow `brainstorm` via the workflow runtime.

This slash command invokes:

```
mcp__penumbra__workflow_run({ "name": "brainstorm" })
```

The workflow auto-recalls memory, optionally dispatches agents with tailored bundles, and emits the configured output sinks.
