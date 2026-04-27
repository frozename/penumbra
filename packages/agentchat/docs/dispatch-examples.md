# Dispatch examples — common agentchat invocations

Concrete patterns for `agentchat new`, `agentchat-worker`, and the MCP `chain.start` tool. Pair with `agent-fleet.md` for picking the right agent and `openai-compat-keys.md` for credential refs.

## One-shot, headless (the most common pattern)

Pipe a prompt to `agentchat new --auto`. The bin treats stdin as a single message (no blank-line splitting) and dispatches one hop, halting after the first reply.

```bash
echo "@local-gemma26 Reply with exactly: OK" \
  | bun packages/agentchat/bin/agentchat.ts new --auto --max-hops 1
```

Expected output:
```
[local-gemma26]
OK
```

`--auto` enables auto-approval of every continuation handoff. With `--max-hops 1` the chain caps after one dispatch even if the reply contains a `@mention`.

## Multi-hop with a hop budget

```bash
echo "@planner: triage the new bug report and route to @executor" \
  | bun packages/agentchat/bin/agentchat.ts new --auto --max-hops 5 --transcript-budget 16384
```

`--transcript-budget` limits how much prior context is wrapped into each hop's prompt. The transcript is truncated from the front (oldest user message stays last; older agent replies drop first).

## Inline file attachments (`--attach`)

`openai-compat-http` agents (local llama-server, NVIDIA NIM, mac-mini gemma) have NO native file-reading tools. Use `--attach <path>` to pre-pend file content to the first user message using the same `--- File: <name> ---` header that llama-server's web chat UI uses.

```bash
echo "@local-gemma26 Review the attached file. Output: Bugs, Concerns, Verdict (LGTM or NEEDS FIXES). Stay under 400 words." \
  | bun packages/agentchat/bin/agentchat.ts new --auto --max-hops 1 \
      --attach packages/agentchat/src/worker/dispatcher.ts
```

Repeatable: `--attach a.md --attach b.md ...`. Files are inlined into the FIRST user message only; subsequent hops use the conversation transcript.

## Per-edge trust (`--trust`)

Use `--trust` (instead of `--auto`) when you want only specific edges auto-approved. Each agent's `auto_approve_to` field in `agentchat.yaml` lists which targets it can dispatch to without human approval. Untrusted edges leave the next handoff `pending`.

```bash
echo "@planner: implement the rate-limiter described in the spec" \
  | bun packages/agentchat/bin/agentchat.ts new --trust --max-hops 5
```

If `planner.auto_approve_to: [executor]`, the planner→executor edge auto-approves. If executor's reply mentions `@reviewer` and `executor.auto_approve_to` does NOT include `reviewer`, the chain pauses — the bin prints `[chain stopped at untrusted edge, handoff abc12345 queued]` and you can approve manually:

```bash
bun packages/agentchat/bin/agentchat.ts approve abc12345
```

## Bin streaming vs worker dispatch

The interactive bin (`agentchat new --auto`) dispatches in-process and streams adapter output live to stdout. Latency-sensitive interactive workflows want the bin.

The worker (`agentchat-worker`, phase-1) drains approved handoffs out-of-process. Use it when the chain runs without a TTY — cron jobs, MCP-driven kicks, webhooks.

```bash
# Start the worker (keep it running):
bun packages/agentchat/bin/agentchat-worker.ts \
  --storage-root /tmp/penumbra-live --concurrency 4 --poll-interval 1000

# Then kick off a chain headlessly via daemon HTTP:
curl -X POST "http://127.0.0.1:$(cat /tmp/penumbra-live/port)/chains/start" \
  -H "authorization: Bearer $(cat /tmp/penumbra-live/token)" \
  -H 'content-type: application/json' \
  -d '{"initial_agent":"local-gemma26","message":"@executor: ping","max_hops":5,"trust_mode":"all"}'
```

The chain runs entirely in the worker; the curl call returns immediately with `{conversation_id, handoff_id}`. Poll `GET /handoffs?conversation_id=<id>&status=pending,approved,dispatched` until empty to detect chain idle.

In phase 1 the bin and worker can both produce/dispatch approved handoffs — `claimDispatch` makes worker-vs-worker races safe, but the bin doesn't go through claim, so don't run `--auto` and the worker against the same conversation simultaneously.

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

**`parseInputStream` whole-mode behavior on piped stdin.** When stdin is a pipe (non-TTY), the bin treats the entire stream as ONE message — no blank-line splitting, no `done` sentinel. Multi-paragraph markdown stays intact. In TTY mode (interactive), blank lines still separate messages.

**Attachment header convention.** `--attach` uses the EXACT `\n\n--- File: <basename> ---\n<content>` template that llama-server's web UI uses, so any model trained on that template (Gemma 4, Qwen 3.x) reads attachments naturally without needing tool-use support.

**Cloud rate limits.** NVIDIA NIM free tier is ~40 rpm. If you fan-out 5 models × 5 prompts in parallel you'll hit the cap mid-run and get empty bodies. Serialize when running batches.

**Worker requires the daemon.** `agentchat-worker` connects to `/tmp/penumbra-live` (the daemon's storage root). Run `bun packages/cli/bin/penumbra.ts start --detach` first.
