# Penumbra operator console — implementation plan

> Spec: `docs/superpowers/specs/2026-05-08-penumbra-console-design.md`. Builds on the daemon prereqs landed in `ff19884` (origin-host guard, `dispatch-events/stream` SSE route, chains list pagination, `@penumbra/api-contract` package).
>
> This plan covers **P0 only** (shell + Mission Control live against the daemon). P1 (Chains + Tasks + ⌘K + production launcher) gets its own plan after P0 ships and we know what hurt.

## Context primer (for implementing agents)

- New workspace package `packages/console/`. Stack is Vite + React 18 + TypeScript. **No CSS framework** — `tokens.css` + `colors_and_type.css` + `app.css` are ported verbatim from the design bundle (sirius theme only at launch; other theme blocks left commented out).
- Architecture mirrors `llamactl/packages/app` but lighter: `src/shell/`, `src/api/`, `src/modules/<id>/`, `src/ui/`, `src/themes/`, `src/stores/`. **No registry indirection** — rail items + routes hardcoded. Scope-cut from adversarial-review pass.
- Two zustand slices at start: `ui-store` (active module, theme — for now sirius only) and `daemon-store` (base URL, token, health pulse). Per-module state inline in module files. Promote to a third slice only when a second consumer reads it.
- All daemon traffic carries `Authorization: Bearer <token>`. Token + URL injected via a `<meta name="penumbra-config" content='{"baseUrl":"...","token":"..."}'>` tag. Dev mode uses `PENUMBRA_TOKEN` + `PENUMBRA_DAEMON_URL` env vars + Vite `define`.
- Bootstrap source-of-truth: token at `~/.penumbra/token`, daemon port at `~/.penumbra/port` (NOT `daemon.lock`). Daemon binds 127.0.0.1 by default.
- The `@penumbra/api-contract` package (just landed) exports zod schemas for `handoffs`, `chains`, `tasks`, `usage`, dispatch-events stream events. Console imports these — does NOT redeclare types.
- Stream broker: one EventSource per topic, opened on first subscriber, closed 30s after last unsubscribe. 200-event ring buffer. Auto-reconnect with exponential backoff; reconnect emits a `__reconnect__` synthetic event so views can refetch their REST snapshot.
- **Always-on at shell**: `handoffs-events` (rail badge counts pending), `usage` polled snapshot (titlebar pressure pip).
- **Lazy per view**: `dispatch-events/stream` (Mission t0 tail), opened on Mission mount.
- Mission Control list virtualization via `@tanstack/react-virtual` for the t0 tail.
- CSP enforced at build (`<meta http-equiv="Content-Security-Policy" ...>`): `default-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:*; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
- Sequential rollout discipline: one phase at a time. Within a phase, 1.x tasks fan out (independent files); the next phase waits for full integration.

## Phase 1 — Workspace scaffold + tokens + bootstrap

Dispatch graph: 1.1 → 1.2 ∥ 1.3

### 1.1 Create `packages/console/` workspace skeleton

```yaml meta
id: "1.1"
files:
  - packages/console/package.json
  - packages/console/tsconfig.json
  - packages/console/vite.config.ts
  - packages/console/index.html
  - packages/console/src/main.tsx
  - packages/console/src/App.tsx
file_scope: new
depends_on: []
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: bootstrap-touching
```

Stand up the workspace package so subsequent tasks have a place to land.

`packages/console/package.json`:
- `name: "@penumbra/console"`, `private: true`, `type: "module"`.
- Scripts: `dev` (vite), `build` (vite build), `typecheck` (tsc --noEmit -p tsconfig.json), `test` (bun test).
- Dependencies: `react@^18.3.1`, `react-dom@^18.3.1`, `react-router-dom@^6`, `zustand@^4`, `@tanstack/react-query@^5`, `@tanstack/react-virtual@^3`.
- DevDependencies: `@vitejs/plugin-react`, `vite`, `typescript`, `@types/react`, `@types/react-dom`.
- Workspace deps: `@penumbra/api-contract: workspace:*`.

`packages/console/tsconfig.json`: extend the root tsconfig with `target: ES2022`, `jsx: react-jsx`, `module: ESNext`, `moduleResolution: bundler`, `strict: true`, `lib: ["ES2022", "DOM", "DOM.Iterable"]`, `noEmit: true`, `skipLibCheck: true`. Add a project reference to `../api-contract`.

`packages/console/vite.config.ts`: react plugin, `define: { '__PENUMBRA_DEV_TOKEN__': JSON.stringify(process.env.PENUMBRA_TOKEN ?? ''), '__PENUMBRA_DEV_DAEMON_URL__': JSON.stringify(process.env.PENUMBRA_DAEMON_URL ?? 'http://127.0.0.1:51257') }`. Server port 5176 by default.

`packages/console/index.html`: minimal HTML5 shell with `<meta name="penumbra-config" content="">` placeholder, the strict CSP `<meta http-equiv>` from the spec, `<div id="root">`, script tag pointing at `/src/main.tsx`.

`packages/console/src/main.tsx`: ReactDOM.createRoot mounts `<App/>`.

`packages/console/src/App.tsx`: temporary `<div>console boot</div>` — replaced in Phase 3.

Add `packages/console` to root workspace globs (`package.json` if needed) and `tsconfig.json` `references`.

TDD steps:
1. Add `packages/console/test/scaffold.test.ts` asserting (a) package.json parses with name `@penumbra/console`, (b) `react`, `zustand`, `@penumbra/api-contract` are in dependencies. Confirm RED (no package.json yet).
2. Create the files per spec.
3. Run `bun install` from repo root; confirm workspace picks up the new package.
4. Run `bun --cwd packages/console run typecheck`; confirm clean.
5. Run `bun --cwd packages/console test`; confirm scaffold.test passes.
6. Run `bun run typecheck` from repo root; confirm whole-tree clean.

Commit: `feat(console): workspace scaffold + Vite + tsconfig wiring`

### 1.2 Port theme tokens (sirius only) + minimal app.css

```yaml meta
id: "1.2"
files:
  - packages/console/src/themes/tokens.css
  - packages/console/src/themes/colors_and_type.css
  - packages/console/src/themes/app.css
  - packages/console/src/main.tsx
file_scope: new
depends_on: ["1.1"]
parallel_with: ["1.3"]
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Copy three CSS files from the design bundle at `/tmp/penumbra-design/penumbra-v3/project/`:
- `tokens.css` → `packages/console/src/themes/tokens.css`. Comment out the three non-sirius theme blocks (`[data-theme='ember']`, `[data-theme='clinical']`, `[data-theme='scrubs']`) with a `/* TODO restore when a user asks for this theme — see spec */` marker. Keep `:root, [data-theme='sirius']` active.
- `colors_and_type.css` → `packages/console/src/themes/colors_and_type.css`. Same treatment for the three non-sirius blocks.
- `app.css` → `packages/console/src/themes/app.css`. Verbatim — no theme blocks here.

Update `packages/console/src/main.tsx` to import the three CSS files in order before mounting.

Add `packages/console/index.html` `<html data-theme="sirius">` so the CSS variables resolve.

TDD steps:
1. Add `packages/console/test/themes.test.ts` that reads the three CSS files and asserts (a) each contains `--color-brand: #6366f1` (sirius brand), (b) tokens.css contains the comment marker for ember/clinical/scrubs blocks (regex match). Confirm RED.
2. Copy the three files. Comment out non-sirius blocks. Add the TODO marker.
3. Re-run; confirm GREEN.

Commit: `feat(console/themes): port sirius tokens + colors_and_type + app.css from Beacon bundle`

### 1.3 Bootstrap config reader + `daemon-store` zustand slice

```yaml meta
id: "1.3"
files:
  - packages/console/src/api/config.ts
  - packages/console/src/stores/daemon-store.ts
  - packages/console/test/api/config.test.ts
  - packages/console/test/stores/daemon-store.test.ts
file_scope: new
depends_on: ["1.1"]
parallel_with: ["1.2"]
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

`packages/console/src/api/config.ts` exports `loadPenumbraConfig(): { baseUrl: string; token: string }`:
1. Look for `<meta name="penumbra-config" content="...">` in `document`. If present and `content` parses as JSON with both keys, return it.
2. Fallback to Vite-injected `__PENUMBRA_DEV_TOKEN__` + `__PENUMBRA_DEV_DAEMON_URL__` (via `declare global` in a `vite-env.d.ts`).
3. **Allowlist check**: `baseUrl` must match `^http://(127\.0\.0\.1|localhost)(:\d+)?$`. Throw a `BadDaemonUrlError` if it doesn't. The `PENUMBRA_ALLOW_REMOTE` opt-in is dev-only — read from `import.meta.env.VITE_PENUMBRA_ALLOW_REMOTE === '1'` to bypass; surface a console.warn when bypassed.
4. Throw `MissingTokenError` if `token` is empty.

`packages/console/src/stores/daemon-store.ts` exports `useDaemonStore`:
- State: `{ baseUrl: string; token: string; health: 'unknown' | 'ok' | 'down'; lastHealthAt: number | null }`.
- Actions: `setHealth(h, at)`, `init()` calls `loadPenumbraConfig()` and seeds baseUrl/token. **Not persisted** (rehydrated each launch).

TDD steps:
1. Failing tests:
   - `config.test.ts`: meta-tag path returns parsed config; missing meta + dev env returns the env values; foreign baseUrl throws; allowRemote bypass works in dev mode.
   - `daemon-store.test.ts`: `init()` populates baseUrl/token; `setHealth` mutates correctly; default `health: 'unknown'`.
2. Confirm RED.
3. Implement.
4. Confirm GREEN.

Commit: `feat(console): config bootstrap + daemon-store zustand slice`

Integration: Three commits FF onto main in 1.1 → (1.2 ∥ 1.3) order. Verify with `bun run typecheck` from repo root and `bun --cwd packages/console test`. After all three: `bun --cwd packages/console run dev` should boot a blank page that mounts without error against `PENUMBRA_TOKEN=$(cat ~/.penumbra/token) PENUMBRA_DAEMON_URL=http://127.0.0.1:$(cat ~/.penumbra/port) bun --cwd packages/console run dev`.

## Phase 2 — Daemon HTTP client + stream broker

Dispatch graph: 2.1 → 2.2 → 2.3

### 2.1 Typed daemon REST client

```yaml meta
id: "2.1"
files:
  - packages/console/src/api/client.ts
  - packages/console/test/api/client.test.ts
file_scope: new
depends_on: ["1.3"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

`packages/console/src/api/client.ts` exports a single `DaemonClient` class with one method per route P0 needs. Internally: `fetch` with `Authorization: Bearer ${token}` from daemon-store, response parsed via the matching zod schema from `@penumbra/api-contract`, throws `DaemonHttpError` (HTTP non-2xx) or `DaemonContractError` (schema parse fails) with structured info.

P0 methods (mirror what Mission Control needs):
- `listHandoffs(opts: { status?: 'pending' | 'completed' | ... })` → uses `HandoffsListResponseSchema`.
- `approveHandoff(id: string)` → POST `/handoffs/:id/approve`, returns `HandoffSchema`.
- `denyHandoff(id: string, reason?: string)` → POST `/handoffs/:id/deny`, returns `HandoffSchema`.
- `deferHandoff(id: string, untilSec: number)` → POST `/handoffs/:id/defer`, returns `HandoffSchema`.
- `listChains(opts: { status?: ...; limit?: number; offset?: number })` → uses `ChainsListResponseSchema`.
- `getUsage()` → GET `/usage`, returns `UsageSnapshotSchema` (verify which exists in api-contract; if missing, add a minimal one as part of this task — small additive change to `packages/api-contract/src/usage.ts`).
- `health()` → GET `/health`, returns `{ status: 'ok' }`.

Constructor takes the daemon-store ref so token rotation (P1) can be wired without a refactor.

TDD steps:
1. Failing tests using `bun:test` and a mock-fetch helper. Cover: 401 → throws `DaemonHttpError`; bad shape → `DaemonContractError`; well-formed `listHandoffs` → typed result. Mock the fetch globally for these tests.
2. Confirm RED.
3. Implement.
4. Confirm GREEN.

Commit: `feat(console/api): typed daemon REST client backed by api-contract zod schemas`

### 2.2 Stream broker (SSE refcount + ring + reconnect)

```yaml meta
id: "2.2"
files:
  - packages/console/src/api/streams.ts
  - packages/console/src/api/event-source-shim.ts
  - packages/console/test/api/streams.test.ts
file_scope: new
depends_on: ["2.1"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

`packages/console/src/api/streams.ts` exports:
```ts
export type StreamTopic = 'handoffs-events' | 'tasks-events' | 'dispatch-events-stream';
export interface StreamMessage<T> { event: string; data: T; raw: MessageEvent | { reconnect: true } }
export interface Subscription { unsubscribe: () => void; tail(): readonly StreamMessage<unknown>[]; }
export function subscribe<T>(topic: StreamTopic, onMessage: (msg: StreamMessage<T>) => void, opts?: { params?: Record<string, string> }): Subscription;
```

Behavior:
- One `EventSource` instance per `(topic, paramsKey)`. Parameters serialized canonically for the cache key (sorted query string).
- First subscribe opens the EventSource; subsequent subscribers attach to the same emitter. Refcount on subscribers.
- Unsubscribe decrements refcount. When refcount hits zero, close after a 30 s linger (cancel the timer if a new subscriber arrives).
- 200-message ring buffer per stream; `tail()` returns the buffered tail. New subscribers replay the buffer synchronously before live messages start.
- Auto-reconnect with exponential backoff (1 s, 2 s, 4 s, 8 s, capped at 30 s). On reconnect, emit `{ event: '__reconnect__', data: { reconnect: true } }` synthetic message + reset the ring (since we don't know what we missed — view layer is responsible for refetching its REST snapshot in response).
- Bearer auth: standard `EventSource` doesn't support headers. Use `event-source-shim.ts` — a tiny `fetch`-based SSE reader that does support `Authorization`. Just enough to parse `data:` and `event:` lines. Use `ReadableStream` reader.

`event-source-shim.ts` exports `createSseSource(url: string, headers: Record<string, string>): EventSourceLike` with `addEventListener`, `close`, and reconnect-on-error semantics.

TDD steps:
1. Failing tests: refcount lifecycle (1 sub opens, 2 subs share, 0 subs lingers 30 s then closes); ring buffer caps at 200; reconnect emits `__reconnect__`; SSE shim parses `event:`/`data:` correctly.
2. Mock EventSource via the shim (deterministic).
3. Confirm RED.
4. Implement.
5. Confirm GREEN.

Commit: `feat(console/api): stream broker with refcounted SSE + ring buffer + reconnect`

### 2.3 React hooks: `useDaemonHealth`, `useStream`

```yaml meta
id: "2.3"
files:
  - packages/console/src/hooks/useDaemonHealth.ts
  - packages/console/src/hooks/useStream.ts
  - packages/console/test/hooks/useDaemonHealth.test.tsx
  - packages/console/test/hooks/useStream.test.tsx
file_scope: new
depends_on: ["2.2"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

`useDaemonHealth()` polls `client.health()` every 5 s; updates `daemon-store` via `setHealth`. Returns the current `health` value from the store.

`useStream<T>(topic, params?)` subscribes via the broker on mount, unsubscribes on unmount; returns `{ messages: StreamMessage<T>[]; reconnected: boolean }` where `reconnected` flips true when a `__reconnect__` synthetic arrives. Use `useSyncExternalStore` for clean React 18 subscriptions.

TDD steps: standard React Testing Library hook tests; assert mount → subscribe → unmount → unsubscribe.

Commit: `feat(console/hooks): useDaemonHealth + useStream`

Integration: 2.1 → 2.2 → 2.3 strict order (each depends on the prior). Verify with `bun --cwd packages/console test` after each commit. After 2.3, the dev server can boot and call `client.listHandoffs()` from a tiny harness in `App.tsx` — render the count for sanity.

## Phase 3 — Shell chrome

Dispatch graph: 3.1 ∥ 3.2 ∥ 3.3 → 3.4 → 3.5

### 3.1 `ui-store` zustand slice

```yaml meta
id: "3.1"
files:
  - packages/console/src/stores/ui-store.ts
  - packages/console/test/stores/ui-store.test.ts
file_scope: new
depends_on: ["1.3"]
parallel_with: ["3.2", "3.3"]
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

`useUIStore` exports state `{ activeModule: 'mission' | 'chains' | 'tasks'; explorerCollapsed: boolean }` with setters. Persisted via `zustand/middleware` `persist` keyed `penumbra-ui`. Theme is hardcoded sirius for now — when a second theme lands, add `theme` here.

TDD: store mutations + persistence round-trip.

Commit: `feat(console/stores): ui-store with active module + explorer collapse`

### 3.2 Titlebar component

```yaml meta
id: "3.2"
files:
  - packages/console/src/shell/Titlebar.tsx
  - packages/console/src/shell/PenumbraOrb.tsx
  - packages/console/test/shell/Titlebar.test.tsx
file_scope: new
depends_on: ["1.2"]
parallel_with: ["3.1", "3.3"]
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Port the titlebar from `app.jsx` (lines 60-84) and the `.tb*` rules from `app.css`. Two regions:
- Left: traffic-light dots (`.traffic`), brand (`.brand` with `.penorb` orb + version).
- Center: a clickable crumb bar showing `<project> / <view>` and "⌘K to jump" hint (clicking does nothing in P0; ⌘K is P1).
- Right: pressure pip (placeholder — fed live in 5.3) + reload (↺) + docs (↗) icon buttons.

Use `<PenumbraOrb/>` as the brand mark — replicate the radial-gradient + ring overlay from `app.css:50-58`.

TDD: snapshot test the rendered DOM structure; assert traffic dots have correct colors via computed style.

Commit: `feat(console/shell): titlebar + brand orb`

### 3.3 Statusbar component

```yaml meta
id: "3.3"
files:
  - packages/console/src/shell/Statusbar.tsx
  - packages/console/test/shell/Statusbar.test.tsx
file_scope: new
depends_on: ["1.2"]
parallel_with: ["3.1", "3.2"]
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Port the statusbar from `app.jsx` (lines 151-163). Left group: `daemon · 127.0.0.1:<port>` dot (color from `daemon-store.health`), `⎇ <branch>` (placeholder — pulled later from a session route), `<n> dispatched · <m> resolved` (placeholder), `<k> t0 in tail` (placeholder).
Right group: theme name (always `sirius` for now), timezone, brand line.

TDD: each chip renders; daemon dot color matches `health` state.

Commit: `feat(console/shell): statusbar with daemon health dot + chips`

### 3.4 Rail (3 hardcoded items)

```yaml meta
id: "3.4"
files:
  - packages/console/src/shell/Rail.tsx
  - packages/console/test/shell/Rail.test.tsx
file_scope: new
depends_on: ["3.1", "1.2"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Hardcoded array `[{ id: 'mission', label: 'Mission control', icon: '◐' }, { id: 'chains', label: 'Chains', icon: '≋' }, { id: 'tasks', label: 'Tasks', icon: '☷' }]`. Rail buttons map to routes; clicking navigates via react-router and updates `ui-store.activeModule`. Rail badge for pending handoff count is added in 5.2.

TDD: rail renders three buttons; clicking routes; active module gets `.active` class.

Commit: `feat(console/shell): rail with hardcoded mission/chains/tasks`

### 3.5 Surface + router + App composition

```yaml meta
id: "3.5"
files:
  - packages/console/src/router.tsx
  - packages/console/src/shell/Shell.tsx
  - packages/console/src/App.tsx
  - packages/console/test/shell/Shell.test.tsx
file_scope: modify-existing
depends_on: ["3.2", "3.3", "3.4"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: bootstrap-touching
```

`router.tsx`: react-router config. Routes: `/` redirects to `/mission`; `/mission` renders `<MissionStub/>`; `/chains` and `/tasks` render `<DeferredViewStub view="chains"/>` / `<DeferredViewStub view="tasks"/>` (these will be replaced in their own plans). 404 → `<NotFound/>`.

`Shell.tsx`: app grid (CSS grid `38px 1fr 26px` per `app.css:18-22`). Renders `<Titlebar/>` + a 3-col flex (`<Rail/>`, optional `<aside class="exp">` explorer slot, `<section class="surface"><Outlet/></section>`) + `<Statusbar/>`. Boots `useDaemonHealth()` on mount.

`App.tsx`: replace the temporary div with `<RouterProvider router={router}/>`. Initialize daemon-store via `useDaemonStore.getState().init()` at module load; show a friendly error screen if config bootstrap throws.

TDD: render `<Shell>` with a memory router pointed at `/mission`; assert the grid layout, titlebar, rail, statusbar all mount; assert health hook is called.

Commit: `feat(console): wire router + shell composition + daemon-store init`

Integration: dispatches fan out 3.1∥3.2∥3.3, then 3.4, then 3.5. After 3.5: `bun --cwd packages/console run dev` shows the chrome with three rail items, navigation works, daemon-health dot greens up if the daemon is running.

## Phase 4 — UI primitives

Dispatch graph: 4.1 ∥ 4.2

### 4.1 Atomic components: Badge, Button, Card, StatusBadge

```yaml meta
id: "4.1"
files:
  - packages/console/src/ui/Badge.tsx
  - packages/console/src/ui/Button.tsx
  - packages/console/src/ui/Card.tsx
  - packages/console/src/ui/StatusBadge.tsx
  - packages/console/test/ui/atoms.test.tsx
file_scope: new
depends_on: ["1.2"]
parallel_with: ["4.2"]
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Lift verbatim from `shared.jsx`:
- `<Badge variant="ok|warn|err|info|brand|muted">` → maps to existing `.badge-*` classes in `app.css`.
- `<Button variant="primary|secondary|ghost|danger|ok">` → existing `.btn-*` classes.
- `<Card>` wrapper → `.card` class with optional `<CardHead title id actions dot/>`.
- `<StatusBadge status="in-progress|claimed|completed|failed|rejected|filed|ok|concerns">` → reuse the `STATUS_BADGE` map from `shared.jsx:30-39`. Returns the dotted badge.

TDD: each component renders the right class names + content for each variant.

Commit: `feat(console/ui): atomic primitives — Badge / Button / Card / StatusBadge`

### 4.2 Visualization primitives: Sparkline, PressureOrb, EventTypeChip, LaneChip

```yaml meta
id: "4.2"
files:
  - packages/console/src/ui/Sparkline.tsx
  - packages/console/src/ui/PressureOrb.tsx
  - packages/console/src/ui/EventTypeChip.tsx
  - packages/console/src/ui/LaneChip.tsx
  - packages/console/test/ui/visualizations.test.tsx
file_scope: new
depends_on: ["1.2"]
parallel_with: ["4.1"]
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

Port from `shared.jsx`:
- `<Sparkline seed color points height fillOpacity>` — deterministic from seed (lines 52-76).
- `<PressureOrb p={...}>` — radial-arc SVG with warn/refuse markers (lines 79-137). `p` typed from `@penumbra/api-contract` (`PressureWindowSnapshotSchema` — add to api-contract if missing as part of this task). Provider-label helper `providerLabel(name)` colocated.
- `<EventTypeChip type>` — color/label mapping for t0 event types (lines 162-189).
- `<LaneChip lane>` — cloud / cli-subscription / local color (lines 192-206).

TDD: render each variant; verify SVG arc lengths for PressureOrb match the formula at the boundaries (0%, 50%, 95%, 100%).

Commit: `feat(console/ui): Sparkline + PressureOrb + EventTypeChip + LaneChip primitives`

Integration: 4.1 ∥ 4.2. Both depend only on Phase 1 themes; no further wiring. Run `bun --cwd packages/console test` to verify both pass independently.

## Phase 5 — Mission Control module

Dispatch graph: 5.1 → 5.2 ∥ 5.3 ∥ 5.4 ∥ 5.5 → 5.6 → 5.7

### 5.1 Mission Control scaffold (header, layout, stat row)

```yaml meta
id: "5.1"
files:
  - packages/console/src/modules/mission/index.tsx
  - packages/console/src/modules/mission/StatRow.tsx
  - packages/console/src/modules/mission/store.ts
  - packages/console/test/modules/mission/scaffold.test.tsx
  - packages/console/src/router.tsx
file_scope: new
depends_on: ["3.5", "4.1", "4.2"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

Port the surface-head from `mission-control.jsx:36-54` (h1, lede, chips). Add the four-card stat row matching `mission-control.jsx:181-189`:
- "Concurrent dispatches": current vs cap from `usage` snapshot.
- "Resolved · session": from a session route (placeholder until session endpoint confirmed; show `—` if missing).
- "t0 events · last 5m": derived from `dispatch-events/stream` ring buffer length.
- "Synthetic spend · session": from `usage.subscription.synth_total`.

`store.ts` (module-local zustand) holds: `{ tailFilter: string | null; pausedTail: boolean }` — the t0 tail filter + pause toggle.

`router.tsx` updated: `/mission` now renders `<MissionControl/>` instead of the stub.

TDD: render module under `<MemoryRouter initialEntries={['/mission']}>`, mock daemon client + stream broker, assert four stat cards mount with the right labels.

Commit: `feat(console/modules/mission): scaffold + 4-card stat row`

### 5.2 Pending handoff list with approve/deny/defer mutations + rail badge

```yaml meta
id: "5.2"
files:
  - packages/console/src/modules/mission/PendingHandoffs.tsx
  - packages/console/src/shell/Rail.tsx
  - packages/console/test/modules/mission/pending-handoffs.test.tsx
file_scope: modify-existing
depends_on: ["5.1"]
parallel_with: ["5.3", "5.4", "5.5"]
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

Port `<PendingHandoffRow/>` from `mission-control.jsx:192-222`. Use TanStack Query: `useQuery({ queryKey: ['handoffs', 'pending'], queryFn: () => client.listHandoffs({ status: 'pending' }) })`. Subscribe via `useStream('handoffs-events')` and on each message call `queryClient.invalidateQueries(['handoffs', 'pending'])` — cheap, daemon's response is small, server is the source of truth.

Action buttons: `approve` calls `client.approveHandoff(id)`, `deny` opens an inline reason input (single-line) then `client.denyHandoff(id, reason)`, `defer` opens a duration picker (5m / 30m / 1h / custom) then `client.deferHandoff(id, untilSec)`. Optimistic update (mark the row "approving" until query revalidates).

Rail badge: `<Rail/>` reads the same query (`useQuery(['handoffs', 'pending'])`) and renders a count pip on the Mission rail item when the array is non-empty. Uses the existing `.pip.warn` class from `app.css`.

TDD: mount module with mocked client returning two pending handoffs; click approve on first; verify mutation called; verify cache invalidates; verify rail badge updates.

Commit: `feat(console/modules/mission): pending handoffs with approve/deny/defer + rail badge`

### 5.3 Pressure orb grid + titlebar pip (live)

```yaml meta
id: "5.3"
files:
  - packages/console/src/modules/mission/PressureGrid.tsx
  - packages/console/src/shell/Titlebar.tsx
  - packages/console/src/hooks/usePressureSnapshot.ts
  - packages/console/test/modules/mission/pressure.test.tsx
file_scope: modify-existing
depends_on: ["5.1"]
parallel_with: ["5.2", "5.4", "5.5"]
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

`usePressureSnapshot()` hook: TanStack Query `useQuery({ queryKey: ['usage'], queryFn: client.getUsage, refetchInterval: 5000 })`. Returns the windows array.

`<PressureGrid/>` renders the grid using `<PressureOrb/>` from 4.2. First 4 windows visible, rest behind a `<details>` per the mock. Empty state if no data.

`<Titlebar/>` updated: pull peak `used_pct` from `usePressureSnapshot()` and render the pip via the existing `.pressure-pip` markup (port from `app.jsx:376-386`).

TDD: pressure grid shows N orbs; pip color matches peak band (ok < 80, warn 80-95, crit ≥ 95).

Commit: `feat(console/modules/mission): pressure orb grid + titlebar pip wired to usage poll`

### 5.4 In-flight chain cards

```yaml meta
id: "5.4"
files:
  - packages/console/src/modules/mission/InFlightChains.tsx
  - packages/console/test/modules/mission/in-flight.test.tsx
file_scope: new
depends_on: ["5.1"]
parallel_with: ["5.2", "5.3", "5.5"]
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Port `<LiveChainCard/>` from `mission-control.jsx:224-256`. Fetch via `useQuery({ queryKey: ['chains', 'in-progress'], queryFn: () => client.listChains({ status: 'in-progress' }), refetchInterval: 5000 })`. Each card: status dot, hop count, title, conversation-id, lead agent, worktree marker, progress bar (gradient + glow per `mission-control.jsx:258-273`), elapsed/eta, status badge, `open ↗` button (no-op in P0; routes to `/chains/:id` in P1).

TDD: list renders, click `open ↗` is a no-op for now but doesn't error.

Commit: `feat(console/modules/mission): in-flight chain cards`

### 5.5 t0 event tail (virtualized, SSE)

```yaml meta
id: "5.5"
files:
  - packages/console/src/modules/mission/T0Tail.tsx
  - packages/console/test/modules/mission/t0-tail.test.tsx
file_scope: new
depends_on: ["5.1"]
parallel_with: ["5.2", "5.3", "5.4"]
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

Port `<T0Row/>` from `mission-control.jsx:275-286`. Uses `useStream('dispatch-events-stream')` from 2.3, mapped to `DispatchEventStreamMessageSchema` from api-contract. List virtualized via `@tanstack/react-virtual` (200-row buffer; item height ~24px; no fixed maxHeight on container — follows surface size).

Filter input + pause toggle wired to `mission/store.ts` from 5.1.

On `__reconnect__` synthetic, show a small "reconnected" toast in the card head and invalidate the chains+handoffs queries (events were missed during the gap).

TDD: feed mocked stream events through the broker; assert virtualized items render; assert filter narrows the list; assert pause stops appending.

Commit: `feat(console/modules/mission): virtualized t0 tail with filter + pause`

### 5.6 Recently-resolved chains panel

```yaml meta
id: "5.6"
files:
  - packages/console/src/modules/mission/RecentResolved.tsx
  - packages/console/test/modules/mission/recent-resolved.test.tsx
file_scope: new
depends_on: ["5.2", "5.3", "5.4", "5.5"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Port the panel from `mission-control.jsx:152-174` — last 4 resolved chains via `client.listChains({ resolved: true, limit: 4 })`. Static refresh interval 30 s. No row interaction in P0.

TDD: rows render; status dot color flips on `failed` vs `completed`.

Commit: `feat(console/modules/mission): recently-resolved chain list`

### 5.7 Mission Control compose + visual smoke

```yaml meta
id: "5.7"
files:
  - packages/console/src/modules/mission/index.tsx
  - packages/console/test/modules/mission/compose.test.tsx
file_scope: modify-existing
depends_on: ["5.6"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

Wire all six pieces into the module's `index.tsx` per the layout in `mission-control.jsx:34-178`:
- Surface head (5.1)
- Stat row (5.1)
- Two-column row: pending handoffs (5.2, ~1.6fr) | pressure (5.3, 1fr)
- In-flight chains section (5.4)
- Two-column row: t0 tail (5.5, ~1.4fr) | recently-resolved (5.6, 1fr)

TDD: full-mount smoke test — every section appears, queries fire, stream subscription opens. Manual run: `bun --cwd packages/console run dev` shows live data against the running daemon.

Commit: `feat(console/modules/mission): compose Mission Control surface`

Integration: 5.1 → fan-out (5.2 ∥ 5.3 ∥ 5.4 ∥ 5.5) → 5.6 → 5.7 strict. Per memory rule: do not run parallel sub-dispatches as fix loops; this fan-out is parallel **implementation** of independent panels, not iterative fixes. Each branch ships independently and lands FF onto main; the compose step (5.7) runs after all four are merged.

## Phase 6 — Launcher + e2e smoke + handoff polish

Dispatch graph: 6.1 → 6.2 → 6.3

### 6.1 `penumbra console` CLI subcommand

```yaml meta
id: "6.1"
files:
  - packages/cli/src/commands/console.ts
  - packages/cli/src/index.ts
  - packages/cli/test/commands/console.test.ts
file_scope: new
depends_on: ["5.7"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: bootstrap-touching
```

`packages/cli/src/commands/console.ts` exports a `consoleCommand(opts: { open?: boolean; port?: number; storageRoot?: string })`:
1. Read token from `${storageRoot ?? '~/.penumbra'}/token`. Throw a clear error if missing.
2. Read daemon port from `${storageRoot}/port`. Throw if missing.
3. Find the built console at `packages/console/dist/`. If absent, run `bun --cwd packages/console run build` first.
4. Read `index.html`. Inject the meta-tag content: replace `<meta name="penumbra-config" content="">` with `<meta name="penumbra-config" content='${escapedJsonString}'>`. Use HTML-escaping on the JSON string.
5. Start a static server on `opts.port ?? 0` (Bun.serve with file-system handler scoped to `packages/console/dist/`). Loopback only.
6. If `opts.open !== false`, open the browser to `http://127.0.0.1:${listenPort}`.
7. Print the URL to stdout. Run until Ctrl-C.

Wire `consoleCommand` into `packages/cli/src/index.ts`'s subcommand dispatcher. Flags: `--port`, `--no-open`.

TDD: a test that uses a temp storage root with token+port files; spins up the command in `--no-open` mode; asserts the served `index.html` contains the injected meta tag with token + url. Use `Bun.serve` in test or hit it via fetch.

Commit: `feat(cli/console): penumbra console subcommand with token+url meta injection`

### 6.2 Playwright e2e smoke

```yaml meta
id: "6.2"
files:
  - packages/console/playwright.config.ts
  - packages/console/e2e/mission-smoke.spec.ts
  - packages/console/package.json
file_scope: new
depends_on: ["6.1"]
parallel_with: []
preferred_agent: claude-acp-sonnet
fallback_agent: codex-acp-deep
task_size: substantial
risk_class: schema-aware
```

Add Playwright as a devDependency. `playwright.config.ts`: single chromium project, headless, trace on first retry.

`e2e/mission-smoke.spec.ts`:
1. Spin up a daemon test harness (use the same harness `packages/daemon/test/_helpers.ts` exports — if not directly importable from console, factor a small `packages/daemon-test-harness/` shim in this task).
2. Seed one pending handoff via the daemon's POST.
3. Boot the dev console (Vite dev server) with the harness's token+url env.
4. Navigate to `/mission`.
5. Assert the pending handoff appears in the UI (selector: `[data-testid="pending-handoff-row"]`).
6. Click `approve`.
7. Assert the row disappears within 5 s and the rail badge decrements to 0.

Add `e2e` script to `package.json`.

TDD: this IS the test. Failing first run should mean either the harness or the UI integration is broken; expected to pass on first non-zero attempt.

Commit: `feat(console/e2e): Playwright smoke for approve-pending-handoff round-trip`

### 6.3 CSP enforcement smoke + memory observation

```yaml meta
id: "6.3"
files:
  - packages/console/test/csp.test.ts
  - packages/console/index.html
  - docs/superpowers/notes/2026-05-08-penumbra-console-p0-handoff.md
file_scope: modify-existing
depends_on: ["6.2"]
parallel_with: []
preferred_agent: codex-acp-fast
fallback_agent: claude-acp-sonnet
task_size: small
risk_class: paste-ready
```

Verify `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:*; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none';">` is present in `index.html` and survives the build into `dist/index.html`. Test reads the built file and asserts the CSP string matches.

Memory observation (manual or via `mcp__penumbra__memory_observe`): record what shipped — the package layout, the bootstrap pattern, anything surprising. File a continuation note at `docs/superpowers/notes/2026-05-08-penumbra-console-p0-handoff.md` summarizing P0 outcomes for the next session.

Commit: `feat(console): CSP enforced in built index.html + P0 handoff note`

Integration: 6.1 → 6.2 → 6.3 strict order. After 6.3 the P0 acceptance criteria from the spec are met: an operator running `penumbra console` sees pending handoffs, approves one, watches the t0 tail update, sees the chain enter "in-flight" — all from the console with CSP enforced.

## Validator gate

After writing every phase: `penumbra plan validate docs/superpowers/plans/2026-05-08-penumbra-console.md`. Iterate until clean.

## Out of scope (P1+)

- Chains module (index + drill-down with swimlane / tree / gantt + send follow-up) — separate plan after P0.
- Tasks module (Kanban + GH bridge actions) — separate plan after P0.
- ⌘K palette — separate plan, comes with P1.
- Workflows / Reviews / Memory / Cost / Agents modules — gated future work.
- Tauri desktop wrap — gated future decision.
- Additional themes (scrubs / ember / clinical) — added on demand.
