# Session Handoff — 2026-05-01 (Phase 3c + 3d shipped; claude-code OTel emission open)

## TL;DR

Two phases shipped end-to-end and pushed in the prior session:
- **Phase 3c** — daemon as local OTel collector (JSON over HTTP, gemini-cli ingest, per-model quotas, registry-based normalizer). Live verified.
- **Phase 3d** — OTLP/protobuf decoder (hand-rolled, no `@bufbuild/protobuf` dep), `codex.sse_event` + `claude_code.api_request` handlers, `--codex-otel` and `--claude-otel` hooks subcommands. Codex verified live (155,390 tokens / 7 dispatches captured under `provider=openai, model=gpt-5.4`). PII redaction extended to user-identifier fields.

~28 commits on `origin/main` (`e80b23f..a4a5311`). Tests: 289 core / 207 daemon / 483 agentchat / 69 cli — all green.

**One open follow-up:** claude-code 2.1.123 doesn't emit OTel in this user's install — even `OTEL_LOGS_EXPORTER=console` produces no output. Suspected plugin layer interference (claude-mem) or bundled SDK quirk. Architecture is verified via codex through the same path; the claude-code handler is unit-tested but not live-verified.

## State of the world (verify on resume)

```bash
cat /tmp/penumbra-live/pid && ps -p $(cat /tmp/penumbra-live/pid)
ps -ef | grep agentchat-worker | grep -v grep | wc -l
git log --oneline -10
git log origin/main..HEAD --oneline    # should be empty (we pushed)
```

Expected:
- 1 daemon (port from `/tmp/penumbra-live/port`)
- 4 workers
- Latest commits include `a4a5311 fix(core): revert incorrect group wire-type skip` and `50726a9 fix(core): redact user.email / user.id / user.account_*`
- main = origin/main

If anything's off, standard restart per memory `feedback_daemon_restart_on_schema_change.md`. After daemon restart with new port, also re-run `penumbra hooks install --gemini-otel` and `penumbra hooks install --codex-otel` to update each tool's endpoint.

**Live cost-ledger snapshot at handoff time:**
- openai: 155,390 / 1,000,000 tokens (84.5% remaining) — codex via OTLP/protobuf
- google/gemini-3-flash-preview: 21,849 / 1,500,000 (98.5% remaining) — gemini via OTLP/JSON
- google/gemini-3.1-pro-preview: 0 / 250,000 (100%)
- anthropic: $0.00 / $50.00 (100% remaining) — no OTLP rows yet (see open follow-up)
- opencode-go: $7.09 / $10.00 (29.1% remaining) — Phase 3b reader path

## What shipped (full commit log on main, last session)

```
a4a5311 fix(core): revert incorrect group wire-type skip — throw and let daemon backstop
50726a9 fix(core): redact user.email / user.id / user.account_* from OTLP payloads
6481056 docs(phase-3d): document OTLP/protobuf path + per-tool handler matrix
9a92f42 fix(core,daemon): handle real codex OTLP traffic — group wire types + event.kind value + 200 on parse fail
0331ec2 feat(cli): penumbra hooks install --claude-otel
34d06a6 feat(cli): penumbra hooks install --codex-otel
90a5518 feat(core): claude_code.api_request handler in OTLP normalizer
da79440 feat(core): codex.sse_event handler in OTLP normalizer registry
b44395d feat(daemon): accept application/x-protobuf on /v1/logs
001006f feat(core): OTLP/protobuf logs envelope walker
94338bf feat(core): minimal protobuf wire-format reader for OTLP/protobuf
b611e7f docs(phase-3d): OTLP/protobuf multi-tool plan from probe
3630a0a docs(phase-3c): document OTLP receiver path + per-model quotas in agent-fleet
e7bfdfa fix(cli): show provider/model label in 'penumbra cost quota'
fdaa401 fix(core): set payload_json.used in OTLP normalizer so cost.ts aggregates tokens
c1fb0a3 feat(cli): penumbra hooks install --gemini-otel
3cd729d feat(agentchat): detect provider capacity errors in cli-spawn stderr
a4f2d14 feat(core): per-(provider,model) aggregation in cost + quotaStatus
271da04 refactor(daemon): drop unnecessary type cast in loadProviderQuotas
bc030a2 feat(config): per-model quota fields on ProviderQuotaConfig
a40b301 feat(daemon): OTLP/JSON routes for /v1/logs|metrics|traces
50a50c4 feat(core): OTLP→T0 normalizer with PII redaction
3dffa66 feat(core): OTLP/JSON logs envelope parser
9c338a1 docs(phase-3c): correct typecheck command in plan
c654685 feat(core): add provider-capacity-error event type
a12a048 docs(phase-3c): OTLP receiver plan + redacted gemini fixtures
```

Operator-side touches:
- `~/.config/agentchat/agentchat.yaml`: `providers:` block now has per-model google entries (gemini-3-flash-preview 1.5M tokens/24h, gemini-3.1-pro-preview 250K/24h + 50K/5h)
- `~/.gemini/settings.json`: `telemetry` block (managed by `penumbra hooks install --gemini-otel`)
- `~/.codex/config.toml`: managed `[otel]` block with marker comments (managed by `--codex-otel`)
- `~/.claude/settings.json`: `env` block with OTEL_* keys (managed by `--claude-otel`) — written but currently a no-op due to the open follow-up

Memory entries written: `project_phase_3c_otlp_receiver.md`, `project_phase_3d_otlp_protobuf.md`.

## Open follow-up: claude-code OTel emission

Symptom: `claude -p` invocations do NOT emit OTel data, even with explicit env vars on the command line. Tested with both `otlp` and `console` exporters — neither produces output. Settings.json `env` block IS visible in child process env (verified via Bash tool `env` dump), but claude-code doesn't act on the OTEL_* keys.

What we know:
- claude-code version: `2.1.123` (Mach-O arm64 binary at `~/.local/share/claude/versions/2.1.123`)
- All 5 required env vars are set correctly: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp/console`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:<daemon-port>`
- `claude --help` shows `--bare` flag that disables hooks/plugins, but it requires `ANTHROPIC_API_KEY` — user is on OAuth, so isolation via `--bare` requires a one-time API key fetch
- `enabledPlugins` includes `claude-mem@frozename` which fires SessionEnd hooks in every claude run; possibly intercepts startup too
- No `~/.claude/managed-settings.json` exists; no env-precedence override visible
- Codex emission works fine via the same OTLP/protobuf path → daemon receiver is good

Suggested investigation paths (ordered by quickness):
1. **Test on a fresh shell with all plugins disabled.** Use `env -i` with only the OTEL_* + ANTHROPIC_API_KEY env, and `claude --bare -p` (requires a temp API key — user can fetch from console for a one-shot test). If telemetry emits in `--bare` mode, the culprit is one of the 15 enabled plugins; bisect by disabling them.
2. **Strace / dtrace claude-code's network calls** during a `-p` run. If no localhost:<port> connection attempts, OTel SDK never initialized. If connections appear but daemon doesn't see them, network filtering is happening (unlikely on localhost).
3. **Check claude-code release notes for 2.1.x** — maybe OTel was introduced in a later version, or has a known issue in 2.1.123. Bump to latest.
4. **Look at managed-settings precedence** — the docs say "Environment variables defined in the managed settings file have high precedence and cannot be overridden by users." Maybe a hidden managed-settings file disables telemetry. Check `/etc/claude-code/`, `/Library/Application Support/`, anywhere claude-code might read.

If the issue is genuinely a plugin layer, possible fixes:
- File a claude-mem issue if its hook is what's interfering (the SessionEnd "Hook cancelled" message appears in every claude run)
- Add a `penumbra hooks status --claude-otel` command that warns if env vars are set but no anthropic OTLP rows have landed in N minutes

## Other backlog (not blocking)

**Specced:**
- Phase 3e — agent-performance ledger codification. Phase 3b/3c/3d shipped real cost data; the agent-performance ledger uses this as a routing signal. Now unblocked. ~2-3 days.

**Idea backlog:**
- Capacity-error → CapturePort emission. Phase 3c T7 wired `onCapacityError` callback in cli-spawn but the actual T0 event emission (via `provider-capacity-error` event_type, already in the schema enum) is deferred. Requires extending `NotificationEvent` union in capture-port.ts and routing the callback through the worker. ~half day.
- OTel traces ingestion. Today `/v1/traces` is accept-and-discard. Could parse `claude_code.interaction` / `claude_code.tool` spans into `agent-thought` / `agent-tool-use` events. Adds visibility into per-call tool latencies. ~1 day. Deferred behind claude-code emission fix.
- Bun `proc.exited` dispatcher wedge investigation. Watchdog bounds it (15min timeout) but root cause unidentified. May need a minimal Bun bug repro.
- `~/.codex/config.toml [otel]` block in this session's user uses tracing-rs's group wire types in trace exports. The daemon catches and discards (correct), but it's worth filing an upstream issue with codex / tracing-rs to clean up the proto schema.
- PR #28 on GitHub — open with a now-redundant cumulative diff (we pushed main directly). Close as bookkeeping.
- `computer-use@openai-bundled` plugin codesigning crashes in `~/.codex/config.toml` — disable to silence macOS dialogs. Cosmetic.

## Discipline rules that stayed load-bearing

(All carried over from prior handoffs and validated again this session)

- Don't commit to main while a dispatch is in flight (FF-merge breaker)
- Single implementer per task; two-round cap; maestro hand-edits round-3+
- Don't tell agents to restart workers (kills them mid-task)
- Commit immediately after green tests, before final report
- cli-spawn uses `stdin: 'ignore'` for argv-mode + 15min watchdog. Don't reintroduce `stdin: 'pipe'` for argv.
- Daemon restart after schema enum changes
- **New (this session):** When a dispatched agent reports "DONE" but cuts off mid-progress without commit (oc-mimo-v2.5-pro pattern, observed 3× this session for hooks-install tasks), inspect worktree directly and commit on the agent's behalf — don't re-dispatch.
- **New (this session):** Probe-validated specs > spec-as-written. T4 (codex.sse_event) had `event.kind === 'completion'` but real codex emits `'response.completed'`. Always probe-then-implement for vendor schema details.
- **New (this session):** Hand-rolled protobuf wire reader works fine for OTel logs envelopes. Don't add `@bufbuild/protobuf` dep unless we genuinely need full schema-aware parsing (e.g. for traces).

## Suggested first move

Pick based on energy / interest:

**(a) Quick win — investigate claude-code emission** (~30-90 min)
1. Stand up a probe server on port 14318 (the same `/tmp/otlp-probe-3d/server.ts` pattern from prior session — kept as scratch)
2. Try `env -i` invocations to isolate plugin interference
3. If it works in isolation, bisect plugins to find the culprit
4. If it doesn't work even in isolation, check claude-code release notes / file an issue

**(b) Phase 3e kickoff — agent-performance ledger** (~2-3 days)
- Use Phase 3b cost data + Phase 3d per-tool token capture as routing signals
- Spec → plan → dispatch like 3c/3d
- Reuses the LOG_HANDLERS registry (no schema work)

**(c) Capacity-error CapturePort wiring** (~half day)
- Extend `NotificationEvent` union in `packages/agentchat/src/worker/capture-port.ts`
- Wire `onCapacityError` callback through the wrapper adapters (claude-cli/codex-cli/gemini-cli/opencode-cli) to the worker's CapturePort
- One T0 event emission per capacity error
- Closes the loop opened in Phase 3c T7

I'd lean **(a)** first — it's the smallest scope and unblocks claude-code visibility for all future cost-ledger queries. (b) and (c) are independent and can wait.

## Probe captures preserved

`/tmp/otlp-probe-3d/00{09..17}-v1_logs.body.bin` — 9 codex protobuf envelopes from a real `codex exec` call. Two of them (0015, 0016) trigger the group-wire-type throw on purpose; useful test fixtures if you ever want to expand parser robustness. **Contain real PII** — DO NOT commit them.

## How to start the next session

Paste this block into the new session:

> Resuming penumbra. Phase 3c (OTLP receiver, JSON, gemini ingest) and Phase 3d (OTLP/protobuf, codex + claude-code handlers) both shipped end-to-end last session. ~28 commits pushed (`e80b23f..a4a5311`). Codex live-verified at 155K tokens; gemini still working from 3c.
>
> **Read `docs/superpowers/notes/2026-05-01-session-handoff.md` first** — it has the full state, the one open follow-up, the backlog, and three suggested first moves.
>
> One open follow-up: **claude-code 2.1.123 doesn't emit OTel in this user's install**, even with the canonical env config. Architecture is verified via codex through the same path; this is a runtime quirk specific to this binary + plugin set. Investigation paths in the handoff doc.
>
> Pre-flight: standard daemon + worker check; if daemon was restarted, re-run `penumbra hooks install --{gemini-otel,codex-otel,claude-otel}` to update endpoints.
>
> Suggested first move: investigate claude-code OTel emission (~30-90 min) — smallest scope, unblocks all future anthropic cost-ledger queries. Or kick off Phase 3e (agent-performance ledger) which is now unblocked by 3b/3c/3d's real data.
