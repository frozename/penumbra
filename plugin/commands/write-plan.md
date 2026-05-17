---
description: Convert a design spec into an executable phased TDD plan. Triggered by /write-plan slash.
---

Run penumbra workflow `write-plan` via the workflow runtime.

This slash command invokes:

```
mcp__penumbra__workflow_run({ "name": "write-plan" })
```

The workflow auto-recalls memory, optionally dispatches agents with tailored bundles, and emits the configured output sinks.
