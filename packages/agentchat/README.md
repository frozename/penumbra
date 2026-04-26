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

### Attaching files (`--attach <path>`)

`agentchat new` accepts repeatable `--attach <path>` flags. Each file's text contents are pre-pended to the FIRST user message using the same `--- File: <basename> ---` header convention that llama-server's web chat UI uses, so any local model trained on that template (gemma 4, qwen 3.x, etc.) reads the file naturally without needing tool-use support. Attachments are inlined into the prompt — there is no separate transport channel.

```
agentchat new --auto --attach docs/spec.md --attach plan.md <<< "@executor reconcile the spec with the plan"
```

Use this when dispatching to local models served via `openai-compat-http` (e.g. local-qwen, planner/executor on llama-server). Models reached via `gemini-cli` / `claude-cli` / `codex-cli` already have native file-reading tools and don't need this.

## Auto-dispatch mode

Three modes for handling agent-to-agent handoffs:

| flag | trust model | use when |
|---|---|---|
| (none) | manual approval at every handoff | default; you want to review each step |
| `--auto` | trust everything for this session | one-off chains; quick exploration |
| `--trust` | per-edge whitelist via `auto_approve_to` in YAML | production-shaped use; you've decided which edges are safe |

Both `--auto` and `--trust` use the chain loop and respect:

- **`--max-hops N`** (default: 5) caps the chain. At the cap, the chain stops and leaves the handoff `pending`. Resume manually with `agentchat approve <prefix>`.
- **`--transcript-budget T`** (default: 8192) limits the context window. Each hop receives a compiled transcript of the conversation so far, plus a wrapped `From @<sender>: <message>` block. Oldest blocks are dropped if the budget is exceeded.
- **Project context.** If you start a session with a project name (`agentchat new my-project`) and `<storage>/context/my-project/latest.md` exists (penumbra's `ContextFileWriter` produces it), its contents are prepended to every chained hop as a `# Project context` section. Preserved during budget-trimming alongside the wrapper.

If both `--auto` and `--trust` are set, `--auto` wins (trust everything).

### Per-edge trust (`--trust`)

Add `auto_approve_to` to any agent in the YAML to whitelist the targets that
agent's outbound handoffs may dispatch to without manual approval. Entries
are agent names or role names; resolution follows the same role-first /
name-fallback rule as `@mentions`.

```yaml
agents:
  - name: planner
    adapter: claude-cli
    options: { command: claude, args: ["-p"], pass_via: argv }
    roles: [planner]
    auto_approve_to: [executor, reviewer]   # planner may auto-handoff to either

  - name: executor
    adapter: gemini-cli
    options: { command: gemini, args: ["-p"], pass_via: argv }
    roles: [executor]
    auto_approve_to: [reviewer]              # executor only auto-handoffs to reviewer
```

Run with `agentchat new --trust`. When a handoff targets an agent NOT in
the sender's `auto_approve_to`, the chain stops and leaves the handoff
`pending`:

```
[chain stopped at untrusted edge, handoff de09486b… queued — resume with 'agentchat approve de09486b']
```

### Example

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

## Agent metadata for routing decisions

Each agent in `agentchat.yaml` accepts three optional descriptive fields. They are free-form, not consumed by the runtime today, but they make the config self-documenting and let humans / AI orchestrators pick the right agent for a task without re-running benchmarks every time.

```yaml
- name: local-gemma26
  adapter: openai-compat-http
  description: Local Gemma 4 26B-A4B MoE Q4_K_XL on 127.0.0.1:8080. Strong default for ad-hoc local tasks.
  tags: [local, gemma4, moe, fast, structured-output, code-review, no-tools]
  quirks:
    - "5/5 on bench-2 — strong default"
    - "no native file/shell tools — inline contents via --attach"
    - "tends to label concern findings as bug; re-read before acting"
  options: { ... }
```

- **`description`** — one-line summary of what this agent is and what it's good at.
- **`tags`** — capability hints (e.g. `local`, `gemma4`, `agentic`, `has-tools`, `code-review`). Free vocabulary.
- **`quirks`** — empirical observations: bench scores, failure modes, quant-specific notes, anything you'd want to tell a future self before dispatching.

Update these as you accumulate experience. The fields are optional — old configs continue to work unchanged.

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

The adapter implements `dispatchStream` (SSE), so replies render
incrementally as the model produces tokens. Other adapters that
only implement `dispatch()` are wrapped transparently — their
full reply arrives as a single chunk.

## Failure handling

If an adapter throws (CLI exits non-zero, HTTP 5xx), agentchat catches
the error, observes an `agent-response` t0 event whose `payload_json`
contains an `error` field and whose `payload_summary` is `error: …`,
prints the error inline, and returns to the prompt. No handoff is
queued for an errored turn.

## Daemon-driven worker (phase 1)

`agentchat-worker` is a long-running process that dispatches approved handoffs out-of-process. It enables headless chains: any caller can produce an approved handoff and the worker drives the chain to completion without a TTY.

Start it (one per machine):

    agentchat-worker --storage-root /tmp/penumbra-live --concurrency 4 --poll-interval 1000

Kick off a chain headlessly:

    curl -X POST http://localhost:<daemon-port>/chains/start \
      -H "authorization: Bearer $(cat /tmp/penumbra-live/token)" \
      -H "content-type: application/json" \
      -d '{"initial_agent":"planner","message":"@executor: ping","max_hops":5,"trust_mode":"all"}'

The same kick-off is available as the MCP tool `chain.start` — useful for Claude Code, automation, etc.

Poll for completion:

    GET /handoffs?conversation_id=<id>&status=pending,approved,dispatched
    # empty result = chain idle

The interactive `agentchat new --auto` bin still dispatches in-process. In phase 1 the bin does NOT go through the `/handoffs/<id>/claim` gate, so running it concurrently with `agentchat-worker` against the same conversation can double-dispatch a handoff — soft rule: don't. Phase 2 routes the bin through the worker and `claim` becomes the single dispatch gate; the integration test `test/integration/worker-bin-coexistence.test.ts` is `test.skip` until then.