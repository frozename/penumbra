# home-mgmt prefill shrink — 2026-05-13

Two stdio-acp adapter knob commits and one yaml change landed today to drop
the claude-agent-acp builtin tool catalog out of home-mgmt's per-tick system
prompt.

## Commits

- `8522201` feat(agentchat/stdio-acp): claudeCodeAllowedTools + claudeCodeDisallowedTools knobs
- `4937134` feat(agentchat/stdio-acp): claudeCodeTools knob to drop builtin tool schemas

`4937134` is the one that moves the needle. `8522201` exposes a different SDK
field (runtime-permission filter, not schema-inclusion control) and turned out
to be ineffective at shrinking prefill — kept in the codebase for future use.

## Real lever — `tools: []`

Source: `~/.bun/install/global/node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js:1276-1281`:

```js
const tools = userProvidedOptions?.tools ??
    (params._meta?.disableBuiltInTools === true ? [] :
     { type: "preset", preset: "claude_code" });
```

Setting `_meta.claudeCode.options.tools = []` drops the entire
`claude_code` preset — Bash, Read/Write/Edit, Grep, Glob, Task, WebFetch,
TodoWrite, NotebookEdit, and their schemas (~22K tokens).

## yaml change (live at `~/.config/agentchat/agentchat.yaml`)

```yaml
  - name: home-mgmt
    ...
    options:
      ...
      claudeCodeStrictMcpConfig: true
      claudeCodeTools: []          # NEW — drops builtin preset
      env: ...
```

## Empirical numbers (gemma-26b-a4b-mtp local, 2026-05-13)

Two-tick controlled measurement against `~/.config/agentchat/agentchat.yaml`
home-mgmt entry. Llama-server log at `/Volumes/WorkSSD/logs/llama.cpp/server.log`
captured per-request `prompt eval time` lines.

| | Baseline (no `tools` knob) | `claudeCodeTools: []` |
|---|---|---|
| Wall time | 9 min 28 s | **4 min 8 s** |
| Turn 1 prompt tokens | 36,243 | **2,471** |
| Turn 2 prompt tokens | 37,090 | 16,850 |
| Turn 3 prompt tokens | 38,085 | 17,049 |
| Turns completed | 3 | 6 |
| cost_cents | 58 | 30 |

Turn-1 prefill dropped 93%. Subsequent turns drop ~55% as tool-call results
accumulate in context but builtin schemas stay out. ACP watchdog risk on
gemma fully defanged — ticks comfortably fit in the 10-min cron window.
