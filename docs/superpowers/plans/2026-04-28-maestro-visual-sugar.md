# Maestro Visual Sugar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use penumbra:dispatching (recommended) or penumbra:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two-layer visual enhancement of penumbra MCP tool output for the maestro running Claude Code: per-tool inline summary headers (penumbra-themed glyphs + dim ANSI for IDs) and a persistent statusline showing in-flight dispatch counts.

**Architecture:** Pure server-side change in penumbra-mcp tool handlers (text-content wrapping with summary headers above raw JSON), plus a new `penumbra statusline` CLI subcommand consumed by Claude Code's `statusLine` config. No daemon work, no new persistent state, no harness hooks beyond the one-line settings.json edit.

**Tech Stack:** Bun, TypeScript, zod, existing penumbra-mcp + daemon HTTP routes.

**Spec:** `docs/superpowers/specs/2026-04-28-maestro-visual-sugar-design.md` (commit `cad179d`).

---

## Sequencing & dispatch notes

Same discipline as Phase 1d. Stress codex-mini + gemini family; avoid claude-acp-sonnet. Two-round-cap on fix loops. Single-implementer-per-task. **Commit IMMEDIATELY after green tests, before final report** (Phase 1d's anti-truncation rule).

### Dependency graph

```
                  ┌────────────────────┐    ┌────────────────────┐
                  │ Task 1             │    │ Task 3             │  ← parallel
                  │ format-summary.ts  │    │ statusline CLI     │
                  │ (utilities + 8     │    │ + penumbra.ts case │
                  │  formatters + 18   │    │ + 5 tests          │
                  │  tests)            │    │                    │
                  └─────────┬──────────┘    └────────────────────┘
                            │
                  ┌─────────▼──────────┐
                  │ Task 2             │  ← after Task 1 lands
                  │ Modify 8 MCP tool  │
                  │ handlers to use    │
                  │ format-summary.ts  │
                  │ + 8 test updates   │
                  └─────────┬──────────┘
                            │
                  ┌─────────▼──────────┐
                  │ Task 4             │  ← maestro-driven
                  │ Settings.json wire │
                  │ + smoke-check      │
                  └────────────────────┘
```

### Routing (per Phase 1d agent-performance signal)

| Task | Recommended agent | Reason |
|---|---|---|
| 1 — format-summary.ts | **gemini** (pro) | Substantive but well-scoped pure-function module; ~18 tests; gemini's sweet spot |
| 3 — statusline CLI | **codex-mini** | CLI subcommand wiring + cache + daemon HTTP fallback — spans modules |
| 2 — modify 8 handlers | **gemini-flash** | Small mechanical edits across 8 known files; flash's fast iteration shines |
| 4 — settings.json + smoke | **maestro** | Machine-local config; not dispatchable |

Reviewer: oc-deepseek-v4-pro for sanity-check after Round 2 lands; skip if green.

---

## File structure

### New files

| File | Responsibility | Owning task |
|---|---|---|
| `packages/mcp/src/format-summary.ts` | Pure-function summary formatters per tool + utilities (`dimColor`, `truncateId`, `formatElapsed`, `glyphFor`). Honors `NO_COLOR` env. | Task 1 |
| `packages/mcp/test/format-summary.test.ts` | Unit tests for the formatters (~18 tests). | Task 1 |
| `packages/cli/src/commands/statusline.ts` | `penumbra statusline` subcommand: 2s file cache, daemon HTTP fetch, line formatting, daemon-down fallback. | Task 3 |
| `packages/cli/test/commands/statusline.test.ts` | CLI subcommand unit tests (~5 tests). | Task 3 |

### Modified files

| File | Change | Owning task |
|---|---|---|
| `packages/mcp/src/tools/chain-start.ts` | Wrap result text content with summary header | Task 2 |
| `packages/mcp/src/tools/chain-status.ts` | " | Task 2 |
| `packages/mcp/src/tools/chain-wait.ts` | " | Task 2 |
| `packages/mcp/src/tools/chain-get-response.ts` | " | Task 2 |
| `packages/mcp/src/tools/handoff-get.ts` | " | Task 2 |
| `packages/mcp/src/tools/handoff-list.ts` | " | Task 2 |
| `packages/mcp/src/tools/permission-list-pending.ts` | " | Task 2 |
| `packages/mcp/src/tools/permission-approve.ts` | " | Task 2 |
| `packages/cli/bin/penumbra.ts` | Add `case 'statusline':` to dispatcher | Task 3 |
| `~/.claude/settings.json` | Add `statusLine` config (machine-local) | Task 4 |

---

## Task 1 — `format-summary.ts` (utilities + 8 formatters)

**Files:**
- Create: `packages/mcp/src/format-summary.ts`
- Test: `packages/mcp/test/format-summary.test.ts`

This task ships the entire summary-rendering module: shared utilities + one formatter per tool. Pure functions; no I/O; trivial to test.

- [ ] **Step 1: Write failing tests for utilities**

```ts
// packages/mcp/test/format-summary.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  dimColor,
  truncateId,
  formatElapsed,
  glyphFor,
} from '../src/format-summary.js';

describe('format-summary utilities', () => {
  let savedNoColor: string | undefined;
  beforeEach(() => { savedNoColor = process.env.NO_COLOR; delete process.env.NO_COLOR; });
  afterEach(() => { if (savedNoColor !== undefined) process.env.NO_COLOR = savedNoColor; else delete process.env.NO_COLOR; });

  test('dimColor wraps in ANSI dim sequence', () => {
    expect(dimColor('h-7d3a91')).toBe('\x1b[2mh-7d3a91\x1b[0m');
  });

  test('dimColor returns plain text when NO_COLOR=1', () => {
    process.env.NO_COLOR = '1';
    expect(dimColor('h-7d3a91')).toBe('h-7d3a91');
  });

  test('truncateId truncates with ellipsis at given length', () => {
    expect(truncateId('h-7d3a91ab1234567890', 8)).toBe('h-7d3a91…');
    expect(truncateId('short', 20)).toBe('short');
  });

  test('formatElapsed handles seconds, minutes, hours, days', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(47_000)).toBe('47s');
    expect(formatElapsed(192_000)).toBe('3m12s');
    expect(formatElapsed(8_040_000)).toBe('2h 14m');
    expect(formatElapsed(100_000_000)).toBe('1d 4h');
  });

  test('glyphFor maps statuses to glyphs', () => {
    expect(glyphFor('dispatched')).toBe('◌');
    expect(glyphFor('pending')).toBe('◐');
    expect(glyphFor('completed')).toBe('●');
    expect(glyphFor('approved')).toBe('●');
    expect(glyphFor('failed')).toBe('◑');
    expect(glyphFor('rejected')).toBe('◑');
    expect(glyphFor('cancelled')).toBe('◑');
    expect(glyphFor('expired')).toBe('◑');
    expect(glyphFor('unknown')).toBe('●');  // safe default
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found)

```bash
cd /Volumes/WorkSSD/repos/personal/penumbra && bun test packages/mcp/test/format-summary.test.ts
```

- [ ] **Step 3: Implement utilities in `format-summary.ts`**

```ts
// packages/mcp/src/format-summary.ts

const DIM_OPEN = '\x1b[2m';
const DIM_CLOSE = '\x1b[0m';

export function dimColor(text: string): string {
  if (process.env.NO_COLOR === '1') return text;
  return `${DIM_OPEN}${text}${DIM_CLOSE}`;
}

export function truncateId(id: string, length: number): string {
  if (id.length <= length) return id;
  return `${id.slice(0, length)}…`;
}

export function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return s > 0 ? `${m}m${s.toString().padStart(2, '0')}s` : `${m}m`;
  }
  if (ms < 86_400_000) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

const GLYPH_MAP: Record<string, string> = {
  dispatched: '◌',
  pending: '◐',
  completed: '●',
  approved: '●',
  failed: '◑',
  rejected: '◑',
  cancelled: '◑',
  expired: '◑',
};

export function glyphFor(status: string): string {
  return GLYPH_MAP[status] ?? '●';
}
```

- [ ] **Step 4: Run, expect 5 PASS**

```bash
bun test packages/mcp/test/format-summary.test.ts
```

- [ ] **Step 5: Write failing tests for the 8 per-tool formatters**

```ts
// append to format-summary.test.ts:
import {
  formatChainStart,
  formatChainStatus,
  formatChainWait,
  formatChainGetResponse,
  formatHandoffGet,
  formatHandoffListPending,
  formatPermissionListPending,
  formatPermissionApprove,
  wrapWithSummary,
} from '../src/format-summary.js';

describe('per-tool formatters', () => {
  beforeEach(() => { process.env.NO_COLOR = '1'; });  // simplify golden strings
  afterEach(() => { delete process.env.NO_COLOR; });

  test('formatChainStart', () => {
    expect(formatChainStart({
      conversation_id: 'conv-abc',
      handoff_id: '7d3a91ab-1234-5678',
      agent: 'claude-acp-sonnet',
      trust_mode: 'config',
    })).toBe('◌ chain_start  claude-acp-sonnet  h-7d3a91a…  trust=config');
  });

  test('formatChainStatus dispatched', () => {
    expect(formatChainStatus({
      handoff_id: '7d3a91ab-1234-5678',
      status: 'dispatched',
      worker_id: 'worker-b',
      started_at: new Date(Date.now() - 192_000).toISOString(),
      resolved_at: null,
      error_summary: null,
    })).toBe('◌ chain_status  h-7d3a91a…  dispatched on worker-b  3m12s');
  });

  test('formatChainStatus completed', () => {
    expect(formatChainStatus({
      handoff_id: '7d3a91ab-1234-5678',
      status: 'completed',
      worker_id: 'worker-b',
      started_at: new Date(Date.now() - 247_000).toISOString(),
      resolved_at: new Date().toISOString(),
      error_summary: null,
    })).toMatch(/^● chain_status  h-7d3a91a…  completed on worker-b  /);
  });

  test('formatChainWait', () => {
    expect(formatChainWait({
      status: 'completed',
      last_handoff_id: '7d3a91ab-1234-5678',
      // simulating elapsed via test-supplied field if needed; otherwise the formatter uses Date math
    }, 247_000)).toBe('● chain_wait  h-7d3a91a…  completed in 4m07s');
  });

  test('formatChainGetResponse single', () => {
    expect(formatChainGetResponse({
      responses: [{ ts: '...', agent: 'claude-acp-sonnet', text: '...' }],
    })).toBe('● chain_get_response  claude-acp-sonnet  1 response');
  });

  test('formatChainGetResponse plural', () => {
    expect(formatChainGetResponse({
      responses: [
        { ts: '...', agent: 'claude-acp-sonnet', text: '...' },
        { ts: '...', agent: 'claude-acp-sonnet', text: '...' },
      ],
    })).toBe('● chain_get_response  claude-acp-sonnet  2 responses');
  });

  test('formatHandoffGet', () => {
    expect(formatHandoffGet({
      handoff: {
        handoff_id: '7d3a91ab-1234-5678',
        agent_name: 'codex-mini',
        status: 'dispatched',
      },
    })).toBe('◌ handoff  h-7d3a91a…  codex-mini  dispatched');
  });

  test('formatHandoffListPending populated', () => {
    expect(formatHandoffListPending({
      handoffs: [
        { handoff_id: 'h1', worker_id: 'worker-primary', status: 'dispatched' },
        { handoff_id: 'h2', worker_id: 'worker-b', status: 'dispatched' },
        { handoff_id: 'h3', worker_id: 'worker-b', status: 'dispatched' },
      ],
    })).toBe('◌ handoff_list_pending  3 entries  worker-primary:1, worker-b:2');
  });

  test('formatHandoffListPending empty', () => {
    expect(formatHandoffListPending({ handoffs: [] })).toBe('● handoff_list_pending  no pending');
  });

  test('formatPermissionListPending populated', () => {
    const oldestAt = Date.now() - 720_000;
    expect(formatPermissionListPending({
      permissions: [
        { permission_id: 'p1', requested_at: new Date(oldestAt).toISOString() },
        { permission_id: 'p2', requested_at: new Date(Date.now() - 60_000).toISOString() },
      ],
    })).toMatch(/^◐ permission_list_pending  2 pending  oldest 12m/);
  });

  test('formatPermissionListPending empty', () => {
    expect(formatPermissionListPending({ permissions: [] }))
      .toBe('● permission_list_pending  no pending');
  });

  test('formatPermissionApprove approve', () => {
    expect(formatPermissionApprove({
      permission_id: 'abc123def456',
      status: 'approved',
      decision: 'approve',
      remember: 'this_dispatch',
    })).toBe('● permission  abc123…  approve  remember=this_dispatch');
  });

  test('formatPermissionApprove reject', () => {
    expect(formatPermissionApprove({
      permission_id: 'abc123def456',
      status: 'rejected',
      decision: 'reject',
      remember: 'this_call',
    })).toBe('◑ permission  abc123…  reject  remember=this_call');
  });

  test('wrapWithSummary combines header + JSON', () => {
    const result = wrapWithSummary('◌ chain_status  h-abc…  dispatched', { foo: 1 });
    expect(result).toBe('◌ chain_status  h-abc…  dispatched\n\n{\n  "foo": 1\n}');
  });
});
```

- [ ] **Step 6: Run, confirm FAIL** (functions not yet defined)

- [ ] **Step 7: Implement the 8 formatters + wrapWithSummary**

Append to `packages/mcp/src/format-summary.ts`:

```ts
// Wrap a tool's structured payload with a header for human readability.
// The maestro parses the JSON; the user reads the header.
export function wrapWithSummary(summary: string, payload: unknown): string {
  return `${summary}\n\n${JSON.stringify(payload, null, 2)}`;
}

// ----- Per-tool formatters -----

export interface ChainStartResult {
  conversation_id: string;
  handoff_id: string;
  agent?: string;
  trust_mode?: string;
}
export function formatChainStart(r: ChainStartResult): string {
  const id = dimColor(`h-${truncateId(r.handoff_id.replace(/-/g, ''), 7)}`);
  const agent = r.agent ?? 'unknown-agent';
  const trust = r.trust_mode ?? 'all';
  return `◌ chain_start  ${agent}  ${id}  trust=${trust}`;
}

export interface ChainStatusResult {
  handoff_id: string;
  status: string;
  worker_id: string | null;
  started_at: string | null;
  resolved_at: string | null;
  error_summary: string | null;
}
export function formatChainStatus(r: ChainStatusResult): string {
  const id = dimColor(`h-${truncateId(r.handoff_id.replace(/-/g, ''), 7)}`);
  const worker = r.worker_id ? dimColor(r.worker_id) : 'unassigned';
  const elapsed = r.started_at
    ? formatElapsed(Date.now() - new Date(r.started_at).getTime())
    : '0s';
  const errSuffix = r.error_summary ? `  err=${r.error_summary.slice(0, 30)}` : '';
  return `${glyphFor(r.status)} chain_status  ${id}  ${r.status} on ${worker}  ${elapsed}${errSuffix}`;
}

export interface ChainWaitResult {
  status: string;
  last_handoff_id: string;
}
// elapsedMsHint optional — caller can pass a measured elapsed; else 0
export function formatChainWait(r: ChainWaitResult, elapsedMsHint: number = 0): string {
  const id = dimColor(`h-${truncateId(r.last_handoff_id.replace(/-/g, ''), 7)}`);
  const elapsed = formatElapsed(elapsedMsHint);
  return `${glyphFor(r.status)} chain_wait  ${id}  ${r.status} in ${elapsed}`;
}

export interface ChainGetResponseResult {
  responses: Array<{ ts: string; agent: string; text: string }>;
}
export function formatChainGetResponse(r: ChainGetResponseResult): string {
  const n = r.responses.length;
  const agent = n > 0 ? r.responses[n - 1]!.agent : 'no-agent';
  const noun = n === 1 ? 'response' : 'responses';
  return `● chain_get_response  ${agent}  ${n} ${noun}`;
}

export interface HandoffGetResult {
  handoff: {
    handoff_id: string;
    agent_name: string;
    status: string;
  };
}
export function formatHandoffGet(r: HandoffGetResult): string {
  const h = r.handoff;
  const id = dimColor(`h-${truncateId(h.handoff_id.replace(/-/g, ''), 7)}`);
  return `${glyphFor(h.status)} handoff  ${id}  ${h.agent_name}  ${h.status}`;
}

export interface HandoffListPendingResult {
  handoffs: Array<{ handoff_id: string; worker_id: string | null; status: string }>;
}
export function formatHandoffListPending(r: HandoffListPendingResult): string {
  const hs = r.handoffs;
  if (hs.length === 0) return '● handoff_list_pending  no pending';
  const byWorker = new Map<string, number>();
  for (const h of hs) {
    const w = h.worker_id ?? 'unassigned';
    byWorker.set(w, (byWorker.get(w) ?? 0) + 1);
  }
  const summary = Array.from(byWorker.entries()).map(([w, c]) => `${dimColor(w)}:${c}`).join(', ');
  return `◌ handoff_list_pending  ${hs.length} entries  ${summary}`;
}

export interface PermissionListPendingResult {
  permissions: Array<{ permission_id: string; requested_at: string }>;
}
export function formatPermissionListPending(r: PermissionListPendingResult): string {
  const ps = r.permissions;
  if (ps.length === 0) return '● permission_list_pending  no pending';
  const oldestAt = ps.reduce((min, p) => Math.min(min, new Date(p.requested_at).getTime()), Infinity);
  const oldestAge = formatElapsed(Date.now() - oldestAt);
  return `◐ permission_list_pending  ${ps.length} pending  oldest ${oldestAge}`;
}

export interface PermissionApproveResult {
  permission_id: string;
  status: string;
  decision: string;
  remember?: string;
}
export function formatPermissionApprove(r: PermissionApproveResult): string {
  const id = dimColor(truncateId(r.permission_id.replace(/-/g, ''), 6));
  const remember = r.remember ?? 'this_call';
  return `${glyphFor(r.status)} permission  ${id}  ${r.decision}  remember=${remember}`;
}
```

- [ ] **Step 8: Run, expect ~18 PASS**

```bash
bun test packages/mcp/test/format-summary.test.ts
```

If a golden-string test fails because of extra whitespace or em-dash variant, fix the formatter (don't fix the test — the test asserts the spec's literal format).

- [ ] **Step 9: Typecheck clean**

```bash
bun typecheck
```

- [ ] **Step 10: Commit**

```bash
git add packages/mcp/src/format-summary.ts packages/mcp/test/format-summary.test.ts
git commit -m "feat(mcp): format-summary helpers for inline visual sugar"
```

---

## Task 2 — Wrap 8 MCP tool handlers with summary headers

**Files:**
- Modify: 8 handler files in `packages/mcp/src/tools/`
- Modify: 8 test files in `packages/mcp/test/tools/`

Each handler currently returns:
```ts
return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
```

Each needs to wrap with the formatter:
```ts
import { formatXxx, wrapWithSummary } from '../format-summary.js';
// ...
return { content: [{ type: 'text', text: wrapWithSummary(formatXxx(payload), payload) }] };
```

The 8 handlers + their formatters:

| Handler file | Formatter |
|---|---|
| `chain-start.ts` | `formatChainStart` |
| `chain-status.ts` | `formatChainStatus` |
| `chain-wait.ts` | `formatChainWait` (pass elapsedMs from caller's tracked startTime) |
| `chain-get-response.ts` | `formatChainGetResponse` |
| `handoff-get.ts` | `formatHandoffGet` |
| `handoff-list.ts` | `formatHandoffListPending` |
| `permission-list-pending.ts` | `formatPermissionListPending` |
| `permission-approve.ts` | `formatPermissionApprove` |

For each: read the handler, identify the response shape, wrap with the formatter.

- [ ] **Step 1: chain-start.ts wrapping**

Read `packages/mcp/src/tools/chain-start.ts`. Find the `return { content: [{type:'text', text: JSON.stringify(...)}] }` line. Replace with:

```ts
import { formatChainStart, wrapWithSummary } from '../format-summary.js';
// ...
return {
  content: [{
    type: 'text',
    text: wrapWithSummary(
      formatChainStart({ conversation_id: ..., handoff_id: ..., agent: ..., trust_mode: ... }),
      { conversation_id: ..., handoff_id: ... },
    ),
  }],
};
```

(Substitute the actual values from the existing handler.)

- [ ] **Step 2: Update existing chain-start test**

Find `packages/mcp/test/tools/chain-start.test.ts`. Wherever it asserts on `result.content[0].text` containing JSON, add a parallel assertion that the text starts with the summary header:

```ts
expect(result.content[0]!.text).toMatch(/^◌ chain_start  /);
expect(result.content[0]!.text).toContain(JSON.stringify(...));  // existing assertion adapted
```

If the existing test asserts a strict equality to `JSON.stringify(payload)`, change to `toContain` since the format now includes a header.

- [ ] **Step 3: Run chain-start tests, expect PASS**

```bash
bun test packages/mcp/test/tools/chain-start.test.ts
```

- [ ] **Step 4: Repeat Steps 1-3 for chain-status.ts**

`chain-status.test.ts` exists. Same pattern: import `formatChainStatus`, wrap, assert header prefix.

For `chain_status`, the formatter takes a `ChainStatusResult` with field names matching what `chainStatusHandler` returns. Likely a 1:1 mapping; verify by reading the handler.

- [ ] **Step 5: Repeat for chain-wait.ts**

Special case: `formatChainWait` takes `elapsedMsHint` as a 2nd arg. The handler should track when the wait started and pass `Date.now() - startMs`:

```ts
const startedAt = Date.now();
// ... existing wait logic ...
const result = await daemon.chainWait(...);
const elapsedMs = Date.now() - startedAt;
return {
  content: [{
    type: 'text',
    text: wrapWithSummary(formatChainWait(result, elapsedMs), result),
  }],
};
```

- [ ] **Step 6: Repeat for chain-get-response.ts**

The handler likely has access to the responses array directly. Pass it to `formatChainGetResponse`.

- [ ] **Step 7: Repeat for handoff-get.ts**

`handoff-get.ts` returns `{ handoff: {...} }`. Pass that to `formatHandoffGet` directly.

- [ ] **Step 8: Repeat for handoff-list.ts**

Returns `{ handoffs: [...] }`. Pass to `formatHandoffListPending`. Note: the formatter expects `handoff_id`, `worker_id`, `status` on each entry — confirm the daemon returns those fields; if not, map.

- [ ] **Step 9: Repeat for permission-list-pending.ts**

Returns `{ permissions: [...] }`. Each permission needs `permission_id` and `requested_at`. Confirm daemon shape; map if necessary.

- [ ] **Step 10: Repeat for permission-approve.ts**

Returns `{ permission_id, status, decision, remember }`. Pass to `formatPermissionApprove`.

- [ ] **Step 11: Run full mcp test suite**

```bash
bun test packages/mcp/test/
```

Expected: all passing. If a test was using strict equality on `JSON.stringify(...)` and a `toContain` swap was missed, fix it.

- [ ] **Step 12: Typecheck clean**

```bash
bun typecheck
```

- [ ] **Step 13: Commit**

```bash
git add packages/mcp/src/tools/ packages/mcp/test/tools/
git commit -m "feat(mcp): wrap 8 tool handlers with summary headers"
```

If you find a handler whose actual return shape differs significantly from the formatter's assumed type, EXTEND the formatter with the additional fields rather than skipping the wrap. The summary header must apply to all 8 listed tools.

---

## Task 3 — `penumbra statusline` CLI subcommand

**Files:**
- Create: `packages/cli/src/commands/statusline.ts`
- Modify: `packages/cli/bin/penumbra.ts` (add `case 'statusline':` to dispatcher)
- Test: `packages/cli/test/commands/statusline.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/cli/test/commands/statusline.test.ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { unlink, writeFile } from 'node:fs/promises';
import { runStatusline } from '../../src/commands/statusline.js';

const CACHE_PATH = '/tmp/penumbra-statusline.cache';

interface MockDaemonResponse {
  dispatchedHandoffs: number;
  pendingPermissions: number;
  doneInLastHour: number;
}

function makeMockFetch(response: MockDaemonResponse | 'offline') {
  return async (url: string) => {
    if (response === 'offline') throw new Error('connect ECONNREFUSED');
    // simulate three daemon route calls — we don't actually distinguish here, just return
    // a synthetic merged response
    return {
      ok: true,
      json: async () => ({
        handoffs: Array(response.dispatchedHandoffs).fill({ status: 'dispatched' }),
        permissions: Array(response.pendingPermissions).fill({ status: 'pending' }),
        done: response.doneInLastHour,
      }),
    };
  };
}

describe('penumbra statusline', () => {
  beforeEach(async () => {
    try { await unlink(CACHE_PATH); } catch {}
    process.env.NO_COLOR = '1';
  });
  afterEach(() => { delete process.env.NO_COLOR; });

  test('cache hit returns cached line without daemon call', async () => {
    const cached = '◌ penumbra  3 dispatched  12 done';
    await writeFile(CACHE_PATH, JSON.stringify({ ts: Date.now(), line: cached }));
    let fetchCalls = 0;
    const out = await runStatusline({ fetch: () => { fetchCalls++; throw new Error('shouldnt-call'); } });
    expect(out).toBe(cached);
    expect(fetchCalls).toBe(0);
  });

  test('cache miss writes cache after fetch', async () => {
    const out = await runStatusline({ fetch: makeMockFetch({ dispatchedHandoffs: 3, pendingPermissions: 0, doneInLastHour: 12 }) });
    expect(out).toBe('◌ penumbra  3 dispatched  12 done');
    const cached = await Bun.file(CACHE_PATH).text();
    expect(cached).toContain('"line":"◌ penumbra  3 dispatched  12 done"');
  });

  test('daemon offline returns graceful fallback', async () => {
    const out = await runStatusline({ fetch: makeMockFetch('offline') });
    expect(out).toBe('◑ penumbra  daemon offline');
  });

  test('glyph priority — pending permission wins over dispatched', async () => {
    const out = await runStatusline({ fetch: makeMockFetch({ dispatchedHandoffs: 3, pendingPermissions: 1, doneInLastHour: 12 }) });
    expect(out).toBe('◐ penumbra  1 awaiting  3 dispatched  12 done');
  });

  test('idle state shows no counts', async () => {
    const out = await runStatusline({ fetch: makeMockFetch({ dispatchedHandoffs: 0, pendingPermissions: 0, doneInLastHour: 0 }) });
    expect(out).toBe('● penumbra  idle');
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found)

- [ ] **Step 3: Implement `statusline.ts`**

```ts
// packages/cli/src/commands/statusline.ts
import { resolveDaemonStorageRoot } from '@penumbra/core';
import { readFile, writeFile } from 'node:fs/promises';

const CACHE_PATH = '/tmp/penumbra-statusline.cache';
const CACHE_TTL_MS = 2_000;
const DAEMON_TIMEOUT_MS = 1_500;

interface StatuslineCache {
  ts: number;
  line: string;
}

interface DaemonCounts {
  dispatched: number;
  awaiting: number;
  done: number;
}

export interface RunStatuslineOpts {
  /** Optional fetch override for tests */
  fetch?: typeof globalThis.fetch;
  /** Optional storage-root override; default resolves via @penumbra/core */
  storageRoot?: string;
}

export async function runStatusline(opts: RunStatuslineOpts = {}): Promise<string> {
  // 1. Cache hit?
  try {
    const raw = await readFile(CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as StatuslineCache;
    if (Date.now() - parsed.ts < CACHE_TTL_MS) return parsed.line;
  } catch { /* cache miss; continue */ }

  // 2. Fetch from daemon
  let counts: DaemonCounts;
  try {
    counts = await fetchCounts(opts.fetch ?? globalThis.fetch, opts.storageRoot);
  } catch {
    return '◑ penumbra  daemon offline';
  }

  // 3. Format line
  const line = formatLine(counts);

  // 4. Write cache (best-effort; ignore failures)
  try {
    await writeFile(CACHE_PATH, JSON.stringify({ ts: Date.now(), line } satisfies StatuslineCache));
  } catch { /* swallow */ }

  return line;
}

async function fetchCounts(fetchFn: typeof globalThis.fetch, storageRootOverride?: string): Promise<DaemonCounts> {
  const storageRoot = storageRootOverride ?? process.env.PENUMBRA_STORAGE_ROOT ?? resolveDaemonStorageRoot();
  // Resolve daemon URL — port lives at <storage_root>/port; the existing
  // daemon-client pattern handles this. For a one-off CLI we read the port file.
  const portPath = `${storageRoot}/port`;
  const port = (await readFile(portPath, 'utf8')).trim();
  const tokenPath = `${storageRoot}/token`;
  const token = (await readFile(tokenPath, 'utf8')).trim();
  const baseUrl = `http://127.0.0.1:${port}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DAEMON_TIMEOUT_MS);

  try {
    const headers = { authorization: `Bearer ${token}` };
    const [handoffsRes, permsRes] = await Promise.all([
      fetchFn(`${baseUrl}/handoffs?status=dispatched`, { headers, signal: controller.signal }),
      fetchFn(`${baseUrl}/permissions?status=pending`, { headers, signal: controller.signal }),
    ]);
    if (!handoffsRes.ok || !permsRes.ok) throw new Error('daemon returned non-2xx');
    const handoffs = await handoffsRes.json() as { handoffs?: any[] };
    const perms = await permsRes.json() as { permissions?: any[] };

    // "done in last hour" — derive from a separate query OR from a recent-handoffs endpoint.
    // For first-cut: hit /handoffs?status=completed&since=<1h-ago-iso>
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const doneRes = await fetchFn(`${baseUrl}/handoffs?status=completed&since=${oneHourAgo}`, {
      headers, signal: controller.signal,
    });
    const done = doneRes.ok ? ((await doneRes.json()) as { handoffs?: any[] }).handoffs?.length ?? 0 : 0;

    return {
      dispatched: handoffs.handoffs?.length ?? 0,
      awaiting: perms.permissions?.length ?? 0,
      done,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function formatLine(c: DaemonCounts): string {
  if (c.awaiting > 0) {
    return `◐ penumbra  ${c.awaiting} awaiting  ${c.dispatched} dispatched  ${c.done} done`;
  }
  if (c.dispatched > 0) {
    return `◌ penumbra  ${c.dispatched} dispatched  ${c.done} done`;
  }
  if (c.done === 0) {
    return '● penumbra  idle';
  }
  return `● penumbra  ${c.done} done`;
}
```

- [ ] **Step 4: Run, expect 5 PASS**

```bash
bun test packages/cli/test/commands/statusline.test.ts
```

If the daemon-routes test calls fail due to actual `/handoffs?status=...` shape mismatch, simplify the test mock to match what the implementation actually queries — the test should mirror the production `fetchCounts` shape.

- [ ] **Step 5: Wire `case 'statusline':` into `packages/cli/bin/penumbra.ts`**

Read the file. Find the existing `case 'hook':` block (around line 144). Add a sibling `case 'statusline':`:

```ts
case 'statusline': {
  const { runStatusline } = await import('../src/commands/statusline.js');
  const line = await runStatusline();
  console.log(line);
  process.exit(0);
}
```

Add `statusline` to the usage string near the bottom of the file.

- [ ] **Step 6: Manual integration check**

```bash
bun packages/cli/bin/penumbra.ts statusline
```

Expected: a single line output matching the format. If daemon is up and idle: `● penumbra  idle`. If daemon offline: `◑ penumbra  daemon offline`. Make sure it doesn't throw or produce stderr noise.

- [ ] **Step 7: Typecheck clean**

```bash
bun typecheck
```

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/commands/statusline.ts packages/cli/test/commands/statusline.test.ts packages/cli/bin/penumbra.ts
git commit -m "feat(cli): penumbra statusline subcommand for Claude Code statusline"
```

---

## Task 4 — Settings.json wiring + smoke check (maestro-driven)

**Files:**
- Modify: `~/.claude/settings.json` (machine-local; not in repo)

This task is performed by the maestro after Tasks 1-3 land on main and a fresh maestro session starts.

- [ ] **Step 1: Read current `~/.claude/settings.json`** to confirm shape

```bash
cat ~/.claude/settings.json | head -20
```

- [ ] **Step 2: Add `statusLine` config**

Add to the top-level object:

```json
"statusLine": {
  "type": "command",
  "command": "PENUMBRA_STORAGE_ROOT=/tmp/penumbra-live bun /Volumes/WorkSSD/repos/personal/penumbra/packages/cli/bin/penumbra.ts statusline"
}
```

If `statusLine` already exists, REPLACE its value (don't merge — Claude Code only invokes one).

- [ ] **Step 3: Restart Claude Code (the maestro session)**

The new statusline takes effect when Claude Code re-reads settings.json on next session start, OR when the user manually runs `/config reload`.

- [ ] **Step 4: Verify in real session**

After restart, the statusline should be visible. Trigger a few states to verify:
- Run a quick MCP-tool call (e.g., `mcp__penumbra__chain_list_agents`) — confirm the inline header renders.
- Dispatch a chain (`chain_start`) — confirm statusline updates from `● penumbra  idle` to `◌ penumbra  1 dispatched  X done` within ~5s.
- Wait for chain to complete — confirm statusline returns to `● penumbra  X done`.

Expected: glyphs render correctly in the terminal; dim color visible on IDs; no stderr noise; no blocking.

If anything looks off (broken glyph, wrong color escape, slow refresh), capture a screenshot or terminal capture and report.

- [ ] **Step 5: Document outcome**

Append a "Visual sugar smoke results" section to this plan with the maestro's findings. Commit.

```bash
git add docs/superpowers/plans/2026-04-28-maestro-visual-sugar.md
git commit -m "docs(maestro-visual-sugar): smoke results for visual sugar shipping"
```

---

## Self-review notes (for plan author)

- [x] **Spec coverage:** every spec section (§ 1-11) maps to a task. Inline rendering = Tasks 1+2; statusline = Task 3; harness wiring = Task 4. Out-of-scope items (notifications, theming) are not implemented per spec § 10.
- [x] **Placeholder scan:** no TBD/TODO/"appropriate error handling" in any step. Each step has either complete code or a concrete file-modification instruction.
- [x] **Type consistency:** formatter input types in Task 1 match the daemon return shapes assumed in Task 2. Each `formatXxx(...)` call site in Task 2 references the type defined in Task 1.

## Visual sugar smoke results

**Shipped 2026-04-28**, three Round 1+2 dispatches landed clean on `main`:

| Task | Agent | Commit | Tests | Notes |
|---|---|---|---|---|
| 1 — `format-summary.ts` + 8 formatters | gemini (pro) | `ea71509` | 19/19 pass | Caught a real plan defect: `formatElapsed` needed `Math.round` for the hours-rollover case, not `Math.floor`. Fixed implementation to match spec golden strings. |
| 3 — `penumbra statusline` CLI | codex-mini | `c4aef72` | 5/5 pass | Architectural surface: `done` count is conservative — daemon has no `completed-since=X` HTTP route. Returns 0 in production until that gap is closed. Mock-driven tests still pass. |
| 2 — wrap 8 MCP handlers | gemini-flash | `1b79af8` | 28 (handler tests) green; 83/83 across full mcp suite | Added `timeout` glyph to `GLYPH_MAP` (sensible enhancement). Tracked elapsed ms in `chain-wait` properly. Self-recovery from one mid-run edit corruption. |

**Aggregate verification on main:**
- `bun typecheck`: 0
- `bun test packages/mcp/test/`: 83 tests across 23 files, 0 failures (cosmetic Bun teardown panic afterward — pre-existing).

**Task 4 (maestro-side wiring):**

`~/.claude/settings.json` already had `statusLine` bound to OpenIsland (`/Users/acordeiro/.open-island/bin/open-island-statusline`). To preserve OpenIsland alongside penumbra, a composer wrapper was added:

- New file: `~/.claude/hooks/statusline-combined.sh` (machine-local, not in repo) — forwards stdin to OpenIsland (which consumes session JSON), invokes `penumbra statusline` separately (no stdin needed), joins with `  ·  ` separator. Falls back gracefully if either command fails.
- `settings.json` `statusLine.command` repointed to the wrapper. `padding: 2` retained.

**Manual smoke (synthetic stdin):**
```
$ echo '{"session_id":"test","cwd":"..."}' | ~/.claude/hooks/statusline-combined.sh
[Claude] 0% context  ·  ● penumbra  idle
```

Daemon at `/tmp/penumbra-live` (PID 91092, since 11:42) was detected as idle; penumbra wing of the line renders with the correct glyph. Pickup of the new statusline + new MCP tool summary headers requires a fresh Claude Code session start (Claude Code re-reads `settings.json` on session start; the running penumbra-mcp processes are long-lived per session).

**Outcome:** All 4 tasks shipped. Two surfaced architectural notes for future tracking:
1. Daemon lacks a `/handoffs?status=completed&since=X` route — `penumbra statusline` returns `done: 0` in production. Cheap to add later if visible in the statusline turns out to matter.
2. The `padding: 2` on `statusLine` may compound oddly with the new wrapper — verify on first live session and adjust if the line looks cramped or padded twice.
