# Phase 1c v2 — Operator-in-the-Loop Permission Flow

**Status:** design complete (2026-04-28). Awaits implementation plan.
**Supersedes parts of:** `2026-04-27-acp-evolution-roadmap.md` (Phase 1c body) and the v2 deferral section in `2026-04-28-acp-phase1c-permission-elicitation.md`.

## Goal

Replace the v1 "blanket reject under `chain_trust_mode='config'`" behavior with an operator-in-the-loop permission flow. Tools on a per-agent allowlist auto-approve; tools off the list pause the dispatch until an operator approves, rejects, or the TTL expires.

## Why this exists

Phase 1c v1 (shipped 2026-04-28) wired a trust-aware `requestPermission` callback through the worker into the stdio-acp adapter. Under `chain_trust_mode='all'` every tool auto-approves; under `'config'` every tool rejects. The `'config'` semantics make `'config'` mode unusable in practice — the agent reports "permission denied" for every tool call and the dispatch produces nothing useful.

v2 closes that gap. Under `'config'`:
- Tools on the agent's `allowed_tools` list auto-approve (low-friction operation).
- Tools off the list pause the dispatch and surface a `permission_request` row to the operator via the penumbra MCP surface.
- Operator approves, rejects (with optional reason), or lets the TTL expire (auto-reject).

This unblocks Phase 1d (write tools / sandbox), where untrusted-by-default-with-explicit-approval becomes the dominant path.

## Out of scope

- **Vendor-specific allowlist semantics for non-stdio-acp adapters.** `opencode-acp`, `claude-cli`, `codex-cli`, `gemini-cli` handle permissions internally — we receive the post-decision tool calls and have no protocol-level seam to gate them. v2 ships only for stdio-acp.
- **Persistent allowlist promotion from operator decisions** (e.g. `remember: 'forever'` writes to yaml). v2 supports `remember: 'this_call' | 'this_dispatch'` only. A separate `allowlist_promote` flow can be added later if real demand emerges.
- **Input-shape matchers** (e.g. `{tool: 'fs.readTextFile', path_glob: 'src/**'}`). v2 matches by tool name only; defer to a future phase.
- **A third trust mode** (`'strict'` etc.). The two-mode enum (`'all' | 'config'`) plus an empty allowlist gives "human-in-the-loop for everything" via `'config' + allowed_tools: []`.

---

## Architecture overview

```
┌─────────────────┐  session/request_permission  ┌──────────────────────┐
│  ACP agent      │  ───────────────────────────▶│  stdio-acp adapter   │
│  (claude-acp,   │                              │  (in worker)         │
│   gemini-acp,…) │  ◀───────────────────────────│                      │
└─────────────────┘     RequestPermissionResponse└──────────┬───────────┘
                                                            │
                                                            │ requestPermission(toolCall)
                                                            ▼
                                                ┌──────────────────────┐
                                                │ worker callback      │
                                                │ (trust + allowlist + │
                                                │  per-dispatch cache) │
                                                └──────────┬───────────┘
                                                           │ POST /permissions
                                                           │ (off-list under 'config')
                                                           ▼
                                                ┌──────────────────────┐
                                                │ daemon               │
                                                │  permission_requests │
                                                │  table + SSE         │
                                                │  + TTL sweeper       │
                                                └──┬─────────────┬─────┘
                                                   │             │
                                       SSE         │             │ POST /permissions/:id/decide
                                       (decision)  │             │ (mcp__penumbra__permission_approve)
                                                   │             ▼
                                                   │   ┌──────────────────────┐
                                                   │   │ operator (any        │
                                                   └──▶│ MCP-using session)   │
                                                       └──────────────────────┘
```

When the stdio-acp adapter receives `session/request_permission`:

1. **Trust-mode short-circuit.** `chain_trust_mode='all'` ⇒ approve immediately (no daemon round-trip). v1 behavior preserved.
2. **Allowlist match.** Under `'config'`, evaluate `tool_name` against the dispatch's effective allowlist (yaml `options.allowed_tools` ∪ per-dispatch in-memory cache). On match ⇒ approve.
3. **Daemon round-trip.** Off-list under `'config'`: `POST /permissions` to create a pending row. Worker subscribes once at boot to `GET /permissions/events` (SSE) and waits for `permission.decided` (or `permission.expired`) for this `permission_id`.
4. **ACP translation.** Approve ⇒ select first matching `allow_*` option; reject ⇒ select first matching `reject_*` option (else `cancelled`). If operator chose `remember: 'this_dispatch'`, the adapter caches the tool name in a `Set<string>` scoped to this dispatch so subsequent calls of the same tool short-circuit at step 2.

Decision logic stays in the worker callback. The adapter only handles ACP-protocol translation. The daemon owns persistence + SSE fan-out + TTL.

---

## Schema

New table in `packages/core/src/db/schema.ts`:

```sql
-- parent_handoff_id here is the dispatch this permission belongs to
-- (the handoff the worker is currently executing). Distinct from
-- handoffs.parent_handoff_id, which is chain.start lineage for recursion.
CREATE TABLE permission_requests (
  permission_id     TEXT PRIMARY KEY,
  parent_handoff_id TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  agent_name        TEXT NOT NULL,
  tool_name         TEXT NOT NULL,
  raw_input_json    TEXT NOT NULL,
  status            TEXT NOT NULL,        -- 'pending'|'approved'|'rejected'|'expired'
  remember_scope    TEXT,                 -- null|'this_call'|'this_dispatch'
  decision_reason   TEXT,
  decided_by        TEXT,
  ttl_at            TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  decided_at        TEXT,
  FOREIGN KEY (parent_handoff_id) REFERENCES handoffs(handoff_id)
);

CREATE INDEX idx_perm_status_conv ON permission_requests(status, conversation_id);
CREATE INDEX idx_perm_parent      ON permission_requests(parent_handoff_id);
CREATE INDEX idx_perm_ttl         ON permission_requests(status, ttl_at);
```

Lifecycle: `pending` → `approved` | `rejected` | `expired` (terminal; never re-transitions).

New file `packages/core/src/schemas/permission.ts`:

```ts
export const PermissionStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired']);

export const PermissionRequestRowSchema = z.object({
  permission_id: z.string(),
  parent_handoff_id: z.string(),
  conversation_id: z.string(),
  agent_name: z.string(),
  tool_name: z.string(),
  raw_input_json: z.string(),                       // pre-serialized JSON
  status: PermissionStatusSchema,
  remember_scope: z.enum(['this_call', 'this_dispatch']).nullable(),
  decision_reason: z.string().nullable(),
  decided_by: z.string().nullable(),
  ttl_at: z.string(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
});

export const CreatePermissionRequestSchema = z.object({
  permission_id: z.string().min(1),                 // client-supplied (worker uuid)
  parent_handoff_id: z.string().min(1),
  conversation_id: z.string().min(1),
  agent_name: z.string().min(1),
  tool_name: z.string().min(1),
  raw_input: z.unknown(),                           // serialized by writer
  ttl_seconds: z.number().int().positive().optional(),
});

export const ApprovePermissionRequestSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  remember: z.enum(['this_call', 'this_dispatch']).optional(),
  reason: z.string().optional(),
  resolved_by: z.string().min(1).optional(),
});
```

New file `packages/core/src/writers/permission.ts`:

```ts
export function permissionWriter(db: Database, services: { uuid: () => string; clock: () => Date; }) {
  return {
    create(input: CreatePermissionRequestInput): PermissionRequestRow { /* INSERT, return row */ },
    /** Atomic CAS: pending → terminal. Returns null if already terminal. */
    decide(permission_id: string, input: DecideInput): PermissionRequestRow | null { /* UPDATE WHERE status='pending' */ },
    /** Atomic CAS: pending → expired. Returns count of rows transitioned. */
    expirePastDue(now: string): number { /* UPDATE WHERE status='pending' AND ttl_at < now */ },
  };
}
```

New file `packages/core/src/readers/permission.ts`:

```ts
export function permissionReader(db: Database) {
  return {
    get(permission_id: string): PermissionRequestRow | null,
    listByStatus(opts: { statuses: PermissionStatus[]; conversation_id?: string; parent_handoff_id?: string }): PermissionRequestRow[],
  };
}
```

Both register on `Services` so daemon routes can consume them via the existing pattern.

---

## Daemon HTTP routes

New file `packages/daemon/src/routes/permissions.ts`. Four routes:

### `POST /permissions`

Worker creates a pending row. Body matches `CreatePermissionRequestSchema`; the worker generates `permission_id` client-side (uuid) and includes it in the body so it can register a waiter BEFORE the POST. The daemon writer is idempotent on `permission_id`: if the row already exists, return it unchanged (200, not 409) — this lets the worker safely retry on transport errors. `ttl_seconds` defaults to the `PENUMBRA_PERMISSION_TTL_S` env var (default 300). Per-agent yaml override is resolved at the worker before posting (the daemon doesn't know the agent yaml).

Response: `{permission_id, ttl_at, status: 'pending'}`.

Side effects:
- Schedules an in-process `setTimeout(ttl_seconds * 1000)` that CAS-transitions the row to `expired` and emits `permission.expired`.
- Emits `permission.created` SSE event with the full row.

### `GET /permissions/:id`

Worker uses this on SSE reconnect to resync state for a still-live waiter. Returns the full row or 404.

### `GET /permissions?status=...&conversation_id=...&parent_handoff_id=...`

Operator-facing query. Mirrors `handoffsListPendingRoute`'s param semantics. Default status filter when omitted: `pending` (matches handoff list-pending convention).

### `POST /permissions/:id/decide`

Operator's MCP tool POSTs here. Body matches `ApprovePermissionRequestSchema`. Atomic CAS pending → terminal via `permissionWriter.decide`. 

- Returns `{permission_id, status, decided_at}` on success.
- Returns 409 with `{error: {code: 'conflict', message: '...'}, current_status}` if already terminal.
- Returns 404 if `permission_id` doesn't exist.

Side effects on success:
- Emits `permission.decided` SSE event with payload `{permission_id, decision, remember, decided_by, decided_at, reason}`.
- Cancels the in-process TTL timer for this `permission_id`.
- Writes a `permission.decided` t0 event (audit trail).

### SSE channel `GET /permissions/events`

Per-spec server-sent events. Each event has an `id:` field set to `<permission_id>:<seq>` so clients can resume with `Last-Event-ID`. Daemon keeps an in-memory ring buffer of the last 256 events for replay.

Event types:
```
event: permission.created
id: <permission_id>:1
data: {"permission_id":"…","parent_handoff_id":"…","tool_name":"…","ttl_at":"…","created_at":"…"}

event: permission.decided
id: <permission_id>:2
data: {"permission_id":"…","decision":"approve","remember":"this_dispatch","decided_by":"…","decided_at":"…","reason":null}

event: permission.expired
id: <permission_id>:3
data: {"permission_id":"…","ttl_at":"…","expired_at":"…"}
```

All workers see all events; each filters by its own outstanding-id set.

### TTL sweeper

A daemon-level interval (every 30s) calls `permissionWriter.expirePastDue(now)` to catch any pending rows whose per-row `setTimeout` was lost (daemon restart). Idempotent because the per-row timer also CAS-transitions; whichever fires first wins, the other sees `null` from `decide`/`expirePastDue` and is a no-op.

**TTL boundary semantics**: a row whose `ttl_at == now` is treated as **expired** (writer uses `WHERE ... ttl_at <= ?` — deadline-reached = expired). Documented here so spec and writer agree.

---

## Worker-side changes

### `packages/agentchat/src/worker/permission-callback.ts` (extended)

The v1 factory grows a v2 form:

```ts
export interface PermissionCallbackOpts {
  trustMode: 'all' | 'config';
  allowedTools: string[];                      // resolved from agent yaml at dispatch start
  handoffId: string;
  conversationId: string;
  agentName: string;
  ttlSeconds: number;                          // resolved at dispatch start (env or yaml)
  daemonClient: PermissionDaemonClient;
  perDispatchAllowlist: Set<string>;           // mutable; populated by 'remember:this_dispatch'
}

export function createPermissionCallback(opts: PermissionCallbackOpts):
  (toolCall: ToolCallContext) => Promise<PermissionDecision>
```

Behavior:

1. `trustMode === 'all'` ⇒ `'approve'` immediately.
2. `matchAllowlist(opts.allowedTools, opts.perDispatchAllowlist, tool_name)` ⇒ `'approve'`.
3. Otherwise: `await opts.daemonClient.requestPermission({parent_handoff_id: opts.handoffId, conversation_id: opts.conversationId, agent_name: opts.agentName, tool_name, raw_input, ttl_seconds: opts.ttlSeconds})` returns a `PermissionDecisionResult` (delivered via SSE) or rejects on TTL/network error.
   - On Promise reject ⇒ `'reject'` (fail closed).
   - On `decision === 'approve'` with `remember === 'this_dispatch'` ⇒ `opts.perDispatchAllowlist.add(tool_name)` before returning.

### Allowlist matcher

```ts
function matchAllowlist(
  yamlList: string[],
  perDispatch: Set<string>,
  tool_name: string,
): boolean {
  if (perDispatch.has(tool_name)) return true;
  for (const pattern of yamlList) {
    const isGlob = /[*?[]/.test(pattern);
    if (isGlob ? picomatch(pattern)(tool_name) : pattern === tool_name) return true;
  }
  return false;
}
```

**Tool-name wire format gotcha (operators writing allowlists, take note):** the MCP protocol envelope is `mcp__<server>__<tool>` and dots in the tool name become **underscores** on the wire. A tool registered as `chain.list_agents` on the `penumbra` server arrives at the adapter as `mcp__penumbra__chain_list_agents` (not `mcp__penumbra__chain.list_agents`). Allowlists must use the underscore form for exact matches, or use a glob like `mcp__penumbra__*` to cover the whole server. This was caught in the Task 23 smoke (Smoke A initially produced a permission row instead of auto-approving because the yaml entry used the dot form).

`picomatch` is already a transitive dep via `fs-glob`. If it isn't a direct dep yet, add it to `packages/agentchat/package.json`.

### Daemon-client helper `PermissionDaemonClient`

In `packages/agentchat/src/worker/permission-daemon-client.ts` (new file):

```ts
export interface PermissionDecisionResult {
  decision: 'approve' | 'reject';
  remember: 'this_call' | 'this_dispatch' | null;
  reason: string | null;
}

export interface RequestPermissionInput {
  parent_handoff_id: string;
  conversation_id: string;
  agent_name: string;
  tool_name: string;
  raw_input: unknown;
  ttl_seconds: number;
}

export class PermissionDaemonClient {
  private waiters = new Map<string, { resolve: (d: PermissionDecisionResult) => void; reject: (e: Error) => void }>();
  private sse: EventSourceLike;

  constructor(opts: { storageRoot: string; log: Logger });

  // Subscribe to /permissions/events at construction. Auto-reconnect with backoff.
  // On reconnect with stale Last-Event-ID, iterate this.waiters and GET each
  // /permissions/:id to converge state.

  async requestPermission(input: RequestPermissionInput): Promise<PermissionDecisionResult> {
    // 1. Generate permission_id client-side (uuid). Register waiter Promise
    //    BEFORE the HTTP POST so an instant decision can't slip past us.
    // 2. POST /permissions with the pre-allocated permission_id.
    // 3. Await the waiter's resolution (Promise resolved by SSE handler).
    // 4. On TTL or transport failure, reject with a typed error; the worker
    //    callback maps reject → 'reject' (fail closed).
  }
}
```

The daemon's `POST /permissions` accepts the client-supplied `permission_id` and is idempotent on collision (returns the existing row, 200). This eliminates the registration race entirely.

### `packages/agentchat/bin/agentchat-worker.ts` wiring

Boot up:
- After `worktreeManager` construction, instantiate `permissionDaemonClient = new PermissionDaemonClient({storageRoot, log})`.
- Subscribe is automatic (constructor side effect).

Per-dispatch (inside the existing `dispatch:` callback):
- Resolve `allowedTools = config.agents[handoff.to_agent]?.options?.allowed_tools ?? []`.
- Resolve `ttlSeconds = config.agents[handoff.to_agent]?.options?.permission_ttl_s ?? Number(process.env.PENUMBRA_PERMISSION_TTL_S ?? 300)`.
- Construct `perDispatchAllowlist = new Set<string>()`.
- Pass these into `createPermissionCallback({...})` and forward as `requestPermission` to `dispatchHandoff`.

---

## Adapter changes

`packages/agentchat/src/adapters/stdio-acp.ts` — surgical:

1. **Tool-name extraction.** Today: `params?.toolCall?.title ?? params?.toolCall?.name ?? 'unknown'`. v2: same chain, but if both `title` and `name` are missing, the adapter returns `{outcome: {outcome: 'cancelled'}}` immediately and logs a warning — operator can't decide on `'unknown'`, allowlist can't match, the daemon row would be useless.
2. **Raw input passing.** Pass `params?.toolCall?.rawInput ?? params?.toolCall ?? null` as the `ToolCallContext.rawInput`. The worker callback forwards it to `permissionDaemonClient.requestPermission` so it persists in `raw_input_json`.
3. **Outcome mapping** stays as today (allow_always | allow_once | first match for approve; reject_always | reject_once | cancelled for reject).
4. **Backward-compat seatbelt.** The `if (!input.requestPermission)` auto-allow fallback at `stdio-acp.ts:95-107` stays — used by tests that bypass the worker. Production always passes a callback.

No changes to `opencode-acp.ts`, `claude-cli.ts`, `codex-cli.ts`, `gemini-cli.ts` — they handle permissions internally and don't expose a seam.

---

## MCP surface

Three new tools in `packages/mcp/src/tools/`. Schema follows the existing pattern (`InputShape` for zod + handler factory taking `daemon: DaemonClient`).

### `permission_list_pending`

`mcp__penumbra__permission_list_pending({conversation_id?, handoff_id?, status?})`

- Optional `conversation_id`: scope to a conversation.
- Optional `handoff_id`: scope to a single dispatch.
- Optional `status` (default `pending`): comma-separated list, mirrors `handoff_list_pending`.

Returns `{permissions: PermissionRequestRow[]}`.

### `permission_get`

`mcp__penumbra__permission_get({permission_id})`

Returns the full row. Operator inspects `tool_name` + `raw_input_json` (already-serialized JSON; client deserializes) before deciding.

### `permission_approve`

`mcp__penumbra__permission_approve({permission_id, decision, remember?, reason?})`

- `decision`: `'approve' | 'reject'`.
- `remember` (optional, default `'this_call'`): `'this_call' | 'this_dispatch'`.
- `reason` (optional): operator's free-text note.

Returns `{permission_id, status, decided_at}` on success. 409 conflict (with `current_status`) if already terminal. 404 if not found.

The naming `permission_*` is parallel to `handoff_*` — the two flows are distinct enough that polymorphic-id semantics on `handoff_approve` would create more confusion than it saves.

### Daemon client

`packages/mcp/src/daemon-client.ts` gains:

```ts
listPermissions(opts?: { status?: string; conversation_id?: string; parent_handoff_id?: string }): Promise<{permissions: PermissionRequestRow[]}>;
getPermission(permission_id: string): Promise<{permission: PermissionRequestRow}>;
approvePermission(permission_id: string, body: ApprovePermissionRequest): Promise<{permission_id: string; status: string; decided_at: string}>;
```

---

## Configuration

### `agentchat.yaml`

Per-agent (only the new keys shown):

```yaml
- name: claude-acp-sonnet
  options:
    mcpServers:
      - name: penumbra
        command: bun
        args: [packages/mcp/src/penumbra-mcp.ts]
    fsReadTextFile: true
    allowed_tools:
      - "mcp__penumbra__*"
      - "fs.readTextFile"
    permission_ttl_s: 600           # optional override of PENUMBRA_PERMISSION_TTL_S
```

Backward compat: agent yamls without `allowed_tools` get `[]` (under `'config'` mode every tool pauses for operator).

### Environment variables

- `PENUMBRA_PERMISSION_TTL_S` — default permission TTL in seconds. Default `300`. Per-agent yaml `permission_ttl_s` overrides.

---

## Audit trail

Each lifecycle transition writes a t0 event via the existing `t0Writer`. `EventTypeSchema` in `packages/core/src/schemas/event.ts` is a closed enum, so this design extends it with three new values (kebab-case to match existing convention):

| Event type | Source | Payload |
|---|---|---|
| `permission-requested` | daemon `POST /permissions` | `{permission_id, parent_handoff_id, agent_name, tool_name, raw_input}` |
| `permission-decided`   | daemon `POST /permissions/:id/decide` | `{permission_id, decision, remember, decided_by, reason}` |
| `permission-expired`   | daemon TTL timer or sweeper | `{permission_id, ttl_at}` |

The `EventTypeSchema` extension is a one-line zod change (additive — no migration of existing rows needed; the column is plain TEXT in sqlite). All three events flow into recall via the existing t0 pipeline. Operators can query "show me all permission requests in chain X" or "what tools has agent Y asked for in the last 24h" via `mcp__penumbra__memory_recall`.

`handoff_get` response gains a derived `pending_permissions_count` field for quick dispatch-state inspection.

---

## Error handling

| Failure | Behavior |
|---|---|
| Daemon HTTP 5xx during `POST /permissions` | Worker callback returns `'reject'` (fail closed). Logs warning with `handoff_id`. |
| SSE channel disconnect | Consumer auto-reconnects with exponential backoff (200ms → 30s cap). Outstanding waiters keep their Promises live. On stale `Last-Event-ID`, consumer iterates `this.waiters` and `GET /permissions/:id` for each to converge. |
| Daemon restart with in-flight perms | TTL sweeper catches any rows whose in-process timer was lost. Workers reconnect SSE and converge via per-id GET. |
| TTL fires on a row whose worker died | Sweeper transitions `pending → expired`. No reconciliation needed — orphaned waiter dies with the worker; the dispatch is already failed via the worker-crash path. |
| Operator approves a row whose worker has gone | `POST /permissions/:id/decide` succeeds (writes terminal row + emits SSE). The SSE event has no waiter; audit trail records the decision. |
| Race: SSE event before waiter registration | Impossible by construction — daemon-client registers the waiter BEFORE issuing `POST /permissions`. Daemon SSE `permission.decided` only fires after operator action, which can't precede creation. |
| Tool-name extraction fails (`title`/`name` both missing) | Adapter returns `{outcome: {outcome: 'cancelled'}}` immediately; no daemon row created. Logs warning. |
| Operator approves with `remember='this_dispatch'` after dispatch already ended | The cache is local to a dead callback; harmless no-op. Audit trail records decision. |

---

## Testing

### Unit (vitest)

- `createPermissionCallback`: trust-mode permutations, allowlist matching (exact + glob via picomatch), per-dispatch cache mutation when `remember='this_dispatch'`.
- `matchAllowlist`: edge cases — empty list, mixed exact + glob, character-class patterns, no false-positives across servers (e.g., `mcp__penumbra__*` doesn't match `mcp__sirius__chat`).
- `permissionWriter` / `permissionReader`: CAS atomicity (concurrent decide), `expirePastDue` idempotency (concurrent calls + TTL race against decide).
- `PermissionDaemonClient`: register-before-POST race correctness; SSE reconnect with stale `Last-Event-ID` triggers per-id GET; TTL/network rejection.

### Daemon route tests (vitest, daemon test harness)

- `POST /permissions` happy path + idempotency on client-supplied `permission_id`.
- `GET /permissions/:id` returns full row; 404 on unknown.
- `GET /permissions` filtering matrix.
- `POST /permissions/:id/decide` happy path; 409 on already-terminal; 404 on unknown.
- SSE `GET /permissions/events`: subscribe, `Last-Event-ID` replay from ring buffer, fall-off-the-buffer behavior.
- TTL sweeper: idempotent against concurrent decide.

### Adapter tests (`packages/agentchat/test/adapters/stdio-acp.test.ts`)

Extend the existing file:
- Per-dispatch cache short-circuits subsequent calls of the same tool (no duplicate callback invocation).
- Tool-name missing both `title` and `name` ⇒ local `cancelled` without callback invocation.

### Integration smoke (via `chain_start`)

All five against `claude-acp-sonnet` with a non-trivial allowed_tools list and `trust_mode: 'config'`:

- **A.** Tool on allowlist (`mcp__penumbra__chain.list_agents` matches `mcp__penumbra__*`) ⇒ auto-approve, dispatch completes with `AGENTS: 51`.
- **B.** Tool off allowlist (`mcp__sirius__sirius_chat`) ⇒ pending row appears in `permission_list_pending` ⇒ operator calls `permission_approve(decision='approve')` ⇒ dispatch resumes and completes.
- **C.** Off-list ⇒ operator calls `permission_approve(decision='reject', reason='no third-party calls')` ⇒ agent receives rejection, surfaces "permission denied", dispatch terminates cleanly.
- **D.** Off-list, no operator action ⇒ TTL fires (use `PENUMBRA_PERMISSION_TTL_S=10` for the smoke) ⇒ adapter receives `'reject'` ⇒ dispatch terminates with `expired` row in audit trail.
- **E.** Off-list, operator approves with `remember='this_dispatch'` ⇒ second invocation of same tool short-circuits (no new permission row created in daemon, verified via `permission_list_pending`).

---

## File touch summary

| Action | Path |
|---|---|
| Modify | `packages/core/src/db/schema.ts` (new table + indexes + migration entry) |
| Modify | `packages/core/src/schemas/event.ts` (extend `EventTypeSchema` with three `permission-*` types) |
| Create | `packages/core/src/schemas/permission.ts` |
| Create | `packages/core/src/writers/permission.ts` |
| Create | `packages/core/src/readers/permission.ts` |
| Modify | `packages/core/src/services.ts` (register writer + reader) |
| Create | `packages/daemon/src/routes/permissions.ts` |
| Create | `packages/daemon/src/sse/permissions-events.ts` (event emitter + ring buffer) |
| Modify | `packages/daemon/src/server.ts` (route registration, TTL sweeper start) |
| Create | `packages/agentchat/src/worker/permission-daemon-client.ts` |
| Modify | `packages/agentchat/src/worker/permission-callback.ts` (v2 form) |
| Modify | `packages/agentchat/bin/agentchat-worker.ts` (wire daemon client + per-dispatch resolution) |
| Modify | `packages/agentchat/src/adapters/stdio-acp.ts` (tool-name extraction guard) |
| Modify | `packages/agentchat/src/config/types.ts` (yaml `allowed_tools`, `permission_ttl_s`) |
| Create | `packages/mcp/src/tools/permission-list-pending.ts` |
| Create | `packages/mcp/src/tools/permission-get.ts` |
| Create | `packages/mcp/src/tools/permission-approve.ts` |
| Modify | `packages/mcp/src/daemon-client.ts` (three new methods) |
| Modify | `packages/mcp/src/server.ts` (register three new tools) |
| Create | tests per the Testing section above |

---

## Estimated effort

Rough breakdown (each row maps to a task in the implementation plan):

- Schema + writer + reader + zod types + migration: 0.5 day
- Daemon routes + SSE channel + TTL sweeper + tests: 1 day
- `PermissionDaemonClient` (worker-side SSE consumer + waiter registration) + tests: 0.5 day
- `createPermissionCallback` v2 form + allowlist matcher + tests: 0.25 day
- `agentchat-worker.ts` wiring + yaml/env resolution: 0.25 day
- stdio-acp adapter guard + tests: 0.25 day
- Three MCP tools + daemon-client methods + tests: 0.5 day
- Integration smoke (5 scenarios via `chain_start`): 0.5 day

Total: ~4 days implementer scope, plus 0.5 day maestro smoke + ledger entries.

---

## Phase 1d implications

This v2 design is the **gating contract for Phase 1d** (write tools / sandbox via `terminal/*`). The Phase 1d plan can assume:

- Every sensitive tool call (write, edit, bash) flows through the permission flow.
- Operators can pre-approve common patterns via `allowed_tools` (e.g., `terminal.run` for an autonomous-coding agent).
- Off-list ops always require explicit approval — the sandbox boundary is enforced at the permission layer, not at the worktree boundary alone.

Phase 1d should NOT introduce its own permission shortcut. It builds on this surface.
