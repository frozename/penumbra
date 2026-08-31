# Dispatch examples — common agentchat invocations

Concrete patterns for `agentchat-worker`, the daemon's `/chains/start` route, and the MCP `chain.start` tool. Pair with `agent-fleet.md` for picking the right agent and `openai-compat-keys.md` for credential refs.

## One-shot, headless (the most common pattern)

Start the worker once, then kick a single-hop chain through the daemon.

```bash
# Start the worker (keep it running):
bun packages/agentchat/bin/agentchat-worker.ts \
  --storage-root /tmp/penumbra-live --concurrency 4 --poll-interval 1000

# Kick a one-hop chain:
curl -X POST "http://127.0.0.1:$(cat /tmp/penumbra-live/port)/chains/start" \
  -H "authorization: Bearer $(cat /tmp/penumbra-live/token)" \
  -H 'content-type: application/json' \
  -d '{"initial_agent":"local-gemma26","message":"Reply with exactly: OK","max_hops":1,"trust_mode":"all"}'
```

The call returns immediately with `{conversation_id, handoff_id}`; the worker runs the chain. `trust_mode: "all"` auto-approves every continuation handoff, and `max_hops: 1` caps the chain after one dispatch even if the reply contains a `@mention`.

Read the reply with the MCP `chain.get_response` tool, or poll the daemon:

```bash
curl -s -H "authorization: Bearer $(cat /tmp/penumbra-live/token)" \
  "http://127.0.0.1:$(cat /tmp/penumbra-live/port)/handoffs?conversation_id=<id>&status=pending,approved,dispatched"
# empty result = chain idle
```

## Multi-hop with a hop budget

```bash
curl -X POST "http://127.0.0.1:$(cat /tmp/penumbra-live/port)/chains/start" \
  -H "authorization: Bearer $(cat /tmp/penumbra-live/token)" \
  -H 'content-type: application/json' \
  -d '{"initial_agent":"planner","message":"triage the new bug report and route to @executor","max_hops":5,"trust_mode":"all"}'
```

At the hop cap the chain stops and leaves the next handoff `pending`; resume it with `bun packages/agentchat/bin/agentchat.ts approve <prefix>`.

## Passing file contents to models without file tools

`openai-compat-http` agents (local llama-server, NVIDIA NIM, mac-mini gemma) have NO native file-reading tools. Inline the file into the chain message using the `--- File: <name> ---` header that llama-server's web chat UI uses, so any model trained on that template reads it naturally:

```bash
FILE=packages/agentchat/src/worker/dispatcher.ts
jq -n --arg body "Review the attached file. Output: Bugs, Concerns, Verdict (LGTM or NEEDS FIXES).\n\n--- File: dispatcher.ts ---\n$(cat "$FILE")" \
  '{initial_agent:"local-gemma26", message:$body, max_hops:1, trust_mode:"all"}' \
  | curl -X POST "http://127.0.0.1:$(cat /tmp/penumbra-live/port)/chains/start" \
      -H "authorization: Bearer $(cat /tmp/penumbra-live/token)" \
      -H 'content-type: application/json' --data-binary @-
```

Agents reached via `gemini-cli` / `claude-cli` / `codex-cli` already have native file-reading tools and need none of this.

## Per-edge trust (`trust_mode: "config"`)

Use `trust_mode: "config"` when you want only specific edges auto-approved. Each agent's `auto_approve_to` field in `agentchat.yaml` lists which targets it may dispatch to without human approval; untrusted edges leave the next handoff `pending`.

```bash
curl -X POST "http://127.0.0.1:$(cat /tmp/penumbra-live/port)/chains/start" \
  -H "authorization: Bearer $(cat /tmp/penumbra-live/token)" \
  -H 'content-type: application/json' \
  -d '{"initial_agent":"planner","message":"implement the rate-limiter described in the spec","max_hops":5,"trust_mode":"config"}'
```

If `planner.auto_approve_to: [executor]`, the planner→executor edge auto-approves. If executor's reply mentions `@reviewer` and `executor.auto_approve_to` does NOT include `reviewer`, the chain pauses and you approve manually:

```bash
bun packages/agentchat/bin/agentchat.ts approve abc12345
```

## MCP `chain.start` (for non-shell callers)

The penumbra MCP server exposes `chain.start` as a tool. Any AI harness (Claude Code, Cursor, Gemini CLI) with the penumbra MCP wired up can call:

```
chain.start({
  initial_agent: "local-gemma26",
  message: "@executor: ping",
  max_hops: 5,
  trust_mode: "all"
})
```

→ returns `{conversation_id, handoff_id}`. Same poll-for-completion pattern.

## Common pitfalls

**Attachment header convention.** Inline file content with the EXACT `\n\n--- File: <basename> ---\n<content>` template that llama-server's web UI uses, so any model trained on that template (Gemma 4, Qwen 3.x) reads it naturally without needing tool-use support.

**Cloud rate limits.** NVIDIA NIM free tier is ~40 rpm. If you fan-out 5 models × 5 prompts in parallel you'll hit the cap mid-run and get empty bodies. Serialize when running batches.

**Worker requires the daemon.** `agentchat-worker` connects to `/tmp/penumbra-live` (the daemon's storage root). Run `bun packages/cli/bin/penumbra.ts start --detach` first.
