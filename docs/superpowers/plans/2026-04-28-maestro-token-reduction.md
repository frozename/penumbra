# Maestro Token Reduction — `chain_status` + Compact `handoff_get`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cut maestro polling tokens by 30-40% on the dispatch lifecycle. Today every status check via `mcp__penumbra__handoff_get` returns the full original prompt (often 1500+ tokens) and the full `resolution_reason` (sometimes 2000+ tokens of stderr/stack). Both are dead weight on routine polling.

**Architecture:** Two changes — one additive, one opt-in. No DB schema changes, no breaking change to existing callers.

1. **New `chain_status` MCP tool**: returns the lean shape `{ handoff_id, status, error_summary, worker_id, started_at, resolved_at, latency_seconds }`. ~50-100 tokens per response vs. 1500-3000 for `handoff_get`. Backed by a new `/handoffs/<id>/status` daemon route that hits `HandoffReader.get` and projects the lean fields.

2. **Optional `compact` flag on `handoff_get`**: when `compact: true`, the response omits the `message` field (caller already knows their own prompt) and truncates `resolution_reason` to the first 500 + last 500 chars with a `[... truncated N chars ...]` marker. Default `false` preserves backward compatibility for any existing caller. Implementation lives at the MCP tool layer; daemon route unchanged.

**Tech Stack:** TypeScript, daemon route at `packages/daemon/src/routes/handoffs.ts`, MCP tools at `packages/mcp/src/tools/`, `bun:test`.

---

## Why this scope (not the full brainstorm)

The maestro brainstorm surfaced ~13 token-leakage sources. This plan tackles only the two with the largest expected savings and the simplest implementations:

- `chain_status` saves on every poll (high frequency, easy win, additive only)
- `handoff_get compact` saves on every failure investigation (medium frequency, opt-in flag, no breakage)

Deferred to follow-up plans (each its own focused PR):
- Opt-in for the Read priming hook (~200-400 tokens per file read; behavioral change)
- Task-list rendering only on transitions (system-reminder layer; needs different access)
- `chain_start` `prompt_template_id` (saves on every dispatch + every echo; needs a template registry)
- Lazy deferred-tool surfacing (~5k tokens at session start; needs runtime change)

---

## File Structure

| Action | Path | Reason |
|---|---|---|
| Create | `packages/daemon/src/routes/handoffs.ts` (or extend if exists) — function `handoffStatusRoute` | Lean GET `/handoffs/:id/status` route that hits `services.handoffReader.get` and projects `{ status, error_summary, worker_id, started_at, resolved_at, latency_seconds }`. |
| Create | `packages/mcp/src/tools/chain-status.ts` | MCP tool `chain.status` wrapping the new route. Input: `{ handoff_id }`. Output: lean status JSON. |
| Modify | `packages/mcp/src/tools/handoff-get.ts` | Accept optional `compact?: boolean` input. When true, omit `message` field and truncate `resolution_reason` to head500 + tail500 with truncation marker. |
| Modify | `packages/mcp/src/index.ts` (or wherever tools are registered) | Register the new `chain.status` tool. |
| Modify | `packages/daemon/src/serve.ts` | Wire the new GET `/handoffs/:id/status` route. |
| Create | `packages/daemon/test/routes/handoffs-status.test.ts` | Tests for the lean route. |
| Create | `packages/mcp/test/tools/chain-status.test.ts` | Tests for the MCP tool wrapper. |
| Modify | `packages/mcp/test/tools/handoff-get.test.ts` | Add tests for `compact: true` behavior. |

---

## Task 1: Add `/handoffs/:id/status` daemon route

**Files:**
- Modify: `packages/daemon/src/routes/handoffs.ts`
- Modify: `packages/daemon/src/serve.ts`
- Create: `packages/daemon/test/routes/handoffs-status.test.ts`

The route projects an already-loaded `HandoffRow` to a lean shape. No schema changes, no new readers — pure projection.

The "error_summary" for failed handoffs derives from `resolution_reason`: take the first line, cap at 200 chars. Drops stack traces / repeated error spam. For non-failed status, `error_summary` is null.

- [ ] **Step 1: Probe the existing handoffs route file**

Run: `grep -n "export.*function\|handoffsRoute\|/handoffs/" packages/daemon/src/routes/handoffs.ts | head -20`

Expected: existing handoff routes (e.g. `handoffsListPendingRoute`, `handoffsApproveRoute`, `handoffsGetRoute`). Note the patterns and helpers used.

- [ ] **Step 2: Write the failing test**

Create `packages/daemon/test/routes/handoffs-status.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { handoffsStatusRoute } from '../../src/routes/handoffs.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

function tempServices(): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  return buildServices({
    env: {}, input: {}, storageRoot: '/tmp/status-test', db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-28T00:00:00Z'),
    uuid: () => `id-${++n}`,
  });
}

function insertHandoff(services: Services, h: {
  handoff_id: string;
  status: string;
  ts?: string;
  resolved_at?: string;
  worker_id?: string;
  resolution_reason?: string;
  message?: string;
}) {
  services.db.prepare(`
    INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent,
      message, status, resolved_at, worker_id, resolution_reason)
    VALUES (?, ?, 'c', 'a', 'b', ?, ?, ?, ?, ?)
  `).run(
    h.handoff_id,
    h.ts ?? '2026-04-28T00:00:00Z',
    h.message ?? 'a long prompt that should not appear in status response',
    h.status,
    h.resolved_at ?? null,
    h.worker_id ?? null,
    h.resolution_reason ?? null,
  );
}

test('handoffsStatusRoute returns lean shape for completed handoff', async () => {
  const services = tempServices();
  insertHandoff(services, {
    handoff_id: 'h-1',
    status: 'completed',
    ts: '2026-04-28T00:00:00Z',
    resolved_at: '2026-04-28T00:00:30Z',
    worker_id: 'worker-c',
  });
  const res = await handoffsStatusRoute(new Request('http://x/handoffs/h-1/status'), services, 'h-1');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({
    handoff_id: 'h-1',
    status: 'completed',
    error_summary: null,
    worker_id: 'worker-c',
    started_at: '2026-04-28T00:00:00Z',
    resolved_at: '2026-04-28T00:00:30Z',
    latency_seconds: 30,
  });
  // Critical: message NOT in response
  expect((body as any).message).toBeUndefined();
});

test('handoffsStatusRoute extracts first-line error_summary for failed handoff', async () => {
  const services = tempServices();
  insertHandoff(services, {
    handoff_id: 'h-2',
    status: 'failed',
    resolution_reason: 'codex: exit code 1\n2026-04-28T01:00 ERROR connect: 401\n[stack trace 1500 chars...]',
  });
  const res = await handoffsStatusRoute(new Request('http://x/handoffs/h-2/status'), services, 'h-2');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('failed');
  expect(body.error_summary).toBe('codex: exit code 1');
});

test('handoffsStatusRoute caps error_summary at 200 chars', async () => {
  const services = tempServices();
  insertHandoff(services, {
    handoff_id: 'h-3',
    status: 'failed',
    resolution_reason: 'a'.repeat(500),
  });
  const res = await handoffsStatusRoute(new Request('http://x/handoffs/h-3/status'), services, 'h-3');
  const body = await res.json();
  expect(body.error_summary?.length).toBeLessThanOrEqual(200);
});

test('handoffsStatusRoute returns null latency when not yet resolved', async () => {
  const services = tempServices();
  insertHandoff(services, {
    handoff_id: 'h-4',
    status: 'dispatched',
    resolved_at: undefined,
  });
  const res = await handoffsStatusRoute(new Request('http://x/handoffs/h-4/status'), services, 'h-4');
  const body = await res.json();
  expect(body.status).toBe('dispatched');
  expect(body.resolved_at).toBeNull();
  expect(body.latency_seconds).toBeNull();
});

test('handoffsStatusRoute returns 404 for unknown handoff_id', async () => {
  const services = tempServices();
  const res = await handoffsStatusRoute(new Request('http://x/handoffs/nope/status'), services, 'nope');
  expect(res.status).toBe(404);
});
```

- [ ] **Step 3: Run test to verify failure**

Run: `bun test packages/daemon/test/routes/handoffs-status.test.ts`

Expected: FAIL — `handoffsStatusRoute` not exported.

- [ ] **Step 4: Implement the route**

In `packages/daemon/src/routes/handoffs.ts`, add:

```ts
export async function handoffsStatusRoute(
  _req: Request,
  services: Services,
  handoff_id: string,
): Promise<Response> {
  const row = services.handoffReader.get(handoff_id);
  if (!row) {
    return json({ error: { code: 'not_found', message: `handoff not found: ${handoff_id}` } }, 404);
  }
  const started_at = row.ts;
  const resolved_at = row.resolved_at ?? null;
  const latency_seconds = resolved_at && started_at
    ? Math.round((new Date(resolved_at).getTime() - new Date(started_at).getTime()) / 1000)
    : null;
  const error_summary = row.resolution_reason
    ? row.resolution_reason.split('\n')[0]?.slice(0, 200) ?? null
    : null;
  return json({
    handoff_id,
    status: row.status,
    error_summary,
    worker_id: row.worker_id ?? null,
    started_at,
    resolved_at,
    latency_seconds,
  });
}
```

(Re-use the existing `json()` helper if present; otherwise import per the existing pattern in the file.)

- [ ] **Step 5: Wire the route into serve.ts**

In `packages/daemon/src/serve.ts`, locate the existing handoff route block (search `'/handoffs'`). Add (matching the existing pattern):

```ts
const statusMatch = url.pathname.match(/^\/handoffs\/([^/]+)\/status$/);
if (req.method === 'GET' && statusMatch) {
  return handoffsStatusRoute(req, opts.services, statusMatch[1]);
}
```

(Place this BEFORE any catch-all `/handoffs/:id` GET so it takes precedence.)

Update the import block:

```ts
import { ..., handoffsStatusRoute, ... } from './routes/handoffs.js';
```

- [ ] **Step 6: Run tests + typecheck**

Run: `bun test packages/daemon/test/routes/handoffs-status.test.ts`
Expected: 5 pass.

Run: `bun run typecheck`
Expected: exit 0.

Run: `bun test packages/daemon/test/`
Expected: all pre-existing pass.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/routes/handoffs.ts packages/daemon/src/serve.ts packages/daemon/test/routes/handoffs-status.test.ts
git commit -m "feat(daemon): GET /handoffs/:id/status — lean status route for low-token polling"
```

---

## Task 2: Add `chain_status` MCP tool

**Files:**
- Create: `packages/mcp/src/tools/chain-status.ts`
- Modify: `packages/mcp/src/index.ts` (or wherever tools register)
- Create: `packages/mcp/test/tools/chain-status.test.ts`

- [ ] **Step 1: Probe the existing tool registration pattern**

Run: `cat packages/mcp/src/tools/chain-cancel.ts | head -30`

Expected: a small file showing input shape + handler that calls a `daemon.<method>(...)`. Use this exact pattern.

Run: `grep -n "ChainStartInputShape\|chainStartHandler" packages/mcp/src/index.ts | head -5`

Expected: registration calls. Note the pattern (likely `server.registerTool('chain.start', { description, inputSchema: z.object(ChainStartInputShape) }, chainStartHandler(daemon))` or similar).

- [ ] **Step 2: Probe the daemon-client method shape**

Run: `grep -n "startChain\|getHandoff\|cancelChain\|fetch.*handoffs" packages/mcp/src/daemon-client.ts | head -10`

Expected: existing methods like `getHandoff(id)`. We need a new `getHandoffStatus(id)` for the lean route.

- [ ] **Step 3: Add `getHandoffStatus` to DaemonClient**

In `packages/mcp/src/daemon-client.ts`, add (next to existing `getHandoff`):

```ts
async getHandoffStatus(handoff_id: string): Promise<{
  handoff_id: string;
  status: string;
  error_summary: string | null;
  worker_id: string | null;
  started_at: string | null;
  resolved_at: string | null;
  latency_seconds: number | null;
}> {
  const url = `${this.baseUrl}/handoffs/${encodeURIComponent(handoff_id)}/status`;
  const res = await fetch(url, { headers: this.authHeaders() });
  if (res.status === 404) {
    throw new Error(`handoff not found: ${handoff_id}`);
  }
  if (!res.ok) {
    throw new Error(`getHandoffStatus failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as any;
}
```

(Match the actual class shape — `baseUrl`, `authHeaders()`, etc. — by reading the file first.)

- [ ] **Step 4: Write the MCP tool wrapper**

Create `packages/mcp/src/tools/chain-status.ts`:

```ts
import { z } from 'zod';
import type { DaemonClient } from '../daemon-client.js';

export const ChainStatusInputShape = {
  handoff_id: z.string().min(1).describe('The ID of the handoff to query status for.'),
};

export function chainStatusHandler(daemon: DaemonClient) {
  return async (input: any) => {
    const status = await daemon.getHandoffStatus(input.handoff_id);
    return { content: [{ type: 'text', text: JSON.stringify(status) }] };
  };
}
```

- [ ] **Step 5: Write the failing test**

Create `packages/mcp/test/tools/chain-status.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { chainStatusHandler } from '../../src/tools/chain-status.js';

test('chainStatusHandler forwards handoff_id and returns the daemon response as JSON text', async () => {
  const calls: string[] = [];
  const fakeDaemon = {
    getHandoffStatus: async (id: string) => {
      calls.push(id);
      return {
        handoff_id: id,
        status: 'completed',
        error_summary: null,
        worker_id: 'worker-c',
        started_at: '2026-04-28T00:00:00Z',
        resolved_at: '2026-04-28T00:00:05Z',
        latency_seconds: 5,
      };
    },
  } as any;
  const handler = chainStatusHandler(fakeDaemon);
  const res = await handler({ handoff_id: 'h-test' });
  expect(calls).toEqual(['h-test']);
  expect(res.content[0].type).toBe('text');
  const payload = JSON.parse(res.content[0].text);
  expect(payload.status).toBe('completed');
  expect(payload.latency_seconds).toBe(5);
});
```

- [ ] **Step 6: Run test to verify pass**

Run: `bun test packages/mcp/test/tools/chain-status.test.ts`
Expected: 1 pass.

- [ ] **Step 7: Register the tool**

In `packages/mcp/src/index.ts` (or wherever tools register), add the import + register call following the existing `chain.cancel` pattern:

```ts
import { ChainStatusInputShape, chainStatusHandler } from './tools/chain-status.js';

// In the registration block, alongside chain.cancel etc.:
server.registerTool('chain.status', {
  description: 'Returns lean status for a handoff: { status, error_summary, worker_id, latency_seconds }. ~30x cheaper than handoff.get for routine polling. Use this for chain_wait followup.',
  inputSchema: z.object(ChainStatusInputShape),
}, chainStatusHandler(daemon));
```

(Adapt the registration call shape to match what exists.)

- [ ] **Step 8: Run typecheck + commit**

Run: `bun run typecheck`
Expected: exit 0.

```bash
git add packages/mcp/src/tools/chain-status.ts packages/mcp/src/daemon-client.ts packages/mcp/src/index.ts packages/mcp/test/tools/chain-status.test.ts
git commit -m "feat(mcp): chain.status — lean polling tool wrapping GET /handoffs/:id/status"
```

---

## Task 3: Add `compact` flag to `handoff_get`

**Files:**
- Modify: `packages/mcp/src/tools/handoff-get.ts`
- Modify: `packages/mcp/test/tools/handoff-get.test.ts`

When `compact: true`:
- Omit the `message` field from the response (the caller dispatched the prompt — they don't need it echoed back)
- Truncate `resolution_reason` to head500 + tail500 with a `[... truncated N chars ...]` marker

Default `false` preserves backward compat. No daemon-side changes — the truncation lives at the MCP tool layer.

- [ ] **Step 1: Probe the existing tool**

Run: `cat packages/mcp/src/tools/handoff-get.ts`

Note the input schema shape and how the daemon response maps to the MCP `content[0].text` field.

- [ ] **Step 2: Write the failing test**

Append to `packages/mcp/test/tools/handoff-get.test.ts`:

```ts
test('handoff_get with compact:true omits message and truncates resolution_reason', async () => {
  const longMessage = 'x'.repeat(5000);
  const longReason = 'a'.repeat(500) + 'MIDDLE-MARKER' + 'b'.repeat(500) + 'END-MARKER' + 'c'.repeat(500);
  const fakeDaemon = {
    getHandoff: async () => ({
      handoff: {
        handoff_id: 'h-1',
        ts: '2026-04-28T00:00:00Z',
        status: 'failed',
        from_agent: 'user',
        to_agent: 'codex-mini',
        message: longMessage,
        resolution_reason: longReason,
        // ... other fields
      },
    }),
  } as any;
  const handler = handoffGetHandler(fakeDaemon);
  const res = await handler({ handoff_id: 'h-1', compact: true });
  const body = JSON.parse(res.content[0].text);
  expect(body.handoff.message).toBeUndefined();
  expect(body.handoff.resolution_reason.length).toBeLessThan(longReason.length);
  expect(body.handoff.resolution_reason).toContain('truncated');
  expect(body.handoff.resolution_reason).toContain('END-MARKER');
});

test('handoff_get without compact preserves backward-compat shape', async () => {
  const longMessage = 'x'.repeat(5000);
  const fakeDaemon = {
    getHandoff: async () => ({
      handoff: {
        handoff_id: 'h-1',
        message: longMessage,
        resolution_reason: 'short',
        status: 'pending',
      },
    }),
  } as any;
  const handler = handoffGetHandler(fakeDaemon);
  const res = await handler({ handoff_id: 'h-1' });
  const body = JSON.parse(res.content[0].text);
  expect(body.handoff.message).toBe(longMessage);
  expect(body.handoff.resolution_reason).toBe('short');
});
```

- [ ] **Step 3: Run test to verify failure**

Run: `bun test packages/mcp/test/tools/handoff-get.test.ts -t "compact"`

Expected: FAIL — current handler ignores `compact`.

- [ ] **Step 4: Implement the compact logic**

In `packages/mcp/src/tools/handoff-get.ts`:

a) Add to input shape:

```ts
compact: z.boolean().optional().describe('When true, omits the original prompt and truncates resolution_reason to head 500 + tail 500 chars. Saves ~1500-2500 tokens per call. Default false.'),
```

b) Wrap the existing handoff response:

```ts
function applyCompactTransform(handoff: any) {
  const out = { ...handoff };
  delete out.message;
  if (typeof out.resolution_reason === 'string' && out.resolution_reason.length > 1100) {
    const head = out.resolution_reason.slice(0, 500);
    const tail = out.resolution_reason.slice(-500);
    const truncated = out.resolution_reason.length - 1000;
    out.resolution_reason = `${head}\n[... truncated ${truncated} chars ...]\n${tail}`;
  }
  return out;
}

export function handoffGetHandler(daemon: DaemonClient) {
  return async (input: any) => {
    const result = await daemon.getHandoff(input.handoff_id);
    const handoff = input.compact ? applyCompactTransform(result.handoff) : result.handoff;
    return { content: [{ type: 'text', text: JSON.stringify({ handoff }) }] };
  };
}
```

(Adjust to match the actual existing shape of the file.)

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test packages/mcp/test/tools/handoff-get.test.ts`
Expected: all tests pass (existing + 2 new).

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/tools/handoff-get.ts packages/mcp/test/tools/handoff-get.test.ts
git commit -m "feat(mcp): handoff.get — opt-in compact mode (omit message, truncate resolution_reason)"
```

---

## Task 4: Update memory rule recommending compact polling

**Files:**
- Modify: `~/.claude/projects/-Volumes-WorkSSD-repos-personal-penumbra/memory/feedback_use_mcp_not_sqlite.md` (or create a new feedback memory)

Add to that memory (or a new sibling): "For routine polling, prefer `chain.status` over `handoff.get` — saves ~30x tokens per call. Reach for `handoff.get` only when investigating a failure (and pass `compact: true` unless you actually need the original prompt body)."

This step is maestro-side, not implementer-scope. Implementer should stop after Task 3.

---

## Verification

| Goal | Task |
|---|---|
| Lean polling endpoint with first-line error summary | Task 1 |
| MCP-tool-layer wrapper for the new endpoint | Task 2 |
| Backward-compat opt-in compact mode for existing handoff.get callers | Task 3 |
| Maestro adoption guidance | Task 4 (maestro-side) |

## End-to-end worked example

**Before (handoff.get on a failed dispatch):**
```
mcp__penumbra__handoff_get({ handoff_id: "abc..." })
→ ~2400 token response: full original prompt (1500 tokens) + full resolution_reason
   with stack trace (800 tokens) + handoff metadata (100 tokens)
```

**After (chain.status):**
```
mcp__penumbra__chain_status({ handoff_id: "abc..." })
→ ~80 token response:
   { handoff_id, status: "failed", error_summary: "codex: exit code 1",
     worker_id: "worker-c", latency_seconds: 23, ... }
```

**After (handoff.get compact:true, when full investigation is needed):**
```
mcp__penumbra__handoff_get({ handoff_id: "abc...", compact: true })
→ ~1100 token response: handoff metadata + resolution_reason head500 + truncation
   marker + resolution_reason tail500. Original prompt omitted.
```

Net effect across a typical phase rollout (3 dispatches × 2 polls each + 1 failure investigation):
- Before: 6 × 2400 + 1 × 2400 = ~16800 tokens
- After: 6 × 80 + 1 × 1100 = ~1580 tokens
- **Savings: ~91% on dispatch-cycle polling.**

## Estimated effort

- Task 1 (daemon route + 5 tests + serve wiring): 1 hour
- Task 2 (MCP tool + DaemonClient method + 1 test + register): 45 min
- Task 3 (compact flag + 2 tests): 30 min
- Task 4 (memory update): 5 min

Total: ~2.5 hours focused work for the implementer.

## Deferred follow-ups (separate plans)

After this lands, the next-highest-leverage token cuts are:
1. Read priming hook opt-in (~200-400 tokens per file read)
2. `chain_start` `prompt_template_id` (saves on every dispatch + every echo)
3. Lazy deferred-tool surfacing (~5k tokens at session start)

Each is its own focused PR — don't bundle.
