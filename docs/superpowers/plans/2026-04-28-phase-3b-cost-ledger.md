# Phase 3b — Cost Ledger + Quota-Aware Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use penumbra:dispatching (recommended) or penumbra:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture token consumption + cost across the agent fleet (ACP wire + local CLI state files), expose totals + per-provider remaining quota + rate-limit windows via MCP tools, stable HTTP routes, and CLI commands.

**Architecture:** Two ingest paths converge on `t0_events` rows with new event_types `usage-update` and `rate-limit-snapshot`. ACP-wire path runs through CapturePort. Local-state path runs through a worker-singleton poller calling per-CLI readers (codex rollout JSONL, opencode sqlite, claude transcript JSONL, claude statusLine bridge). Read path uses the existing core-readers pattern; aggregation is a `max-per-handoff, then SUM` window query. Daemon exposes stable `GET /usage/recent` and `GET /usage/quota_status` HTTP routes alongside the MCP tools.

**Tech Stack:** Bun + TypeScript monorepo; bun:sqlite; bun:test; zod schemas; YAML config; new `penumbra hooks install` CLI installs Claude Code statusLine; daemon HTTP routes use the existing serve.ts dispatcher.

**Spec:** `docs/superpowers/specs/2026-04-28-phase-3b-cost-ledger-design.md` (commit 2619999).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `packages/core/src/schemas/event.ts` | modify | Add `'usage-update'`, `'rate-limit-snapshot'` to EventTypeSchema |
| `packages/core/src/readers/cost.ts` | create | `recentCost()` SQL aggregation (max-per-handoff → SUM) |
| `packages/core/test/readers/cost.test.ts` | create | Cost reader unit tests |
| `packages/core/src/readers/cost-quota.ts` | create | `quotaStatus()` joins config quotas with usage |
| `packages/core/test/readers/cost-quota.test.ts` | create | Quota reader unit tests |
| `packages/core/src/services.ts` | modify | Add `providerQuotas: ProviderQuota[]` to Services + BuildServicesOpts |
| `packages/core/src/index.ts` | modify | Re-export new reader functions and types |
| `packages/agentchat/src/worker/capture-port.ts` | modify | Add `usage_update` NotificationEvent kind + `handleUsageUpdate` |
| `packages/agentchat/test/worker/capture-port.test.ts` | modify | 3 new tests for usage_update handling |
| `packages/agentchat/src/adapters/stdio-acp.ts` | modify | Add `case 'usage_update'` to session/update switch |
| `packages/agentchat/test/adapters/stdio-acp.test.ts` | modify | 1 new test |
| `packages/agentchat/src/adapters/opencode-acp.ts` | modify | Audit; add usage_update emit if OpenCode emits it |
| `packages/agentchat/src/usage-readers/index.ts` | create | `UsageReader` interface + reader-result types |
| `packages/agentchat/src/usage-readers/codex-rollout-reader.ts` | create | Polls `~/.codex/sessions/.../rollout-*.jsonl` for usage + rate_limits |
| `packages/agentchat/test/usage-readers/codex-rollout-reader.test.ts` | create | 5 tests |
| `packages/agentchat/src/usage-readers/opencode-db-reader.ts` | create | Polls `~/.local/share/opencode/opencode.db message` table |
| `packages/agentchat/test/usage-readers/opencode-db-reader.test.ts` | create | 4 tests |
| `packages/agentchat/src/usage-readers/claude-jsonl-reader.ts` | create | Polls `~/.claude/projects/*/*.jsonl` |
| `packages/agentchat/test/usage-readers/claude-jsonl-reader.test.ts` | create | 3 tests |
| `packages/agentchat/src/usage-readers/claude-statusline-bridge.ts` | create | Reads `/tmp/penumbra-claude-rl.json` |
| `packages/agentchat/test/usage-readers/claude-statusline-bridge.test.ts` | create | 3 tests |
| `packages/agentchat/src/usage-readers/poller.ts` | create | Periodic poller; loads/persists cursor file |
| `packages/agentchat/test/usage-readers/poller.test.ts` | create | 2 tests |
| `packages/agentchat/bin/agentchat-worker.ts` | modify | Singleton poller startup gated to `worker-primary` |
| `packages/agentchat/src/config.ts` | modify | Add `providers: ProviderQuota[]` to YAML schema |
| `packages/daemon/src/routes/usage.ts` | create | HTTP route handlers for `/usage/recent` and `/usage/quota_status` |
| `packages/daemon/test/routes/usage.test.ts` | create | 4 tests |
| `packages/daemon/src/serve.ts` | modify | Register the two new routes in dispatcher |
| `packages/daemon/src/start.ts` | modify | Read agentchat.yaml `providers` block at startup; pass to buildServices |
| `packages/mcp/src/tools/cost-recent.ts` | create | MCP tool wrapping `recentCost()` |
| `packages/mcp/src/tools/cost-quota-status.ts` | create | MCP tool wrapping `quotaStatus()` |
| `packages/mcp/test/tools/cost.test.ts` | create | 2 tests covering both tools |
| `packages/mcp/src/server.ts` | modify | Register the two new tools |
| `packages/cli/src/commands/cost.ts` | create | `penumbra cost recent` and `penumbra cost quota` |
| `packages/cli/test/commands/cost.test.ts` | create | 3 tests |
| `packages/cli/src/commands/hooks.ts` | create | `penumbra hooks install/uninstall/status --claude/--codex` |
| `packages/cli/test/commands/hooks.test.ts` | create | 5 tests |
| `packages/cli/bin/penumbra.ts` | modify | Wire up `cost` and `hooks` subcommands |
| `~/.config/agentchat/agentchat.yaml` | modify | Add `providers:` block (operator config; not git-tracked) |
| `~/.claude/projects/-Volumes-WorkSSD-repos-personal-penumbra/memory/feedback_phase_3b_cost_ledger.md` | create | Memory entry |
| `~/.claude/projects/-Volumes-WorkSSD-repos-personal-penumbra/memory/MEMORY.md` | modify | Add index pointer |
| `packages/agentchat/docs/agent-fleet.md` | modify | Per-CLI cost-data + rate-limit landscape |

**Order:** Schema first → ACP wire path → readers + Services wiring → HTTP/MCP/CLI surfaces → local-state readers → poller + worker wiring → yaml config → CLI hooks → docs/memory + live verify. Each commit is a logical unit (TDD test-then-impl pairs).

**Pre-flight:** Daemon at `/tmp/penumbra-live` must be running. After landing schema changes, daemon MUST be restarted to pick up the new `EventTypeSchema` enum values (per the daemon-restart-on-schema-change memory entry).

---

## Task 1: Add `usage-update` and `rate-limit-snapshot` to EventTypeSchema (TDD)

**Files:**
- Modify: `packages/core/src/schemas/event.ts`
- Modify (test): an existing schema test file or `packages/core/test/schemas/event.test.ts` (create if absent)

- [ ] **Step 1: Locate the existing schema test file**

Run:
```bash
find /Volumes/WorkSSD/repos/personal/penumbra/packages/core/test -name "event*" -type f 2>/dev/null
```
Expected: at least one path. Read it to understand the test pattern. If no test file references EventTypeSchema, create `packages/core/test/schemas/event.test.ts` with the basic `bun:test` skeleton:

```ts
import { describe, it, expect } from 'bun:test';
import { EventTypeSchema, T0EventInputSchema } from '../../src/schemas/event.js';
```

- [ ] **Step 2: Add the failing assertion**

Append to the test file:

```ts
describe('EventTypeSchema — Phase 3b additions', () => {
  it('accepts "usage-update"', () => {
    expect(EventTypeSchema.safeParse('usage-update').success).toBe(true);
  });
  it('accepts "rate-limit-snapshot"', () => {
    expect(EventTypeSchema.safeParse('rate-limit-snapshot').success).toBe(true);
  });
  it('parses a usage-update event through T0EventInputSchema', () => {
    const result = T0EventInputSchema.safeParse({
      ts: new Date().toISOString(),
      source: 'agentchat',
      user_id: 'local-user',
      machine_id: 'local',
      event_type: 'usage-update',
      lane: 'cli-subscription',
      payload_json: { handoff_id: 'h', used: 1234, size: 200000 },
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test, confirm FAIL**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/core/test/schemas/event.test.ts
```
Expected: 3 failures (enum doesn't include the new values).

- [ ] **Step 4: Apply the schema change**

Edit `packages/core/src/schemas/event.ts`. Locate `EventTypeSchema` and add the two new values:

```ts
export const EventTypeSchema = z.enum([
  'agent-prompt', 'agent-tool-use', 'agent-response', 'agent-thought', 'agent-handoff',
  'usage-update', 'rate-limit-snapshot',
  'user-prompt', 'request', 'response', 'chain-terminated',
  'permission-requested', 'permission-decided', 'permission-expired',
  'fs.write_applied', 'fs.edit_applied',
  'terminal.spawned', 'terminal.exited', 'terminal.killed',
]);
```

- [ ] **Step 5: Re-run the test, confirm PASS**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/core/test/schemas/event.test.ts
```
Expected: all 3 new tests PASS.

- [ ] **Step 6: Run full core suite + typecheck**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/core && bun typecheck
```
Expected: green; 0 typecheck errors.

- [ ] **Step 7: Commit**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
git add packages/core/src/schemas/event.ts packages/core/test/schemas/event.test.ts && \
git commit -m "feat(core): add usage-update and rate-limit-snapshot event types"
```

---

## Task 2: CapturePort `usage_update` kind (TDD)

**Files:**
- Modify: `packages/agentchat/src/worker/capture-port.ts`
- Modify (test): `packages/agentchat/test/worker/capture-port.test.ts`

- [ ] **Step 1: Read the current CapturePort to understand the existing test scaffolding**

```bash
cat /Volumes/WorkSSD/repos/personal/penumbra/packages/agentchat/test/worker/capture-port.test.ts | head -60
```
Note the helper that constructs a `CapturePort` and the `mockObserve` shape — reuse them.

- [ ] **Step 2: Add 3 failing tests**

Append a new `describe` block to `capture-port.test.ts`:

```ts
describe('CapturePort — usage_update', () => {
  it('emits a usage-update row when usage_update arrives with USD cost', async () => {
    const observed: any[] = [];
    const port = new CapturePort({
      observe: async (e) => { observed.push(e); return { event_id: 'eid' }; },
      chainId: 'conv-1',
      handoffId: 'h-1',
      projectId: null,
      agentName: 'claude-acp-sonnet',
      provider: 'anthropic',
      model: 'sonnet-4',
      lane: 'cli-subscription',
    });
    port.emit({ kind: 'usage_update', used: 5000, size: 200000, cost: { amount: 0.42, currency: 'USD' } });
    await port.flush();
    expect(observed).toHaveLength(1);
    expect(observed[0].event_type).toBe('usage-update');
    expect(observed[0].cost_usd).toBe(0.42);
    expect(observed[0].payload_json.used).toBe(5000);
    expect(observed[0].payload_json.size).toBe(200000);
    expect(observed[0].payload_json.currency).toBe('USD');
    expect(observed[0].payload_json.source_kind).toBe('acp-wire');
  });

  it('emits a usage-update row with cost_usd=null when currency is not USD', async () => {
    const observed: any[] = [];
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...args) => { errors.push(args.join(' ')); };
    try {
      const port = new CapturePort({
        observe: async (e) => { observed.push(e); return { event_id: 'eid' }; },
        chainId: null, handoffId: 'h', projectId: null,
        agentName: 'x', provider: null, model: null, lane: 'cli-subscription',
      });
      port.emit({ kind: 'usage_update', used: 100, size: 100000, cost: { amount: 0.5, currency: 'EUR' } });
      await port.flush();
      expect(observed).toHaveLength(1);
      expect(observed[0].cost_usd).toBeNull();
      expect(observed[0].payload_json.raw_cost).toEqual({ amount: 0.5, currency: 'EUR' });
      expect(errors.some(e => e.includes('EUR not converted'))).toBe(true);
    } finally {
      console.error = origErr;
    }
  });

  it('drops usage_update when used is missing or non-numeric', async () => {
    const observed: any[] = [];
    const port = new CapturePort({
      observe: async (e) => { observed.push(e); return { event_id: 'eid' }; },
      chainId: null, handoffId: 'h', projectId: null,
      agentName: 'x', provider: null, model: null, lane: 'cli-subscription',
    });
    port.emit({ kind: 'usage_update', used: NaN as any, size: 100000 });
    port.emit({ kind: 'usage_update', used: 'oops' as any, size: 100000 });
    await port.flush();
    expect(observed).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run the targeted tests, confirm FAIL**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/agentchat/test/worker/capture-port.test.ts -t "usage_update"
```
Expected: type errors (the `kind: 'usage_update'` variant doesn't exist) and runtime failures.

- [ ] **Step 4: Extend `NotificationEvent` and add `handleUsageUpdate`**

Edit `packages/agentchat/src/worker/capture-port.ts`:

Find the `NotificationEvent` discriminated union (currently 4 kinds). Add a 5th variant:

```ts
| { kind: 'usage_update'; used: number; size: number; cost?: { amount: number; currency: string } }
```

Find the class fields. Add:

```ts
private usageWarnedMissing = false;
```

In the `emit` method's `try` block, after the `tool_call_update` branch, add:

```ts
} else if (ev.kind === 'usage_update') {
  this.handleUsageUpdate(ev);
```

Add a new private method (place it after `handleToolCallUpdate`):

```ts
private handleUsageUpdate(ev: Extract<NotificationEvent, { kind: 'usage_update' }>): void {
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

- [ ] **Step 5: Re-run the targeted tests, confirm PASS**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/agentchat/test/worker/capture-port.test.ts -t "usage_update"
```
Expected: 3 PASS.

- [ ] **Step 6: Run full agentchat suite + typecheck**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/agentchat && bun typecheck
```
Expected: all green. Bun ONNX teardown panic at end of bun test is COSMETIC.

- [ ] **Step 7: Commit**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
git add packages/agentchat/src/worker/capture-port.ts packages/agentchat/test/worker/capture-port.test.ts && \
git commit -m "feat(agentchat): CapturePort handles usage_update notifications"
```

---

## Task 3: stdio-acp adapter wires `usage_update` (TDD)

**Files:**
- Modify: `packages/agentchat/src/adapters/stdio-acp.ts`
- Modify (test): `packages/agentchat/test/adapters/stdio-acp.test.ts`

- [ ] **Step 1: Add the failing test**

Open the existing test file. Locate the existing `tool_call` test for the session/update flow and add a new test that mirrors its structure but emits a usage_update notification:

```ts
it('forwards session/update.usage_update to the capture port', async () => {
  const captureEmitSpy = mock();
  const fakeCapturePort = { emit: captureEmitSpy } as any;

  const mockStdout = new PassThrough();
  const mockStdin = new PassThrough();
  const mockKill = vi.fn();
  const startServer = vi.fn().mockResolvedValue({
    stdin: mockStdin,
    stdout: mockStdout,
    kill: mockKill,
    exited: Promise.resolve(0),
  });

  const adapter = new StdioAcpAdapter(
    { binary: 'fake', capturePort: fakeCapturePort },
    { startServer, createClient: (h) => new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout }) },
  );

  const dispatchPromise = adapter.dispatch({
    prompt: 'hi',
    conversation: { id: 'c-1', project_id: null },
    config: {},
    signal: new AbortController().signal,
  } as any);

  // Fake the initialize -> newSession -> session/prompt sequence enough to receive a session/update
  await new Promise(r => setTimeout(r, 5));
  mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { protocolVersion: 1, authMethods: [] }, id: 1 }) + '\n');
  await new Promise(r => setTimeout(r, 5));
  mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { sessionId: 'session-1' }, id: 2 }) + '\n');
  await new Promise(r => setTimeout(r, 5));
  mockStdout.write(JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'usage_update',
        used: 1234,
        size: 200000,
        cost: { amount: 0.05, currency: 'USD' },
      },
    },
  }) + '\n');
  await new Promise(r => setTimeout(r, 10));

  expect(captureEmitSpy).toHaveBeenCalledWith({
    kind: 'usage_update',
    used: 1234,
    size: 200000,
    cost: { amount: 0.05, currency: 'USD' },
  });

  // Cleanup: complete the prompt so dispatch resolves
  mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { stopReason: 'end_turn' }, id: 3 }) + '\n');
  await dispatchPromise.catch(() => {}); // tolerate reject; we're only asserting the emit
});
```

(If the file uses a different mock framework — check the existing tests' style and adapt; the assertion is what matters.)

- [ ] **Step 2: Run the test, confirm FAIL**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/agentchat/test/adapters/stdio-acp.test.ts -t "usage_update"
```
Expected: FAIL — the switch case doesn't exist.

- [ ] **Step 3: Add the case to the session/update switch**

Edit `packages/agentchat/src/adapters/stdio-acp.ts`. Find the existing `client.on('session/update', ...)` handler. Inside the `switch (update.sessionUpdate)` block — after the `tool_call_update` case and before the trailing `// ignore: ...` comment — add:

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

Update the trailing comment to remove `usage_update` if it was listed there.

- [ ] **Step 4: Re-run the test, confirm PASS**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/agentchat/test/adapters/stdio-acp.test.ts -t "usage_update"
```
Expected: PASS.

- [ ] **Step 5: Run full agentchat suite + typecheck**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/agentchat && bun typecheck
```
Expected: green.

- [ ] **Step 6: Commit**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
git add packages/agentchat/src/adapters/stdio-acp.ts packages/agentchat/test/adapters/stdio-acp.test.ts && \
git commit -m "feat(agentchat): stdio-acp routes usage_update to CapturePort"
```

---

## Task 4: opencode-acp adapter audit + parallel emit (investigation + TDD if applicable)

**Files:**
- Read: `packages/agentchat/src/adapters/opencode-acp.ts`
- Maybe modify: same file + its test

- [ ] **Step 1: Read the opencode-acp adapter session/update handling**

```bash
grep -n "session/update\|sessionUpdate\|usage" /Volumes/WorkSSD/repos/personal/penumbra/packages/agentchat/src/adapters/opencode-acp.ts | head -30
```

Three branches:
- If opencode-acp ALREADY routes `usage_update` to a capturePort: nothing to do; commit a one-line comment update if needed and skip to Step 6.
- If opencode-acp processes session/update but doesn't handle `usage_update`: add a parallel case (mirror Task 3).
- If opencode-acp uses a different update kind name (e.g., `metering.update`): map the vendor-specific kind into our `usage_update` shape at the adapter boundary.

- [ ] **Step 2: If a code change is needed, write a failing test first**

Mirror Task 3's test pattern in `packages/agentchat/test/adapters/opencode-acp.test.ts` (create if absent following the test-file pattern):

```ts
it('forwards opencode session/update for usage to capture port', async () => {
  // ... mock the opencode-acp transport, emit a usage update notification,
  //     assert capturePort.emit was called with kind: 'usage_update'
});
```

Run, confirm FAIL.

- [ ] **Step 3: Add the parallel emit code**

Apply the parallel handler. If the vendor uses different fields (e.g., `metering.tokens_used` instead of `used`), normalize at the adapter boundary so what flows into CapturePort is always:
```ts
{ kind: 'usage_update', used: number, size: number, cost?: { amount, currency } }
```

If `size` isn't available from opencode-acp's notification, use `Number.MAX_SAFE_INTEGER` or a sentinel, and document that in a comment.

- [ ] **Step 4: Re-run the test, confirm PASS**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/agentchat/test/adapters/opencode-acp.test.ts
```

- [ ] **Step 5: Run full agentchat suite + typecheck**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/agentchat && bun typecheck
```

- [ ] **Step 6: Commit**

If a change was made:
```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
git add packages/agentchat/src/adapters/opencode-acp.ts packages/agentchat/test/adapters/opencode-acp.test.ts && \
git commit -m "feat(agentchat): opencode-acp routes usage updates to CapturePort"
```

If no change was needed, document the audit result by editing a one-line comment in `opencode-acp.ts` (e.g., `// usage updates: not emitted by opencode-acp; relies on opencode-db-reader for usage capture`) and commit:
```bash
git add packages/agentchat/src/adapters/opencode-acp.ts && \
git commit -m "docs(agentchat): note opencode-acp usage capture path"
```

If the path is fundamentally different and would need a new design, surface NEEDS_CONTEXT to the maestro with the specific vendor-update-kind name observed; do not force-fit.

---

## Task 5: `recentCost` reader (TDD)

**Files:**
- Create: `packages/core/src/readers/cost.ts`
- Create: `packages/core/test/readers/cost.test.ts`
- Modify: `packages/core/src/index.ts` (re-export)

- [ ] **Step 1: Create the test file with 4 failing tests**

```ts
// packages/core/test/readers/cost.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { recentCost } from '../../src/readers/cost.js';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE t0_events (
      event_id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      ingest_ts TEXT NOT NULL,
      source TEXT NOT NULL,
      source_detail TEXT,
      project_id TEXT,
      user_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      session_id TEXT,
      event_type TEXT NOT NULL,
      lane TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cost_usd REAL,
      latency_ms INTEGER,
      request_id TEXT,
      payload_json TEXT NOT NULL,
      payload_summary TEXT
    );
  `);
  return db;
}

function insertUsageRow(db: Database, row: { event_id: string; ts: string; provider: string; cost_usd: number | null; used: number; handoff_id: string | null; }) {
  db.prepare(`
    INSERT INTO t0_events (event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane, provider, cost_usd, payload_json)
    VALUES (?, ?, ?, 'agentchat', 'u', 'm', 'usage-update', 'cli-subscription', ?, ?, ?)
  `).run(row.event_id, row.ts, row.ts, row.provider, row.cost_usd, JSON.stringify({ handoff_id: row.handoff_id, used: row.used }));
}

describe('recentCost', () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it('returns sum of max-per-handoff for a single provider', () => {
    insertUsageRow(db, { event_id: '1', ts: '2026-04-28T12:00:00Z', provider: 'anthropic', cost_usd: 0.5, used: 1000, handoff_id: 'h1' });
    insertUsageRow(db, { event_id: '2', ts: '2026-04-28T12:01:00Z', provider: 'anthropic', cost_usd: 1.2, used: 2400, handoff_id: 'h1' }); // newer snapshot for h1
    insertUsageRow(db, { event_id: '3', ts: '2026-04-28T12:02:00Z', provider: 'anthropic', cost_usd: 0.3, used: 600,  handoff_id: 'h2' });
    const out = recentCost(db, { since: '2026-04-28T00:00:00Z' }, () => new Date('2026-04-28T13:00:00Z'));
    expect(out.total_cost_usd).toBe(1.5); // max(0.5,1.2)=1.2 for h1 + 0.3 for h2 = 1.5
    expect(out.total_tokens_used).toBe(3000); // 2400 + 600
    expect(out.handoff_count).toBe(2);
    expect(out.by_provider).toHaveLength(1);
    expect(out.by_provider[0].provider).toBe('anthropic');
    expect(out.by_provider[0].cost_usd).toBe(1.5);
  });

  it('groups by provider and sorts descending by cost', () => {
    insertUsageRow(db, { event_id: '1', ts: '2026-04-28T12:00:00Z', provider: 'anthropic', cost_usd: 5.0,  used: 1000, handoff_id: 'h1' });
    insertUsageRow(db, { event_id: '2', ts: '2026-04-28T12:00:00Z', provider: 'google',    cost_usd: 0.50, used: 500,  handoff_id: 'h2' });
    insertUsageRow(db, { event_id: '3', ts: '2026-04-28T12:00:00Z', provider: 'openai',    cost_usd: null, used: 300,  handoff_id: 'h3' });
    const out = recentCost(db, { since: '2026-04-28T00:00:00Z' }, () => new Date('2026-04-28T13:00:00Z'));
    expect(out.by_provider.map(p => p.provider)).toEqual(['anthropic', 'google', 'openai']);
  });

  it('respects the since window', () => {
    insertUsageRow(db, { event_id: '1', ts: '2026-04-26T12:00:00Z', provider: 'anthropic', cost_usd: 100, used: 999, handoff_id: 'old' });
    insertUsageRow(db, { event_id: '2', ts: '2026-04-28T12:00:00Z', provider: 'anthropic', cost_usd: 1,   used: 100, handoff_id: 'new' });
    const out = recentCost(db, { since: '2026-04-28T00:00:00Z' }, () => new Date('2026-04-28T13:00:00Z'));
    expect(out.total_cost_usd).toBe(1);
    expect(out.handoff_count).toBe(1);
  });

  it('returns zeros for empty window', () => {
    const out = recentCost(db, { since: '2026-04-28T00:00:00Z' }, () => new Date('2026-04-28T13:00:00Z'));
    expect(out.total_cost_usd).toBeNull(); // no rows = no cost knowledge (per spec D in §5.10)
    expect(out.total_tokens_used).toBe(0);
    expect(out.handoff_count).toBe(0);
    expect(out.by_provider).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test, confirm FAIL**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/core/test/readers/cost.test.ts
```
Expected: import errors (file doesn't exist).

- [ ] **Step 3: Implement `cost.ts`**

```ts
// packages/core/src/readers/cost.ts
import type { Database } from 'bun:sqlite';

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

export function recentCost(db: Database, input: RecentCostInput, now: () => Date): RecentCostOutput {
  const nowDate = now();
  const since = input.since ?? new Date(nowDate.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const window = { from: since, to: nowDate.toISOString() };

  // The aggregation: max-per-handoff (using payload_json.handoff_id when present;
  // local-state-derived rows have no handoff_id and bucket by source_kind+provider+date instead).
  // For v1 we use a single GROUP BY that treats the absent handoff_id as the row's event_id —
  // that gives each local-state row its own virtual handoff bucket.
  const totalsRow = db.prepare(`
    WITH per_handoff AS (
      SELECT
        COALESCE(json_extract(payload_json, '$.handoff_id'), event_id) AS handoff_key,
        provider,
        MAX(cost_usd) AS handoff_cost_usd,
        MAX(CAST(json_extract(payload_json, '$.used') AS INTEGER)) AS handoff_tokens
      FROM t0_events
      WHERE event_type = 'usage-update'
        AND ts >= ?
        AND (? IS NULL OR project_id = ?)
      GROUP BY handoff_key, provider
    )
    SELECT
      SUM(handoff_cost_usd) AS sum_cost,
      SUM(handoff_tokens)   AS sum_tokens,
      COUNT(*)              AS n,
      SUM(CASE WHEN handoff_cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS n_with_cost
    FROM per_handoff
  `).get(since, input.projectId ?? null, input.projectId ?? null) as
    | { sum_cost: number | null; sum_tokens: number | null; n: number; n_with_cost: number | null }
    | undefined;

  const byProviderRows = db.prepare(`
    WITH per_handoff AS (
      SELECT
        COALESCE(json_extract(payload_json, '$.handoff_id'), event_id) AS handoff_key,
        provider,
        MAX(cost_usd) AS handoff_cost_usd,
        MAX(CAST(json_extract(payload_json, '$.used') AS INTEGER)) AS handoff_tokens
      FROM t0_events
      WHERE event_type = 'usage-update'
        AND ts >= ?
        AND (? IS NULL OR project_id = ?)
      GROUP BY handoff_key, provider
    )
    SELECT
      provider,
      SUM(handoff_cost_usd) AS cost_usd,
      SUM(handoff_tokens)   AS tokens_used,
      COUNT(*)              AS handoff_count
    FROM per_handoff
    GROUP BY provider
    ORDER BY (cost_usd IS NULL) ASC, cost_usd DESC, tokens_used DESC
  `).all(since, input.projectId ?? null, input.projectId ?? null) as Array<{
    provider: string | null;
    cost_usd: number | null;
    tokens_used: number | null;
    handoff_count: number;
  }>;

  const total_cost_usd = (totalsRow?.n_with_cost ?? 0) > 0 ? (totalsRow?.sum_cost ?? 0) : null;
  return {
    total_cost_usd,
    total_tokens_used: totalsRow?.sum_tokens ?? 0,
    handoff_count: totalsRow?.n ?? 0,
    by_provider: byProviderRows.map(r => ({
      provider: r.provider,
      cost_usd: r.cost_usd,
      tokens_used: r.tokens_used ?? 0,
      handoff_count: r.handoff_count,
    })),
    window,
  };
}
```

- [ ] **Step 4: Re-run the test, confirm PASS**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/core/test/readers/cost.test.ts
```
Expected: 4 PASS.

- [ ] **Step 5: Re-export from `packages/core/src/index.ts`**

Add to the main index file:
```ts
export { recentCost, type RecentCostInput, type RecentCostOutput } from './readers/cost.js';
```

- [ ] **Step 6: Run full core suite + typecheck**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/core && bun typecheck
```

- [ ] **Step 7: Commit**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
git add packages/core/src/readers/cost.ts packages/core/test/readers/cost.test.ts packages/core/src/index.ts && \
git commit -m "feat(core): recentCost reader for usage-update aggregation"
```

---

## Task 6: `quotaStatus` reader + Services.providerQuotas (TDD)

**Files:**
- Create: `packages/core/src/readers/cost-quota.ts`
- Create: `packages/core/test/readers/cost-quota.test.ts`
- Modify: `packages/core/src/services.ts` (add ProviderQuota type + Services.providerQuotas)
- Modify: `packages/core/src/index.ts` (re-export)

- [ ] **Step 1: Add the failing tests**

```ts
// packages/core/test/readers/cost-quota.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { quotaStatus } from '../../src/readers/cost-quota.js';

function makeDb(): Database { /* same as cost.test.ts — copy the helper */ /* ... */ }
function insertUsageRow(db: Database, row: any) { /* same helper */ /* ... */ }

describe('quotaStatus', () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it('computes remaining_usd and pct correctly when both quota and usage are present', () => {
    insertUsageRow(db, { event_id: '1', ts: '2026-04-28T12:00:00Z', provider: 'anthropic', cost_usd: 12.40, used: 12000, handoff_id: 'h1' });
    const out = quotaStatus(
      db,
      [{ provider: 'anthropic', quota_usd_per_24h: 50.00 }],
      { since: '2026-04-28T00:00:00Z' },
      () => new Date('2026-04-28T13:00:00Z'),
    );
    expect(out.providers).toHaveLength(1);
    expect(out.providers[0]).toMatchObject({
      provider: 'anthropic',
      used_usd: 12.40,
      quota_usd: 50.00,
      remaining_usd: 37.60,
      remaining_pct_usd: 75.2,
    });
  });

  it('uses token-side fields when only quota_tokens_per_24h is configured', () => {
    insertUsageRow(db, { event_id: '1', ts: '2026-04-28T12:00:00Z', provider: 'openai', cost_usd: null, used: 250000, handoff_id: 'h1' });
    const out = quotaStatus(
      db,
      [{ provider: 'openai', quota_tokens_per_24h: 1_000_000 }],
      { since: '2026-04-28T00:00:00Z' },
      () => new Date('2026-04-28T13:00:00Z'),
    );
    expect(out.providers[0].quota_usd).toBeNull();
    expect(out.providers[0].used_tokens).toBe(250000);
    expect(out.providers[0].quota_tokens).toBe(1_000_000);
    expect(out.providers[0].remaining_tokens).toBe(750000);
    expect(out.providers[0].remaining_pct_tokens).toBe(75.0);
  });

  it('returns 0 used + full quota remaining for a provider with config but no usage', () => {
    const out = quotaStatus(
      db,
      [{ provider: 'google', quota_usd_per_24h: 25 }],
      { since: '2026-04-28T00:00:00Z' },
      () => new Date('2026-04-28T13:00:00Z'),
    );
    expect(out.providers[0].used_usd).toBe(0);
    expect(out.providers[0].remaining_usd).toBe(25);
    expect(out.providers[0].remaining_pct_usd).toBe(100);
  });

  it('omits providers from response when no quota is configured', () => {
    insertUsageRow(db, { event_id: '1', ts: '2026-04-28T12:00:00Z', provider: 'unknown', cost_usd: 1, used: 100, handoff_id: 'h1' });
    const out = quotaStatus(
      db,
      [{ provider: 'anthropic', quota_usd_per_24h: 50 }],
      { since: '2026-04-28T00:00:00Z' },
      () => new Date('2026-04-28T13:00:00Z'),
    );
    expect(out.providers.map(p => p.provider)).toEqual(['anthropic']); // no 'unknown' in response
  });
});
```

(Copy the `makeDb` and `insertUsageRow` helpers from Task 5's test file verbatim — it's OK to duplicate within tests.)

- [ ] **Step 2: Run the tests, confirm FAIL**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/core/test/readers/cost-quota.test.ts
```

- [ ] **Step 3: Implement `cost-quota.ts`**

```ts
// packages/core/src/readers/cost-quota.ts
import type { Database } from 'bun:sqlite';
import { recentCost } from './cost.js';

export interface ProviderQuota {
  provider: string;
  quota_usd_per_24h?: number;
  quota_tokens_per_24h?: number;
}

export interface QuotaStatusInput {
  since?: string;
}

export interface QuotaStatusProviderRow {
  provider: string;
  used_usd: number | null;
  quota_usd: number | null;
  remaining_usd: number | null;
  remaining_pct_usd: number | null;
  used_tokens: number;
  quota_tokens: number | null;
  remaining_tokens: number | null;
  remaining_pct_tokens: number | null;
}

export interface QuotaStatusOutput {
  window: { from: string; to: string };
  providers: QuotaStatusProviderRow[];
}

export function quotaStatus(
  db: Database,
  providers: ProviderQuota[],
  input: QuotaStatusInput,
  now: () => Date,
): QuotaStatusOutput {
  const recent = recentCost(db, { since: input.since }, now);

  const usageByProvider = new Map<string, { cost_usd: number | null; tokens_used: number }>();
  for (const row of recent.by_provider) {
    if (row.provider == null) continue;
    usageByProvider.set(row.provider, { cost_usd: row.cost_usd, tokens_used: row.tokens_used });
  }

  const out: QuotaStatusProviderRow[] = providers.map((p) => {
    const usage = usageByProvider.get(p.provider) ?? { cost_usd: null, tokens_used: 0 };
    const used_usd = p.quota_usd_per_24h !== undefined ? (usage.cost_usd ?? 0) : null;
    const quota_usd = p.quota_usd_per_24h ?? null;
    const remaining_usd = (used_usd !== null && quota_usd !== null) ? Math.max(0, quota_usd - used_usd) : null;
    const remaining_pct_usd = (remaining_usd !== null && quota_usd !== null && quota_usd > 0)
      ? Math.round((remaining_usd / quota_usd) * 1000) / 10
      : null;

    const used_tokens = usage.tokens_used;
    const quota_tokens = p.quota_tokens_per_24h ?? null;
    const remaining_tokens = quota_tokens !== null ? Math.max(0, quota_tokens - used_tokens) : null;
    const remaining_pct_tokens = (remaining_tokens !== null && quota_tokens !== null && quota_tokens > 0)
      ? Math.round((remaining_tokens / quota_tokens) * 1000) / 10
      : null;

    return {
      provider: p.provider,
      used_usd, quota_usd, remaining_usd, remaining_pct_usd,
      used_tokens, quota_tokens, remaining_tokens, remaining_pct_tokens,
    };
  });

  return { window: recent.window, providers: out };
}
```

- [ ] **Step 4: Add `providerQuotas` to Services**

Edit `packages/core/src/services.ts`:

1. At the top imports, add:
   ```ts
   import type { ProviderQuota } from './readers/cost-quota.js';
   ```
2. In the `Services` interface, add a new field after `agentRegistry`:
   ```ts
   providerQuotas: ProviderQuota[];
   ```
3. In `BuildServicesOpts`, add an optional field:
   ```ts
   providerQuotas?: ProviderQuota[];
   ```
4. In the `buildServices` return object, add:
   ```ts
   providerQuotas: opts.providerQuotas ?? [],
   ```

- [ ] **Step 5: Re-export from `packages/core/src/index.ts`**

Add:
```ts
export { quotaStatus, type ProviderQuota, type QuotaStatusInput, type QuotaStatusOutput, type QuotaStatusProviderRow } from './readers/cost-quota.js';
```

- [ ] **Step 6: Re-run tests, confirm PASS + typecheck**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
bun test packages/core/test/readers/cost-quota.test.ts && \
bun test packages/core && \
bun typecheck
```

- [ ] **Step 7: Commit**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
git add packages/core/src/readers/cost-quota.ts packages/core/test/readers/cost-quota.test.ts packages/core/src/services.ts packages/core/src/index.ts && \
git commit -m "feat(core): quotaStatus reader + ProviderQuota in Services"
```

---

## Task 7: Daemon HTTP routes `/usage/recent` and `/usage/quota_status` (TDD)

**Files:**
- Create: `packages/daemon/src/routes/usage.ts`
- Create: `packages/daemon/test/routes/usage.test.ts`
- Modify: `packages/daemon/src/serve.ts` (route registration)

- [ ] **Step 1: Read the existing observations route + test for the established pattern**

```bash
cat /Volumes/WorkSSD/repos/personal/penumbra/packages/daemon/src/routes/observations.ts
cat /Volumes/WorkSSD/repos/personal/penumbra/packages/daemon/test/routes/observations.test.ts | head -60
```
Note: how Services is constructed in tests, how bearer-token auth is applied (search serve.ts for the auth wrapper).

- [ ] **Step 2: Add the failing tests**

```ts
// packages/daemon/test/routes/usage.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { usageRecentRoute, usageQuotaStatusRoute } from '../../src/routes/usage.js';

// Use the existing test-services helper if present (look in packages/daemon/test/utils or similar)
function makeServices(db: Database, providerQuotas: any[] = []): any {
  // Mirror the existing test-services factory pattern; minimal services for usage routes.
  return {
    db,
    clock: () => new Date('2026-04-28T13:00:00Z'),
    providerQuotas,
  };
}

function makeDb(): Database { /* same makeDb as cost.test.ts */ /* ... */ }
function insertUsageRow(db: Database, row: any) { /* same helper */ /* ... */ }

describe('GET /usage/recent', () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it('returns RecentCostOutput shape', async () => {
    insertUsageRow(db, { event_id: '1', ts: '2026-04-28T12:00:00Z', provider: 'anthropic', cost_usd: 0.5, used: 1000, handoff_id: 'h1' });
    const services = makeServices(db);
    const req = new Request('http://x/usage/recent?since=2026-04-28T00:00:00Z');
    const res = await usageRecentRoute(req, services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total_cost_usd).toBe(0.5);
    expect(body.by_provider).toHaveLength(1);
  });

  it('returns 400 on malformed since', async () => {
    const services = makeServices(db);
    const req = new Request('http://x/usage/recent?since=not-a-date');
    const res = await usageRecentRoute(req, services);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_params');
  });
});

describe('GET /usage/quota_status', () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  it('returns QuotaStatusOutput shape with configured providers', async () => {
    insertUsageRow(db, { event_id: '1', ts: '2026-04-28T12:00:00Z', provider: 'anthropic', cost_usd: 12.4, used: 12000, handoff_id: 'h1' });
    const services = makeServices(db, [{ provider: 'anthropic', quota_usd_per_24h: 50 }]);
    const req = new Request('http://x/usage/quota_status?since=2026-04-28T00:00:00Z');
    const res = await usageQuotaStatusRoute(req, services);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0].remaining_usd).toBe(37.6);
  });

  it('returns 400 on malformed since', async () => {
    const services = makeServices(db);
    const req = new Request('http://x/usage/quota_status?since=garbage');
    const res = await usageQuotaStatusRoute(req, services);
    expect(res.status).toBe(400);
  });
});
```

(401 auth test is added at the serve.ts level since the route handlers themselves don't check auth — that's a wrapper concern. Add a separate test in `serve.test.ts` if there's an existing pattern for it; otherwise skip and rely on the auth-wrapper covering all routes uniformly.)

- [ ] **Step 3: Run tests, confirm FAIL**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/daemon/test/routes/usage.test.ts
```

- [ ] **Step 4: Implement `usage.ts`**

```ts
// packages/daemon/src/routes/usage.ts
import type { Services } from '@penumbra/core';
import { recentCost, quotaStatus } from '@penumbra/core';
import { z } from 'zod';

const RecentInputSchema = z.object({
  since: z.string().datetime().optional(),
  project_id: z.string().min(1).nullable().optional(),
});

const QuotaInputSchema = z.object({
  since: z.string().datetime().optional(),
});

export async function usageRecentRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const parsed = RecentInputSchema.safeParse({
    since: url.searchParams.get('since') ?? undefined,
    project_id: url.searchParams.get('project_id') ?? undefined,
  });
  if (!parsed.success) {
    return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  }
  const result = recentCost(services.db, parsed.data, services.clock);
  return json(result);
}

export async function usageQuotaStatusRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const parsed = QuotaInputSchema.safeParse({
    since: url.searchParams.get('since') ?? undefined,
  });
  if (!parsed.success) {
    return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  }
  const result = quotaStatus(services.db, services.providerQuotas, parsed.data, services.clock);
  return json(result);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
```

- [ ] **Step 5: Wire routes into `serve.ts`**

Edit `packages/daemon/src/serve.ts`. Add the import alongside existing route imports:

```ts
import { usageRecentRoute, usageQuotaStatusRoute } from './routes/usage.js';
```

In the request dispatcher (look for the section that matches existing GET routes like `/recall`), add:

```ts
if (req.method === 'GET' && url.pathname === '/usage/recent') {
  return usageRecentRoute(req, services);
}
if (req.method === 'GET' && url.pathname === '/usage/quota_status') {
  return usageQuotaStatusRoute(req, services);
}
```

These should sit AFTER the bearer-token auth check (so the routes are protected; check the existing pattern — most read-only routes are wrapped uniformly).

- [ ] **Step 6: Re-run tests, full daemon suite, typecheck**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
bun test packages/daemon/test/routes/usage.test.ts && \
bun test packages/daemon && \
bun typecheck
```

- [ ] **Step 7: Commit**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
git add packages/daemon/src/routes/usage.ts packages/daemon/test/routes/usage.test.ts packages/daemon/src/serve.ts && \
git commit -m "feat(daemon): /usage/recent and /usage/quota_status HTTP routes"
```

---

## Task 8: MCP tools `cost.recent` and `cost.quota_status` (TDD)

**Files:**
- Create: `packages/mcp/src/tools/cost-recent.ts`
- Create: `packages/mcp/src/tools/cost-quota-status.ts`
- Create: `packages/mcp/test/tools/cost.test.ts`
- Modify: `packages/mcp/src/server.ts` (registration)

- [ ] **Step 1: Read existing tool registration pattern**

```bash
cat /Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/src/tools/recall.ts | head -40
grep -n "registerRecall\|tools/recall" /Volumes/WorkSSD/repos/personal/penumbra/packages/mcp/src/server.ts | head -5
```
Note the registerXyz function pattern + how it's called in server.ts.

- [ ] **Step 2: Add failing tests** (in `packages/mcp/test/tools/cost.test.ts`)

```ts
import { describe, it, expect } from 'bun:test';
import { CostRecentInputSchema } from '../../src/tools/cost-recent.js';
import { CostQuotaStatusInputSchema } from '../../src/tools/cost-quota-status.js';

describe('cost.recent input schema', () => {
  it('accepts no arguments', () => {
    expect(CostRecentInputSchema.safeParse({}).success).toBe(true);
  });
  it('rejects invalid since', () => {
    expect(CostRecentInputSchema.safeParse({ since: 'not-a-date' }).success).toBe(false);
  });
});

describe('cost.quota_status input schema', () => {
  it('accepts no arguments', () => {
    expect(CostQuotaStatusInputSchema.safeParse({}).success).toBe(true);
  });
});
```

- [ ] **Step 3: Run, confirm FAIL**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/mcp/test/tools/cost.test.ts
```

- [ ] **Step 4: Implement the tools — mirror the recall.ts pattern**

```ts
// packages/mcp/src/tools/cost-recent.ts
import { z } from 'zod';
import { recentCost, type Services } from '@penumbra/core';

export const CostRecentInputSchema = z.object({
  since: z.string().datetime().optional(),
  project_id: z.string().min(1).nullable().optional(),
});

export type CostRecentInput = z.infer<typeof CostRecentInputSchema>;

export function registerCostRecent(server: any, services: Services): void {
  server.tool(
    'cost.recent',
    'Returns the recent cost ledger summary (totals + by_provider) over a 24h-default window.',
    CostRecentInputSchema.shape,
    async (input: CostRecentInput) => {
      const out = recentCost(services.db, { since: input.since, projectId: input.project_id ?? null }, services.clock);
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    },
  );
}
```

```ts
// packages/mcp/src/tools/cost-quota-status.ts
import { z } from 'zod';
import { quotaStatus, type Services } from '@penumbra/core';

export const CostQuotaStatusInputSchema = z.object({
  since: z.string().datetime().optional(),
});

export type CostQuotaStatusInput = z.infer<typeof CostQuotaStatusInputSchema>;

export function registerCostQuotaStatus(server: any, services: Services): void {
  server.tool(
    'cost.quota_status',
    'Returns per-provider quota status: used vs configured 24h-rolling cost/token budgets.',
    CostQuotaStatusInputSchema.shape,
    async (input: CostQuotaStatusInput) => {
      const out = quotaStatus(services.db, services.providerQuotas, { since: input.since }, services.clock);
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    },
  );
}
```

(If the actual `server.tool(...)` signature in `recall.ts` differs, adjust to match — the goal is the same reader call wrapped in MCP's pattern.)

- [ ] **Step 5: Register in server.ts**

In `packages/mcp/src/server.ts`, alongside the `registerRecall(...)` call, add:

```ts
import { registerCostRecent } from './tools/cost-recent.js';
import { registerCostQuotaStatus } from './tools/cost-quota-status.js';
// ...
registerCostRecent(server, services);
registerCostQuotaStatus(server, services);
```

- [ ] **Step 6: Re-run, full mcp suite + typecheck**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
bun test packages/mcp && \
bun typecheck
```

- [ ] **Step 7: Commit**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
git add packages/mcp/src/tools/cost-recent.ts packages/mcp/src/tools/cost-quota-status.ts packages/mcp/test/tools/cost.test.ts packages/mcp/src/server.ts && \
git commit -m "feat(mcp): cost.recent and cost.quota_status tools"
```

---

## Task 9: `UsageReader` interface

**Files:**
- Create: `packages/agentchat/src/usage-readers/index.ts`

- [ ] **Step 1: Create the interface file**

```ts
// packages/agentchat/src/usage-readers/index.ts

export interface UsageReaderDelta {
  provider: string;
  model: string | null;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read?: number;
  tokens_cache_write?: number;
  /** USD cost for this delta. Null when source doesn't expose cost. */
  cost_usd: number | null;
  /** Time range covered by this delta (ISO8601). */
  window_start: string;
  window_end: string;
  /** Optional handoff_id correlation. Most local-state readers leave this null. */
  handoff_id?: string | null;
}

export interface RateLimitDelta {
  provider: string;
  /** "primary" | "secondary" for codex; "five_hour" | "seven_day" for claude statusline; etc. */
  window_label: string;
  used_pct: number;
  /** Window length in minutes. Optional — claude doesn't expose this directly. */
  window_minutes?: number;
  /** Unix seconds until the window resets. */
  resets_at?: number;
  /** Vendor-specific extra fields, captured for forensics. */
  extra?: Record<string, unknown>;
}

export interface UsageReaderResult {
  /** Opaque cursor that the poller persists; passed back on the next call. */
  cursor: unknown;
  /** Token + cost deltas, one per (provider, model) bucket. */
  usage_deltas: UsageReaderDelta[];
  /** Rate-limit window snapshots. Empty for readers that don't observe rate limits. */
  rate_limit_snapshots: RateLimitDelta[];
}

export interface UsageReader {
  /** Stable identifier (used as cursor key + source_kind suffix). */
  readonly id: string;
  /** Read backing state from `previousCursor` to "now"; return new cursor + deltas. */
  read(previousCursor: unknown | null): Promise<UsageReaderResult>;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun typecheck
```
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
git add packages/agentchat/src/usage-readers/index.ts && \
git commit -m "feat(agentchat): UsageReader interface for local-state usage capture"
```

---

## Task 10: Codex rollout JSONL reader (TDD, 5 tests)

**Files:**
- Create: `packages/agentchat/src/usage-readers/codex-rollout-reader.ts`
- Create: `packages/agentchat/test/usage-readers/codex-rollout-reader.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/agentchat/test/usage-readers/codex-rollout-reader.test.ts
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRolloutReader } from '../../src/usage-readers/codex-rollout-reader.js';

function writeRollout(dir: string, name: string, lines: object[]): string {
  const path = join(dir, name);
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

const tokenCountLine = (used_pct_primary: number, used_pct_secondary: number, resets_p = 1777364441, resets_s = 1777545224) => ({
  type: 'event_msg',
  timestamp: '2026-04-28T12:00:00Z',
  payload: {
    type: 'token_count',
    rate_limits: {
      limit_id: 'codex',
      primary:   { used_percent: used_pct_primary,   window_minutes: 300,   resets_at: resets_p },
      secondary: { used_percent: used_pct_secondary, window_minutes: 10080, resets_at: resets_s },
      plan_type: 'plus',
      rate_limit_reached_type: null,
    },
  },
});

describe('CodexRolloutReader', () => {
  it('emits one rate-limit-snapshot per window from the latest token_count event', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-rollout-'));
    const dayDir = join(root, '2026', '04', '28');
    mkdirSync(dayDir, { recursive: true });
    writeRollout(dayDir, 'rollout-2026-04-28T12-00-00-aaa.jsonl', [
      tokenCountLine(2.0, 30.0),
      tokenCountLine(3.0, 31.0), // latest
    ]);
    const reader = new CodexRolloutReader({ rootDir: root });
    const result = await reader.read(null);
    expect(result.rate_limit_snapshots).toHaveLength(2);
    const primary = result.rate_limit_snapshots.find(s => s.window_label === 'primary');
    expect(primary?.used_pct).toBe(3.0); // latest, not 2.0
    expect(primary?.window_minutes).toBe(300);
  });

  it('cursor persists byte_offset; second read with same file emits no new snapshots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-rollout-'));
    const dayDir = join(root, '2026', '04', '28');
    mkdirSync(dayDir, { recursive: true });
    const path = writeRollout(dayDir, 'rollout-2026-04-28T12-00-00-bbb.jsonl', [tokenCountLine(5.0, 40.0)]);
    const reader = new CodexRolloutReader({ rootDir: root });
    const r1 = await reader.read(null);
    expect(r1.rate_limit_snapshots).toHaveLength(2);
    const r2 = await reader.read(r1.cursor);
    expect(r2.rate_limit_snapshots).toHaveLength(0);
  });

  it('canonicalizes provider name to "openai"', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-rollout-'));
    const dayDir = join(root, '2026', '04', '28');
    mkdirSync(dayDir, { recursive: true });
    writeRollout(dayDir, 'rollout-2026-04-28T12-00-00-ccc.jsonl', [tokenCountLine(1.0, 1.0)]);
    const reader = new CodexRolloutReader({ rootDir: root });
    const r = await reader.read(null);
    expect(r.rate_limit_snapshots.every(s => s.provider === 'openai')).toBe(true);
  });

  it('skips corrupt lines, continues parsing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-rollout-'));
    const dayDir = join(root, '2026', '04', '28');
    mkdirSync(dayDir, { recursive: true });
    const path = join(dayDir, 'rollout-2026-04-28T12-00-00-ddd.jsonl');
    writeFileSync(path, [
      '{not valid json',
      JSON.stringify(tokenCountLine(7.0, 70.0)),
    ].join('\n') + '\n');
    const reader = new CodexRolloutReader({ rootDir: root });
    const r = await reader.read(null);
    expect(r.rate_limit_snapshots).toHaveLength(2);
    expect(r.rate_limit_snapshots.find(s => s.window_label === 'primary')?.used_pct).toBe(7.0);
  });

  it('returns empty result when root dir is absent', async () => {
    const reader = new CodexRolloutReader({ rootDir: '/tmp/this-does-not-exist-xyz' });
    const r = await reader.read(null);
    expect(r.rate_limit_snapshots).toHaveLength(0);
    expect(r.usage_deltas).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/agentchat/test/usage-readers/codex-rollout-reader.test.ts
```

- [ ] **Step 3: Implement the reader**

```ts
// packages/agentchat/src/usage-readers/codex-rollout-reader.ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { UsageReader, UsageReaderResult, RateLimitDelta, UsageReaderDelta } from './index.js';

export interface CodexRolloutReaderOptions {
  rootDir?: string;
}

interface FileCursor { byte_offset: number; mtime_ms: number; }
interface CodexRolloutCursor { files: Record<string, FileCursor>; }

export class CodexRolloutReader implements UsageReader {
  readonly id = 'codex-rollout';
  private rootDir: string;

  constructor(opts: CodexRolloutReaderOptions = {}) {
    this.rootDir = opts.rootDir ?? join(homedir(), '.codex', 'sessions');
  }

  async read(previousCursor: unknown | null): Promise<UsageReaderResult> {
    if (!existsSync(this.rootDir)) {
      return { cursor: previousCursor ?? { files: {} }, usage_deltas: [], rate_limit_snapshots: [] };
    }
    const cursor: CodexRolloutCursor = (previousCursor as CodexRolloutCursor | null) ?? { files: {} };
    const newCursor: CodexRolloutCursor = { files: { ...cursor.files } };

    const files = await this.listRolloutFiles();
    const allRateLimitSnapshots: RateLimitDelta[] = [];

    for (const filePath of files) {
      const fileCursor = newCursor.files[filePath];
      const stats = statSync(filePath);
      const mtime_ms = stats.mtimeMs;
      if (fileCursor && fileCursor.mtime_ms === mtime_ms && fileCursor.byte_offset >= stats.size) {
        continue;
      }
      const buf = readFileSync(filePath, 'utf8');
      const start = fileCursor?.byte_offset ?? 0;
      const slice = buf.slice(start);

      let latestRateLimits: any = null;
      for (const rawLine of slice.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        let obj: any;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj?.type === 'event_msg' && obj?.payload?.type === 'token_count' && obj?.payload?.rate_limits) {
          latestRateLimits = obj.payload.rate_limits;
        }
      }
      if (latestRateLimits) {
        for (const key of ['primary', 'secondary']) {
          const w = latestRateLimits[key];
          if (!w) continue;
          allRateLimitSnapshots.push({
            provider: this.canonicalizeProvider(latestRateLimits.limit_id),
            window_label: key,
            used_pct: Number(w.used_percent),
            window_minutes: typeof w.window_minutes === 'number' ? w.window_minutes : undefined,
            resets_at: typeof w.resets_at === 'number' ? w.resets_at : undefined,
            extra: { plan_type: latestRateLimits.plan_type, limit_id: latestRateLimits.limit_id },
          });
        }
      }
      newCursor.files[filePath] = { byte_offset: stats.size, mtime_ms };
    }

    // usage_deltas: per-turn token rollups from inference_completed events would go here.
    // For v1, we leave usage_deltas empty for codex — the rate_limits snapshot is the load-bearing signal.
    // A future enhancement can scan inference_completed events for per-turn input/output tokens.
    return { cursor: newCursor, usage_deltas: [], rate_limit_snapshots: allRateLimitSnapshots };
  }

  private async listRolloutFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = (dir: string) => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = (require('node:fs') as typeof import('node:fs')).readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.isFile() && ent.name.startsWith('rollout-') && ent.name.endsWith('.jsonl')) out.push(p);
      }
    };
    walk(this.rootDir);
    return out;
  }

  private canonicalizeProvider(limit_id: string | undefined): string {
    // codex uses 'codex' as the limit_id; canonicalize to upstream provider 'openai'
    if (!limit_id || limit_id === 'codex') return 'openai';
    return limit_id;
  }
}
```

- [ ] **Step 4: Re-run, confirm PASS**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/agentchat/test/usage-readers/codex-rollout-reader.test.ts
```
Expected: all 5 PASS.

- [ ] **Step 5: Run full agentchat suite + typecheck**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/agentchat && bun typecheck
```

- [ ] **Step 6: Commit**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
git add packages/agentchat/src/usage-readers/codex-rollout-reader.ts packages/agentchat/test/usage-readers/codex-rollout-reader.test.ts && \
git commit -m "feat(agentchat): CodexRolloutReader emits rate-limit snapshots from JSONL"
```

---

## Task 11: OpenCode db reader (TDD, 4 tests)

**Files:**
- Create: `packages/agentchat/src/usage-readers/opencode-db-reader.ts`
- Create: `packages/agentchat/test/usage-readers/opencode-db-reader.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/agentchat/test/usage-readers/opencode-db-reader.test.ts
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenCodeDbReader } from '../../src/usage-readers/opencode-db-reader.js';

function makeOpencodeDb(): { db: Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-db-'));
  const path = join(dir, 'opencode.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);`);
  return { db, path };
}

function insertAssistant(db: Database, id: string, time_created: number, body: any) {
  db.prepare(`INSERT INTO message VALUES (?, 'sess-1', ?, ?, ?)`).run(id, time_created, time_created, JSON.stringify(body));
}

describe('OpenCodeDbReader', () => {
  it('emits usage_deltas grouped by (provider, model) with cost_usd populated', async () => {
    const { db, path } = makeOpencodeDb();
    insertAssistant(db, 'm1', 1777421548000, { role: 'assistant', cost: 0.0011, tokens: { total: 500, input: 100, output: 200, reasoning: 50, cache: { read: 100, write: 50 } }, modelID: 'deepseek-v4-pro', providerID: 'opencode-go' });
    insertAssistant(db, 'm2', 1777421549000, { role: 'assistant', cost: 0.0013, tokens: { total: 600, input: 150, output: 250, reasoning: 60, cache: { read: 110, write: 30 } }, modelID: 'deepseek-v4-pro', providerID: 'opencode-go' });
    db.close();
    const reader = new OpenCodeDbReader({ dbPath: path });
    const r = await reader.read(null);
    expect(r.usage_deltas).toHaveLength(1);
    expect(r.usage_deltas[0].provider).toBe('opencode-go');
    expect(r.usage_deltas[0].model).toBe('deepseek-v4-pro');
    expect(r.usage_deltas[0].cost_usd).toBeCloseTo(0.0024, 4);
    expect(r.usage_deltas[0].tokens_input).toBe(250);
    expect(r.usage_deltas[0].tokens_output).toBe(450);
  });

  it('cursor advances by max time_created; second call returns nothing for same data', async () => {
    const { db, path } = makeOpencodeDb();
    insertAssistant(db, 'm1', 1777421548000, { role: 'assistant', cost: 0.001, tokens: { input: 10, output: 20 }, modelID: 'x', providerID: 'p' });
    db.close();
    const reader = new OpenCodeDbReader({ dbPath: path });
    const r1 = await reader.read(null);
    expect(r1.usage_deltas).toHaveLength(1);
    const r2 = await reader.read(r1.cursor);
    expect(r2.usage_deltas).toHaveLength(0);
  });

  it('skips rows missing tokens', async () => {
    const { db, path } = makeOpencodeDb();
    insertAssistant(db, 'm1', 1777421548000, { role: 'assistant', cost: 0, modelID: 'x', providerID: 'p' }); // no tokens
    insertAssistant(db, 'm2', 1777421549000, { role: 'assistant', cost: 0.5, tokens: { input: 1, output: 1 }, modelID: 'x', providerID: 'p' });
    db.close();
    const reader = new OpenCodeDbReader({ dbPath: path });
    const r = await reader.read(null);
    expect(r.usage_deltas).toHaveLength(1);
    expect(r.usage_deltas[0].tokens_input).toBe(1);
  });

  it('returns empty when db file is absent', async () => {
    const reader = new OpenCodeDbReader({ dbPath: '/tmp/no-such-opencode.db' });
    const r = await reader.read(null);
    expect(r.usage_deltas).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Implement the reader**

```ts
// packages/agentchat/src/usage-readers/opencode-db-reader.ts
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { UsageReader, UsageReaderResult, UsageReaderDelta } from './index.js';

export interface OpenCodeDbReaderOptions {
  dbPath?: string;
}

interface OpenCodeDbCursor { last_seen_time_created: number; }

export class OpenCodeDbReader implements UsageReader {
  readonly id = 'opencode-db';
  private dbPath: string;

  constructor(opts: OpenCodeDbReaderOptions = {}) {
    this.dbPath = opts.dbPath ?? join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  }

  async read(previousCursor: unknown | null): Promise<UsageReaderResult> {
    if (!existsSync(this.dbPath)) {
      return { cursor: previousCursor ?? { last_seen_time_created: 0 }, usage_deltas: [], rate_limit_snapshots: [] };
    }
    const cursor: OpenCodeDbCursor = (previousCursor as OpenCodeDbCursor | null) ?? { last_seen_time_created: 0 };
    const db = new Database(this.dbPath, { readonly: true });
    const rows = db.prepare(`SELECT id, time_created, data FROM message WHERE time_created > ? AND json_extract(data, '$.role') = 'assistant' ORDER BY time_created ASC`).all(cursor.last_seen_time_created) as Array<{ id: string; time_created: number; data: string }>;

    const buckets = new Map<string, UsageReaderDelta>();
    let max_tc = cursor.last_seen_time_created;
    for (const row of rows) {
      let body: any;
      try { body = JSON.parse(row.data); } catch { continue; }
      const tokens = body?.tokens;
      if (!tokens || typeof tokens !== 'object') continue;
      const provider = String(body.providerID ?? 'unknown');
      const model = body.modelID ?? null;
      const key = `${provider}\0${model ?? ''}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          provider, model,
          tokens_input: 0, tokens_output: 0, tokens_cache_read: 0, tokens_cache_write: 0,
          cost_usd: 0,
          window_start: new Date(row.time_created).toISOString(),
          window_end: new Date(row.time_created).toISOString(),
        };
        buckets.set(key, bucket);
      }
      bucket.tokens_input += Number(tokens.input ?? 0);
      bucket.tokens_output += Number(tokens.output ?? 0);
      bucket.tokens_cache_read = (bucket.tokens_cache_read ?? 0) + Number(tokens.cache?.read ?? 0);
      bucket.tokens_cache_write = (bucket.tokens_cache_write ?? 0) + Number(tokens.cache?.write ?? 0);
      bucket.cost_usd = (bucket.cost_usd ?? 0) + Number(body.cost ?? 0);
      bucket.window_end = new Date(row.time_created).toISOString();
      if (row.time_created > max_tc) max_tc = row.time_created;
    }
    db.close();

    return {
      cursor: { last_seen_time_created: max_tc } satisfies OpenCodeDbCursor,
      usage_deltas: [...buckets.values()],
      rate_limit_snapshots: [],
    };
  }
}
```

- [ ] **Step 4: Re-run, confirm PASS + full agentchat suite + typecheck**

- [ ] **Step 5: Commit**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
git add packages/agentchat/src/usage-readers/opencode-db-reader.ts packages/agentchat/test/usage-readers/opencode-db-reader.test.ts && \
git commit -m "feat(agentchat): OpenCodeDbReader emits cost+tokens from message.data"
```

---

## Task 12: Claude JSONL reader (TDD, 3 tests)

**Files:**
- Create: `packages/agentchat/src/usage-readers/claude-jsonl-reader.ts`
- Create: `packages/agentchat/test/usage-readers/claude-jsonl-reader.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/agentchat/test/usage-readers/claude-jsonl-reader.test.ts
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeJsonlReader } from '../../src/usage-readers/claude-jsonl-reader.js';

function setupProjectsDir(): { rootDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'claude-projects-'));
  return { rootDir: root };
}

function writeJsonl(rootDir: string, project: string, sessionId: string, lines: object[]): string {
  const projDir = join(rootDir, project);
  mkdirSync(projDir, { recursive: true });
  const path = join(projDir, `${sessionId}.jsonl`);
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

describe('ClaudeJsonlReader', () => {
  it('aggregates input + output tokens by model from assistant rows', async () => {
    const { rootDir } = setupProjectsDir();
    writeJsonl(rootDir, '-Volumes-WorkSSD-foo', 'sess-1', [
      { type: 'assistant', message: { model: 'claude-opus-4-7', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } } },
      { type: 'assistant', message: { model: 'claude-opus-4-7', usage: { input_tokens: 30, output_tokens: 40, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } } },
    ]);
    const reader = new ClaudeJsonlReader({ rootDir });
    const r = await reader.read(null);
    expect(r.usage_deltas).toHaveLength(1);
    expect(r.usage_deltas[0].provider).toBe('anthropic');
    expect(r.usage_deltas[0].model).toBe('claude-opus-4-7');
    expect(r.usage_deltas[0].tokens_input).toBe(40);
    expect(r.usage_deltas[0].tokens_output).toBe(60);
    expect(r.usage_deltas[0].tokens_cache_read).toBe(15);
    expect(r.usage_deltas[0].tokens_cache_write).toBe(2);
    expect(r.usage_deltas[0].cost_usd).toBeNull();
  });

  it('cursor advances by file byte_offset; second call returns nothing for same content', async () => {
    const { rootDir } = setupProjectsDir();
    writeJsonl(rootDir, '-foo', 'sess', [
      { type: 'assistant', message: { model: 'claude-opus-4-7', usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const reader = new ClaudeJsonlReader({ rootDir });
    const r1 = await reader.read(null);
    expect(r1.usage_deltas).toHaveLength(1);
    const r2 = await reader.read(r1.cursor);
    expect(r2.usage_deltas).toHaveLength(0);
  });

  it('skips non-assistant lines and rows without usage', async () => {
    const { rootDir } = setupProjectsDir();
    writeJsonl(rootDir, '-bar', 'sess', [
      { type: 'queue-operation', timestamp: '2026-04-28T12:00:00Z' },
      { type: 'user', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', message: { model: 'claude-opus-4-7' } }, // no usage
      { type: 'assistant', message: { model: 'claude-opus-4-7', usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const reader = new ClaudeJsonlReader({ rootDir });
    const r = await reader.read(null);
    expect(r.usage_deltas).toHaveLength(1);
    expect(r.usage_deltas[0].tokens_input).toBe(1);
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Implement the reader**

```ts
// packages/agentchat/src/usage-readers/claude-jsonl-reader.ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { UsageReader, UsageReaderResult, UsageReaderDelta } from './index.js';

export interface ClaudeJsonlReaderOptions {
  rootDir?: string;
}

interface FileCursor { byte_offset: number; mtime_ms: number; }
interface ClaudeJsonlCursor { files: Record<string, FileCursor>; }

export class ClaudeJsonlReader implements UsageReader {
  readonly id = 'claude-jsonl';
  private rootDir: string;

  constructor(opts: ClaudeJsonlReaderOptions = {}) {
    this.rootDir = opts.rootDir ?? join(homedir(), '.claude', 'projects');
  }

  async read(previousCursor: unknown | null): Promise<UsageReaderResult> {
    if (!existsSync(this.rootDir)) {
      return { cursor: previousCursor ?? { files: {} }, usage_deltas: [], rate_limit_snapshots: [] };
    }
    const cursor: ClaudeJsonlCursor = (previousCursor as ClaudeJsonlCursor | null) ?? { files: {} };
    const newCursor: ClaudeJsonlCursor = { files: { ...cursor.files } };

    const buckets = new Map<string, UsageReaderDelta>();
    const projectDirs = readdirSync(this.rootDir, { withFileTypes: true }).filter(d => d.isDirectory());

    for (const projDir of projectDirs) {
      const projectPath = join(this.rootDir, projDir.name);
      let files: import('node:fs').Dirent[];
      try { files = readdirSync(projectPath, { withFileTypes: true }); } catch { continue; }
      for (const fEnt of files) {
        if (!fEnt.isFile() || !fEnt.name.endsWith('.jsonl')) continue;
        const filePath = join(projectPath, fEnt.name);
        const stats = statSync(filePath);
        const fileCursor = newCursor.files[filePath];
        if (fileCursor && fileCursor.byte_offset >= stats.size) continue;
        const buf = readFileSync(filePath, 'utf8');
        const slice = buf.slice(fileCursor?.byte_offset ?? 0);
        for (const rawLine of slice.split('\n')) {
          const line = rawLine.trim();
          if (!line) continue;
          let obj: any;
          try { obj = JSON.parse(line); } catch { continue; }
          if (obj?.type !== 'assistant') continue;
          const usage = obj?.message?.usage;
          if (!usage) continue;
          const model = obj?.message?.model ?? null;
          const key = `anthropic\0${model ?? ''}`;
          let b = buckets.get(key);
          if (!b) {
            b = {
              provider: 'anthropic', model,
              tokens_input: 0, tokens_output: 0, tokens_cache_read: 0, tokens_cache_write: 0,
              cost_usd: null,
              window_start: new Date().toISOString(),
              window_end: new Date().toISOString(),
            };
            buckets.set(key, b);
          }
          b.tokens_input += Number(usage.input_tokens ?? 0);
          b.tokens_output += Number(usage.output_tokens ?? 0);
          b.tokens_cache_read = (b.tokens_cache_read ?? 0) + Number(usage.cache_read_input_tokens ?? 0);
          b.tokens_cache_write = (b.tokens_cache_write ?? 0) + Number(usage.cache_creation_input_tokens ?? 0);
        }
        newCursor.files[filePath] = { byte_offset: stats.size, mtime_ms: stats.mtimeMs };
      }
    }
    return { cursor: newCursor, usage_deltas: [...buckets.values()], rate_limit_snapshots: [] };
  }
}
```

- [ ] **Step 4: Re-run, full agentchat + typecheck**

- [ ] **Step 5: Commit**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
git add packages/agentchat/src/usage-readers/claude-jsonl-reader.ts packages/agentchat/test/usage-readers/claude-jsonl-reader.test.ts && \
git commit -m "feat(agentchat): ClaudeJsonlReader aggregates token usage from transcripts"
```

---

## Task 13: Claude statusLine bridge reader (TDD, 3 tests)

**Files:**
- Create: `packages/agentchat/src/usage-readers/claude-statusline-bridge.ts`
- Create: `packages/agentchat/test/usage-readers/claude-statusline-bridge.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/agentchat/test/usage-readers/claude-statusline-bridge.test.ts
import { describe, it, expect } from 'bun:test';
import { writeFileSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeStatusLineBridge } from '../../src/usage-readers/claude-statusline-bridge.js';

function tmpCache(): string {
  return join(mkdtempSync(join(tmpdir(), 'claude-rl-')), 'rl.json');
}

describe('ClaudeStatusLineBridge', () => {
  it('emits one rate-limit-snapshot per window with provider=anthropic', async () => {
    const path = tmpCache();
    writeFileSync(path, JSON.stringify({
      five_hour: { used_percentage: 30, resets_at: 1777364441 },
      seven_day: { used_percentage: 50, resets_at: 1777545224 },
    }));
    const reader = new ClaudeStatusLineBridge({ cachePath: path });
    const r = await reader.read(null);
    expect(r.rate_limit_snapshots).toHaveLength(2);
    expect(r.rate_limit_snapshots.every(s => s.provider === 'anthropic')).toBe(true);
    expect(r.rate_limit_snapshots.find(s => s.window_label === 'five_hour')?.used_pct).toBe(30);
    expect(r.rate_limit_snapshots.find(s => s.window_label === 'seven_day')?.used_pct).toBe(50);
  });

  it('accepts utilization as alternate field name', async () => {
    const path = tmpCache();
    writeFileSync(path, JSON.stringify({
      five_hour: { utilization: 25, resets_at: 1777364441 },
    }));
    const reader = new ClaudeStatusLineBridge({ cachePath: path });
    const r = await reader.read(null);
    expect(r.rate_limit_snapshots).toHaveLength(1);
    expect(r.rate_limit_snapshots[0].used_pct).toBe(25);
  });

  it('does not re-emit when file mtime is unchanged', async () => {
    const path = tmpCache();
    writeFileSync(path, JSON.stringify({ five_hour: { used_percentage: 10, resets_at: 1 } }));
    const reader = new ClaudeStatusLineBridge({ cachePath: path });
    const r1 = await reader.read(null);
    expect(r1.rate_limit_snapshots).toHaveLength(1);
    const r2 = await reader.read(r1.cursor);
    expect(r2.rate_limit_snapshots).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Implement the reader**

```ts
// packages/agentchat/src/usage-readers/claude-statusline-bridge.ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { UsageReader, UsageReaderResult, RateLimitDelta } from './index.js';

export interface ClaudeStatusLineBridgeOptions {
  cachePath?: string;
}

interface BridgeCursor { last_seen_mtime_ms: number; }

const DEFAULT_CACHE_PATH = process.env.PENUMBRA_CLAUDE_RL_PATH ?? '/tmp/penumbra-claude-rl.json';

export class ClaudeStatusLineBridge implements UsageReader {
  readonly id = 'claude-statusline';
  private cachePath: string;

  constructor(opts: ClaudeStatusLineBridgeOptions = {}) {
    this.cachePath = opts.cachePath ?? DEFAULT_CACHE_PATH;
  }

  async read(previousCursor: unknown | null): Promise<UsageReaderResult> {
    if (!existsSync(this.cachePath)) {
      return { cursor: previousCursor ?? { last_seen_mtime_ms: 0 }, usage_deltas: [], rate_limit_snapshots: [] };
    }
    const cursor: BridgeCursor = (previousCursor as BridgeCursor | null) ?? { last_seen_mtime_ms: 0 };
    const stats = statSync(this.cachePath);
    if (stats.mtimeMs <= cursor.last_seen_mtime_ms) {
      return { cursor, usage_deltas: [], rate_limit_snapshots: [] };
    }
    let body: any;
    try { body = JSON.parse(readFileSync(this.cachePath, 'utf8')); } catch {
      return { cursor: { last_seen_mtime_ms: stats.mtimeMs }, usage_deltas: [], rate_limit_snapshots: [] };
    }
    const snapshots: RateLimitDelta[] = [];
    for (const key of ['five_hour', 'seven_day']) {
      const w = body?.[key];
      if (!w) continue;
      const used_pct = Number(w.used_percentage ?? w.utilization);
      if (!Number.isFinite(used_pct)) continue;
      snapshots.push({
        provider: 'anthropic',
        window_label: key,
        used_pct,
        resets_at: typeof w.resets_at === 'number' ? w.resets_at : undefined,
      });
    }
    return { cursor: { last_seen_mtime_ms: stats.mtimeMs }, usage_deltas: [], rate_limit_snapshots: snapshots };
  }
}
```

- [ ] **Step 4: Re-run, full agentchat + typecheck**

- [ ] **Step 5: Commit**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
git add packages/agentchat/src/usage-readers/claude-statusline-bridge.ts packages/agentchat/test/usage-readers/claude-statusline-bridge.test.ts && \
git commit -m "feat(agentchat): ClaudeStatusLineBridge reads /tmp/penumbra-claude-rl.json"
```

---

## Task 14: Usage poller + cursor persistence (TDD, 2 tests)

**Files:**
- Create: `packages/agentchat/src/usage-readers/poller.ts`
- Create: `packages/agentchat/test/usage-readers/poller.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/agentchat/test/usage-readers/poller.test.ts
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startUsagePoller } from '../../src/usage-readers/poller.js';
import type { UsageReader, UsageReaderResult } from '../../src/usage-readers/index.js';

class StubReader implements UsageReader {
  readonly id: string;
  reads = 0;
  next: UsageReaderResult;
  constructor(id: string, next: UsageReaderResult) { this.id = id; this.next = next; }
  async read(_prev: unknown | null) { this.reads++; return this.next; }
}

class ThrowingReader implements UsageReader {
  readonly id = 'throws';
  reads = 0;
  async read() { this.reads++; throw new Error('boom'); }
}

describe('startUsagePoller', () => {
  it('runs all readers and persists cursors atomically', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poller-'));
    const cursorPath = join(dir, 'cursors.json');
    const reader = new StubReader('a', {
      cursor: { x: 42 },
      usage_deltas: [{ provider: 'p', model: 'm', tokens_input: 1, tokens_output: 2, cost_usd: 0.5, window_start: '', window_end: '' }],
      rate_limit_snapshots: [],
    });
    const observed: any[] = [];
    const poller = startUsagePoller({
      readers: [reader],
      intervalMs: 30_000, // long; we trigger manually
      cursorPath,
      emit: async (e) => { observed.push(e); return { event_id: 'x' }; },
      log: { info: () => {}, error: () => {} },
    });
    await (poller as any).runOnce();
    poller.stop();
    expect(reader.reads).toBe(1);
    expect(observed).toHaveLength(1);
    expect(observed[0].event_type).toBe('usage-update');
    expect(observed[0].payload_json.source_kind).toBe('local-state-a');
    const persisted = JSON.parse(readFileSync(cursorPath, 'utf8'));
    expect(persisted.a).toEqual({ x: 42 });
  });

  it('isolates failures: one reader throws, others still run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poller-'));
    const cursorPath = join(dir, 'cursors.json');
    const ok = new StubReader('ok', { cursor: { y: 1 }, usage_deltas: [], rate_limit_snapshots: [] });
    const bad = new ThrowingReader();
    const poller = startUsagePoller({
      readers: [bad, ok],
      intervalMs: 30_000,
      cursorPath,
      emit: async () => ({ event_id: 'x' }),
      log: { info: () => {}, error: () => {} },
    });
    await (poller as any).runOnce();
    poller.stop();
    expect(bad.reads).toBe(1);
    expect(ok.reads).toBe(1);
    const persisted = JSON.parse(readFileSync(cursorPath, 'utf8'));
    expect(persisted.ok).toEqual({ y: 1 });
    expect(persisted.throws).toBeUndefined(); // failed reader doesn't update cursor
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Implement the poller**

```ts
// packages/agentchat/src/usage-readers/poller.ts
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import type { UsageReader, UsageReaderResult, UsageReaderDelta, RateLimitDelta } from './index.js';

export interface PollerOptions {
  readers: UsageReader[];
  intervalMs?: number;
  cursorPath: string;
  emit: (event: any) => Promise<{ event_id: string }>;
  log: { info: (m: any, ...rest: any[]) => void; error: (m: any, ...rest: any[]) => void };
}

export interface PollerHandle {
  stop: () => void;
  runOnce: () => Promise<void>;
}

export function startUsagePoller(opts: PollerOptions): PollerHandle {
  const intervalMs = opts.intervalMs ?? 60_000;
  let cursors: Record<string, unknown> = {};
  if (existsSync(opts.cursorPath)) {
    try { cursors = JSON.parse(readFileSync(opts.cursorPath, 'utf8')); } catch (err) {
      opts.log.error({ err: String(err), path: opts.cursorPath }, 'usage-poller: cursor file corrupt; recreating');
      cursors = {};
    }
  }

  const persist = () => {
    const tmp = `${opts.cursorPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(cursors));
    renameSync(tmp, opts.cursorPath);
  };

  const runOnce = async () => {
    for (const reader of opts.readers) {
      try {
        const prev = cursors[reader.id] ?? null;
        const result = await reader.read(prev);
        await emitDeltas(reader.id, result, opts.emit, opts.log);
        cursors[reader.id] = result.cursor;
        persist();
      } catch (err) {
        opts.log.error({ err: String(err), reader: reader.id }, 'usage-poller: reader failed');
      }
    }
  };

  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    runOnce().catch(err => opts.log.error({ err: String(err) }, 'usage-poller: tick failed'));
  }, intervalMs);
  if (timer && typeof (timer as any).unref === 'function') (timer as any).unref();

  return {
    stop: () => {
      if (timer) { clearInterval(timer); timer = null; }
    },
    runOnce,
  };
}

async function emitDeltas(
  readerId: string,
  result: UsageReaderResult,
  emit: PollerOptions['emit'],
  log: PollerOptions['log'],
): Promise<void> {
  for (const d of result.usage_deltas) {
    const ev = baseEvent('usage-update', readerId, d.provider, d.model);
    ev.cost_usd = d.cost_usd;
    ev.payload_json = {
      handoff_id: d.handoff_id ?? null,
      used: (d.tokens_input ?? 0) + (d.tokens_output ?? 0),
      tokens_input: d.tokens_input,
      tokens_output: d.tokens_output,
      tokens_cache_read: d.tokens_cache_read ?? 0,
      tokens_cache_write: d.tokens_cache_write ?? 0,
      window_start: d.window_start,
      window_end: d.window_end,
      source_kind: `local-state-${readerId}`,
    };
    ev.payload_summary = `${d.provider}/${d.model ?? '?'}: ${ev.payload_json.used} tokens`;
    try { await emit(ev); } catch (err) {
      log.error({ err: String(err), readerId }, 'usage-poller: emit failed');
    }
  }
  for (const r of result.rate_limit_snapshots) {
    const ev = baseEvent('rate-limit-snapshot', readerId, r.provider, null);
    ev.cost_usd = null;
    ev.payload_json = {
      window_label: r.window_label,
      used_pct: r.used_pct,
      window_minutes: r.window_minutes,
      resets_at: r.resets_at,
      extra: r.extra,
      source_kind: `local-state-${readerId}`,
    };
    ev.payload_summary = `${r.provider}/${r.window_label}: ${r.used_pct}%`;
    try { await emit(ev); } catch (err) {
      log.error({ err: String(err), readerId }, 'usage-poller: emit failed');
    }
  }
}

function baseEvent(eventType: string, readerId: string, provider: string, model: string | null): any {
  return {
    ts: new Date().toISOString(),
    source: 'agentchat',
    source_detail: `usage-poller-${readerId}`,
    user_id: 'local-user',
    machine_id: 'local',
    event_type: eventType,
    lane: 'cli-subscription',
    provider,
    model,
    payload_json: {},
    payload_summary: '',
  };
}
```

- [ ] **Step 4: Re-run, full agentchat + typecheck**

- [ ] **Step 5: Commit**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
git add packages/agentchat/src/usage-readers/poller.ts packages/agentchat/test/usage-readers/poller.test.ts && \
git commit -m "feat(agentchat): usage poller with per-reader cursor persistence"
```

---

## Task 15: Worker singleton wiring

**Files:**
- Modify: `packages/agentchat/bin/agentchat-worker.ts`

- [ ] **Step 1: Read the current worker bin to find the right insertion point**

```bash
grep -n "loadConfig\|workerId\|worker_id\|main()\|start()" /Volumes/WorkSSD/repos/personal/penumbra/packages/agentchat/bin/agentchat-worker.ts | head -10
```

- [ ] **Step 2: Add the poller startup conditional**

After the worker startup logging line (look for `'agentchat worker started'`), add:

```ts
import { startUsagePoller } from '../src/usage-readers/poller.js';
import { CodexRolloutReader } from '../src/usage-readers/codex-rollout-reader.js';
import { OpenCodeDbReader } from '../src/usage-readers/opencode-db-reader.js';
import { ClaudeJsonlReader } from '../src/usage-readers/claude-jsonl-reader.js';
import { ClaudeStatusLineBridge } from '../src/usage-readers/claude-statusline-bridge.js';

// ... after worker start log, in the same async main() function ...

let usagePoller: { stop: () => void } | null = null;
if (workerId === 'worker-primary') {
  usagePoller = startUsagePoller({
    readers: [
      new CodexRolloutReader(),
      new OpenCodeDbReader(),
      new ClaudeJsonlReader(),
      new ClaudeStatusLineBridge(),
    ],
    intervalMs: Number(process.env.PENUMBRA_USAGE_POLL_INTERVAL_MS) || 60_000,
    cursorPath: join(storageRoot, 'local-state-cursors.json'),
    emit: client.observe.bind(client),
    log,
  });
  log.info({ readers: 4 }, 'usage-poller started (worker-primary)');
}

process.on('SIGTERM', () => {
  usagePoller?.stop();
});
process.on('SIGINT', () => {
  usagePoller?.stop();
});
```

(Adapt to whatever variables exist: `workerId`, `storageRoot`, `client`, `log` — replace if names differ in current file.)

- [ ] **Step 3: Typecheck**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun typecheck
```

- [ ] **Step 4: Run agentchat suite**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/agentchat
```

- [ ] **Step 5: Commit**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
git add packages/agentchat/bin/agentchat-worker.ts && \
git commit -m "feat(agentchat-worker): start usage-poller singleton on worker-primary"
```

---

## Task 16: agentchat.yaml `providers:` block + config schema parse

**Files:**
- Modify: `packages/agentchat/src/config.ts` (or wherever yaml is parsed)
- Modify: `packages/daemon/src/start.ts` (read providers and pass to buildServices)
- Modify: `~/.config/agentchat/agentchat.yaml` (operator config; not git-tracked)

- [ ] **Step 1: Find the existing yaml schema parser**

```bash
grep -n "loadConfig\|parseYaml\|agentchat.yaml" /Volumes/WorkSSD/repos/personal/penumbra/packages/agentchat/src/config.ts /Volumes/WorkSSD/repos/personal/penumbra/packages/daemon/src 2>/dev/null | head -15
```

- [ ] **Step 2: Add `providers` field to agentchat config schema**

In `packages/agentchat/src/config.ts`, find the top-level zod schema (likely something like `ConfigSchema` with `agents: z.array(...)`). Add a parallel field:

```ts
import { z } from 'zod';

export const ProviderQuotaSchema = z.object({
  name: z.string().min(1),
  quota_usd_per_24h: z.number().positive().optional(),
  quota_tokens_per_24h: z.number().int().positive().optional(),
});

// In the existing top-level schema, add:
//   providers: z.array(ProviderQuotaSchema).optional(),
```

Update the loader to expose `providers` on the loaded config object.

- [ ] **Step 3: Pass `providers` into buildServices in daemon startup**

In `packages/daemon/src/start.ts` (or `serve.ts` startup):

```ts
import { homedir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

let providerQuotas: Array<{ provider: string; quota_usd_per_24h?: number; quota_tokens_per_24h?: number }> = [];
const agentchatYamlPath = process.env.AGENTCHAT_CONFIG ?? join(homedir(), '.config/agentchat/agentchat.yaml');
if (existsSync(agentchatYamlPath)) {
  try {
    const raw = parseYaml(readFileSync(agentchatYamlPath, 'utf8')) as any;
    if (Array.isArray(raw?.providers)) {
      providerQuotas = raw.providers.map((p: any) => ({
        provider: p.name,
        quota_usd_per_24h: p.quota_usd_per_24h,
        quota_tokens_per_24h: p.quota_tokens_per_24h,
      }));
    }
  } catch (err) {
    log.error({ err: String(err) }, 'daemon: failed to parse providers from agentchat.yaml; using empty list');
  }
}

// Pass to buildServices:
const services = buildServices({
  // ... existing fields ...
  providerQuotas,
});
```

- [ ] **Step 4: Edit `~/.config/agentchat/agentchat.yaml`**

Add a top-level `providers:` block (paste this verbatim at the very end of the file or near the top — yaml allows either):

```yaml
providers:
  - name: anthropic
    quota_usd_per_24h: 50.00
  - name: openai
    quota_tokens_per_24h: 1000000
  - name: google
    quota_usd_per_24h: 25.00
  - name: opencode-go
    quota_usd_per_24h: 10.00
```

- [ ] **Step 5: Restart the daemon to pick up the new config**

```bash
kill -TERM $(cat /tmp/penumbra-live/pid)
sleep 3
PENUMBRA_STORAGE_ROOT=/tmp/penumbra-live bun packages/cli/bin/penumbra.ts start --detach
sleep 4
cat /tmp/penumbra-live/pid
```

Expected: new PID written; daemon HTTP responsive.

- [ ] **Step 6: Smoke test the daemon HTTP route**

```bash
TOKEN=$(cat /tmp/penumbra-live/token)
PORT=$(cat /tmp/penumbra-live/port)
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/usage/quota_status" | python3 -m json.tool
```

Expected: JSON response with the 4 configured providers (used=0, full quota remaining for each — no usage data captured yet).

- [ ] **Step 7: Run full suite + typecheck**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test && bun typecheck
```

- [ ] **Step 8: Commit (code only — yaml is operator config)**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
git add packages/agentchat/src/config.ts packages/daemon/src/start.ts && \
git commit -m "feat(agentchat,daemon): providers config block flows from yaml to Services"
```

---

## Task 17: `penumbra cost recent` and `penumbra cost quota` CLI (TDD, 3 tests)

**Files:**
- Create: `packages/cli/src/commands/cost.ts`
- Create: `packages/cli/test/commands/cost.test.ts`
- Modify: `packages/cli/bin/penumbra.ts` (subcommand wiring)

- [ ] **Step 1: Write failing tests**

```ts
// packages/cli/test/commands/cost.test.ts
import { describe, it, expect } from 'bun:test';
import { runCostRecent, runCostQuota, parseDuration } from '../../src/commands/cost.js';

describe('parseDuration', () => {
  it('parses Nh', () => { expect(parseDuration('24h')).toBe(24 * 60 * 60 * 1000); });
  it('parses Nm', () => { expect(parseDuration('30m')).toBe(30 * 60 * 1000); });
  it('parses Nd', () => { expect(parseDuration('2d')).toBe(2 * 24 * 60 * 60 * 1000); });
});

describe('runCostRecent', () => {
  it('--json prints raw RecentCostOutput shape', async () => {
    let printed = '';
    const out = await runCostRecent({
      since: '24h',
      json: true,
      fetch: async () => new Response(JSON.stringify({ total_cost_usd: 0.42, total_tokens_used: 100, handoff_count: 1, by_provider: [], window: { from: 'a', to: 'b' } }), { status: 200 }),
      print: (s: string) => { printed = s; },
    });
    expect(JSON.parse(printed).total_cost_usd).toBe(0.42);
  });
});

describe('runCostQuota', () => {
  it('prints a table with providers', async () => {
    let printed = '';
    await runCostQuota({
      since: undefined,
      json: false,
      fetch: async () => new Response(JSON.stringify({
        window: { from: 'x', to: 'y' },
        providers: [{ provider: 'anthropic', used_usd: 12.4, quota_usd: 50, remaining_usd: 37.6, remaining_pct_usd: 75.2, used_tokens: 0, quota_tokens: null, remaining_tokens: null, remaining_pct_tokens: null }],
      }), { status: 200 }),
      print: (s: string) => { printed += s + '\n'; },
    });
    expect(printed).toContain('anthropic');
    expect(printed).toContain('75.2');
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Implement `cost.ts`**

```ts
// packages/cli/src/commands/cost.ts
import { resolveDaemonStorageRoot } from '@penumbra/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function parseDuration(input: string): number {
  const m = /^(\d+)([smhd])$/.exec(input);
  if (!m) {
    if (/^\d{4}-\d{2}-\d{2}T/.test(input)) {
      return Date.now() - new Date(input).getTime();
    }
    throw new Error(`Invalid duration: ${input}`);
  }
  const n = Number(m[1]);
  const unit = m[2];
  const mult: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * mult[unit];
}

interface RunOpts {
  since?: string;
  json: boolean;
  fetch?: typeof fetch;
  print?: (s: string) => void;
  storageRoot?: string;
}

function resolveDaemon(storageRoot?: string): { baseUrl: string; token: string } {
  const root = storageRoot ?? resolveDaemonStorageRoot();
  const port = readFileSync(join(root, 'port'), 'utf8').trim();
  const token = readFileSync(join(root, 'token'), 'utf8').trim();
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

export async function runCostRecent(opts: RunOpts & { project_id?: string | null }): Promise<void> {
  const fetcher = opts.fetch ?? fetch;
  const print = opts.print ?? ((s: string) => process.stdout.write(s + '\n'));
  let url: string;
  let headers: Record<string, string> = {};
  if (opts.fetch) {
    url = '/usage/recent';
  } else {
    const daemon = resolveDaemon(opts.storageRoot);
    const sinceISO = opts.since ? new Date(Date.now() - parseDuration(opts.since)).toISOString() : undefined;
    const params = new URLSearchParams();
    if (sinceISO) params.set('since', sinceISO);
    if (opts.project_id) params.set('project_id', opts.project_id);
    url = `${daemon.baseUrl}/usage/recent${params.toString() ? '?' + params.toString() : ''}`;
    headers = { authorization: `Bearer ${daemon.token}` };
  }
  const res = await fetcher(url, { headers });
  if (!res.ok) { print(`error: HTTP ${res.status}`); return; }
  const body: any = await res.json();
  if (opts.json) {
    print(JSON.stringify(body, null, 2));
    return;
  }
  print(`Cost ledger — window ${body.window.from} → ${body.window.to}`);
  print('');
  print(`  Total: $${(body.total_cost_usd ?? 0).toFixed(4)}  (${body.total_tokens_used} tokens, ${body.handoff_count} dispatches)`);
  print('  ────────────────────────────────────');
  print('  By provider:');
  for (const p of body.by_provider) {
    const cost = p.cost_usd === null ? '   —   ' : `$${p.cost_usd.toFixed(4)}`;
    print(`    ${p.provider?.padEnd(14) ?? '(unknown)     '} ${cost}  (${p.tokens_used} tokens, ${p.handoff_count})`);
  }
}

export async function runCostQuota(opts: RunOpts): Promise<void> {
  const fetcher = opts.fetch ?? fetch;
  const print = opts.print ?? ((s: string) => process.stdout.write(s + '\n'));
  let url: string;
  let headers: Record<string, string> = {};
  if (opts.fetch) {
    url = '/usage/quota_status';
  } else {
    const daemon = resolveDaemon(opts.storageRoot);
    url = `${daemon.baseUrl}/usage/quota_status`;
    headers = { authorization: `Bearer ${daemon.token}` };
  }
  const res = await fetcher(url, { headers });
  if (!res.ok) { print(`error: HTTP ${res.status}`); return; }
  const body: any = await res.json();
  if (opts.json) { print(JSON.stringify(body, null, 2)); return; }
  print(`Quota status — 24h rolling`);
  print('');
  for (const p of body.providers) {
    if (p.quota_usd != null) {
      print(`  ${p.provider.padEnd(14)} $${p.used_usd.toFixed(2)} / $${p.quota_usd.toFixed(2)}   (${p.remaining_pct_usd}% remaining)`);
    } else if (p.quota_tokens != null) {
      print(`  ${p.provider.padEnd(14)} ${p.used_tokens} / ${p.quota_tokens} tokens   (${p.remaining_pct_tokens}% remaining)`);
    }
  }
}
```

- [ ] **Step 4: Wire subcommand into `packages/cli/bin/penumbra.ts`**

Add a `case 'cost': ...` block. Branches: `recent` (calls runCostRecent), `quota` (calls runCostQuota). Parse `--since`, `--project-id`, `--json` flags using whatever flag-parsing helper the existing CLI uses.

- [ ] **Step 5: Re-run tests, full suite, typecheck**

- [ ] **Step 6: Commit**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
git add packages/cli/src/commands/cost.ts packages/cli/test/commands/cost.test.ts packages/cli/bin/penumbra.ts && \
git commit -m "feat(cli): penumbra cost recent and penumbra cost quota commands"
```

---

## Task 18: `penumbra hooks install/uninstall/status` CLI (TDD, 5 tests)

**Files:**
- Create: `packages/cli/src/commands/hooks.ts`
- Create: `packages/cli/test/commands/hooks.test.ts`
- Modify: `packages/cli/bin/penumbra.ts` (subcommand wiring)

- [ ] **Step 1: Write failing tests**

```ts
// packages/cli/test/commands/hooks.test.ts
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHooksInstallClaude, runHooksUninstallClaude } from '../../src/commands/hooks.js';

function tmpClaudeDir(initial?: any): string {
  const root = mkdtempSync(join(tmpdir(), 'penumbra-hooks-'));
  const claudeDir = join(root, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  if (initial !== undefined) writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(initial));
  return claudeDir;
}

describe('hooks install --claude', () => {
  it('installs penumbra statusline when no statusLine is configured', async () => {
    const claudeDir = tmpClaudeDir({});
    const scriptDir = mkdtempSync(join(tmpdir(), 'penumbra-bin-'));
    const result = await runHooksInstallClaude({ claudeDir, scriptDir, force: false });
    expect(result.installed).toBe(true);
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.statusLine.command).toContain('penumbra-claude-statusline');
    expect(existsSync(join(scriptDir, 'penumbra-claude-statusline'))).toBe(true);
  });

  it('is idempotent when penumbra is already installed', async () => {
    const scriptDir = mkdtempSync(join(tmpdir(), 'penumbra-bin-'));
    const claudeDir = tmpClaudeDir({ statusLine: { command: join(scriptDir, 'penumbra-claude-statusline') } });
    const result = await runHooksInstallClaude({ claudeDir, scriptDir, force: false });
    expect(result.installed).toBe(false);
    expect(result.idempotent).toBe(true);
  });

  it('refuses to overwrite a third-party statusLine without --force', async () => {
    const claudeDir = tmpClaudeDir({ statusLine: { command: '/some/other/script.sh' } });
    const scriptDir = mkdtempSync(join(tmpdir(), 'penumbra-bin-'));
    await expect(runHooksInstallClaude({ claudeDir, scriptDir, force: false }))
      .rejects.toThrow(/Refusing to overwrite|--force/);
  });

  it('with --force, backs up the existing statusLine and replaces it', async () => {
    const claudeDir = tmpClaudeDir({ statusLine: { command: '/oi/script.sh' } });
    const scriptDir = mkdtempSync(join(tmpdir(), 'penumbra-bin-'));
    const result = await runHooksInstallClaude({ claudeDir, scriptDir, force: true });
    expect(result.installed).toBe(true);
    expect(result.backupPath).toBeDefined();
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.statusLine.command).toContain('penumbra-claude-statusline');
    expect(existsSync(result.backupPath!)).toBe(true);
  });
});

describe('hooks uninstall --claude', () => {
  it('removes penumbra statusLine but does not touch backup file', async () => {
    const scriptDir = mkdtempSync(join(tmpdir(), 'penumbra-bin-'));
    const claudeDir = tmpClaudeDir({ statusLine: { command: join(scriptDir, 'penumbra-claude-statusline') } });
    const r = await runHooksUninstallClaude({ claudeDir, scriptDir });
    expect(r.removed).toBe(true);
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    expect(settings.statusLine).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Implement `hooks.ts`**

```ts
// packages/cli/src/commands/hooks.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STATUSLINE_SCRIPT = `#!/bin/bash
# Penumbra Claude Code statusLine integration
# Writes only to penumbra's own cache. Self-contained.
input=$(cat)
_rl=$(echo "$input" | jq -c '.rate_limits // empty' 2>/dev/null)
if [ -n "$_rl" ]; then
  tmpf=$(mktemp /tmp/penumbra-claude-rl.XXXXXX.json)
  printf '%s\\n' "$_rl" > "$tmpf"
  mv -f "$tmpf" /tmp/penumbra-claude-rl.json
fi
echo "$input" | jq -r '"[\\(.model.display_name // \\"Claude\\")] \\(.context_window.used_percentage // 0)% context"' 2>/dev/null
`;

export interface InstallClaudeOpts {
  claudeDir?: string;
  scriptDir?: string;
  force?: boolean;
}

export interface InstallClaudeResult {
  installed: boolean;
  idempotent?: boolean;
  scriptPath: string;
  backupPath?: string;
}

export async function runHooksInstallClaude(opts: InstallClaudeOpts = {}): Promise<InstallClaudeResult> {
  const claudeDir = opts.claudeDir ?? join(homedir(), '.claude');
  const scriptDir = opts.scriptDir ?? join(homedir(), '.penumbra', 'bin');
  const scriptPath = join(scriptDir, 'penumbra-claude-statusline');
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(scriptPath, STATUSLINE_SCRIPT);
  chmodSync(scriptPath, 0o755);

  const settingsPath = join(claudeDir, 'settings.json');
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  const existing = settings.statusLine?.command;

  if (existing === scriptPath) {
    return { installed: false, idempotent: true, scriptPath };
  }
  let backupPath: string | undefined;
  if (existing && !opts.force) {
    throw new Error(`Existing statusLine \`${existing}\` detected. Refusing to overwrite. Run with --force-replace to replace.`);
  }
  if (existing && opts.force) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = `${settingsPath}.penumbra-backup-${stamp}`;
    writeFileSync(backupPath, JSON.stringify(settings, null, 2));
  }

  settings.statusLine = { type: 'command', command: scriptPath, padding: 2 };
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { installed: true, scriptPath, backupPath };
}

export interface UninstallClaudeOpts {
  claudeDir?: string;
  scriptDir?: string;
}
export interface UninstallClaudeResult {
  removed: boolean;
}

export async function runHooksUninstallClaude(opts: UninstallClaudeOpts = {}): Promise<UninstallClaudeResult> {
  const claudeDir = opts.claudeDir ?? join(homedir(), '.claude');
  const scriptDir = opts.scriptDir ?? join(homedir(), '.penumbra', 'bin');
  const scriptPath = join(scriptDir, 'penumbra-claude-statusline');
  const settingsPath = join(claudeDir, 'settings.json');
  if (!existsSync(settingsPath)) return { removed: false };
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  if (settings.statusLine?.command !== scriptPath) return { removed: false };
  delete settings.statusLine;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { removed: true };
}

export async function runHooksStatus(_opts: { claudeDir?: string; scriptDir?: string } = {}): Promise<void> {
  // Print which hooks are installed; leave detail-level reporting to a future enhancement.
  // For v1 just check Claude's statusLine and codex JSONL polling status.
  // Intentionally minimal.
}
```

- [ ] **Step 4: Wire into `bin/penumbra.ts`**

Add `case 'hooks': ...` with subcommands `install`, `uninstall`, `status`. Parse `--claude`, `--codex`, `--force-replace` flags.

- [ ] **Step 5: Re-run tests, full suite, typecheck**

- [ ] **Step 6: Commit**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
git add packages/cli/src/commands/hooks.ts packages/cli/test/commands/hooks.test.ts packages/cli/bin/penumbra.ts && \
git commit -m "feat(cli): penumbra hooks install/uninstall/status (Claude statusLine)"
```

---

## Task 19: Documentation + memory entry + live verification

**Files:**
- Modify: `packages/agentchat/docs/agent-fleet.md`
- Create: `~/.claude/projects/-Volumes-WorkSSD-repos-personal-penumbra/memory/feedback_phase_3b_cost_ledger.md`
- Modify: `~/.claude/projects/-Volumes-WorkSSD-repos-personal-penumbra/memory/MEMORY.md`

- [ ] **Step 1: Update agent-fleet.md**

Add a new section near the bottom (or wherever observability is discussed):

```md
## Cost + rate-limit capture (Phase 3b)

Penumbra captures token usage and provider rate limits via two parallel paths:

- **ACP wire** (CapturePort) — every dispatched ACP turn that emits `session/update.usage_update` lands as a `usage-update` row. claude-acp-sonnet has the richest wire emission with `cost_usd` populated.
- **Local-state polling** (worker-primary singleton, ≤60s interval):
  - **Codex** rollout JSONL → both `usage-update` (tokens) and `rate-limit-snapshot` (primary 5h + secondary 7d windows)
  - **OpenCode** sqlite (`message.data` JSON) → `usage-update` with full cost+tokens (USD-native)
  - **Claude** transcript JSONL → `usage-update` with token breakdown (no cost)
  - **Claude statusLine** (when `penumbra hooks install --claude` is run) → `rate-limit-snapshot` for five_hour + seven_day windows

Surfaces:
- MCP: `cost.recent`, `cost.quota_status`
- HTTP: `GET /usage/recent`, `GET /usage/quota_status` (bearer-token auth)
- CLI: `penumbra cost recent`, `penumbra cost quota`, `penumbra hooks install/uninstall/status`
- Quota config: `~/.config/agentchat/agentchat.yaml` `providers:` block

Gemini and OpenCode rate-limits are NOT captured today (vendor doesn't surface locally).
```

- [ ] **Step 2: Write the memory entry**

Use the Write tool to create `~/.claude/projects/-Volumes-WorkSSD-repos-personal-penumbra/memory/feedback_phase_3b_cost_ledger.md`:

```markdown
---
name: Phase 3b cost ledger architecture and gotchas
description: How penumbra captures token usage + rate-limit windows across the agent fleet; gotchas around the new event_types, daemon restart requirement, and per-CLI source quirks
type: project
---

Phase 3b ships token + cost + rate-limit capture across the fleet via dual ingest:
- ACP wire (CapturePort emits usage-update on session/update.usage_update from dispatched ACP agents)
- Local-state polling (worker-primary singleton, ≤60s) — CodexRolloutReader, OpenCodeDbReader, ClaudeJsonlReader, ClaudeStatusLineBridge

**Why:** Visibility for "balanced agent use" — maestro consults `cost.quota_status` (via MCP, HTTP `/usage/quota_status`, or `penumbra cost quota` CLI) to avoid dispatching to providers near their 24h-rolling soft quota or — for codex/Claude — near their hard rate-limit windows.

**How to apply:**
1. After landing schema changes (new `usage-update` and `rate-limit-snapshot` enum values), restart the daemon with `kill -TERM $(cat /tmp/penumbra-live/pid) && PENUMBRA_STORAGE_ROOT=/tmp/penumbra-live bun packages/cli/bin/penumbra.ts start --detach`. The daemon caches the zod schema at boot — running daemon will silently 400 on the new event types.
2. Provider quotas live in `~/.config/agentchat/agentchat.yaml` under a top-level `providers:` block. Format: `{name, quota_usd_per_24h?, quota_tokens_per_24h?}`. Unconfigured providers are omitted from `cost.quota_status` responses.
3. Cursor file: `${storageRoot}/local-state-cursors.json`. If corrupt, delete it and the next poll cycle re-emits from beginning of available data (accept duplicate rows on first poll).
4. Hooks-style integration: `penumbra hooks install --claude` writes `~/.penumbra/bin/penumbra-claude-statusline` and configures Claude Code's statusLine. Refuses to overwrite existing statusLines without `--force-replace`. The script writes only to `/tmp/penumbra-claude-rl.json` — penumbra never reads any other tool's cache (no OpenIsland dependency).
5. Rate-limit visibility today: codex (primary 5h + secondary 7d) + Claude (five_hour + seven_day, only when statusLine is installed AND user is interactively using Claude Code). Gemini and OpenCode rate-limits are NOT captured (vendor doesn't surface locally).
6. Stable HTTP routes: `/usage/recent` and `/usage/quota_status` are part of penumbra's public API, semver-compatible. Other tools can curl them with the bearer token from `${storageRoot}/token`.
7. Known double-counting: when both ACP wire and local-state observe the same activity, tokens may double-count in `cost.recent`. Acceptable for soft 24h-rolling quotas; not for hard accounting.
```

- [ ] **Step 3: Append to MEMORY.md index**

Edit the index file. Append at the end:

```
- [Phase 3b cost ledger architecture and gotchas](feedback_phase_3b_cost_ledger.md) — dual-path capture (ACP wire + local-state polling); daemon-restart-on-schema-change; HTTP routes; `penumbra hooks install --claude`
```

- [ ] **Step 4: Live verification (multi-step manual check)**

Restart workers (so they pick up the new poller singleton):
```bash
ps -ef | grep agentchat-worker | grep -v grep | awk '{print $2}' | xargs kill -TERM 2>&1; sleep 3
nohup bun packages/agentchat/bin/agentchat-worker.ts --storage-root /tmp/penumbra-live --worker-id worker-primary > /tmp/penumbra-live/logs/worker-primary.log 2>&1 & disown
nohup bun packages/agentchat/bin/agentchat-worker.ts --storage-root /tmp/penumbra-live --worker-id worker-b > /tmp/penumbra-live/logs/worker-b.log 2>&1 & disown
nohup bun packages/agentchat/bin/agentchat-worker.ts --storage-root /tmp/penumbra-live --worker-id worker-c > /tmp/penumbra-live/logs/worker-c.log 2>&1 & disown
nohup bun packages/agentchat/bin/agentchat-worker.ts --storage-root /tmp/penumbra-live --worker-id worker-d > /tmp/penumbra-live/logs/worker-d.log 2>&1 & disown
sleep 5
ps -ef | grep agentchat-worker | grep -v grep | wc -l
```
Expected: 4 workers; `worker-primary.log` shows `usage-poller started (worker-primary)`.

Wait for the first poller cycle to fire (≤60s), then check t0_events:
```bash
sleep 65
sqlite3 /tmp/penumbra-live/db.sqlite "SELECT event_type, source_detail, COUNT(*) FROM t0_events WHERE event_type IN ('usage-update','rate-limit-snapshot') AND ts > datetime('now','-5 minutes') GROUP BY event_type, source_detail"
```
Expected: rows for `source_detail='usage-poller-codex-rollout'` (rate-limit-snapshot for primary + secondary), and any other readers with recent activity.

Trigger a `claude-acp-sonnet` dispatch and confirm ACP-wire path:
```bash
# Use chain_start MCP tool (or CLI) to dispatch a brief claude turn,
# then check t0_events for source_detail=null + source_kind=acp-wire.
```

Smoke the HTTP routes:
```bash
TOKEN=$(cat /tmp/penumbra-live/token)
PORT=$(cat /tmp/penumbra-live/port)
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/usage/quota_status" | python3 -m json.tool
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/usage/recent?since=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)" | python3 -m json.tool
```

Smoke the CLI:
```bash
bun packages/cli/bin/penumbra.ts cost quota
bun packages/cli/bin/penumbra.ts cost recent --since 1h
```

If any step fails or shows unexpected output, document in a session note and triage.

- [ ] **Step 5: Commit docs**

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && \
git add packages/agentchat/docs/agent-fleet.md && \
git commit -m "docs(phase-3b): cost + rate-limit capture landscape and surfaces"
```

The memory entries are operator-space and not git-tracked; no commit needed for them.

---

## Done criteria

All checkboxes in Tasks 1–19 checked AND:

1. Total of ~16-18 commits on main, in TDD-paired pattern (test commits paired with impl commits where the workflow merits a split; otherwise combined).
2. Full suite green: `bun test` passes; `bun typecheck` returns 0 errors.
3. Daemon restarted on the new schema; `/usage/recent` and `/usage/quota_status` respond 200 with valid JSON.
4. The 4 local-state readers each emit at least one row in t0_events within 5 minutes of activity (verified via sqlite query in Task 19 Step 4).
5. `penumbra cost quota` prints a populated table with at least the configured providers.
6. The new memory entry + index pointer are persisted.
7. Phase 3b spec at `docs/superpowers/specs/2026-04-28-phase-3b-cost-ledger-design.md` is referenced in commit messages where appropriate; no spec edits needed during implementation.

If any reader observed a CLI-version-specific schema variation that the spec didn't anticipate (e.g., codex rollout format changed, opencode message.data shape evolved, Claude transcript fields renamed), open a follow-up phase 3b.x spec; do NOT silently work around in v1.
