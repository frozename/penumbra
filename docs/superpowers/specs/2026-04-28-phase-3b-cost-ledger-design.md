# Phase 3b — Cost Ledger + Quota-Aware Routing (Design)

**Status:** design proposed 2026-04-28
**Predecessor:** Phase 3a (dispatch t0 capture) — shipped 2026-04-28; Phase 1d.2 (stdio-acp yaml caps + parser hardening) — shipped 2026-04-28.
**Trigger:** Handoff backlog item from `docs/superpowers/notes/2026-04-30-session-handoff.md` § "Suggested first move" → option A; user-driven expansion to include quota-aware routing inputs and authoritative per-CLI usage readers.

## 1. Summary

Capture token consumption and cost across the agent fleet via two parallel ingest paths — ACP wire `usage_update` notifications (passive) and per-CLI local-state readers (active polling) — both landing as `usage-update` rows in t0_events. Add MCP tools `cost.recent` and `cost.quota_status` (plus parallel CLI commands) that aggregate the ledger and surface "remaining quota" per provider so the maestro can make routing decisions before dispatching to high-cost agents.

The local-state readers solve a real gap exposed during Phase 1d.2 verification: `gemini-acp-pro` default model doesn't emit `usage_update`, and `codex-acp-zed`'s ACP wrapper doesn't translate its internal reasoning/usage events to ACP `usage_update` at all. Reading codex's `~/.codex/state_5.sqlite threads.tokens_used` and Claude Code's `~/.claude/projects/<project>/<sessionId>.jsonl` per-message `usage` blocks gives authoritative cumulative usage even when ACP wire data is silent. This is the same approach OpenIsland uses.

The phase ships in roughly 5 days, foundational for Phase 3d (agent-performance ledger codification) which uses cost-per-agent as a routing-decision input.

## 2. Motivation

Phase 3a proved t0-capture-via-CapturePort works for content events. Cost is the next observable signal that ACP wraps in `session/update`, but our Phase 1d.2 audit revealed the wire data is uneven across the fleet:

- `claude-acp-sonnet`: emits `usage_update` reliably with `cost: {amount, currency}`. Best wire-side coverage.
- `gemini-acp-pro`: default model doesn't emit `usage_update` for typical prompts (verified empirically over 4 dispatches). The wire path exists in gemini-cli but is gated on conditions our default config doesn't trigger.
- `codex-acp-zed`: the precompiled Rust binary contains no `agent_thought_chunk` strings and we observed no `usage_update` either. ACP wrapper level limitation.
- `oc-acp-deepseek-v4-pro`: ACP-wire emission unverified; treated as "wire only, observe what comes."

That coverage gap matters because the user already runs manual quota management for Anthropic ("Anthropic quota conserved by deprioritizing claude-acp-sonnet for review"). Without authoritative usage data, the deprioritization is intuition — the maestro can't actually answer "how close am I to the Anthropic budget?" or "is gemini cheaper than codex right now?".

The two-path ingest (ACP wire + local-state) closes the gap: every dispatched turn produces a `usage-update` row regardless of which side the data came from, and `cost.quota_status` becomes a real tool that informs routing.

## 3. Locked design decisions

These were resolved during brainstorming on 2026-04-28; rationale included for each.

| ID | Decision | Rationale |
|----|----------|-----------|
| D1 | New event_type `'usage-update'` rather than augmenting existing `agent-response` rows | Separation of concerns; full snapshot fidelity; aligns with Phase 1d/3a audit-emission pattern. |
| D2 | Store snapshots as-is (cumulative `used` and `cost.amount`) rather than computing deltas at write time | "Dumb capture, smart query." Aggregation does `max-per-handoff, then SUM` in SQL. |
| D3 | `cost.recent` returns totals plus `by_provider` breakdown only — not `by_agent`/`by_dispatch` in v1 | YAGNI; once data is flowing, adding breakdowns is a small query change. |
| D4 | `cost.quota_status` is a maestro-consumed read-only tool; no auto-routing or daemon-side enforcement | Penumbra exposes data; maestro reads and judges. Same pattern as `memory.recall` / `chain.start`. |
| D5 | Skip rows with non-USD currency (warn log, set `cost_usd=null`, retain raw cost in payload_json) | Forward-compat: future fx migration can backfill. No fx work in this phase. |
| D6 | Skip notifications missing `used` (warn-log once per session, drop) | Not a meaningful snapshot. |
| D7 | tokens_in / tokens_out columns stay null for usage-update rows; `used` lives in payload_json | ACP wire payload doesn't expose the in/out split. Local readers DO have the split (Claude JSONL especially); they store input/output in payload_json sub-fields rather than the t0 columns to keep schema semantics consistent. |
| D8 | No new daemon HTTP route — `cost.recent` and `cost.quota_status` live at the MCP layer only | Same pattern as `memory.recall`. |
| D9 | Ship the CLI surface (`penumbra cost recent`, `penumbra cost quota`) in this phase | Cheap; mirrors Phase 3a's `penumbra recall` parallel surface. |
| D10 | Two-path ingest: ACP wire (CapturePort) AND local-state readers (polling) | Coverage. ACP wire emits unevenly; local readers are authoritative. Both paths land in the same `usage-update` event_type with a `source_kind` discriminator in payload_json. |
| D11 | Local readers: codex (sqlite) + claude (JSONL) + **opencode (sqlite)**; gemini left on ACP wire only | Codex has clean sqlite source. Claude has structured JSONL with full usage blocks. **OpenCode has the richest source: `~/.local/share/opencode/opencode.db message.data` JSON contains `cost` (USD), `tokens.{input,output,reasoning,cache}`, `modelID`, `providerID` per message — all the data we need in one place.** Gemini has no persistent local file (verified — `~/.gemini/` has no usage tracking; gemini-cli holds usage in process memory only); deferred until a vendor change makes it possible. |
| D12 | Quota config lives in `~/.config/agentchat/agentchat.yaml` under a new top-level `providers:` block | Reuses existing operator-config infrastructure; matches the agent yaml pattern. |
| D13 | Quotas can be `quota_usd_per_24h` OR `quota_tokens_per_24h` (per-provider choice) | Cost-only quotas don't work for codex (no cost data from local sqlite) or claude JSONL pre-pricing-table. Token quotas cover the case where we know tokens but not cost. |
| D14 | Window for "current usage" = rolling 24h ending at "now" | Matches "what have I burned recently" intuition; daily-reset has midnight cliffs that mislead. |
| D15 | When config has no quota set for a provider, omit from `cost.quota_status` response (don't show with `null`) | Cleaner response shape; user opts in per-provider. Providers without configured quotas are silent. |
| D16 | Local-state readers run on a periodic timer in the worker (not in the daemon, not on-demand from the MCP tool) | Polling close to the data; isolated failure surface. On-demand reads would add latency to `cost.quota_status`. Timer interval default 60s, configurable. |
| D17 | Local-state readers persist a `lastSeen` cursor per source (per-CLI-state-file) so they emit deltas, not duplicates | Idempotency. Cursors stored in penumbra storage_root (`local-state-cursors.json` or similar). |

## 4. Architecture

```
┌─────────────────────────── ACP wire path (passive) ────────────────────────────┐
│                                                                                │
│  ACP agent emits session/update.usage_update                                   │
│      └─> stdio-acp.ts session/update switch                                    │
│          └─> case 'usage_update':                                              │
│                capturePort.emit({kind:'usage_update', used, size, cost?})      │
│                                                                                │
│  CapturePort.handleUsageUpdate(ev)                                             │
│      └─> immediate dispatch, no buffering                                      │
│          └─> usage-update t0 row, source_kind='acp-wire'                       │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────── Local-state path (active poll) ─────────────────────────┐
│                                                                                │
│  Worker runs LocalStatePoller every 60s                                        │
│      └─> for each registered UsageReader:                                      │
│           - Read cursor from local-state-cursors.json                          │
│           - Query backing source (sqlite / JSONL)                              │
│           - Compute delta from cursor                                          │
│           - Emit one usage-update t0 row per (provider, model) bucket          │
│           - Persist new cursor                                                 │
│                                                                                │
│  Readers:                                                                      │
│   - CodexStateReader  -> ~/.codex/state_5.sqlite (threads.tokens_used)         │
│   - OpenCodeDbReader  -> ~/.local/share/opencode/opencode.db (message.data)    │
│   - ClaudeJsonlReader -> ~/.claude/projects/*/*.jsonl (message.usage rows)     │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘

Both paths converge on:
  t0_events row with event_type='usage-update', payload_json.source_kind in
  {'acp-wire','local-state-codex','local-state-claude'}.

┌──────────────────── Read path (cost.recent / cost.quota_status) ──────────────┐
│                                                                                │
│  cost.recent({since?, project_id?}) MCP tool                                   │
│      └─> readers/cost.ts recentCost()                                          │
│          - per_handoff CTE: max(cost_usd) and max(used) per (handoff, provider)│
│          - SUM totals; group by provider                                       │
│          - Return {total_cost_usd, total_tokens_used, count, by_provider, ...} │
│                                                                                │
│  cost.quota_status({since?}) MCP tool                                          │
│      └─> 1. recentCost() over the last 24h window                              │
│          2. Load providers config from agentchat.yaml                          │
│          3. Compute remaining_usd / remaining_tokens / remaining_pct           │
│          4. Filter: providers without quotas omitted                           │
│          5. Return {window, providers: [{provider, used, quota, remaining_*}]} │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

## 5. Components

### 5.1 `packages/core/src/schemas/event.ts` — add event_type

Add `'usage-update'` to `EventTypeSchema`:

```ts
export const EventTypeSchema = z.enum([
  'agent-prompt', 'agent-tool-use', 'agent-response', 'agent-thought', 'agent-handoff',
  'usage-update',
  'user-prompt', 'request', 'response', 'chain-terminated',
  'permission-requested', 'permission-decided', 'permission-expired',
  'fs.write_applied', 'fs.edit_applied',
  'terminal.spawned', 'terminal.exited', 'terminal.killed',
]);
```

### 5.2 `packages/agentchat/src/worker/capture-port.ts` — usage_update kind

Extend `NotificationEvent`:

```ts
| { kind: 'usage_update'; used: number; size: number; cost?: { amount: number; currency: string } }
```

In `emit()`, route to `handleUsageUpdate(ev)`. Stateless — no buffering, no Map.

```ts
private handleUsageUpdate(ev: Extract<NotificationEvent, {kind:'usage_update'}>): void {
  if (typeof ev.used !== 'number' || !Number.isFinite(ev.used)) {
    if (!this.usageWarnedMissing) {
      console.error('capture-port: usage_update missing/invalid `used`, dropping');
      this.usageWarnedMissing = true;
    }
    return;
  }
  const event = this.buildBaseEvent('usage-update', Date.now());
  let cost_usd: number | null = null;
  if (ev.cost) {
    if (ev.cost.currency === 'USD') {
      cost_usd = ev.cost.amount;
    } else {
      console.error(`capture-port: usage_update cost ${ev.cost.currency} not converted (skipped)`);
    }
  }
  event.cost_usd = cost_usd;
  event.payload_json = {
    handoff_id: this.opts.handoffId,
    used: ev.used,
    size: ev.size,
    currency: ev.cost?.currency ?? null,
    raw_cost: ev.cost ?? null,
    source_kind: 'acp-wire',
  };
  event.payload_summary = ev.cost
    ? `${ev.used}/${ev.size} tokens, ${ev.cost.amount} ${ev.cost.currency}`.slice(0, 240)
    : `${ev.used}/${ev.size} tokens`.slice(0, 240);
  this.dispatch(event);
}
```

### 5.3 `packages/agentchat/src/adapters/stdio-acp.ts` — wire the kind

In the existing session/update switch (around lines 327-401), add:

```ts
case 'usage_update': {
  const used = typeof update.used === 'number' ? update.used : NaN;
  const size = typeof update.size === 'number' ? update.size : NaN;
  if (!Number.isFinite(used) || !Number.isFinite(size)) break;
  this.opts.capturePort?.emit({
    kind: 'usage_update',
    used,
    size,
    cost: update.cost,
  });
  break;
}
```

Update the existing `// ignore: ...` comment to remove `usage_update`.

### 5.4 `packages/agentchat/src/adapters/opencode-acp.ts` — same wiring

opencode-acp's session/update plumbing differs. During implementation, audit whether OpenCode emits `usage_update` on its session/update channel; if so, add a parallel emit path. If OpenCode uses a different update kind (e.g., `metering.update`), map at the adapter boundary into the same CapturePort kind.

### 5.5 `packages/agentchat/src/usage-readers/index.ts` (NEW) — reader interface

```ts
export interface UsageReaderResult {
  /** Stable identifier for this poll's cursor (e.g. last sqlite row id, last JSONL byte offset). */
  cursor: unknown;
  /** Aggregated deltas to emit, one event per (provider, model) bucket. */
  deltas: Array<{
    provider: string;
    model: string | null;
    tokens_input: number;
    tokens_output: number;
    tokens_cache_read?: number;
    tokens_cache_write?: number;
    cost_usd: number | null;
    /** Time range covered by this delta. */
    window_start: string; // ISO8601
    window_end: string;
    /** Optional handoff_id if the local source can attribute the activity to a dispatch. */
    handoff_id?: string | null;
  }>;
}

export interface UsageReader {
  /** Stable name used as the cursor key and source_kind suffix. */
  readonly id: string;
  /** Read backing state from `previous_cursor` to "now"; return new cursor + deltas. */
  read(previous_cursor: unknown | null): Promise<UsageReaderResult>;
}
```

### 5.6 `packages/agentchat/src/usage-readers/codex-state-reader.ts` (NEW)

```ts
// Schema reminder (verified 2026-04-28):
// CREATE TABLE threads (id TEXT PRIMARY KEY, ..., tokens_used INTEGER NOT NULL DEFAULT 0,
//                       updated_at INTEGER NOT NULL, model_provider TEXT NOT NULL, model TEXT, ...)
//
// Cursor shape: { last_seen_updated_at: number /* unix-seconds */ }
```

Polls `~/.codex/state_5.sqlite` (path resolvable via `${process.env.HOME}/.codex/state_5.sqlite`; configurable via env).

Algorithm:
1. Read cursor (default `{ last_seen_updated_at: 0 }`).
2. `SELECT model_provider, model, SUM(tokens_used) AS tokens, MAX(updated_at) AS max_updated FROM threads WHERE updated_at > :last_seen_updated_at GROUP BY model_provider, model;` (Note: tokens_used is itself cumulative-per-thread; updated_at is the last bump. Threads only appear in the delta if they advanced since the cursor.)
3. For each row, the tokens reported are CUMULATIVE for that thread, not a delta. To compute the delta correctly we additionally fetch `SUM(tokens_used)` over the SAME (provider, model) for threads with `updated_at <= last_seen_updated_at` and subtract — OR keep a per-provider/model running total in the cursor. The simpler implementation: in the cursor, store `last_total_per_pm: Record<"provider/model", number>` and emit `delta = current_total - last_total` per (provider, model).
4. Return cursor `{ last_seen_updated_at: now_seconds, last_total_per_pm: {...} }` and deltas array.
5. Note: codex sqlite doesn't expose cost. `cost_usd: null` for these deltas. Provider name is whatever codex stores (`openai`, `chatgpt`, etc.) — the reader normalizes to a canonical provider string (`openai` for `chatgpt`/`openai`).

cost_usd remains null until pricing-table support is added (out of scope).

### 5.6.1 `packages/agentchat/src/usage-readers/opencode-db-reader.ts` (NEW)

```ts
// Schema reminder (verified 2026-04-28):
// CREATE TABLE message (
//   id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER,
//   data TEXT NOT NULL  -- JSON: {role, agent, cost, tokens:{total,input,output,reasoning,cache:{write,read}}, modelID, providerID, time:{created,completed}, finish}
// )
//
// Cursor shape: { last_seen_time_created: number /* unix-ms */ }
```

Polls `~/.local/share/opencode/opencode.db` (path resolvable via `${process.env.HOME}/.local/share/opencode/opencode.db`; configurable via env).

Algorithm:
1. Read cursor (default `{ last_seen_time_created: 0 }`).
2. `SELECT id, time_created, data FROM message WHERE time_created > :last_seen_time_created AND json_extract(data, '$.role') = 'assistant' ORDER BY time_created ASC;`
3. For each row, parse `data` JSON. Extract `cost` (USD assumed; opencode emits USD in this column), `tokens.input`, `tokens.output`, `tokens.reasoning`, `tokens.cache.read`, `tokens.cache.write`, `modelID`, `providerID`. (Skip rows where `tokens` is absent — typically tool-call-only assistant messages.)
4. Aggregate deltas grouped by (`providerID`, `modelID`). Each delta carries:
   - `tokens_input += tokens.input`
   - `tokens_output += tokens.output` (excluding reasoning by convention; reasoning tracked separately)
   - `tokens_cache_read += tokens.cache.read`
   - `tokens_cache_write += tokens.cache.write`
   - `cost_usd += cost`
   - `provider = canonicalizeProvider(providerID)` — opencode uses `opencode-go`, `anthropic`, etc.; canonicalize to a small set: `anthropic`, `openai`, `google`, `opencode-go`. The provider mapping table is part of this reader.
5. Emit one t0 row per (canonicalized provider, modelID) bucket via the standard `usage-update` shape, with `payload_json.source_kind = 'local-state-opencode-db'` and the delta values populated. `cost_usd` on the t0 column is set (opencode is USD-native).
6. Update cursor to the max `time_created` seen.

### 5.7 `packages/agentchat/src/usage-readers/claude-jsonl-reader.ts` (NEW)

Polls `~/.claude/projects/*/*.jsonl` files.

Cursor shape: `{ files: { [filepath]: { byte_offset: number, mtime_ms: number } } }`.

Algorithm:
1. List all `*.jsonl` files under `~/.claude/projects/`.
2. For each file:
   - If file mtime is older than `cursor.files[path].mtime_ms`, skip.
   - Otherwise read from `byte_offset` to EOF, parse line-by-line.
3. For each line where `type === "assistant"` and `message.usage` is present, accumulate:
   - `tokens_input += usage.input_tokens`
   - `tokens_output += usage.output_tokens`
   - `tokens_cache_read += usage.cache_read_input_tokens`
   - `tokens_cache_write += usage.cache_creation_input_tokens`
   - Emit one delta per (provider=`anthropic`, model=`message.model`).
4. Update cursor: byte offset = file.size, mtime_ms = current mtime.
5. cost_usd: null for v1 (would require a pricing table; deferred). Tokens give us quota_tokens_per_24h coverage.

Pricing-aware cost computation is OUT OF SCOPE. Note in the design: future Phase 3b.1 can add a pricing table keyed by `model` if cost-based quotas become important for Anthropic.

### 5.8 `packages/agentchat/src/usage-readers/poller.ts` (NEW)

```ts
export interface PollerOptions {
  readers: UsageReader[];
  intervalMs?: number;     // default 60_000
  cursorPath: string;      // e.g. `${storageRoot}/local-state-cursors.json`
  emit: (event: any) => Promise<{ event_id: string }>; // observe()
  log: { info: (m: any, ...rest: any[]) => void; error: (m: any, ...rest: any[]) => void };
}

export function startUsagePoller(opts: PollerOptions): { stop: () => void };
```

The poller runs in the worker process (one instance, regardless of which worker — singleton via `worker-primary` only, to avoid duplicate emission). Loads cursors from disk on start; persists after each successful read.

Singleton selection: agentchat-worker.ts checks if `worker-id === 'worker-primary'` (or equivalent) and only starts the poller in that one worker. The other workers don't run the poller. This is an explicit gate to avoid concurrent cursor mutation.

Each emitted t0 row uses `source_detail = 'usage-poller-<reader.id>'` (e.g. `usage-poller-codex-state`, `usage-poller-claude-jsonl`) and `payload_json.source_kind = 'local-state-<reader.id>'`. The provider field on the t0 row comes from the delta's `provider`.

### 5.9 `packages/agentchat/src/usage-readers/gemini-fallback.ts` — NOT IMPLEMENTED

A documented gap: gemini-cli has no persistent local usage state. We rely on ACP wire emission, which is currently silent for default models. If a future gemini-cli release adds local tracking or wire emission turns on by default, add a reader here.

### 5.10 `packages/core/src/readers/cost.ts` (NEW)

```ts
export interface RecentCostInput {
  since?: string;
  projectId?: string | null;
}

export interface RecentCostOutput {
  total_cost_usd: number | null;
  total_tokens_used: number;
  handoff_count: number;
  by_provider: Array<{
    provider: string | null;
    cost_usd: number | null;
    tokens_used: number;
    handoff_count: number;
  }>;
  window: { from: string; to: string };
}

export function recentCost(db: Database, input: RecentCostInput, now: () => Date): RecentCostOutput;
```

The `per_handoff` CTE described in §4 plus the by_provider grouping query. Note: if all matching rows have `cost_usd IS NULL` (e.g., codex-only window), `total_cost_usd = null` rather than `0` to distinguish "we know no cost" from "we know zero cost".

### 5.11 `packages/core/src/readers/cost-quota.ts` (NEW)

```ts
export interface ProviderQuota {
  provider: string;
  quota_usd_per_24h?: number;
  quota_tokens_per_24h?: number;
}

export interface QuotaStatusInput {
  since?: string; // defaults to now - 24h
}

export interface QuotaStatusOutput {
  window: { from: string; to: string };
  providers: Array<{
    provider: string;
    used_usd: number | null;
    quota_usd: number | null;
    remaining_usd: number | null;
    remaining_pct_usd: number | null;
    used_tokens: number;
    quota_tokens: number | null;
    remaining_tokens: number | null;
    remaining_pct_tokens: number | null;
  }>;
}

export function quotaStatus(db: Database, providers: ProviderQuota[], input: QuotaStatusInput, now: () => Date): QuotaStatusOutput;
```

Algorithm: call `recentCost` with the 24h window, then per provider:
1. Look up the provider's `quota_usd_per_24h` and `quota_tokens_per_24h` from the providers list.
2. If neither is set, omit the provider from the response.
3. Compute `remaining = quota - used` (clamped at 0); `remaining_pct = (remaining / quota) * 100` (rounded to 1 decimal).
4. Cost-side fields are null if the provider has no `quota_usd_per_24h`. Token-side fields likewise.

### 5.12 `packages/mcp/src/tools/cost.ts` (NEW)

Two MCP tools:

- `cost.recent` — input: `{ since?: ISO8601 string, project_id?: string }`. Output: `RecentCostOutput`.
- `cost.quota_status` — input: `{ since?: ISO8601 string }`. Output: `QuotaStatusOutput`.

Both registered in `server.ts` follow the read-only-tools pattern.

### 5.13 `packages/cli/src/commands/cost.ts` (NEW)

Two subcommands under `penumbra cost`:

- `penumbra cost recent [--since <duration>] [--project-id <id>] [--json]` — defaults to `24h`. Pretty-prints totals and the by_provider table. `--json` emits raw `RecentCostOutput`.
- `penumbra cost quota [--json]` — prints the quota status table. `--json` emits raw `QuotaStatusOutput`.

Duration parsing: accept `Nh` / `Nm` / `Nd` / ISO8601. Translate to a `since` timestamp before calling the reader.

### 5.14 `~/.config/agentchat/agentchat.yaml` — providers block (operator config)

```yaml
providers:
  - name: anthropic
    quota_usd_per_24h: 50.00
  - name: openai
    # codex sqlite doesn't expose cost; use token quota
    quota_tokens_per_24h: 1000000
  - name: google
    quota_usd_per_24h: 25.00
```

The yaml schema in `packages/agentchat/src/config.ts` (or wherever config is parsed) gains a `providers` field with the `ProviderQuota[]` shape. Loader for the `cost-quota` reader receives this list at startup.

### 5.15 Worker startup integration

`packages/agentchat/bin/agentchat-worker.ts` gains:

1. Conditional poller startup:
   ```ts
   if (worker_id === 'worker-primary') {
     const poller = startUsagePoller({
       readers: [
         new CodexStateReader(...),
         new OpenCodeDbReader(...),
         new ClaudeJsonlReader(...),
       ],
       intervalMs: 60_000,
       cursorPath: join(storageRoot, 'local-state-cursors.json'),
       emit: client.observe.bind(client),
       log,
     });
     // SIGTERM cleanup: poller.stop();
   }
   ```

2. Cursor file is created on first run with empty state.

## 6. Data flow

Three behavioral cases for ACP wire (covered in v1 of original spec, retained):

**Case A — agent emits usage_update mid-turn.** Forwarded to CapturePort, dispatched immediately as `source_kind='acp-wire'` row.
**Case B — agent emits usage_update at end-of-turn with cost.** Same flow; the row carries `cost_usd`.
**Case C — agent emits no usage_update.** No ACP-wire row. Local-state path picks up the slack on the next poll cycle.

Plus the local-state path:

**Case D — Codex thread completes.** `~/.codex/state_5.sqlite threads.tokens_used` increments. Next poll (≤60s later) reads the delta, emits `source_kind='local-state-codex-state'` row with `cost_usd=null` and tokens populated in `payload_json.delta_tokens`.
**Case D' — OpenCode message lands.** `~/.local/share/opencode/opencode.db message` gets a new assistant row. Next poll reads new rows since the time_created cursor, parses `data` JSON, emits one row per (providerID, modelID) bucket with `cost_usd` populated (USD-native), tokens broken down (input/output/reasoning/cache_read/cache_write) in `payload_json`. `source_kind='local-state-opencode-db'`. **Highest-fidelity local source in the fleet.**
**Case E — Claude Code completes a turn.** New `assistant`-type line appended to the active session JSONL. Next poll reads from the cursor offset, accumulates tokens by (provider=anthropic, model), emits one row per (provider, model) bucket with `cost_usd=null` and tokens in `payload_json`.
**Case F — Same dispatch produces both ACP-wire and local-state events.** Both rows land in t0_events with different `source_kind`. `cost.recent` aggregation uses `max(cost_usd)` per handoff, so if ACP-wire row has cost and local-state row has only tokens, the cost from ACP-wire dominates (max of `null` and `X` is `X` in SQLite). Tokens may double-count IF the same handoff is observed by both paths — mitigation: ACP-wire rows have `handoff_id`; local-state rows DON'T (the codex sqlite doesn't expose handoff IDs in a form penumbra can correlate to). The `per_handoff` CTE GROUPs BY `handoff_id` extracted from payload — local-state rows go into a "null handoff" bucket. To avoid double-counting at the SUM level, the aggregation treats local-state rows as a SEPARATE virtual handoff per (source_kind, provider, model, day) and includes them in the SUM. ACP-wire rows for the SAME real activity will then under-count (because their handoff is a different bucket from the local-state bucket). For v1, we accept some over-counting on overlapping events as a known limitation — the alternative (correlation logic across heterogeneous IDs) is significantly more complex.

This double-counting concern is documented in the spec's "Known limitations" section. v1 accepts it; future tightening adds correlation logic.

## 7. Error handling

| Case | Behavior |
|------|----------|
| usage_update arrives with no `cost` field | Emit ACP-wire row with `cost_usd = null`, `used` and `size` in payload_json. |
| `cost.currency != "USD"` | Emit row with `cost_usd = null`, log warn, retain raw cost in payload_json. |
| usage_update arrives but `used` is missing | Drop the notification (warn-log once per session). |
| Daemon HTTP 400 on the new event_type | Phase 1d.2 `err.body` logging surfaces field_errors. Daemon restart documented in the existing memory entry. |
| `cost.recent` / `cost.quota_status` called with malformed `since` | MCP-level zod validation rejects with 400. |
| Reader throws (codex sqlite unavailable, JSONL corrupt) | Poller catches, logs error, retains last cursor (no advance). Next poll retries. |
| Cursor file corrupt at poller startup | Log warn, recreate empty cursor. Re-emits any deltas from beginning of available data — accept duplicate rows on first poll. |
| Two pollers run concurrently (e.g., user manually runs `worker-primary` twice) | Cursor file is updated atomically (write-tmp-then-rename); concurrent races may produce duplicate rows. Mitigation: file lock on the cursor file (advisory; if lock unavailable, skip the poll). |
| Provider config has both `quota_usd_per_24h` and `quota_tokens_per_24h` | Both surfaces populated in the response — caller can use either. |
| Provider has no quota in config | Omitted from `cost.quota_status.providers` array. |
| `since` < earliest t0 row | Window includes all available data; not an error. |

## 8. Testing strategy

### 8.1 Unit tests

- **CapturePort** (~3 new tests in `capture-port.test.ts`):
  - `usage_update with USD cost → row dispatched with cost_usd populated`.
  - `usage_update with non-USD cost → row dispatched with cost_usd=null, warn logged`.
  - `usage_update with missing used → no row dispatched`.

- **Schema** (`packages/core/test/schemas/event.test.ts` if exists; otherwise extend `event-validation.test.ts`): assert `'usage-update'` in EventTypeSchema enum.

- **stdio-acp adapter** (~1 test): mock session/update with `sessionUpdate: 'usage_update'` → adapter emits to capturePort with right shape.

- **Cost reader** (`packages/core/test/readers/cost.test.ts`, NEW, ~4 tests):
  - Two handoffs, one provider — sum-of-max matches expected.
  - Two providers, three handoffs — by_provider sorted descending.
  - Window filter respected.
  - Empty window returns zeros.

- **Quota reader** (`packages/core/test/readers/cost-quota.test.ts`, NEW, ~4 tests):
  - Provider with cost quota and matching usage → remaining_usd correct, remaining_pct correct.
  - Provider with token quota only → token-side fields populated, cost-side null.
  - Provider in config but no usage → returns 0 used and full quota remaining.
  - Provider with usage but no config quota → omitted from response.

- **Codex sqlite reader** (`packages/agentchat/test/usage-readers/codex-state-reader.test.ts`, NEW, ~3 tests): seed an in-memory sqlite with the threads schema, test cursor advance + delta correctness across two reads.

- **OpenCode db reader** (`packages/agentchat/test/usage-readers/opencode-db-reader.test.ts`, NEW, ~4 tests): seed an in-memory sqlite with the message schema; test (a) cursor advances by max time_created, (b) cost_usd populated from data.cost, (c) tokens deltas grouped by (providerID, modelID), (d) rows without `tokens` in data are skipped.

- **Claude JSONL reader** (`packages/agentchat/test/usage-readers/claude-jsonl-reader.test.ts`, NEW, ~3 tests): write synthetic JSONL files in a temp dir, test cursor advance + delta tokens.

- **Poller** (`packages/agentchat/test/usage-readers/poller.test.ts`, NEW, ~2 tests): poller calls each reader, persists cursor, emits via injected `emit` function. Failure isolation: one reader throws, the other still runs.

- **MCP tools** (~2 tests): zod input validation; reader call; response shape for both `cost.recent` and `cost.quota_status`.

- **CLI** (`packages/cli/test/commands/cost.test.ts`, NEW, ~3 tests): `cost recent --since 24h` table output; `cost quota` table; `--json` flag returns raw shape.

### 8.2 Live verification (post-merge, manual)

After landing, verify:
- Trigger a `claude-acp-sonnet` dispatch — confirm a `usage-update` row with `source_kind='acp-wire'` and `cost_usd` populated.
- Wait for one poller cycle (≤60s) — confirm a row with `source_kind='local-state-codex-state'` for any codex activity OR with `source_kind='local-state-claude-jsonl'` for recent Claude Code work.
- `mcp__penumbra__cost_recent({since: "1h"})` returns non-zero totals.
- `mcp__penumbra__cost_quota_status({})` returns the configured providers with computed remaining.
- `penumbra cost quota` prints the table.

### 8.3 Known limitations (documented, not tested)

- v1 may double-count when ACP-wire and local-state observe the same real activity. Acceptable for soft 24h-rolling quotas; not acceptable for hard accounting (Phase 3b.x or 3d).
- Codex local-state reader has no handoff_id correlation — local-state-derived rows are bucketed by (source_kind, provider, model, day) rather than by handoff.

## 9. Documentation updates

- `packages/agentchat/docs/agent-fleet.md` — note that cost data is captured for ACP agents (claude wire-emitted; codex via local sqlite tokens-only; opencode via local sqlite with full cost+tokens; gemini wire-only; claude also via local JSONL tokens-only as a backstop).
- New memory entry `feedback_phase_3b_cost_ledger.md` — daemon-restart reminder for the new event_type; cursor file location; per-CLI source caveats; over-counting note.

## 10. Out of scope

- Currency conversion (fx rates). Non-USD costs skipped with warn log.
- Per-agent breakdown in `cost.recent` (D3 — could add later as a query change).
- Per-dispatch breakdown.
- Cost-based routing automation built into chain_start.
- Quota gating / hard limits at dispatch time (maestro-side judgment only).
- Pricing table for converting tokens → cost in local-state readers (Phase 3b.1+).
- Gemini local-state reader (no persistent local file exists today).
- Backfilling cost_usd for existing agent-response rows.
- Streaming/realtime cost subscriptions over MCP.
- Handoff-correlation logic for local-state readers (deferred to Phase 3d-or-later).

## 11. Effort & sequencing

Estimated 5 days.

- Day 1: Schema enum + CapturePort kind handler + stdio-acp wiring + opencode-acp audit + unit tests.
- Day 2: Cost reader SQL + tests; Quota reader + tests; MCP tools + tests.
- Day 3: Codex sqlite reader + tests; OpenCode db reader + tests; Claude JSONL reader + tests; Poller + tests; worker singleton wiring.
- Day 4: CLI commands + tests; agentchat.yaml `providers` block schema; live verification dispatch.
- Day 5: Buffer for surprises (opencode-acp wiring quirks, cursor edge cases, JSONL parse failures, by-provider canonicalization).

Ships independently of any other phase. Phase 3d (agent-performance ledger codification) consumes this phase's data but does not block it.
