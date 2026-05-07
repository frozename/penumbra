# Maestro continuation prompt — 2026-05-07 pm

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/penumbra`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

## Recall summary

### Today's session memories



### Commits since midnight

```
fd2b3b3 docs(specs): subscription-aware cost tracking design
df693af fix(plugin/playbooks/session-handoff): stop hijacking the clipboard on every handoff
3541360 feat(workflows/dispatch-source): exclude heartbeat/watchdog ticks by default
095b821 docs(mcp/daemon-reload-config): advertise workflow + project registry hot-reload
a4fe835 fix(workflows/template): resolve {{.}} to current item inside {{#each}}
4b58b8d docs(plugin/playbooks): switch process refs from superpowers/* to penumbra plugin skills
676e504 docs(notes): handoff for next session — Phase 5 smoke + AGENTS.md ref swap
aab4dd5 feat(plugin/skills): session-fast-context — auto-prime session context from recent notes + recall
96639a8 feat(plugin/skills): worktree-state-audit — post-dispatch verification loop
8dce78f feat(plugin/skills): agent-pick-via-ledger -- agent_recommend gate before dispatch
402e8b6 feat(plugin/skills): maestro-recall-prime - pre-action t2 memory prime
22897d0 feat(plugin/skills): dispatch-reliability-triage -- failure taxonomy with memory citations
cd73d26 feat(plugin/skills): test-driven-development — failing-test-first discipline with chain_start dispatch contract
42d83f4 feat(plugin/skills): dispatching — chain_start + agent_recommend + parallelism playbook
1ac1f36 fix(plugin/skills/mem-search): align tool names with live MCP surface; tighten description
43270ba feat(plugin/skills): handoff — thin port over plugin/playbooks/session-handoff
ed61949 feat(plugin/skills): writing-plans — thin port over plugin/playbooks/write-plan
d3f4527 feat(plugin/skills): brainstorming — thin port over plugin/playbooks/brainstorm
e4cf374 fix(plugin/playbooks): make session-handoff and context-prime portable; add portability guard test
53dacec feat(plugin/skills): penumbra-skill-loader — meta auto-load replacing superpowers:using-superpowers
0e9f7c9 feat(plugin): skill-meta loader with frontmatter validation
b061c9e docs(plans): make penumbra-native skill bodies portable
4a13c23 docs(plans): phased implementation plan for penumbra-native skill plugin
923d159 docs(notes): handoff for next session — penumbra-native skill plugin work
26b1f1f docs(notes): kickoff brief — phase out superpowers skills, build penumbra-native plugin
```

### Diff against main

```

```

### Dispatch events this session


- 2026-05-07T10:16:02.765Z `claim` handoff `77b228f3-7427-4669-851d-71757d7b798f`

- 2026-05-07T10:16:02.765Z `dispatch.start` handoff `77b228f3-7427-4669-851d-71757d7b798f`

- 2026-05-07T10:16:03.132Z `acp.server.start` handoff `77b228f3-7427-4669-851d-71757d7b798f`

- 2026-05-07T10:16:04.235Z `acp.session.start` handoff `77b228f3-7427-4669-851d-71757d7b798f`

- 2026-05-07T10:16:31.073Z `agent.tool_call.failed` handoff `77b228f3-7427-4669-851d-71757d7b798f`

- 2026-05-07T10:16:44.747Z `agent.tool_call.failed` handoff `77b228f3-7427-4669-851d-71757d7b798f`

- 2026-05-07T10:16:49.225Z `agent.tool_call.failed` handoff `77b228f3-7427-4669-851d-71757d7b798f`

- 2026-05-07T10:17:06.117Z `agent.tool_call.failed` handoff `77b228f3-7427-4669-851d-71757d7b798f`

- 2026-05-07T10:17:26.628Z `acp.session.end` handoff `77b228f3-7427-4669-851d-71757d7b798f`

- 2026-05-07T10:17:26.691Z `dispatch.end` handoff `77b228f3-7427-4669-851d-71757d7b798f`

- 2026-05-07T10:24:01.886Z `claim` handoff `7d1636e0-ba7f-4617-a1e2-74e7239fba76`

- 2026-05-07T10:24:01.887Z `dispatch.start` handoff `7d1636e0-ba7f-4617-a1e2-74e7239fba76`

- 2026-05-07T10:24:02.105Z `acp.server.start` handoff `7d1636e0-ba7f-4617-a1e2-74e7239fba76`

- 2026-05-07T10:24:02.378Z `acp.session.start` handoff `7d1636e0-ba7f-4617-a1e2-74e7239fba76`

- 2026-05-07T10:24:18.820Z `agent.tool_call.failed` handoff `7d1636e0-ba7f-4617-a1e2-74e7239fba76`

- 2026-05-07T10:24:21.927Z `agent.tool_call.failed` handoff `7d1636e0-ba7f-4617-a1e2-74e7239fba76`

- 2026-05-07T10:24:29.053Z `acp.session.end` handoff `7d1636e0-ba7f-4617-a1e2-74e7239fba76`

- 2026-05-07T10:24:29.115Z `dispatch.end` handoff `7d1636e0-ba7f-4617-a1e2-74e7239fba76`

- 2026-05-07T10:27:19.343Z `claim` handoff `3711eda9-1d0e-4d6b-bee1-12573764428b`

- 2026-05-07T10:27:19.344Z `dispatch.start` handoff `3711eda9-1d0e-4d6b-bee1-12573764428b`

- 2026-05-07T10:27:19.533Z `acp.server.start` handoff `3711eda9-1d0e-4d6b-bee1-12573764428b`

- 2026-05-07T10:27:19.614Z `acp.session.start` handoff `3711eda9-1d0e-4d6b-bee1-12573764428b`

- 2026-05-07T10:28:24.872Z `agent.tool_call.failed` handoff `3711eda9-1d0e-4d6b-bee1-12573764428b`

- 2026-05-07T10:28:43.379Z `acp.session.end` handoff `3711eda9-1d0e-4d6b-bee1-12573764428b`

- 2026-05-07T10:28:43.422Z `dispatch.end` handoff `3711eda9-1d0e-4d6b-bee1-12573764428b`

- 2026-05-07T10:29:52.146Z `claim` handoff `70aca81b-7032-432b-81cc-444ca0cf2394`

- 2026-05-07T10:29:52.146Z `dispatch.start` handoff `70aca81b-7032-432b-81cc-444ca0cf2394`

- 2026-05-07T10:29:52.460Z `acp.server.start` handoff `70aca81b-7032-432b-81cc-444ca0cf2394`

- 2026-05-07T10:29:52.543Z `acp.session.start` handoff `70aca81b-7032-432b-81cc-444ca0cf2394`

- 2026-05-07T10:30:09.543Z `claim` handoff `e1782fb6-9b5c-49ee-8a66-3a263ca156ca`

- 2026-05-07T10:30:09.544Z `dispatch.start` handoff `e1782fb6-9b5c-49ee-8a66-3a263ca156ca`

- 2026-05-07T10:30:09.753Z `acp.server.start` handoff `e1782fb6-9b5c-49ee-8a66-3a263ca156ca`

- 2026-05-07T10:30:09.833Z `acp.session.start` handoff `e1782fb6-9b5c-49ee-8a66-3a263ca156ca`

- 2026-05-07T10:30:13.089Z `acp.session.end` handoff `70aca81b-7032-432b-81cc-444ca0cf2394`

- 2026-05-07T10:30:13.132Z `dispatch.end` handoff `70aca81b-7032-432b-81cc-444ca0cf2394`

- 2026-05-07T10:30:15.387Z `agent.tool_call.failed` handoff `e1782fb6-9b5c-49ee-8a66-3a263ca156ca`

- 2026-05-07T10:30:24.306Z `claim` handoff `da96f1a0-fca0-4bf4-bf54-fb4c6fe3967c`

- 2026-05-07T10:30:24.307Z `dispatch.start` handoff `da96f1a0-fca0-4bf4-bf54-fb4c6fe3967c`

- 2026-05-07T10:30:24.514Z `acp.server.start` handoff `da96f1a0-fca0-4bf4-bf54-fb4c6fe3967c`

- 2026-05-07T10:30:24.607Z `acp.session.start` handoff `da96f1a0-fca0-4bf4-bf54-fb4c6fe3967c`

- 2026-05-07T10:30:31.949Z `acp.session.end` handoff `e1782fb6-9b5c-49ee-8a66-3a263ca156ca`

- 2026-05-07T10:30:31.994Z `dispatch.end` handoff `e1782fb6-9b5c-49ee-8a66-3a263ca156ca`

- 2026-05-07T10:30:43.643Z `claim` handoff `70bfa925-10c2-4022-abbf-75c51bd8c917`

- 2026-05-07T10:30:43.643Z `dispatch.start` handoff `70bfa925-10c2-4022-abbf-75c51bd8c917`

- 2026-05-07T10:30:43.839Z `acp.server.start` handoff `70bfa925-10c2-4022-abbf-75c51bd8c917`

- 2026-05-07T10:30:43.919Z `acp.session.start` handoff `70bfa925-10c2-4022-abbf-75c51bd8c917`

- 2026-05-07T10:30:53.614Z `acp.session.end` handoff `da96f1a0-fca0-4bf4-bf54-fb4c6fe3967c`

- 2026-05-07T10:30:53.666Z `dispatch.end` handoff `da96f1a0-fca0-4bf4-bf54-fb4c6fe3967c`

- 2026-05-07T10:31:03.233Z `agent.tool_call.failed` handoff `70bfa925-10c2-4022-abbf-75c51bd8c917`

- 2026-05-07T10:31:11.672Z `acp.session.end` handoff `70bfa925-10c2-4022-abbf-75c51bd8c917`

- 2026-05-07T10:31:11.722Z `dispatch.end` handoff `70bfa925-10c2-4022-abbf-75c51bd8c917`

- 2026-05-07T10:32:35.029Z `claim` handoff `6e5ce6ff-47c4-49ea-9c6e-a5742da185a1`

- 2026-05-07T10:32:35.030Z `dispatch.start` handoff `6e5ce6ff-47c4-49ea-9c6e-a5742da185a1`

- 2026-05-07T10:32:35.232Z `acp.server.start` handoff `6e5ce6ff-47c4-49ea-9c6e-a5742da185a1`

- 2026-05-07T10:32:35.313Z `acp.session.start` handoff `6e5ce6ff-47c4-49ea-9c6e-a5742da185a1`

- 2026-05-07T10:32:45.116Z `agent.tool_call.failed` handoff `6e5ce6ff-47c4-49ea-9c6e-a5742da185a1`

- 2026-05-07T10:33:07.744Z `claim` handoff `b6870c59-b8c1-436f-aaa3-25ab0c710563`

- 2026-05-07T10:33:07.745Z `dispatch.start` handoff `b6870c59-b8c1-436f-aaa3-25ab0c710563`

- 2026-05-07T10:33:07.938Z `acp.server.start` handoff `b6870c59-b8c1-436f-aaa3-25ab0c710563`

- 2026-05-07T10:33:08.014Z `acp.session.start` handoff `b6870c59-b8c1-436f-aaa3-25ab0c710563`

- 2026-05-07T10:33:09.311Z `acp.session.end` handoff `6e5ce6ff-47c4-49ea-9c6e-a5742da185a1`

- 2026-05-07T10:33:09.335Z `dispatch.end` handoff `6e5ce6ff-47c4-49ea-9c6e-a5742da185a1`

- 2026-05-07T10:33:38.649Z `acp.session.end` handoff `b6870c59-b8c1-436f-aaa3-25ab0c710563`

- 2026-05-07T10:33:38.697Z `dispatch.end` handoff `b6870c59-b8c1-436f-aaa3-25ab0c710563`

- 2026-05-07T10:33:45.987Z `claim` handoff `0207b2f4-3dff-429f-a994-a8b038f86b31`

- 2026-05-07T10:33:45.987Z `dispatch.start` handoff `0207b2f4-3dff-429f-a994-a8b038f86b31`

- 2026-05-07T10:33:46.170Z `acp.server.start` handoff `0207b2f4-3dff-429f-a994-a8b038f86b31`

- 2026-05-07T10:33:46.246Z `acp.session.start` handoff `0207b2f4-3dff-429f-a994-a8b038f86b31`

- 2026-05-07T10:34:07.691Z `acp.session.end` handoff `0207b2f4-3dff-429f-a994-a8b038f86b31`

- 2026-05-07T10:34:07.760Z `dispatch.end` handoff `0207b2f4-3dff-429f-a994-a8b038f86b31`

- 2026-05-07T10:34:56.090Z `claim` handoff `d735c7a2-f986-478d-a4d0-5c9df98cc91b`

- 2026-05-07T10:34:56.091Z `dispatch.start` handoff `d735c7a2-f986-478d-a4d0-5c9df98cc91b`

- 2026-05-07T10:34:56.303Z `acp.server.start` handoff `d735c7a2-f986-478d-a4d0-5c9df98cc91b`

- 2026-05-07T10:34:56.381Z `acp.session.start` handoff `d735c7a2-f986-478d-a4d0-5c9df98cc91b`

- 2026-05-07T10:35:14.668Z `claim` handoff `a7c1921c-2fa1-4886-9988-36ae617447df`

- 2026-05-07T10:35:14.668Z `dispatch.start` handoff `a7c1921c-2fa1-4886-9988-36ae617447df`

- 2026-05-07T10:35:14.872Z `acp.server.start` handoff `a7c1921c-2fa1-4886-9988-36ae617447df`

- 2026-05-07T10:35:14.954Z `acp.session.start` handoff `a7c1921c-2fa1-4886-9988-36ae617447df`

- 2026-05-07T10:35:19.026Z `acp.session.end` handoff `d735c7a2-f986-478d-a4d0-5c9df98cc91b`

- 2026-05-07T10:35:19.070Z `dispatch.end` handoff `d735c7a2-f986-478d-a4d0-5c9df98cc91b`

- 2026-05-07T10:35:37.388Z `claim` handoff `01d9c2ac-1393-4579-9c14-5119156575d6`

- 2026-05-07T10:35:37.388Z `dispatch.start` handoff `01d9c2ac-1393-4579-9c14-5119156575d6`

- 2026-05-07T10:35:37.584Z `acp.server.start` handoff `01d9c2ac-1393-4579-9c14-5119156575d6`

- 2026-05-07T10:35:37.657Z `acp.session.start` handoff `01d9c2ac-1393-4579-9c14-5119156575d6`

- 2026-05-07T10:35:41.779Z `acp.session.end` handoff `a7c1921c-2fa1-4886-9988-36ae617447df`

- 2026-05-07T10:35:41.840Z `dispatch.end` handoff `a7c1921c-2fa1-4886-9988-36ae617447df`

- 2026-05-07T10:35:52.999Z `claim` handoff `1ff879da-1a58-43bf-ab55-b9e6a9d667f5`

- 2026-05-07T10:35:53.000Z `dispatch.start` handoff `1ff879da-1a58-43bf-ab55-b9e6a9d667f5`

- 2026-05-07T10:35:53.208Z `acp.server.start` handoff `1ff879da-1a58-43bf-ab55-b9e6a9d667f5`

- 2026-05-07T10:35:53.293Z `acp.session.start` handoff `1ff879da-1a58-43bf-ab55-b9e6a9d667f5`

- 2026-05-07T10:35:55.647Z `agent.tool_call.failed` handoff `01d9c2ac-1393-4579-9c14-5119156575d6`

- 2026-05-07T10:36:01.051Z `agent.tool_call.failed` handoff `1ff879da-1a58-43bf-ab55-b9e6a9d667f5`

- 2026-05-07T10:36:01.184Z `acp.session.end` handoff `01d9c2ac-1393-4579-9c14-5119156575d6`

- 2026-05-07T10:36:01.217Z `dispatch.end` handoff `01d9c2ac-1393-4579-9c14-5119156575d6`

- 2026-05-07T10:36:34.302Z `acp.session.end` handoff `1ff879da-1a58-43bf-ab55-b9e6a9d667f5`

- 2026-05-07T10:36:34.347Z `dispatch.end` handoff `1ff879da-1a58-43bf-ab55-b9e6a9d667f5`

- 2026-05-07T10:55:22.513Z `claim` handoff `06df3bd9-ebbd-49ca-8f64-934d3e935de7`

- 2026-05-07T10:55:22.515Z `dispatch.start` handoff `06df3bd9-ebbd-49ca-8f64-934d3e935de7`

- 2026-05-07T10:55:22.745Z `acp.server.start` handoff `06df3bd9-ebbd-49ca-8f64-934d3e935de7`

- 2026-05-07T10:55:23.243Z `acp.session.start` handoff `06df3bd9-ebbd-49ca-8f64-934d3e935de7`


### Pending handoffs



## What this session shipped (commits `4b58b8d..fd2b3b3`)

Phase 5 of the penumbra-native skill plugin closed (smoke + ref-swap), then a productive smoke-driven bug hunt:

- `4b58b8d` — Part B ref-swap: `superpowers:brainstorming` / `superpowers:writing-plans` → `brainstorming` / `writing-plans` in `plugin/playbooks/`. Real call-sites only; replacement-table entries left.
- `a4fe835` — workflow template engine `{{.}}` regression fixed (codex-acp-fast dispatch). Every `{{#each recall.fs.glob}}- {{.}}{{/each}}` had been silently rendering empty; now works.
- `095b821` — `daemon_reload_config` MCP description honesty: advertised workflow + project registry hot-reload (it always covered them, just wasn't documented).
- `3541360` — `dispatch_events` recall source filters out `heartbeat.received` / `heartbeat.sent` / `watchdog.tick` by default. Optional `include_heartbeats: true` for forensics.
- `df693af` — `session-handoff` playbook no longer hijacks the clipboard on every run.
- `fd2b3b3` — **spec for the next plan**: `docs/superpowers/specs/2026-05-07-subscription-cost-tracking-design.md`.

Also fixed (no commit, user-personal): `~/.claude/hooks/statusline-combined.sh` had a stale `PENUMBRA_STORAGE_ROOT=/tmp/penumbra-live` override → CLI fell back to "daemon offline" forever. Override dropped; statusline now reports correctly.

## Open thread — Subscription-aware cost tracking (V1 plan target)

**Read the spec first**: `docs/superpowers/specs/2026-05-07-subscription-cost-tracking-design.md`. It captures the full brainstorm — forensics findings, design shape, deferred items, open questions, code anchors.

**TL;DR of the spec:** USD-based cost-tracking is fictional for subscription-based CLI/ACP agents (Claude Code, codex-acp-fast, opencode-acp, etc.). The brainstorm confirmed Phase 0 forensics:
- Live signal exists for Claude (`/tmp/penumbra-claude-rl.json` — `five_hour: 15%`, `seven_day: 68%` today; the `ClaudeStatusLineBridge` reader consumes it).
- 3 of 4 readers have `rate_limit_snapshots: []` hardcoded (Claude JSONL, OpenCode db).
- Codex rollout reader DOES capture rate limits — live status unverified.
- No aggregator MCP tool consumes the snapshots; `cost_quota_status` operates on static yaml-config quotas, not live data.
- Gemini has no signal source at all (in-memory only per `project_gemini_aftermodel_hook_payload.md`).

**The next-session task is `/write-plan` against that spec — Phase 1 + Phase 2 only.**

Phase 1 = per-agent `pricing_mode: api | subscription` classification + reader fixes (Claude JSONL, OpenCode; Codex live-verify; Gemini deferred).
Phase 2 = `subscription_pressure_status` MCP tool aggregating rate-limit snapshots per (provider, window_label).
Phase 3 (cap mechanism) and Gemini gap deferred to follow-up plans once Phase 1+2 data is trusted.

**Why split:** sequential rollout per `feedback_sequential_rollout_no_dispatch_loops.md` — don't fan out fix loops; ship one phase, validate, then layer the next.

## Smoke findings to track (small things, log them)

These surfaced during this session's `/brainstorm` → `/write-plan` → `/handoff` smoke. None block the cost-tracking work; file as you encounter them again.

1. **`mcp.tool` recall source not wired into the workflow runtime.** `/write-plan` warned `mcp.tool chain.list_agents: invokeMcpTool not provided`. Any playbook with `source: mcp.tool` silently omits that data. Fix is in the daemon's recall context — the runtime needs an `invokeMcpTool` callback wired to actual MCP. Workaround: query `mcp__penumbra__chain_list_agents` separately when writing plans.
2. **Workflow runtime ignores edits without `daemon_reload_config`.** Playbook edits to `plugin/playbooks/<name>/playbook.md` need a reload (no daemon restart needed; documented now in commit `095b821`). Auto-memory note: `project_daemon_reload_config_covers_workflows.md`.
3. **`packages/*` code edits DO need a daemon restart** — `daemon_reload_config` won't pick them up. Caught when commit `3541360` (heartbeat filter) didn't take effect until I `launchctl kickstart -k`'d the daemon.
4. **Cross-repo worktree placement may ignore `project_id`.** Observed during a separate maestro session in `/Volumes/WorkSSD/repos/personal/llamactl`: a `chain_start` with `project_id` = llamactl still placed the worker in a penumbra-branched worktree. Workaround: `use_worktree: false`. Forensics path: `packages/agentchat/src/.../worktree-manager.ts` for `project_id` handling at create-time. Filed as t0 observation `46fe3e8a-b83d-40a7-a71d-9328750a7d7b`.
5. **`/handoff` "Today's session memories" recall is empty** even with active t0/t2 traffic. Likely `{{session_start}}` template var isn't substituting into the `memory.search dateStart` arg, OR the search is over-filtered. Worth a forensics pass before this becomes load-bearing.

## Memories to read at session start

- `feedback_phase_3b_cost_ledger.md` — Phase 3b cost ledger architecture
- `project_gemini_aftermodel_hook_payload.md` — Gemini gap (relevant to Phase 1)
- `project_maestro_reply_channel_2026-05-06.md` — IPC bridge (relevant to deferred Phase 3 cap-warn)
- `project_daemon_reload_config_covers_workflows.md` — when reload-config suffices vs daemon restart
- `feedback_sequential_rollout_no_dispatch_loops.md` — sequential phase discipline
- `feedback_dispatch_reliability_workarounds.md` — codex-acp-fast `tool_failure_with_end_turn` is mostly cosmetic
- `feedback_delegate_dont_implement.md` — delegate via `chain_start`

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. Read the spec: `docs/superpowers/specs/2026-05-07-subscription-cost-tracking-design.md`
4. Run `/write-plan` and follow the playbook's process — anchor the plan on this spec (most recent under `docs/superpowers/specs/`); scope to Phase 1 + Phase 2 only; query `mcp__penumbra__chain_list_agents` directly for `preferred_agent` / `fallback_agent` (workaround for smoke finding #1)
5. Validate via `penumbra plan validate` and offer Subagent-Driven vs Inline execution to the user.
