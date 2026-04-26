# @penumbra/agentchat

Cross-agent group-chat orchestrator. Lets Claude / Gemini / Codex / local
LLMs talk to each other via `@mention`s, with the human in the loop only
to approve handoffs.

## Quick start

1. Make sure penumbra is running:
   ```
   penumbra init && penumbra start
   ```
2. Write `~/.config/agentchat/agentchat.yaml`:
   ```yaml
   agents:
     - name: claude
       adapter: claude-cli
       options: { command: claude, args: ["-p"], pass_via: argv }
       roles: [planner, reviewer]
     - name: gemini
       adapter: gemini-cli
       options: { command: gemini, args: ["-p"], pass_via: argv }
       roles: [executor]
     - name: codex
       adapter: codex-cli
       options: { command: codex, args: ["exec"], pass_via: argv }
       roles: [reviewer]
     - name: local
       adapter: openai-compat-http
       options:
         baseUrl: https://192.168.68.76:7843/v1
         api_key_env: LLAMACTL_TOKEN_LOCAL
         model: gemma-4-E4B-it-GGUF/...
       roles: [reviewer]

   default_roles:
     planner: claude
     executor: gemini
     reviewer: codex
   ```
3. Run a conversation:
   ```
   agentchat new my-project
   > Add rate limiting to /api/login
   ```

## Commands

- `agentchat new [project]` — start a new conversation
- `agentchat queue` — list pending handoffs
- `agentchat approve <id> [--redirect <name>]` — approve or redirect
- `agentchat reject <id> [--reason <text>]` — reject

## Mention semantics

- `@<role>` (e.g. `@executor`) → resolves via `default_roles`
- `@<name>` (e.g. `@gemini`) → resolves to the literal agent
- Role wins over name when both could match

## Adapters

Built-in: `claude-cli`, `gemini-cli`, `codex-cli`, `openai-compat-http`.
Add your own by importing `Adapter`, `registerAdapter` from
`@penumbra/agentchat`.

## CLI adapter options

The three CLI adapters (`claude-cli`, `gemini-cli`, `codex-cli`) all
share the same option shape:

```yaml
options:
  command: codex                              # required: binary on $PATH
  args: ["exec"]                              # extra argv flags
  pass_via: argv                              # 'stdin' (default) | 'argv'
  cwd: /optional/working/dir
  env:                                        # extra env vars for the spawn
    SOME_VAR: hello
  unset_env: [OPENAI_BASE_URL, OPENAI_API_KEY] # vars to drop from inherited env
  strip_patterns:                             # regex patterns; matching lines removed
    - '^Hook system message:'
    - '^Created execution plan for'
```

**`pass_via`** — `stdin` writes the prompt to the spawned process's
stdin (default). `argv` appends the prompt as the final positional
argument; use this when the CLI takes the prompt via a flag value
(e.g. `claude -p "prompt"`, `gemini -p "prompt"`, `codex exec "prompt"`).

**`unset_env`** — useful when the host shell exports `OPENAI_BASE_URL`
or similar to route OpenAI-compatible CLIs at a local backend, but the
adapter wants the spawned CLI to fall back to its own auth. Names
listed here are deleted from the inherited env before spawning. Codex
in particular needs `OPENAI_BASE_URL` and `OPENAI_API_KEY` unset if
they're set in your shell profile.

**`strip_patterns`** — regex strings matched line-by-line; matching
lines are removed from the captured output. Use when the CLI prints
hook lifecycle banners, session-start/-end logs, or other wrapper
noise around the actual model reply.

## Failure handling

If an adapter throws (CLI exits non-zero, HTTP 5xx), agentchat catches
the error, observes an `agent-response` t0 event whose `payload_json`
contains an `error` field and whose `payload_summary` is `error: …`,
prints the error inline, and returns to the prompt. No handoff is
queued for an errored turn.