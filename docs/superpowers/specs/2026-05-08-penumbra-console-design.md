# Penumbra operator console — spec

> Captured 2026-05-08 from the Beacon design handoff (`penumbra-v3` bundle, 28 files, exported from claude.ai/design). User intent: a desktop-first operator console for the maestro flow, pixel-faithful to the design, talking to the existing daemon over local HTTP/SSE. Web app first under `packages/console/`. Tauri left out of phasing as a separate gated decision.
>
> Adversarial-review pass run 2026-05-08 (8 personas, 62 findings, synthesis at `.penumbra/reviews/2026-05-08T20-40-27.675Z/synthesis.md`). Spec revised below to absorb the high-severity findings and the simplicity-persona scope cuts. Recorded dissent — not adopted — listed at the bottom.

## Design source of truth

- Bundle: `/tmp/penumbra-design/penumbra-v3/` (re-extract from `https://api.anthropic.com/v1/design/h/Oph7DeexF8oqudLFnJIltQ` if needed). Treat as **read-only reference**. Do not commit prototype JSX into the repo.
- Files we mirror, in order: `tokens.css` → `colors_and_type.css` → `app.css` → component JSX (`app.jsx`, `mission-control.jsx`, `chain-detail.jsx`, `tasks-view.jsx`, `memory-view.jsx`, `review-browser.jsx`, `stubs.jsx`, `tweaks-panel.jsx`, `shared.jsx`).
- Design medium is HTML/CSS/JS prototype. We re-implement in TS+React; **match the visual output, not the prototype's internal structure**.

## Locked-in choices

### Stack & package
- **Vite + React 18 + TypeScript** under new workspace `packages/console/` (alongside `cli`, `daemon`, `mcp`).
- **No CSS framework.** Port `tokens.css` + `colors_and_type.css` + `app.css` verbatim from the bundle. The design's tokens are the design system. Pixel-faithful is the explicit goal — recorded dissent on this choice rejected.
- **One theme at launch: `sirius`** (the default indigo). Other three themes (scrubs, ember, clinical) are CSS vars; add on demand later.
- **No density toggle** until a user asks. Ship compact.
- **TanStack Query** for REST caching/dedup; raw EventSource for SSE topics through a small broker (below).

### Architecture (modular shell, mirrors `llamactl/packages/app`)
- `src/shell/` — persistent chrome rendered once at root: titlebar, rail (activity bar), explorer slot, surface (`<Outlet/>`), statusbar. Tweaks panel and ⌘K palette are mounted here when they ship (⌘K is P1, not P0).
- `src/stores/` — **start with two zustand slices, split when a second consumer imports**:
  - `ui-store` — active module, palette open (when ⌘K lands), theme (sirius for now), layout collapse state. Persisted via `zustand/middleware`.
  - `daemon-store` — connection state, base URL (resolved at boot, see Bootstrap below), token, health pulse. Not persisted; rehydrated each launch.
  - Promote per-feature state to its own slice **only when** a second consumer reads it.
- `src/modules/<id>/` — one folder per active activity-bar item. **P0 ships three modules: `mission`, `chains`, `tasks`.** Each:
  - `index.tsx` default-exports the main view.
  - Module-local zustand stores defined inline (filter strip on Tasks, selected hop on Chains). Not exported from `src/stores/`.
  - Sub-trees as needed (`detail/`, `index.tsx` for chains' index + drill, etc.).
- **No `registry.ts` until a second consumer or a 9th module exists.** Rail items + routes hardcoded in `src/shell/Rail.tsx` and `src/router.tsx`. Adversarial-review-recorded simplicity finding accepted.
- `src/api/` — typed daemon client (REST + SSE). One folder, one client. Imports zod schemas from `@penumbra/api-contract` (new package, see API contract below).
- `src/ui/` — primitives shared across modules: `<Badge/>`, `<Button/>`, `<Card/>`, `<StatusBadge/>`, `<Sparkline/>`, `<PressureOrb/>`, `<EventTypeChip/>`, `<LaneChip/>`. Map 1:1 to the prototype's `shared.jsx`.
- `src/themes/` — `tokens.css`, `colors_and_type.css`, `app.css` ported verbatim (sirius theme only kept active; other theme blocks left in tokens.css commented out for later).
- `src/hooks/` — cross-cutting (`useDaemonHealth`, `useHotkey`).

### Bootstrap & auth (security-revised)
- **The daemon already requires a bearer token** (`~/.penumbra/token`). Original spec said "no auth" — wrong; fixed here.
- **Browser cannot read filesystem.** Use a thin launcher that injects config into the page:
  - `penumbra console` CLI subcommand (added to `packages/cli`) reads `~/.penumbra/token` + `~/.penumbra/worker-port` (and the daemon port from process state), starts a local static server on a random port, serves the built console with token + base URL injected via a `<meta name="penumbra-config" content="…"/>` tag, and opens the browser to it.
  - Dev mode: Vite dev server reads the token from env at start (`PENUMBRA_TOKEN`, `PENUMBRA_DAEMON_URL`) and injects via `define`. Dev fallback fails closed if env missing.
- **All daemon requests** (REST + SSE) attach `Authorization: Bearer <token>`.
- **Origin/Host enforcement** lives daemon-side; verify the existing middleware already rejects requests with foreign `Origin`. If not, add a finding to the daemon backlog before P1 ships.
- **Daemon URL allowlist:** the resolved base URL must match `http://127.0.0.1:*` or `http://localhost:*`. Anything else fails closed unless `PENUMBRA_ALLOW_REMOTE=1` is set in dev — surface a banner when active.
- **CSP**: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* http://localhost:*; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. Tighten `style-src` later when the inline styles from the prototype are migrated to CSS modules.

### API contract (new package)
- New workspace package `packages/api-contract/` exporting zod schemas for every route + SSE event the console consumes.
- Daemon imports the same package for request/response validation; CI runs a contract test that fails when the daemon returns a shape the schemas don't accept.
- Schemas declare a `version` constant; client sends `X-Penumbra-Console-Version` and the daemon refuses if major version mismatches.
- Minor additions are non-breaking (new optional fields). Breaking removals require contract bump + console + daemon both updated.

### Realtime (stream broker, not shell-mounted firehose)
- `src/api/streams.ts` — single broker. `subscribe(topic, handler)` returns `unsubscribe`. Internally:
  - One `EventSource` per topic, opened on first subscribe, closed when refcount hits zero (with a 30 s linger so back-and-forth navigation doesn't churn).
  - 200-event ring buffer per topic; new subscribers get the buffered tail.
  - Auto-reconnect with exponential backoff; reconnect emits a `__reconnect__` synthetic event so views can show "reconnected" toast and refetch their REST snapshot.
- **Always-on at shell** (small, justified): `handoffs-events` (rail badge counts pending), `usage` snapshot poll (pressure pip).
- **Lazy per view**: `dispatch-events` (Mission), `conversation-stream` (Chain detail), `tasks-events` (Tasks). Acquired on mount, released on unmount.
- **Audit before P1** which routes are actually SSE versus polled JSON. Maintainability persona flagged `dispatch-events` may not be SSE — verify in `packages/daemon/src/routes/`.

### Mutations & data plane
- Daemon HTTP on `127.0.0.1:51257` (port from `~/.penumbra/worker-port` or env). Routes already present:
  - REST snapshots: `chains`, `handoffs`, `tasks`, `agents`, `memory`, `usage`, `metrics`, `recall`, `workflows`, `worktrees`, `sessions`, `health`.
  - SSE-or-polled streams (audit before wiring): `conversation-stream`, `dispatch-events`, `handoffs-events`, `handoffs-progress`, `tasks-events`, `permissions-events`.
  - Mutations already wired: handoff approve/deny, dispatch cancel, `chain_send_message`, the four task GH bridge endpoints, `task.file/next/complete/fail/cancel`.
- **List endpoints used by Kanban / chain index must support server-side pagination + filter** (or be confirmed to bound below ~500 rows). Performance persona flagged client-side-only as non-scaling. P1 acceptance criterion: any list-backed view stays responsive with 5,000 rows.
- **Virtualize** any list >100 rows visible at once. Use `@tanstack/react-virtual`. Applies to t0 tail, task columns, chain index.

### Routing
- React-router v6. **P0 routes only**: `/` (redirects to `/mission`), `/mission`, `/chains`, `/chains/:id`, `/tasks`. Other module slugs return 404 — not registered as stubs. Adds when the corresponding module ships.

## Information architecture (full reference)

```
┌─────────────────────────────────────────────────────────────┐
│ titlebar (38px)  · brand+ver  ·  crumb  ·  pressure pip  ↺ ↗ │
├──────┬──────────────┬────────────────────────────────────────┤
│ rail │ explorer     │ surface (view-specific)                │
│ (3)  │ (per-view)   │                                        │
├──────┴──────────────┴────────────────────────────────────────┤
│ statusbar (26px) · daemon ⎇ branch · n disp / n res          │
└─────────────────────────────────────────────────────────────┘
```

| View | Status | Surface contents | Backing routes |
|---|---|---|---|
| Mission control | **P0** | pending-handoff rows · 4 stat cards · pressure orb grid · in-flight chain cards · t0 tail · recent-resolved | `handoffs?status=pending`, `handoffs-events`, `chains?status=in-progress`, `dispatch-events` (verify SSE), `usage`, `metrics`, `chains?resolved=true&limit=4` |
| Chains | **P0** | index table · drill-down (swimlane / tree / gantt) · handoff detail · artifacts · send follow-up | `chains`, `chains/:id`, `chains/:id/events`, `conversation-stream`, `chain_send_message` |
| Tasks | **P0** | Kanban with 6 status columns · kind+GH filter strip · detail rail · GH bridge panel | `tasks`, `tasks-events`, `task.{link_gh,sync_gh_now,comment_gh,unlink_gh,file,next,complete,fail,cancel}` |
| Workflows | deferred | registered list · run-form · recent runs | `workflows`, `workflows/run` |
| Reviews | deferred | index · matrix · synthesis pane | new daemon route required (path-canonicalized, sanitized markdown) |
| Memory | deferred | Explore + Refinement | `memory/*`, `recall`, `observations` |
| Cost · quotas | deferred | stat row · pressure orbs · cap-trips | `usage`, `metrics` |
| Agents | deferred | fleet roster · live ranking | `agents`, `agent.recommend` |

## Phasing

Two phases written. P2+ written after P1 ships and we know what hurt.

### P0 — shell + Mission Control (live)

Goal: chrome works; Mission Control is fully wired against the daemon; one operator can approve a real handoff from the console without leaving it.

- `packages/console/` Vite scaffold; `packages/api-contract/` scaffold with zod schemas for `handoffs`, `chains`, `usage`, `metrics`.
- Port `tokens.css` + `colors_and_type.css` + `app.css` (sirius only).
- Shell components: titlebar, rail (3 items), explorer slot, surface, statusbar. Theme provider with sirius hardcoded.
- Bootstrap path: `penumbra console` CLI subcommand spec'd; for P0 the dev flow uses `PENUMBRA_TOKEN` + `PENUMBRA_DAEMON_URL` env. Production launcher slipped to P1.
- Stream broker (`src/api/streams.ts`) implemented; `handoffs-events` and `usage` mounted at shell.
- Mission Control module: every section live against real daemon data. Approve/deny/defer wired. List virtualization for the t0 tail.
- Test plan: zod contract tests (api-contract ↔ daemon); component tests for shell + mission; one Playwright smoke that approves a fixture handoff against a daemon test harness.
- Verification: with a live dispatch, the operator sees pending handoffs appear, approves one, sees the rail badge decrement, watches the t0 tail update, and sees the chain enter "in-flight". CSP enforced; running with `PENUMBRA_ALLOW_REMOTE=0` (default) refuses any non-loopback URL.

### P1 — Chains + Tasks live + ⌘K + production launcher

Goal: the daily-use loop is complete. Operator can plan and execute a full work-cycle from the console.

- Chains module: index → drill-down. Three viz modes (swimlane / tree / gantt) — toggle behind a Tweaks gear (Tweaks panel introduced in P1, themes still single).
- Tasks module: Kanban + GH bridge with all four states (linked / queued / pending / failed) and corresponding actions.
- ⌘K palette mounted at shell with three groups (Views, Chains, Handoffs).
- `penumbra console` CLI subcommand finalized (token + URL injection, opens browser, `--no-open` flag).
- Server-side pagination on tasks + chains; virtualization on each Kanban column.
- New daemon route required for any P1 mutation that doesn't exist yet (audited at P1 entry).
- Verification: create a task → see it appear → claim it → dispatch → drill into the chain → send a follow-up → mark task complete. All from the console. ⌘K reachable everywhere. Lighthouse a11y ≥ 85.

### Future (gated, not phased)

- **Workflows / Reviews / Memory / Cost / Agents modules.** Each gated on its backing daemon route(s) being stable + a real operator need. When unblocked, each is a self-contained PR mirroring the P0/P1 module shape.
- **Reviews module specifically:** new daemon route `GET /reviews` + `GET /reviews/:id` required. Path canonicalization + ID allowlist (`^[0-9TZ:.-]+$`) + base-dir confinement. Markdown rendered through `react-markdown` + `rehype-sanitize` with raw HTML disabled.
- **Tauri shell.** Gated decision after web console proves out. Go/no-go criteria: (1) a real operator request for tray / global hotkey / native menu; (2) signed-update toolchain ready (mac codesign + notarize, Linux AppImage signing, Windows deferred). Until both are met, the console stays a web app served by the launcher.
- **Other themes (scrubs / ember / clinical).** Add when one is asked for. Each is a CSS-var block in tokens.css.
- **Density toggle.** Add if a real ergonomics complaint surfaces.

## Test plan

- **Unit:** zod schemas, stream-broker refcount + buffer, store reducers.
- **Contract:** api-contract package's zod schemas validate live daemon responses on every CI run (small fixture daemon spun up).
- **Integration:** module-level tests that mount each module against a mocked daemon, drive a happy-path interaction, assert mutations fire with correct payloads.
- **E2E (Playwright):** at minimum one smoke per phase that exercises the marquee user story end-to-end against a daemon test harness.
- **Reconnect/downtime:** explicit tests for SSE drop + reconnect + REST snapshot refetch; daemon stop while a view is open shows the offline banner; restart re-establishes streams.

## Recorded dissent (reviewed and not adopted)

- **devils_advocate:** "use Material-UI / Radix / Ant instead of pixel-perfect from tokens." User explicitly chose pixel-faithful as the fidelity bar. Component libraries would change the visual output materially and the bundle's CSS already does the work.
- **devils_advocate:** "drop Tauri entirely, ship as PWA only." Demoted from "Phase 5" to "future gated decision," not eliminated. Native shell remains the design's clear intent (traffic-light dots, statusbar) but does not block any phased work.
- **devils_advocate:** "share the shell with `llamactl` as `packages/operator-console-shell`." Cross-repo abstraction with one consumer is premature. Re-evaluate if a third operator console emerges.
- **simplicity:** "drop reviews module entirely" — left as deferred (not deleted) since the design and operator value are clear; gated on the daemon route work that's a small follow-up.

## Audit results — P0 prerequisites (resolved 2026-05-08)

### Q1. Auth + Origin/Host enforcement
- **Bearer auth: present** (`packages/daemon/src/auth.ts`, timing-safe compare).
- **Origin/Host validation: absent.** Daemon binds 127.0.0.1 by default (`serve.ts:872`, `PENUMBRA_DAEMON_HOST` env override) but does not check `Origin` or `Host` headers. A malicious page in the operator's browser could attempt requests; bearer is the only line of defense. DNS-rebinding adds a residual risk.
- **P0 prerequisite (daemon-side):** add `Origin` + `Host` validation middleware. Reject requests whose `Origin` header (when present) is not `null`, `127.0.0.1:*`, or `localhost:*`; reject any `Host` not in the same allowlist. Constant-time compare. Small change, lives next to `auth.ts`.

### Q2. SSE vs JSON classification
| Route | Classification | Notes |
|---|---|---|
| `handoffs-events` | **SSE** (`text/event-stream`) | replay-since support |
| `tasks-events` | **SSE** | replay-since, kind+agent filters, 30 s keepalive |
| `permissions-events` | **SSE** | event id support for resume |
| `conversation-stream` | **SSE** | per-conversation progress |
| `dispatch-events` | **JSON only** (POST batch + GET by `handoff_id`) | spec was wrong; needs correction |
| `handoffs-progress` | **JSON only** | snapshot, not a stream |

- **Spec correction**: Mission Control's "t0 live tail" cannot subscribe to `dispatch-events` as SSE. **P0 prerequisite (daemon-side):** add a new SSE route `GET /dispatch-events/stream` mirroring the `tasks-events` pattern (replay-since + filters + keepalive). Minimal addition, ~80 lines.

### Q3. Port/URL surface
- The daemon writes its port to **`~/.penumbra/port`** (not `daemon.lock` — original spec was wrong) at `packages/cli/src/commands/start.ts:168`, mode 0644.
- Worker port at `~/.penumbra/worker-port`.
- Token at `~/.penumbra/token`.
- Daemon hostname: `127.0.0.1` default, env override `PENUMBRA_DAEMON_HOST`.
- **Decision**: the `penumbra console` launcher reads `~/.penumbra/port` + `~/.penumbra/token` + (optional) `PENUMBRA_DAEMON_HOST` and injects via `<meta name="penumbra-config">`. Filename references throughout this spec corrected from `daemon.lock` to `port`.

### Q4. Server-side pagination + filters
- **Tasks: ✅** `?status=`, `?kind=`, `?eligible_for=`, `?parent_task_id=`, `?origin=`, `?limit=` (max 500), `?offset=` already present (`tasks.ts:28-36`).
- **Chains: partial.** History (`chains/:id/history`) supports `?limit=` (default 50). Top-level chain list pagination unverified; **P0 prerequisite (daemon-side):** confirm and add if missing — likely a 1-day item.
- Other lists (handoffs, agents, memory, workflows) — verify during P0 entry; defer pagination to a follow-up unless clearly needed.

## P0 prerequisite checklist (daemon-side, before any console code)

1. Add `Origin`/`Host` validation middleware in daemon (Q1).
2. Add `GET /dispatch-events/stream` SSE route (Q2).
3. Confirm or add `?limit&offset` on chains list endpoint (Q4).
4. Bump `packages/api-contract/` zod schemas to capture the new SSE route + the existing tasks/chains/handoffs/usage shapes consumed in P0.

These three small daemon changes unblock the entire console line. Suggest dispatching them as one chained PR before P0 console scaffolding starts.
