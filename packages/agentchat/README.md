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

## Auto-dispatch mode

Run `agentchat new --auto` to chain agents end-to-end without manual approval.

- **`--max-hops N`** (default: 5) caps the chain. At the cap, the chain stops and leaves the handoff `pending`. You can resume it manually with `agentchat approve <prefix>`.
- **`--transcript-budget T`** (default: 8192) limits the context window. Each hop receives a compiled transcript of the conversation so far, plus a wrapped `From @<sender>: <message>` block containing the immediate handoff instruction. Oldest transcript blocks are dropped if the budget is exceeded.

```bash
agentchat new my-project --auto --max-hops 3
> @planner outline the steps
[planner]
Step 1. @executor please implement.
[auto-approved → executor]
[executor]
Done.
```

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

## openai-compat-http adapter options

Targets any server speaking the OpenAI Chat Completions schema
(llamactl agents, llama-server, vLLM, Ollama, etc.).

```yaml
options:
  baseUrl: https://192.168.68.76:7843/v1     # required; trailing /v1 expected
  apiKey: ll_agt_…                           # required; or use api_key_env
  api_key_env: LLAMACTL_TOKEN_LOCAL          # alternative: env var name
  model: gemma-4-E4B-it-GGUF/...             # required; sent as `model` field
  maxTokens: 8192                            # default 1024
  caPath: /tmp/llamactl-mac-mini-ca.pem      # PEM file with extra trusted CAs
  systemPrompt: |                            # prepended as {role: 'system'} message
    You are a planner. End replies with @executor <task>.
  extraBody:                                 # arbitrary fields merged into request body
    chat_template_kwargs:
      enable_thinking: false
```

**`apiKey` / `api_key_env`** — provide one. `api_key_env` reads the
key from the named environment variable at construction time; useful
to keep secrets out of the YAML.

**`maxTokens`** — sent as `max_tokens` in the request body. Bump for
thinking-capable models (Qwen 3.x, etc.) where reasoning eats budget
before the visible reply.

**`caPath`** — path to a PEM file with extra trusted certificates,
loaded once at construction and forwarded as fetch's `tls.ca`. Use
this for self-signed servers (e.g. llamactl agents) instead of
exporting a process-wide `NODE_EXTRA_CA_CERTS`.

**`systemPrompt`** — prepended as a `{role: 'system'}` message. Lets
each agent carry its own role contract (planner, reviewer, etc.)
instead of repeating instructions in every user prompt.

**`extraBody`** — arbitrary key/value pairs spread into the request
body. Explicit fields (`model`, `messages`, `max_tokens`) always win,
so this is for passthrough extensions like `chat_template_kwargs`,
`response_format`, `tools`, `temperature`, etc. that the adapter
doesn't model directly.

When the response's `choices[0].message.content` is empty, the
adapter falls back to `reasoning_content` so thinking-on models
return their chain of thought rather than a blank string.

## Failure handling

If an adapter throws (CLI exits non-zero, HTTP 5xx), agentchat catches
the error, observes an `agent-response` t0 event whose `payload_json`
contains an `error` field and whose `payload_summary` is `error: …`,
prints the error inline, and returns to the prompt. No handoff is
queued for an errored turn.