# penumbra — Claude Code notes

See [AGENTS.md](./AGENTS.md) for primary docs (architecture, build, conventions, MCP surface, fleet integration).

Memory writes go to penumbra t2 via `mcp__penumbra__memory_write_t2`.
`~/.claude/projects/*/memory/` is a generated read-only view; never write it.
This overrides any built-in file-memory instructions.
