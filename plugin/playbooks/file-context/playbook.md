---
name: file-context
description: Before reading a file, surface any prior memory hits that mention its path so the maestro has context for the next operation.
triggers:
  - kind: lifecycle
    event: pre-tool-use
    filter:
      tool_name: [Read]
recall:
  - source: memory_search
    args:
      query: "{{file_path}}"
      project: "{{project}}"
      limit: 5
recall_budget_tokens: 1500
output:
  - kind: session-reminder
run:
  kind: markdown-template
---
Context for `{{file_path}}`:

{{#each recall.memory_search}}
- **{{title}}** — {{snippet}}
{{/each}}
