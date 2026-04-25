# @penumbra/e2e

End-to-end smoke tests and an interactive harness for Penumbra.

## Smoke tests

Run the always-on five:

```bash
bun test packages/e2e
```

The gated llamactl+sirius test skips unless:
- `PENUMBRA_E2E_LLAMACTL=1`
- `llamactl` is on PATH
- The configured sirius `<baseUrl>/healthz` returns 200

Run the gated test:

```bash
PENUMBRA_E2E_LLAMACTL=1 bun test packages/e2e/test/smoke/llamactl-sirius-embedding.test.ts
```

To preserve the sandbox dir on a failing test (for postmortem):

```bash
PENUMBRA_E2E_KEEP=1 bun test packages/e2e
```

## Live harness

```bash
bun packages/e2e/bin/penumbra-harness.ts
```

Starts a Penumbra daemon in a fresh tmp sandbox, prints a ready-to-paste
MCP config snippet for Claude Code's `.mcp.json`, then tails the daemon
log. Ctrl-C tears down and cleans up.

### Modes

- **Default:** init + start + print config + tail + cleanup on Ctrl-C.
- **`--mcp-config-only --sandbox <path>`:** prints config for an existing
  daemon and exits.
- **`--llm-driver llamactl`:** also brings up a sirius-compatible embedder
  via `llamactl composite apply` and points Penumbra at it.

### Persisting the sandbox

```bash
bun packages/e2e/bin/penumbra-harness.ts --persist
```

Keeps the sandbox after Ctrl-C. Useful when you want to inspect the
SQLite db or re-run with `--sandbox <path>`.

### MCP config

The harness prints something like:

```jsonc
{
  "mcpServers": {
    "penumbra": {
      "type": "stdio",
      "command": "bun",
      "args": ["/abs/path/to/packages/mcp/bin/penumbra-mcp.ts"],
      "env": { "PENUMBRA_STORAGE_ROOT": "/tmp/penumbra-harness-XXXX" }
    }
  }
}
```

Paste it into Claude Code's `.mcp.json` alongside any existing servers.
The MCP server reads token + port from files inside `PENUMBRA_STORAGE_ROOT`.
