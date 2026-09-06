# Console integration plan — wiring the module set into the existing console

Companion to `console-ui-plan.md` (which defines *what* the 13 modules expose).
This document analyses the current `packages/console` architecture and defines
*how* the modules plug in without forking the existing patterns.

## 1. Current architecture (as of main, 75 files / 6,929 lines)

| layer | what exists | verdict for 13 modules |
|---|---|---|
| Shell | `Shell.tsx` = `Titlebar` / `Rail` + `Explorer` + `<Outlet/>` / `Statusbar`; grid `56px 224px 1fr` (`themes/app.css`) | Keep. Layout scales; chrome content does not (see below). |
| Module registry | `modules/manifest.ts` `MODULES: ModuleSpec[] {id,path,label,icon,available}` | Extend. `available` is declared but never read by router or rail. |
| Router | `router.tsx` `moduleElement()` / `moduleRoutes()` hard-code `mission`, `sessions`, `registrar` (nested `:registrarId`); all others → `DeferredViewStub` | Replace with manifest-driven routing. |
| Explorer | `Explorer.tsx` renders project card + mission-only sidebar (`pathname === "/mission"`); rows have empty `onClick` | Replace with per-module explorer slot. |
| Rail | `Rail.tsx` renders every manifest entry; pending pip only for `mission`; settings button inert | Make badge and visibility manifest-driven. |
| Statusbar / Titlebar | health dot + pressure live; branch, dispatched/resolved, t0 count, host, version, `Cmd-K`, reload-config, docs all hard-coded or inert | Wire to queries/actions in P0. |
| API client | `DaemonClient` class, 14 methods, private `request<S extends z.ZodType>` with zod `safeParse` → `DaemonContractError`, non-2xx → `DaemonHttpError`; bearer in dev, `/api` + cookie via `penumbra console` launcher in prod | Keep pattern; split into per-domain client files. |
| SSE | `event-source-shim.ts` (fetch-based, auth header, idle watchdog) + `streams.ts` ref-counted broker; `TOPIC_PATHS` has one topic `dispatch-events` | Keep; add topics. |
| Query | TanStack Query, `staleTime 5s`, `retry 1`; `lib/query-keys.ts` registry; `HEARTBEAT_MS` 5s / `COOL_POLL_MS` 30s | Keep; extend key registry per module. |
| State | `daemon-store` (baseUrl/token/health), `ui-store` (activeModule, explorerCollapsed — collapse unused, persisted `penumbra-ui`), `mission/store` | Keep; add `operatorOverride` + palette state. |
| Mutations | ad-hoc: `PendingHandoffs` calls `client.approveHandoff` and invalidates one key; local `busy/error` state per row | Replace with `useDaemonAction`. |
| Primitives | `Badge, Button, Card/CardHead, EventTypeChip, PressureOrb, Sparkline, StatCard, StatusBadge` | Add form/table/dialog/toast/menu primitives. |
| Contracts | `@penumbra/api-contract` zod schemas for chains, handoffs, registrar, sessions, drafts, tasks (dormant), usage; console keeps local loose schemas for health/workspace/approve/envelopes | Move all wire shapes to api-contract; console keeps zero local schemas. |
| Tests | Bun + Testing Library (happy-dom), 41 test files; Playwright e2e on :5176; Storybook + visual snapshots | Keep; every module ships the same trio. |
| Serving | `penumbra console` (`packages/cli/src/commands/console.ts`) serves `dist` and proxies `/api/*` with cookie auth + server-side bearer | Unchanged; SSE passes through the same proxy. |

Known debt to clear before scaling: N+1 detail queries in `RegistrarList`,
`PendingDraft` prints a CLI command instead of calling
`SessionNoteApproveRequestSchema`, `TODO: needs daemon-side defer route` in
`PendingHandoffs.tsx`, inline styles in module components, duplicated tokens
between `tokens.css` and `colors_and_type.css`.

## 2. Target architecture

### 2.1 Module contract

Replace the flat `ModuleSpec` with a module definition that owns its routes,
explorer, badge, palette commands and client slice. `manifest.ts` keeps only
static metadata (id/path/label/icon/order) so the rail/tests stay cheap; the
runtime definition lives in each module's `index.tsx`.

```ts
// modules/module.ts
export interface ModuleDefinition {
  readonly meta: ModuleSpec;                           // from manifest.ts
  readonly routes: RouteObject[];                      // relative to meta.path
  readonly Explorer?: React.ComponentType;             // secondary pane content
  readonly useBadge?: () => number | null;             // rail pip count
  readonly commands?: (ctx: CommandContext) => PaletteCommand[];
  readonly queryKeys: Record<string, (...a: never[]) => QueryKey>;
}

// modules/registry.ts
export const MODULE_DEFS: readonly ModuleDefinition[] = [
  mission, chains, handoffs, tasks, plans, approvals, sessions,
  memory, dreaming, agents, workflows, workspace, ops,
];
```

`router.tsx` becomes fully generic:

```ts
children: [
  { index: true, element: <Navigate to={first.meta.path} replace /> },
  ...MODULE_DEFS.filter(m => m.meta.available).map(m => ({
    path: m.meta.id,
    element: <ModuleBoundary module={m} />,   // sets activeModule, error boundary
    children: m.routes,
  })),
  { path: "*", element: <NotFound /> },
]
```

`Rail` filters `available`, reads `useBadge` per module; `Explorer` looks up
`activeModule` in `MODULE_DEFS` and renders its `Explorer` (falling back to the
project card). `ui-store.activeModule` is set by `ModuleBoundary` from the route
instead of from the rail click, so deep links work.

Each module lives at `modules/<id>/`:

```
index.tsx        ModuleDefinition export
routes/          route components (List.tsx, Detail.tsx, …)
components/      module-specific presentational components + stories
explorer.tsx     Explorer content
api.ts           client slice (see 2.2)
hooks.ts         useXxxQuery / useXxxAction wrappers
keys.ts          query keys, re-exported into lib/query-keys.ts
store.ts         optional zustand slice (persist only UI prefs)
```

### 2.2 API client split

`api/client.ts` (315 lines) cannot absorb ~130 more methods under the 700-line
cap. Keep `DaemonClient` as the transport (`request()`, headers, errors) and
compose domain slices:

```ts
// api/transport.ts   — today's request()/buildHeaders/errors, no endpoints
export class DaemonTransport { request<S extends z.ZodType>(opts: RequestOpts<S>) }

// api/domains/handoffs.ts
export const handoffsApi = (t: DaemonTransport) => ({
  list: (q?: HandoffsListQuery) => t.request({ path: "/handoffs", query: q, schema: HandoffsListResponseSchema }),
  approve: (id: string, body: ApproveHandoffRequest) => t.request({ method: "POST", path: `/handoffs/${enc(id)}/approve`, body, schema: ApproveHandoffResponseSchema }),
  …
});

// api/client.ts
export class DaemonClient {
  readonly handoffs = handoffsApi(this.t); readonly chains = chainsApi(this.t); …
}
```

Rules: one file per daemon route file (`routes/handoffs.ts` ↔
`api/domains/handoffs.ts`); every method names a schema imported from
`@penumbra/api-contract`; console-local schemas (`HealthResponseSchema`,
`WorkspaceSchema`, approve envelope, registrar/session event envelopes) move to
api-contract in P0. Query params keep the daemon's snake_case at the boundary
(as `listChains` already does with `project_id`).

Error handling upgrade: `request()` parses non-2xx bodies with
`ErrorEnvelopeSchema` (already exported by api-contract) so `DaemonHttpError`
carries `code` for the action framework's toasts, falling back to `bodyText`.

### 2.3 Streams

Extend `TOPIC_PATHS`:

```ts
"dispatch-events": "/dispatch/events/stream",
"handoff-events":  "/handoffs/events",
"task-events":     "/tasks/events",
"permission-events": "/permissions/events",
"conversation":    (p) => `/conversations/${p.id}/stream`,
"long-lived":      (p) => `/long-lived/${p.id}/stream`,
```

The broker key already includes sorted params, so per-id topics reuse the
ref-counting as-is. Add `useLiveQuery(queryKey, topic, {params, patch?})`: a
hook that subscribes via `useStream({bufferSize: 0})` and either invalidates
the key or applies `patch(old, msg)` for append-only lists (chain transcript,
ticks). Reconnect (`__reconnect__`) always invalidates. This formalises what
`T0Tail` does by hand today.

### 2.4 Action framework

```ts
type ActionTier = "safe" | "guarded" | "destructive";
function useDaemonAction<TArgs, TResult>(spec: {
  tier: ActionTier;
  label: string;
  run: (client: DaemonClient, args: TArgs, ctx: { reason?: string }) => Promise<TResult>;
  invalidate: (args: TArgs) => QueryKey[];
  confirm?: { title: string; body?: (args: TArgs) => ReactNode; typedTarget?: (args: TArgs) => string };
  requiresOverride?: boolean;      // gated by ui-store.operatorOverride
}): { execute(args: TArgs): Promise<void>; isPending: boolean };
```

Behaviour: `safe` executes immediately; `guarded` opens `ConfirmDialog` with a
required reason field; `destructive` additionally requires typing
`typedTarget`; `requiresOverride` renders disabled with a tooltip until the
operator enables override in Titlebar settings. Success/failure emit through a
`ToastProvider` mounted in `Shell`. This replaces the per-row `busy/error`
state in `PendingHandoffs` and unblocks `PendingDraft` approval.

### 2.5 Primitives to add (`src/ui`)

`ConfirmDialog`, `Toast/ToastProvider`, `Drawer` (new-chain, run-workflow,
create-task forms), `DataTable` (column defs, sort, cursor pagination via
`useCursorQuery`, virtualised with the existing `@tanstack/react-virtual`),
`Field/Input/Select/Textarea`, `Tabs`, `Menu`, `JsonEditor` (zod-validated),
`EntityLink` (id → module route), `ReliabilityChip`, `EmptyState`,
`SectionHeader`. Each gets a story and an atoms test; module components stop
using inline styles and use `app.css` classes or component-scoped CSS modules.

### 2.6 Shell chrome

- `Statusbar`: branch from `/workspace`, dispatched/resolved from
  `chains` counts already fetched by mission, t0 count from the broker ring
  size, version from `import.meta.env` (build-time from package.json), drop
  hard-coded host.
- `Titlebar`: `Cmd-K` opens `CommandPalette` (commands aggregated from
  `MODULE_DEFS[].commands`); reload-config runs a `guarded` action on
  `POST /agentchat/reload`; docs opens `/docs`; breadcrumb from route matches.
- `Rail`: badge for `approvals` = sum of inbox queues; keep `mission` pip.
- `ui-store`: add `operatorOverride: boolean`, `paletteOpen`, wire
  `explorerCollapsed` to a toggle.

## 3. Migration sequence

P0 is prerequisite refactoring; it lands with zero user-visible change except
the fixed shell chrome. Each step is one PR.

| # | change | touches | tests |
|---|---|---|---|
| P0.1 | `DaemonTransport` extraction; move local schemas to api-contract; `ErrorEnvelope` parsing | `api/*`, `api-contract` | existing `test/api/*` unchanged + envelope test |
| P0.2 | `ModuleDefinition` + registry; generic router; `ModuleBoundary`; rail/explorer read registry; migrate mission/registrar/sessions to definitions | `router.tsx`, `shell/*`, `modules/*/index.tsx` | `test/modules/manifest`, `test/shell/*` updated; deep-link e2e |
| P0.3 | `ToastProvider`, `ConfirmDialog`, `useDaemonAction`; port `PendingHandoffs` approve/deny and `PendingDraft` approve to it | `ui/*`, `mission`, `sessions` | atoms tests, pending-handoffs/pending-draft tests |
| P0.4 | `useLiveQuery`, new `TOPIC_PATHS`; port `T0Tail` reconnect invalidation | `api/streams.ts`, `hooks/` | `test/api/streams`, `test/hooks/useStream` |
| P0.5 | `DataTable`, `useCursorQuery`, `Drawer`, form fields, `EntityLink`; fix `RegistrarList` N+1 (needs `/registrar` list to return rollup — daemon change, or one batched detail query) | `ui/*`, `registrar` | atoms + registrar list tests |
| P0.6 | Statusbar/Titlebar wiring, `operatorOverride`, `CommandPalette` skeleton | `shell/*`, `ui-store` | shell tests |
| P1–P3 | modules per `console-ui-plan.md` §5, each as `modules/<id>/` following the template; one PR per module (handoffs and chains may share a PR) | | list/detail/action tests + stories + one e2e spec per module |

Definition of done per module PR: `ModuleDefinition` registered with
`available: true`; every route in its ui-plan table has a client method,
a query key, and a view or action; stories for new components; Bun tests for
list/detail/action paths; e2e spec `e2e/<id>-panels.spec.ts`; no inline styles;
file sizes under cap.

## 4. Daemon-side prerequisites surfaced by the analysis

- `GET /registrar` should include the rollup the list currently derives via
  N+1 detail calls.
- Defer route for handoffs (existing TODO in `PendingHandoffs.tsx`).
- The §6 routes in `console-ui-plan.md` (cron status, workers, outbox, config,
  plan validate, warm pool, cross-agent pending actions, lease history, dream
  cycles).
- Confirm the `penumbra console` proxy streams SSE without buffering (it
  proxies `/api/*` via fetch; verify `text/event-stream` bodies are piped, not
  awaited) — required before any new topic is relied upon in prod.

## 5. Risks

- **Route coverage drift**: mitigated by the `console-route-coverage` script
  (ui-plan §7) which now also checks each `api/domains/*.ts` maps to a daemon
  route file.
- **Bundle growth**: 13 modules with tables/editors; use `React.lazy` per
  `ModuleDefinition.routes` element and keep vendor chunks split in
  `vite.config.ts`.
- **Polling load**: 5s `refetchInterval` × many lists; prefer `useLiveQuery`
  where a stream exists and `COOL_POLL_MS` elsewhere; only the active module's
  queries should poll (`refetchInterval` gated on `activeModule`).
- **Destructive surfaces** (fs write/exec, shell, lease override): gated by
  `operatorOverride`, typed confirmation, and the launcher's same-origin check
  for mutating methods.
