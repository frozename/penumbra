---
name: brainstorm
description: Begin a brainstorming session with prior specs and recent project memory pre-loaded. Triggered by /brainstorm slash.
triggers:
  - kind: slash
    command: brainstorm
recall:
  - source: memory.search
    args:
      query: brainstorm
      project: "{{project}}"
      limit: 10
  - source: fs.glob
    args:
      pattern: docs/superpowers/specs/*.md
output:
  - kind: clipboard
run:
  kind: markdown-template
---
# Brainstorming session — {{date}}

You are starting a brainstorming session in {{project}}. Prior specs and recent brainstorm memory are pre-loaded below — read them, then ask the user one clarifying question at a time.

## Prior specs in this project

{{#each recall.fs.glob}}
- {{.}}
{{/each}}

## Recent brainstorm-tagged memories

{{#each recall.memory.search}}
- `{{id}}` — {{title}}
{{/each}}

## Process

Follow `brainstorming`. Do not write any code or invoke any implementation skill until the user has approved a design.
