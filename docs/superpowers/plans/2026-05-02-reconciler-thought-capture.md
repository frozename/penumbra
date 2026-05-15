# Reconciler Thought-Capture Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use penumbra:dispatching (recommended) or penumbra:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture agent reasoning chunks as first-class dispatch events, normalize across adapters, persist alongside other dispatch_events, and let the reconciler optionally analyze the captured stream at merge time using configurable agents (defaulting to local models for cost).

**Architecture:** Three layers. (1) Per-adapter normalizer (`thought-capture.ts`) emits canonical `agent.thought` events into the existing `DispatchEventQueue`. (2) Persistence reuses `dispatch_events` via four new `DispatchEventKind` values. (3) `thought-analyzer.ts` runs at reconciler time when the merge outcome matches an allowlist; it dispatches digest and signal-extraction sub-handoffs via `chain_start` and records results back as new dispatch events. All new behavior is gated behind a top-level `thoughts:` block in `agentchat.yaml` that defaults to disabled.

**Tech Stack:** Bun, TypeScript, zod, bun:sqlite, the existing `DispatchEventQueue` / `chain_start` infrastructure, the existing `merge-reconciler.ts` flow.

---

## Current Facts From Exploration

- `DispatchEventKind` lives in `packages/core/src/services/dispatch-event-log.ts:3-17` as a string-literal union; today it covers dispatch/proc/cancel/heartbeat/watchdog/acp event families.
- Daemon route validation in `packages/daemon/src/routes/dispatch-events.ts:19-25` re-derives an enum (`KIND_VALUES`) from the union and validates POST bodies against it. New kinds must be added there too or POSTs will 400.
- `DispatchEventQueue` is wired in `packages/agentchat/bin/agentchat-worker.ts:12,82` (`new DispatchEventQueue({...})`) and exposes a buffered fire-and-forget `.enqueue()` method.
- Adapters call into the queue via the `eventContext` plumbed through `SpawnOpts`/adapter deps; `cli-spawn.ts` already emits `proc.spawn`, `proc.kill.sent`, `proc.exited.resolved`.
- `stdio-acp.ts` emits `acp.server.start`, `acp.session.start`, `acp.session.end` and routes ACP RPC notifications through a `JSONRPCNotification` dispatch table.
- Merge-reconciler at `packages/agentchat/src/worker/merge-reconciler.ts:202` exposes `createMergeReconciler(deps)`; the existing flow computes a `MergeResult`, then optionally calls `deps.notifyResult(handoffId, result)` (line ~225) before returning. There is no post-`notifyResult` hook today; the new analyzer step is added here.
- `loadNotificationConfig` in `packages/agentchat/src/worker/notification-config.ts` is the existing pattern for env+yaml normalization with snake_case schema and camelCase runtime keys; the new thought-config follows the same shape.
- `chain_start` is reachable from the worker via `PenumbraClient` (it already drives sub-handoffs in other contexts); no new transport needed.

## File Structure

| Action | Path | Responsibility |
| --- | --- | --- |
| Modify | `packages/agentchat/src/config/types.ts` | Add `ThoughtsConfigSchema` with capture and analyze sub-blocks; wire onto `AgentChatConfigSchema` |
| Create | `packages/agentchat/src/worker/thought-config.ts` | Runtime normalizer producing camelCase `RuntimeThoughtsConfig` from yaml + env |
| Create | `packages/agentchat/test/worker/thought-config.test.ts` | Schema parse + normalizer tests |
| Modify | `packages/core/src/services/dispatch-event-log.ts` | Add `agent.thought`, `agent.thought.overflow`, `agent.thought.digest`, `agent.thought.signal` to `DispatchEventKind` |
| Modify | `packages/core/test/services/dispatch-event-log.test.ts` | Round-trip tests for the four new kinds |
| Modify | `packages/daemon/src/routes/dispatch-events.ts` | Extend `KIND_VALUES` with the four new kinds |
| Modify | `packages/daemon/test/routes/dispatch-events.test.ts` | POST + GET tests for the new kinds |
| Create | `packages/agentchat/src/worker/thought-capture.ts` | `ThoughtCapture` class: normalize → redact → truncate → enqueue; per-stream byte counter |
| Create | `packages/agentchat/test/worker/thought-capture.test.ts` | Unit tests for shape, redaction, per-row truncation, per-stream cap |
| Modify | `packages/agentchat/src/adapters/stdio-acp.ts` | Hook the ACP `agent_thought_chunk` notification path through `ThoughtCapture` |
| Modify | `packages/agentchat/test/adapters/stdio-acp.test.ts` | Test that incoming ACP thought chunks flow through the capture pipeline |
| Modify | `packages/agentchat/src/adapters/cli-spawn.ts` | Optional `<thinking>…</thinking>` stdout parsing when adapter has `emit_stdout_thoughts: true` |
| Modify | `packages/agentchat/test/adapters/cli-spawn.test.ts` | Tests for opt-in stdout-thinking parsing (on and off) |
| Create | `packages/agentchat/src/worker/thought-analyzer.ts` | `runThoughtAnalyzer({ handoffId, thoughts, config, deps })`; digest + per-signal sub-handoffs |
| Create | `packages/agentchat/test/worker/thought-analyzer.test.ts` | Pipeline tests with mocked `chain_start` |
| Modify | `packages/agentchat/src/worker/merge-reconciler.ts` | Add gated post-merge analyze step using `thought-analyzer` |
| Modify | `packages/agentchat/test/worker/merge-reconciler.test.ts` | Gating, recursion guard, parallel signal dispatch, failure isolation |
| Create | `packages/agentchat/test/integration/thoughts-e2e.test.ts` | One end-to-end test: dispatch → live thought events → merge → digest + signal events visible via `dispatch.timeline` |
| Modify | `docs/superpowers/notes/2026-04-28-discord-mcp-setup.md` | Cross-link only; full thought-capture setup goes under a new "## Thought capture" section in this same file |

## Resolved Decisions

1. New event kinds live in the existing `dispatch_events` table; no new tables.
2. `thoughts.enabled = false` is the master gate. With it false, the normalizer is never instantiated, the analyzer is never invoked, and no new code paths run.
3. Adapter coverage at v1 is honest: `stdio-acp` (active emitter today is claude-acp-sonnet) and opt-in `cli-spawn` stdout parsing. Other adapters are out of scope.
4. Reconciler-time analysis runs *after* `notifyResult` has already fired. Notifications do not change at v1.
5. Sub-handoffs use the existing `chain_start` with `parent_handoff_id` set to the original dispatch. The recursion guard in the analyzer is `parent_handoff_id IS NULL` — analyzer dispatches don't trigger more analysis.
6. Stream cap per-dispatch is 1 MB; per-row cap is 16 KB; analyzer input cap is 50 000 chars. All overridable in config.

---

## Task 1: Add Thoughts Config Schema And Runtime Normalizer

**Files:**
- Modify: `packages/agentchat/src/config/types.ts`
- Create: `packages/agentchat/src/worker/thought-config.ts`
- Test: `packages/agentchat/test/worker/thought-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agentchat/test/worker/thought-config.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { AgentChatConfigSchema } from '../../src/config/types.js';
import { loadThoughtsConfig } from '../../src/worker/thought-config.js';

describe('thoughts config schema', () => {
  it('accepts a minimal thoughts block', () => {
    const parsed = AgentChatConfigSchema.parse({
      agents: [{ name: 'codex', adapter: 'codex-cli' }],
      thoughts: {
        enabled: true,
        capture: {
          adapters: { 'stdio-acp': true },
        },
        analyze: {
          enabled: true,
          only_when: ['pr_opened'],
          digest: { enabled: true, agent: 'local-gemma26' },
          signals: {
            enabled: true,
            agent: 'local-gemma26',
            definitions: [{ name: 'uncertainty', prompt: 'list doubts' }],
          },
        },
      },
    });
    expect(parsed.thoughts?.enabled).toBe(true);
    expect(parsed.thoughts?.analyze?.signals?.definitions?.[0]?.name).toBe('uncertainty');
  });
});

describe('loadThoughtsConfig', () => {
  it('returns a disabled config when no thoughts block is present', () => {
    const cfg = loadThoughtsConfig({
      agentchat: { agents: [{ name: 'codex', adapter: 'codex-cli', options: {}, roles: [], auto_approve_to: [] }], default_roles: {}, providers: [] },
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.capture.maxTextBytes).toBe(16384);
    expect(cfg.capture.maxStreamBytes).toBe(1048576);
    expect(cfg.analyze.enabled).toBe(false);
  });

  it('preserves capture caps and analyze gating from the config', () => {
    const cfg = loadThoughtsConfig({
      agentchat: {
        agents: [{ name: 'codex', adapter: 'codex-cli', options: {}, roles: [], auto_approve_to: [] }],
        default_roles: {},
        providers: [],
        thoughts: {
          enabled: true,
          capture: {
            max_text_bytes: 8000,
            max_stream_bytes: 200000,
            adapters: { 'stdio-acp': true, 'cli-spawn': false },
            per_agent_overrides: { 'gemini-acp-pro': false },
          },
          analyze: {
            enabled: true,
            only_when: ['pr_opened', 'test_failed'],
            digest: { enabled: true, agent: 'local-gemma26', max_input_chars: 4000, timeout_ms: 30000 },
            signals: {
              enabled: true,
              agent: 'local-gemma31',
              timeout_ms: 30000,
              definitions: [
                { name: 'uncertainty', prompt: 'list doubts' },
                { name: 'security', prompt: 'list security risks' },
              ],
            },
          },
        },
      },
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.capture.maxTextBytes).toBe(8000);
    expect(cfg.capture.adapters['stdio-acp']).toBe(true);
    expect(cfg.capture.adapters['cli-spawn']).toBe(false);
    expect(cfg.capture.perAgentOverrides['gemini-acp-pro']).toBe(false);
    expect(cfg.analyze.onlyWhen).toEqual(['pr_opened', 'test_failed']);
    expect(cfg.analyze.digest.agent).toBe('local-gemma26');
    expect(cfg.analyze.digest.maxInputChars).toBe(4000);
    expect(cfg.analyze.signals.definitions).toHaveLength(2);
    expect(cfg.analyze.signals.definitions[1]?.name).toBe('security');
  });

  it('disables analyze when capture is disabled', () => {
    const cfg = loadThoughtsConfig({
      agentchat: {
        agents: [{ name: 'codex', adapter: 'codex-cli', options: {}, roles: [], auto_approve_to: [] }],
        default_roles: {},
        providers: [],
        thoughts: {
          enabled: false,
          analyze: { enabled: true, digest: { enabled: true, agent: 'local-gemma26' } },
        },
      },
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.analyze.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/agentchat/test/worker/thought-config.test.ts
```

Expected: FAIL because `thoughts` is not on `AgentChatConfigSchema` and `loadThoughtsConfig` does not exist.

- [ ] **Step 3: Add zod schemas**

Add to `packages/agentchat/src/config/types.ts` (alongside the existing `NotificationConfigSchema` declarations):

```ts
export const ThoughtSignalDefinitionSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
});

export const ThoughtCaptureConfigSchema = z.object({
  max_text_bytes: z.number().int().positive().default(16384),
  max_stream_bytes: z.number().int().positive().default(1048576),
  adapters: z.record(z.string(), z.boolean()).default({}),
  per_agent_overrides: z.record(z.string(), z.boolean()).default({}),
}).default({});

export const ThoughtDigestConfigSchema = z.object({
  enabled: z.boolean().default(false),
  agent: z.string().min(1).default('local-gemma26'),
  max_input_chars: z.number().int().positive().default(50000),
  timeout_ms: z.number().int().positive().default(60000),
}).default({});

export const ThoughtSignalsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  agent: z.string().min(1).default('local-gemma26'),
  timeout_ms: z.number().int().positive().default(60000),
  max_input_chars: z.number().int().positive().optional(),
  definitions: z.array(ThoughtSignalDefinitionSchema).default([]),
}).default({});

export const ThoughtAnalyzeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  only_when: z.array(z.string().min(1)).default(['pr_opened', 'test_failed', 'typecheck_failed']),
  digest: ThoughtDigestConfigSchema,
  signals: ThoughtSignalsConfigSchema,
}).default({});

export const ThoughtsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  capture: ThoughtCaptureConfigSchema,
  analyze: ThoughtAnalyzeConfigSchema,
}).optional();
```

Then add `thoughts: ThoughtsConfigSchema` to the existing `AgentChatConfigSchema` object alongside `notifications`.

Create `packages/agentchat/src/worker/thought-config.ts`:

```ts
import type { AgentChatConfig } from '../config/types.js';

export interface RuntimeThoughtCaptureConfig {
  maxTextBytes: number;
  maxStreamBytes: number;
  adapters: Record<string, boolean>;
  perAgentOverrides: Record<string, boolean>;
}

export interface RuntimeThoughtSignalDefinition {
  name: string;
  prompt: string;
}

export interface RuntimeThoughtDigestConfig {
  enabled: boolean;
  agent: string;
  maxInputChars: number;
  timeoutMs: number;
}

export interface RuntimeThoughtSignalsConfig {
  enabled: boolean;
  agent: string;
  timeoutMs: number;
  maxInputChars: number | null;
  definitions: RuntimeThoughtSignalDefinition[];
}

export interface RuntimeThoughtAnalyzeConfig {
  enabled: boolean;
  onlyWhen: string[];
  digest: RuntimeThoughtDigestConfig;
  signals: RuntimeThoughtSignalsConfig;
}

export interface RuntimeThoughtsConfig {
  enabled: boolean;
  capture: RuntimeThoughtCaptureConfig;
  analyze: RuntimeThoughtAnalyzeConfig;
}

export function loadThoughtsConfig(input: { agentchat: AgentChatConfig }): RuntimeThoughtsConfig {
  const t = input.agentchat.thoughts;
  const enabled = t?.enabled === true;

  const capture: RuntimeThoughtCaptureConfig = {
    maxTextBytes: t?.capture?.max_text_bytes ?? 16384,
    maxStreamBytes: t?.capture?.max_stream_bytes ?? 1048576,
    adapters: { ...(t?.capture?.adapters ?? {}) },
    perAgentOverrides: { ...(t?.capture?.per_agent_overrides ?? {}) },
  };

  const analyzeRequested = enabled && t?.analyze?.enabled === true;
  const digest: RuntimeThoughtDigestConfig = {
    enabled: analyzeRequested && t?.analyze?.digest?.enabled === true,
    agent: t?.analyze?.digest?.agent ?? 'local-gemma26',
    maxInputChars: t?.analyze?.digest?.max_input_chars ?? 50000,
    timeoutMs: t?.analyze?.digest?.timeout_ms ?? 60000,
  };
  const signals: RuntimeThoughtSignalsConfig = {
    enabled: analyzeRequested && t?.analyze?.signals?.enabled === true,
    agent: t?.analyze?.signals?.agent ?? 'local-gemma26',
    timeoutMs: t?.analyze?.signals?.timeout_ms ?? 60000,
    maxInputChars: t?.analyze?.signals?.max_input_chars ?? null,
    definitions: (t?.analyze?.signals?.definitions ?? []).map((d) => ({ name: d.name, prompt: d.prompt })),
  };

  return {
    enabled,
    capture,
    analyze: {
      enabled: analyzeRequested,
      onlyWhen: t?.analyze?.only_when ?? ['pr_opened', 'test_failed', 'typecheck_failed'],
      digest,
      signals,
    },
  };
}
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/agentchat/test/worker/thought-config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/config/types.ts packages/agentchat/src/worker/thought-config.ts packages/agentchat/test/worker/thought-config.test.ts
git commit -m "feat(agentchat): add thoughts config schema and normalizer"
```

---

## Task 2: Extend DispatchEventKind With Thought Event Kinds

**Files:**
- Modify: `packages/core/src/services/dispatch-event-log.ts`
- Modify: `packages/core/test/services/dispatch-event-log.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/services/dispatch-event-log.test.ts` (mirror the file's existing pattern; use the existing in-memory DB harness):

```ts
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../../src/db/schema.js';
import { DispatchEventLog } from '../../src/services/dispatch-event-log.js';

describe('DispatchEventLog — thought event kinds', () => {
  it('records and lists agent.thought rows with sequence_n + adapter meta', () => {
    const db = new Database(':memory:');
    applySchema(db);
    const log = new DispatchEventLog(db);
    log.record({
      handoff_id: 'h-1',
      worker_id: 'worker-1',
      source: 'worker',
      kind: 'agent.thought',
      ts: '2026-05-02T10:00:00.000Z',
      meta: { sequence_n: 0, adapter: 'stdio-acp', agent_name: 'claude-acp-sonnet', text: 'thinking…', token_count: 12 },
    });
    log.record({
      handoff_id: 'h-1',
      worker_id: 'worker-1',
      source: 'worker',
      kind: 'agent.thought.overflow',
      ts: '2026-05-02T10:00:00.500Z',
      meta: { sequence_n: 0, bytes_dropped: 4096 },
    });
    const rows = log.listByHandoff('h-1');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.kind).toBe('agent.thought');
    expect(rows[1]!.kind).toBe('agent.thought.overflow');
  });

  it('records analyzer event kinds', () => {
    const db = new Database(':memory:');
    applySchema(db);
    const log = new DispatchEventLog(db);
    log.record({
      handoff_id: 'h-2',
      worker_id: null,
      source: 'worker',
      kind: 'agent.thought.digest',
      ts: '2026-05-02T10:01:00.000Z',
      meta: { digester_agent: 'local-gemma26', digest_text: 'short summary' },
    });
    log.record({
      handoff_id: 'h-2',
      worker_id: null,
      source: 'worker',
      kind: 'agent.thought.signal',
      ts: '2026-05-02T10:01:01.000Z',
      meta: { signal_name: 'uncertainty', evidence_text: 'agent doubted X', extractor_agent: 'local-gemma26' },
    });
    const rows = log.listByHandoff('h-2');
    expect(rows.map((r) => r.kind)).toEqual(['agent.thought.digest', 'agent.thought.signal']);
  });
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/core/test/services/dispatch-event-log.test.ts
```

Expected: FAIL with TypeScript error or runtime rejection on the unknown `agent.thought*` kinds.

- [ ] **Step 3: Extend the union**

In `packages/core/src/services/dispatch-event-log.ts:3-17`, add four new members to `DispatchEventKind`:

```ts
export type DispatchEventKind =
  | 'dispatch.start'
  | 'dispatch.end'
  | 'acp.server.start'
  | 'acp.session.start'
  | 'acp.session.end'
  | 'proc.spawn'
  | 'proc.kill.sent'
  | 'proc.exited.resolved'
  | 'cancel.received'
  | 'cancel.dispatched'
  | 'heartbeat.sent'
  | 'heartbeat.received'
  | 'watchdog.tick'
  | 'watchdog.auto_fail'
  | 'agent.thought'
  | 'agent.thought.overflow'
  | 'agent.thought.digest'
  | 'agent.thought.signal';
```

No DB schema change is required — the `kind` column is `TEXT`.

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/core/test/services/dispatch-event-log.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/dispatch-event-log.ts packages/core/test/services/dispatch-event-log.test.ts
git commit -m "feat(core): add thought event kinds to dispatch event log"
```

---

## Task 3: Accept Thought Event Kinds On The Daemon Route

**Files:**
- Modify: `packages/daemon/src/routes/dispatch-events.ts`
- Modify: `packages/daemon/test/routes/dispatch-events.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/daemon/test/routes/dispatch-events.test.ts` a test that POSTs a batch including the four new kinds and asserts `200` plus a GET round-trip. Mirror the file's existing helper that builds an in-process daemon. Concrete additions:

```ts
it('POST accepts agent thought event kinds and GET returns them', async () => {
  const { url, services } = await startTestDaemon();
  const handoffId = 'h-thoughts-1';
  const body = {
    events: [
      { handoff_id: handoffId, worker_id: 'w', source: 'worker', kind: 'agent.thought', ts: '2026-05-02T10:00:00.000Z', meta: { sequence_n: 0, adapter: 'stdio-acp', agent_name: 'claude-acp-sonnet', text: 'thinking', token_count: 5 } },
      { handoff_id: handoffId, worker_id: 'w', source: 'worker', kind: 'agent.thought.overflow', ts: '2026-05-02T10:00:01.000Z', meta: { sequence_n: 0, bytes_dropped: 4096 } },
      { handoff_id: handoffId, worker_id: null, source: 'worker', kind: 'agent.thought.digest', ts: '2026-05-02T10:00:02.000Z', meta: { digester_agent: 'local-gemma26', digest_text: 'summary' } },
      { handoff_id: handoffId, worker_id: null, source: 'worker', kind: 'agent.thought.signal', ts: '2026-05-02T10:00:03.000Z', meta: { signal_name: 'uncertainty', evidence_text: 'doubt', extractor_agent: 'local-gemma26' } },
    ],
  };
  const post = await fetch(`${url}/dispatch/events`, { method: 'POST', headers: authHeaders(services), body: JSON.stringify(body) });
  expect(post.status).toBe(200);

  const get = await fetch(`${url}/dispatch/events?handoff_id=${encodeURIComponent(handoffId)}`, { headers: authHeaders(services) });
  expect(get.status).toBe(200);
  const json = await get.json() as { events: Array<{ kind: string }> };
  expect(json.events.map((e) => e.kind)).toEqual([
    'agent.thought',
    'agent.thought.overflow',
    'agent.thought.digest',
    'agent.thought.signal',
  ]);
});
```

If the existing test file does not export `startTestDaemon` / `authHeaders` helpers, define them inline matching the patterns already used in the file.

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/daemon/test/routes/dispatch-events.test.ts
```

Expected: FAIL with `400 Bad Request` on the POST because `KIND_VALUES` does not include the new kinds.

- [ ] **Step 3: Extend KIND_VALUES**

In `packages/daemon/src/routes/dispatch-events.ts:19`, append the four new kinds to the literal array. Updated declaration:

```ts
const KIND_VALUES = [
  'dispatch.start',
  'dispatch.end',
  'acp.server.start',
  'acp.session.start',
  'acp.session.end',
  'proc.spawn',
  'proc.kill.sent',
  'proc.exited.resolved',
  'cancel.received',
  'cancel.dispatched',
  'heartbeat.sent',
  'heartbeat.received',
  'watchdog.tick',
  'watchdog.auto_fail',
  'agent.thought',
  'agent.thought.overflow',
  'agent.thought.digest',
  'agent.thought.signal',
] as const satisfies readonly DispatchEventKind[];
```

The existing zod schema reads from `KIND_VALUES`; nothing else changes.

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/daemon/test/routes/dispatch-events.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/routes/dispatch-events.ts packages/daemon/test/routes/dispatch-events.test.ts
git commit -m "feat(daemon): accept thought event kinds on dispatch events route"
```

---

## Task 4: Build The Thought-Capture Normalizer

**Files:**
- Create: `packages/agentchat/src/worker/thought-capture.ts`
- Create: `packages/agentchat/test/worker/thought-capture.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agentchat/test/worker/thought-capture.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { ThoughtCapture } from '../../src/worker/thought-capture.js';
import type { RuntimeThoughtsConfig } from '../../src/worker/thought-config.js';

function makeConfig(overrides: Partial<RuntimeThoughtsConfig> = {}): RuntimeThoughtsConfig {
  return {
    enabled: true,
    capture: {
      maxTextBytes: 100,
      maxStreamBytes: 400,
      adapters: { 'stdio-acp': true, 'cli-spawn': true },
      perAgentOverrides: {},
      ...(overrides.capture ?? {}),
    },
    analyze: {
      enabled: false,
      onlyWhen: [],
      digest: { enabled: false, agent: 'local-gemma26', maxInputChars: 50000, timeoutMs: 60000 },
      signals: { enabled: false, agent: 'local-gemma26', timeoutMs: 60000, maxInputChars: null, definitions: [] },
      ...(overrides.analyze ?? {}),
    },
  };
}

describe('ThoughtCapture.recordThought', () => {
  it('emits a canonical agent.thought event and increments sequence_n', () => {
    const enqueued: any[] = [];
    const cap = new ThoughtCapture({ config: makeConfig(), enqueue: (e) => enqueued.push(e) });
    cap.recordThought({ handoffId: 'h-1', adapter: 'stdio-acp', agentName: 'claude-acp-sonnet', text: 'first thought', tokenCount: 4 });
    cap.recordThought({ handoffId: 'h-1', adapter: 'stdio-acp', agentName: 'claude-acp-sonnet', text: 'second thought' });
    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]).toMatchObject({
      kind: 'agent.thought',
      handoff_id: 'h-1',
      meta: { sequence_n: 0, adapter: 'stdio-acp', agent_name: 'claude-acp-sonnet', text: 'first thought', token_count: 4 },
    });
    expect(enqueued[1].meta.sequence_n).toBe(1);
  });

  it('truncates text to maxTextBytes and emits a paired overflow event', () => {
    const enqueued: any[] = [];
    const cap = new ThoughtCapture({ config: makeConfig(), enqueue: (e) => enqueued.push(e) });
    const long = 'x'.repeat(150);
    cap.recordThought({ handoffId: 'h-1', adapter: 'stdio-acp', agentName: 'a', text: long });
    expect(enqueued).toHaveLength(2);
    expect(enqueued[0].kind).toBe('agent.thought');
    expect((enqueued[0].meta.text as string).length).toBe(100);
    expect(enqueued[1].kind).toBe('agent.thought.overflow');
    expect(enqueued[1].meta).toMatchObject({ sequence_n: 0, bytes_dropped: 50 });
  });

  it('redacts api keys, github tokens, discord webhooks, and bearer tokens', () => {
    const enqueued: any[] = [];
    const cap = new ThoughtCapture({ config: makeConfig(), enqueue: (e) => enqueued.push(e) });
    cap.recordThought({
      handoffId: 'h-1', adapter: 'stdio-acp', agentName: 'a',
      text: 'tried sk-test123ABCDEF1234567890 and ghp_abcdef1234567890XYZA and https://discord.com/api/webhooks/12345/abcdef_-XYZ and Authorization: Bearer xyz.abc-123',
    });
    expect(enqueued).toHaveLength(1);
    const text = enqueued[0].meta.text as string;
    expect(text).not.toContain('sk-test123');
    expect(text).not.toContain('ghp_abcdef');
    expect(text).not.toContain('discord.com/api/webhooks/12345');
    expect(text).not.toContain('xyz.abc-123');
    expect(text.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('honors per-stream byte cap and stops emitting after the cap is hit', () => {
    const enqueued: any[] = [];
    const cap = new ThoughtCapture({ config: makeConfig({ capture: { maxTextBytes: 100, maxStreamBytes: 250, adapters: { 'stdio-acp': true }, perAgentOverrides: {} } }), enqueue: (e) => enqueued.push(e) });
    for (let i = 0; i < 6; i++) {
      cap.recordThought({ handoffId: 'h-1', adapter: 'stdio-acp', agentName: 'a', text: 'x'.repeat(100) });
    }
    const thoughtRows = enqueued.filter((e) => e.kind === 'agent.thought');
    const overflowRows = enqueued.filter((e) => e.kind === 'agent.thought.overflow');
    expect(thoughtRows.length).toBeLessThanOrEqual(3);
    const streamOverflow = overflowRows.find((e) => e.meta.sequence_n === -1);
    expect(streamOverflow).toBeDefined();
    expect(streamOverflow!.meta.bytes_dropped).toBeGreaterThan(0);
  });

  it('skips emission when adapter is disabled', () => {
    const enqueued: any[] = [];
    const cap = new ThoughtCapture({ config: makeConfig({ capture: { maxTextBytes: 100, maxStreamBytes: 1000, adapters: { 'stdio-acp': false }, perAgentOverrides: {} } }), enqueue: (e) => enqueued.push(e) });
    cap.recordThought({ handoffId: 'h-1', adapter: 'stdio-acp', agentName: 'a', text: 'x' });
    expect(enqueued).toHaveLength(0);
  });

  it('honors per-agent override over adapter default', () => {
    const enqueued: any[] = [];
    const cap = new ThoughtCapture({ config: makeConfig({ capture: { maxTextBytes: 100, maxStreamBytes: 1000, adapters: { 'stdio-acp': true }, perAgentOverrides: { 'gemini-acp-pro': false } } }), enqueue: (e) => enqueued.push(e) });
    cap.recordThought({ handoffId: 'h-1', adapter: 'stdio-acp', agentName: 'gemini-acp-pro', text: 'x' });
    cap.recordThought({ handoffId: 'h-1', adapter: 'stdio-acp', agentName: 'claude-acp-sonnet', text: 'y' });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].meta.agent_name).toBe('claude-acp-sonnet');
  });
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/agentchat/test/worker/thought-capture.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the normalizer**

Create `packages/agentchat/src/worker/thought-capture.ts`:

```ts
import type { DispatchEventInput } from '@penumbra/core';
import type { RuntimeThoughtsConfig } from './thought-config.js';

export interface RecordThoughtInput {
  handoffId: string;
  adapter: string;
  agentName: string;
  text: string;
  tokenCount?: number;
  ts?: string;
}

export interface ThoughtCaptureDeps {
  config: RuntimeThoughtsConfig;
  enqueue: (event: DispatchEventInput) => void;
  workerId?: string | null;
  now?: () => Date;
}

const REDACTION_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /https:\/\/discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
  /Bearer\s+[A-Za-z0-9._-]+/g,
];

function redactCredentials(text: string): string {
  let out = text;
  for (const pattern of REDACTION_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

export class ThoughtCapture {
  private readonly perDispatch = new Map<string, { sequence: number; bytesUsed: number; streamCapHit: boolean }>();

  constructor(private readonly deps: ThoughtCaptureDeps) {}

  isAdapterEnabled(adapter: string, agentName: string): boolean {
    if (!this.deps.config.enabled) return false;
    const override = this.deps.config.capture.perAgentOverrides[agentName];
    if (override === false) return false;
    if (override === true) return true;
    return this.deps.config.capture.adapters[adapter] === true;
  }

  recordThought(input: RecordThoughtInput): void {
    if (!this.isAdapterEnabled(input.adapter, input.agentName)) return;

    const state = this.perDispatch.get(input.handoffId) ?? { sequence: 0, bytesUsed: 0, streamCapHit: false };
    if (state.streamCapHit) return;

    const ts = (input.ts ?? (this.deps.now ?? (() => new Date()))().toISOString());
    const sequence = state.sequence;
    state.sequence = sequence + 1;

    const redacted = redactCredentials(input.text);
    const cap = this.deps.config.capture.maxTextBytes;
    const truncated = redacted.length > cap ? redacted.slice(0, cap) : redacted;
    const droppedFromRow = redacted.length - truncated.length;

    const remaining = this.deps.config.capture.maxStreamBytes - state.bytesUsed;
    if (truncated.length > remaining) {
      const totalDropped = (redacted.length) + 0; // entire row dropped after stream-cap; counts redacted bytes
      state.streamCapHit = true;
      this.perDispatch.set(input.handoffId, state);
      this.deps.enqueue({
        handoff_id: input.handoffId,
        worker_id: this.deps.workerId ?? null,
        source: 'worker',
        kind: 'agent.thought.overflow',
        ts,
        meta: { sequence_n: -1, bytes_dropped: totalDropped },
      });
      return;
    }

    state.bytesUsed += truncated.length;
    this.perDispatch.set(input.handoffId, state);

    const thoughtMeta: Record<string, unknown> = {
      sequence_n: sequence,
      adapter: input.adapter,
      agent_name: input.agentName,
      text: truncated,
    };
    if (input.tokenCount !== undefined) thoughtMeta.token_count = input.tokenCount;

    this.deps.enqueue({
      handoff_id: input.handoffId,
      worker_id: this.deps.workerId ?? null,
      source: 'worker',
      kind: 'agent.thought',
      ts,
      meta: thoughtMeta,
    });

    if (droppedFromRow > 0) {
      this.deps.enqueue({
        handoff_id: input.handoffId,
        worker_id: this.deps.workerId ?? null,
        source: 'worker',
        kind: 'agent.thought.overflow',
        ts,
        meta: { sequence_n: sequence, bytes_dropped: droppedFromRow },
      });
    }
  }

  resetDispatch(handoffId: string): void {
    this.perDispatch.delete(handoffId);
  }
}
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/agentchat/test/worker/thought-capture.test.ts
```

Expected: PASS (six test cases).

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/worker/thought-capture.ts packages/agentchat/test/worker/thought-capture.test.ts
git commit -m "feat(agentchat): add thought capture normalizer"
```

---

## Task 5: Wire stdio-acp Through Thought Capture

**Files:**
- Modify: `packages/agentchat/src/adapters/stdio-acp.ts`
- Modify: `packages/agentchat/test/adapters/stdio-acp.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/agentchat/test/adapters/stdio-acp.test.ts` a test that mocks the ACP transport, sends an `agent_thought_chunk`-shaped notification, and asserts the configured `ThoughtCapture.recordThought` is called. The test fixture should mirror the file's existing transport mocks. Concrete addition:

```ts
import { ThoughtCapture } from '../../src/worker/thought-capture.js';

it('routes agent_thought_chunk notifications through ThoughtCapture', async () => {
  const recorded: any[] = [];
  const capture = new ThoughtCapture({
    config: {
      enabled: true,
      capture: { maxTextBytes: 100, maxStreamBytes: 1000, adapters: { 'stdio-acp': true }, perAgentOverrides: {} },
      analyze: { enabled: false, onlyWhen: [], digest: { enabled: false, agent: 'x', maxInputChars: 50000, timeoutMs: 60000 }, signals: { enabled: false, agent: 'x', timeoutMs: 60000, maxInputChars: null, definitions: [] } },
    },
    enqueue: (e) => recorded.push(e),
  });

  // Build the adapter with thoughtCapture injected (use the same harness the file uses for other adapter tests).
  const adapter = await buildStdioAcpAdapter({ thoughtCapture: capture, ...defaultDeps });
  const handoffId = 'h-acp-1';
  // Drive a session that emits an agent_thought_chunk notification with text 'thinking'.
  await driveSessionWithNotifications(adapter, handoffId, [
    { method: 'agent_thought_chunk', params: { text: 'thinking', token_count: 3 } },
  ]);

  expect(recorded.filter((e) => e.kind === 'agent.thought')).toHaveLength(1);
  expect(recorded[0].meta).toMatchObject({ adapter: 'stdio-acp', text: 'thinking', token_count: 3 });
  expect(recorded[0].handoff_id).toBe(handoffId);
});
```

`buildStdioAcpAdapter`, `driveSessionWithNotifications`, and `defaultDeps` already exist or have analogous helpers in the test file — reuse them. If the existing test harness does not accept `thoughtCapture` in deps, the test must fail compilation, which is the RED signal.

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/agentchat/test/adapters/stdio-acp.test.ts
```

Expected: FAIL — adapter does not accept `thoughtCapture` in deps OR does not call `recordThought` on `agent_thought_chunk`.

- [ ] **Step 3: Wire the adapter**

In `packages/agentchat/src/adapters/stdio-acp.ts`:

1. Add an optional `thoughtCapture?: { recordThought: (input: { handoffId: string; adapter: 'stdio-acp'; agentName: string; text: string; tokenCount?: number; ts?: string }) => void }` to the adapter's deps interface.
2. In the JSON-RPC notification dispatch table, add a handler for `agent_thought_chunk` that calls `deps.thoughtCapture?.recordThought(...)` with `adapter: 'stdio-acp'`, the handoff id from the active session context, the configured agent name, the params' `text`, and `tokenCount` if present.
3. Do not block the session on capture errors — wrap the call in try/catch and log a warn.

The file's existing notification dispatch pattern (e.g., for `acp.session.start`) is the template. Do not change other notification handling.

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/agentchat/test/adapters/stdio-acp.test.ts
```

Expected: PASS, including the new test plus the existing suite.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/adapters/stdio-acp.ts packages/agentchat/test/adapters/stdio-acp.test.ts
git commit -m "feat(agentchat): emit thought events from stdio-acp adapter"
```

---

## Task 6: Opt-In Stdout Thinking Parser For cli-spawn

**Files:**
- Modify: `packages/agentchat/src/adapters/cli-spawn.ts`
- Modify: `packages/agentchat/test/adapters/cli-spawn.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/agentchat/test/adapters/cli-spawn.test.ts`:

```ts
import { ThoughtCapture } from '../../src/worker/thought-capture.js';

it('parses <thinking>…</thinking> blocks from stdout when emit_stdout_thoughts is true', async () => {
  const recorded: any[] = [];
  const capture = new ThoughtCapture({
    config: {
      enabled: true,
      capture: { maxTextBytes: 1000, maxStreamBytes: 10000, adapters: { 'cli-spawn': true }, perAgentOverrides: {} },
      analyze: { enabled: false, onlyWhen: [], digest: { enabled: false, agent: 'x', maxInputChars: 50000, timeoutMs: 60000 }, signals: { enabled: false, agent: 'x', timeoutMs: 60000, maxInputChars: null, definitions: [] } },
    },
    enqueue: (e) => recorded.push(e),
  });

  // Drive the spawn helper with a fake child that emits stdout containing two <thinking>...</thinking> blocks.
  const result = await spawnCliAdapter({
    ...baseSpawnOpts,
    emit_stdout_thoughts: true,
    thoughtCapture: capture,
    eventContext: { handoffId: 'h-cli-1', agentName: 'codex' },
    // Test harness override: feed canned stdout chunks; existing tests already do this.
    spawn: () => fakeProc('PRE <thinking>step one</thinking> MID <thinking>step two</thinking> POST'),
  });

  expect(result.text).toContain('PRE');
  expect(result.text).toContain('POST');
  // Thoughts are removed from the captured stdout text or are recorded *and* present — match implementation.
  const thoughtTexts = recorded.filter((e) => e.kind === 'agent.thought').map((e) => e.meta.text);
  expect(thoughtTexts).toEqual(['step one', 'step two']);
});

it('does not parse <thinking> blocks when emit_stdout_thoughts is false (default)', async () => {
  const recorded: any[] = [];
  const capture = new ThoughtCapture({
    config: {
      enabled: true,
      capture: { maxTextBytes: 1000, maxStreamBytes: 10000, adapters: { 'cli-spawn': true }, perAgentOverrides: {} },
      analyze: { enabled: false, onlyWhen: [], digest: { enabled: false, agent: 'x', maxInputChars: 50000, timeoutMs: 60000 }, signals: { enabled: false, agent: 'x', timeoutMs: 60000, maxInputChars: null, definitions: [] } },
    },
    enqueue: (e) => recorded.push(e),
  });
  const result = await spawnCliAdapter({
    ...baseSpawnOpts,
    thoughtCapture: capture,
    eventContext: { handoffId: 'h-cli-2', agentName: 'codex' },
    spawn: () => fakeProc('PRE <thinking>hidden</thinking> POST'),
  });
  expect(result.text).toContain('<thinking>hidden</thinking>');
  expect(recorded).toHaveLength(0);
});
```

If the test file does not already export a `fakeProc` helper, add a minimal one inline that returns a fake `Bun.spawn`-shaped child whose stdout yields the canned text and whose `proc.exited` resolves to 0.

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/agentchat/test/adapters/cli-spawn.test.ts
```

Expected: FAIL — `emit_stdout_thoughts` and `thoughtCapture` are not on `SpawnOpts` or are not honored.

- [ ] **Step 3: Implement the parser**

In `packages/agentchat/src/adapters/cli-spawn.ts`:

1. Add `emit_stdout_thoughts?: boolean` and `thoughtCapture?: ThoughtCapture` (import from `../worker/thought-capture.js`) to `SpawnOpts`.
2. After the proc completes and `text` has been collected, if `opts.emit_stdout_thoughts === true && opts.thoughtCapture` and `opts.eventContext?.handoffId` and `opts.eventContext?.agentName`, run a regex scan over `text`:
   - Pattern: `/<thinking>([\s\S]*?)<\/thinking>/g`
   - For each non-empty captured group, call `opts.thoughtCapture.recordThought({ handoffId, adapter: 'cli-spawn', agentName, text: capturedText.trim() })`.
3. Do NOT modify the returned `text` — the caller already gets the full stdout. The captured thoughts go through the capture pipeline only.

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/agentchat/test/adapters/cli-spawn.test.ts
```

Expected: PASS (both new tests + the existing suite).

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/adapters/cli-spawn.ts packages/agentchat/test/adapters/cli-spawn.test.ts
git commit -m "feat(agentchat): opt-in stdout thinking parser for cli-spawn"
```

---

## Task 7: Build The Thought Analyzer

**Files:**
- Create: `packages/agentchat/src/worker/thought-analyzer.ts`
- Create: `packages/agentchat/test/worker/thought-analyzer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agentchat/test/worker/thought-analyzer.test.ts`:

```ts
import { describe, expect, it, mock } from 'bun:test';
import { runThoughtAnalyzer } from '../../src/worker/thought-analyzer.js';
import type { RuntimeThoughtsConfig } from '../../src/worker/thought-config.js';

const baseConfig: RuntimeThoughtsConfig = {
  enabled: true,
  capture: { maxTextBytes: 16384, maxStreamBytes: 1048576, adapters: {}, perAgentOverrides: {} },
  analyze: {
    enabled: true,
    onlyWhen: ['pr_opened'],
    digest: { enabled: true, agent: 'local-gemma26', maxInputChars: 1000, timeoutMs: 5000 },
    signals: {
      enabled: true,
      agent: 'local-gemma26',
      timeoutMs: 5000,
      maxInputChars: null,
      definitions: [
        { name: 'uncertainty', prompt: 'list doubts' },
        { name: 'security', prompt: 'list security concerns' },
      ],
    },
  },
};

const sampleThoughts = [
  { sequence_n: 0, adapter: 'stdio-acp', agent_name: 'claude-acp-sonnet', text: 'thinking about A' },
  { sequence_n: 1, adapter: 'stdio-acp', agent_name: 'claude-acp-sonnet', text: 'thinking about B' },
];

describe('runThoughtAnalyzer', () => {
  it('dispatches digest and one signal per definition in parallel', async () => {
    const calls: any[] = [];
    const recorded: any[] = [];
    const chainStart = mock(async (input: { initial_agent: string; message: string; parent_handoff_id?: string }) => {
      calls.push(input);
      return { conversation_id: `conv-${calls.length}`, handoff_id: `h-sub-${calls.length}` };
    });
    const chainWait = mock(async () => ({ status: 'completed' as const }));
    const chainResponse = mock(async () => ({ responses: [{ text: `response for call ${calls.length}` }] }));
    const recordEvent = mock(async (e: any) => { recorded.push(e); });

    await runThoughtAnalyzer({
      handoffId: 'h-1',
      thoughts: sampleThoughts,
      mergeStatus: 'pr_opened',
      config: baseConfig,
      deps: { chainStart, chainWait, chainResponse, recordEvent, log: console },
    });

    // 1 digest + 2 signals = 3 sub-handoff dispatches
    expect(chainStart).toHaveBeenCalledTimes(3);
    const recordedKinds = recorded.map((r) => r.kind);
    expect(recordedKinds.filter((k) => k === 'agent.thought.digest')).toHaveLength(1);
    expect(recordedKinds.filter((k) => k === 'agent.thought.signal')).toHaveLength(2);
    const signalNames = recorded.filter((r) => r.kind === 'agent.thought.signal').map((r) => r.meta.signal_name);
    expect(signalNames.sort()).toEqual(['security', 'uncertainty']);
  });

  it('skips analyze when mergeStatus is not in onlyWhen', async () => {
    const chainStart = mock(async () => ({ conversation_id: 'x', handoff_id: 'y' }));
    await runThoughtAnalyzer({
      handoffId: 'h-1',
      thoughts: sampleThoughts,
      mergeStatus: 'cancelled',
      config: baseConfig,
      deps: { chainStart, chainWait: mock(async () => ({ status: 'completed' as const })), chainResponse: mock(async () => ({ responses: [] })), recordEvent: mock(async () => {}), log: console },
    });
    expect(chainStart).not.toHaveBeenCalled();
  });

  it('records a digest event with failure text when the digest sub-handoff fails', async () => {
    const recorded: any[] = [];
    const chainStart = mock(async (input: { message: string }) => {
      if (input.message.includes('list doubts') || input.message.includes('list security')) {
        return { conversation_id: 'sig', handoff_id: 'h-sig' };
      }
      throw new Error('digest dispatch failed');
    });
    const chainWait = mock(async () => ({ status: 'completed' as const }));
    const chainResponse = mock(async () => ({ responses: [{ text: 'signal text' }] }));
    const recordEvent = mock(async (e: any) => { recorded.push(e); });

    await runThoughtAnalyzer({
      handoffId: 'h-1',
      thoughts: sampleThoughts,
      mergeStatus: 'pr_opened',
      config: baseConfig,
      deps: { chainStart, chainWait, chainResponse, recordEvent, log: console },
    });

    const digestRow = recorded.find((r) => r.kind === 'agent.thought.digest');
    expect(digestRow).toBeDefined();
    expect((digestRow!.meta.digest_text as string)).toContain('analyzer failed');
    // Signals still ran:
    expect(recorded.filter((r) => r.kind === 'agent.thought.signal')).toHaveLength(2);
  });

  it('truncates the analyzer prompt to maxInputChars and notes the truncation', async () => {
    const captured: string[] = [];
    const chainStart = mock(async (input: { message: string }) => {
      captured.push(input.message);
      return { conversation_id: 'c', handoff_id: 'h' };
    });
    const big = Array.from({ length: 200 }, (_, i) => ({ sequence_n: i, adapter: 'x', agent_name: 'y', text: 'x'.repeat(50) }));
    await runThoughtAnalyzer({
      handoffId: 'h-1',
      thoughts: big,
      mergeStatus: 'pr_opened',
      config: { ...baseConfig, analyze: { ...baseConfig.analyze, digest: { ...baseConfig.analyze.digest, maxInputChars: 200 } } },
      deps: { chainStart, chainWait: mock(async () => ({ status: 'completed' as const })), chainResponse: mock(async () => ({ responses: [{ text: 'ok' }] })), recordEvent: mock(async () => {}), log: console },
    });
    const digestPrompt = captured.find((m) => m.includes('list')) ?? captured[0]!;
    expect(digestPrompt.length).toBeLessThan(2000); // headers + truncated body
    expect(digestPrompt).toContain('truncated');
  });
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/agentchat/test/worker/thought-analyzer.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the analyzer**

Create `packages/agentchat/src/worker/thought-analyzer.ts`:

```ts
import type { DispatchEventInput } from '@penumbra/core';
import type { RuntimeThoughtsConfig } from './thought-config.js';

export interface ThoughtRow {
  sequence_n: number;
  adapter: string;
  agent_name: string;
  text: string;
  token_count?: number;
}

export interface ThoughtAnalyzerDeps {
  chainStart: (input: { initial_agent: string; message: string; parent_handoff_id?: string; task_type?: string }) => Promise<{ conversation_id: string; handoff_id: string }>;
  chainWait: (input: { conversation_id: string; timeout_ms?: number }) => Promise<{ status: 'completed' | 'failed' | 'timeout' }>;
  chainResponse: (input: { conversation_id: string }) => Promise<{ responses: Array<{ text?: string }> }>;
  recordEvent: (event: DispatchEventInput) => Promise<void> | void;
  log: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void } | typeof console;
  workerId?: string | null;
  now?: () => Date;
}

export interface ThoughtAnalyzerInput {
  handoffId: string;
  thoughts: ThoughtRow[];
  mergeStatus: string;
  config: RuntimeThoughtsConfig;
  deps: ThoughtAnalyzerDeps;
}

function joinThoughtsForPrompt(rows: ThoughtRow[], limit: number): { body: string; truncated: boolean } {
  // Prefer recent thoughts: take from the end until we run out of budget.
  const reversed = [...rows].reverse();
  const kept: ThoughtRow[] = [];
  let used = 0;
  for (const row of reversed) {
    const piece = `[#${row.sequence_n} ${row.adapter}/${row.agent_name}] ${row.text}\n`;
    if (used + piece.length > limit) break;
    kept.push(row);
    used += piece.length;
  }
  const truncated = kept.length < rows.length;
  // Restore chronological order in the output.
  const ordered = kept.reverse();
  return {
    body: ordered.map((r) => `[#${r.sequence_n} ${r.adapter}/${r.agent_name}] ${r.text}`).join('\n'),
    truncated,
  };
}

async function runOneSubHandoff(
  agent: string,
  prompt: string,
  parentHandoffId: string,
  timeoutMs: number,
  deps: ThoughtAnalyzerDeps,
): Promise<string> {
  const started = await deps.chainStart({ initial_agent: agent, message: prompt, parent_handoff_id: parentHandoffId, task_type: 'unknown' });
  const wait = await deps.chainWait({ conversation_id: started.conversation_id, timeout_ms: timeoutMs });
  if (wait.status !== 'completed') throw new Error(`sub-handoff did not complete: ${wait.status}`);
  const resp = await deps.chainResponse({ conversation_id: started.conversation_id });
  return resp.responses[resp.responses.length - 1]?.text ?? '';
}

export async function runThoughtAnalyzer(input: ThoughtAnalyzerInput): Promise<void> {
  const { handoffId, thoughts, mergeStatus, config, deps } = input;
  if (!config.analyze.enabled) return;
  if (!config.analyze.onlyWhen.includes(mergeStatus)) return;
  if (thoughts.length === 0) return;

  const ts = (deps.now ?? (() => new Date()))().toISOString();
  const tasks: Array<Promise<void>> = [];

  if (config.analyze.digest.enabled) {
    const cap = config.analyze.digest.maxInputChars;
    const { body, truncated } = joinThoughtsForPrompt(thoughts, cap);
    const prompt = [
      'Summarize the agent reasoning below in 2-4 sentences. Focus on the final approach, not abandoned steps.',
      truncated ? '(Stream truncated; only most recent thoughts shown.)' : '',
      '---',
      body,
    ].filter(Boolean).join('\n');

    tasks.push(
      runOneSubHandoff(config.analyze.digest.agent, prompt, handoffId, config.analyze.digest.timeoutMs, deps)
        .then(async (text) => {
          await deps.recordEvent({
            handoff_id: handoffId, worker_id: deps.workerId ?? null, source: 'worker',
            kind: 'agent.thought.digest', ts,
            meta: { digester_agent: config.analyze.digest.agent, digest_text: text },
          });
        })
        .catch(async (err) => {
          deps.log.warn?.('thought analyzer digest failed', { handoffId, err: String(err) });
          await deps.recordEvent({
            handoff_id: handoffId, worker_id: deps.workerId ?? null, source: 'worker',
            kind: 'agent.thought.digest', ts,
            meta: { digester_agent: config.analyze.digest.agent, digest_text: `<analyzer failed: ${String(err)}>` },
          });
        }),
    );
  }

  if (config.analyze.signals.enabled) {
    const cap = config.analyze.signals.maxInputChars ?? config.analyze.digest.maxInputChars;
    const { body, truncated } = joinThoughtsForPrompt(thoughts, cap);
    for (const def of config.analyze.signals.definitions) {
      const prompt = [
        def.prompt,
        truncated ? '(Stream truncated; only most recent thoughts shown.)' : '',
        '---',
        body,
      ].filter(Boolean).join('\n');
      tasks.push(
        runOneSubHandoff(config.analyze.signals.agent, prompt, handoffId, config.analyze.signals.timeoutMs, deps)
          .then(async (text) => {
            await deps.recordEvent({
              handoff_id: handoffId, worker_id: deps.workerId ?? null, source: 'worker',
              kind: 'agent.thought.signal', ts,
              meta: { signal_name: def.name, evidence_text: text, extractor_agent: config.analyze.signals.agent },
            });
          })
          .catch(async (err) => {
            deps.log.warn?.('thought analyzer signal failed', { handoffId, signal: def.name, err: String(err) });
            await deps.recordEvent({
              handoff_id: handoffId, worker_id: deps.workerId ?? null, source: 'worker',
              kind: 'agent.thought.signal', ts,
              meta: { signal_name: def.name, evidence_text: `<analyzer failed: ${String(err)}>`, extractor_agent: config.analyze.signals.agent },
            });
          }),
      );
    }
  }

  await Promise.all(tasks);
}
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/agentchat/test/worker/thought-analyzer.test.ts
```

Expected: PASS (four cases).

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/worker/thought-analyzer.ts packages/agentchat/test/worker/thought-analyzer.test.ts
git commit -m "feat(agentchat): add thought analyzer for digest and signals"
```

---

## Task 8: Wire Merge Reconciler To Run The Analyzer

**Files:**
- Modify: `packages/agentchat/src/worker/merge-reconciler.ts`
- Modify: `packages/agentchat/test/worker/merge-reconciler.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/agentchat/test/worker/merge-reconciler.test.ts`:

```ts
it('runs thought analyzer after notifyResult when merge status is in onlyWhen', async () => {
  const recordedAfterNotify: string[] = [];
  const notifyResult = mock(async () => { recordedAfterNotify.push('notify'); });
  const runAnalyzer = mock(async () => { recordedAfterNotify.push('analyze'); });

  const recon = createMergeReconciler({
    ...baseDeps,
    notifyResult,
    thoughtsConfig: thoughtsConfigEnabled(['pr_opened']),
    listThoughtEvents: async () => [{ sequence_n: 0, adapter: 'stdio-acp', agent_name: 'a', text: 'thinking' }],
    runThoughtAnalyzer: runAnalyzer,
  });
  await recon.runReconciliation({ handoffId: 'h-1', mergeOutcome: 'pr_opened' });

  expect(recordedAfterNotify).toEqual(['notify', 'analyze']);
  expect(runAnalyzer).toHaveBeenCalledTimes(1);
  const analyzerCall = (runAnalyzer.mock.calls as any[])[0]![0];
  expect(analyzerCall.handoffId).toBe('h-1');
  expect(analyzerCall.mergeStatus).toBe('pr_opened');
});

it('skips the analyzer when merge status is not in onlyWhen', async () => {
  const runAnalyzer = mock(async () => {});
  const recon = createMergeReconciler({
    ...baseDeps,
    thoughtsConfig: thoughtsConfigEnabled(['pr_opened']),
    listThoughtEvents: async () => [{ sequence_n: 0, adapter: 'x', agent_name: 'y', text: 't' }],
    runThoughtAnalyzer: runAnalyzer,
  });
  await recon.runReconciliation({ handoffId: 'h-1', mergeOutcome: 'cancelled' });
  expect(runAnalyzer).not.toHaveBeenCalled();
});

it('skips the analyzer when there are no thought events', async () => {
  const runAnalyzer = mock(async () => {});
  const recon = createMergeReconciler({
    ...baseDeps,
    thoughtsConfig: thoughtsConfigEnabled(['pr_opened']),
    listThoughtEvents: async () => [],
    runThoughtAnalyzer: runAnalyzer,
  });
  await recon.runReconciliation({ handoffId: 'h-1', mergeOutcome: 'pr_opened' });
  expect(runAnalyzer).not.toHaveBeenCalled();
});

it('skips the analyzer for sub-handoff dispatches (parent_handoff_id non-null)', async () => {
  const runAnalyzer = mock(async () => {});
  const recon = createMergeReconciler({
    ...baseDeps,
    thoughtsConfig: thoughtsConfigEnabled(['pr_opened']),
    listThoughtEvents: async () => [{ sequence_n: 0, adapter: 'x', agent_name: 'y', text: 't' }],
    runThoughtAnalyzer: runAnalyzer,
    getParentHandoffId: async () => 'h-parent',
  });
  await recon.runReconciliation({ handoffId: 'h-sub', mergeOutcome: 'pr_opened' });
  expect(runAnalyzer).not.toHaveBeenCalled();
});

it('does not throw when analyzer throws — logs and continues', async () => {
  const log = { warn: mock(() => {}) };
  const runAnalyzer = mock(async () => { throw new Error('boom'); });
  const recon = createMergeReconciler({
    ...baseDeps,
    log,
    thoughtsConfig: thoughtsConfigEnabled(['pr_opened']),
    listThoughtEvents: async () => [{ sequence_n: 0, adapter: 'x', agent_name: 'y', text: 't' }],
    runThoughtAnalyzer: runAnalyzer,
  });
  await expect(recon.runReconciliation({ handoffId: 'h-1', mergeOutcome: 'pr_opened' })).resolves.toBeUndefined();
  expect(log.warn).toHaveBeenCalled();
});
```

Add a helper near the top of the test file if not present:

```ts
function thoughtsConfigEnabled(onlyWhen: string[]) {
  return {
    enabled: true,
    capture: { maxTextBytes: 16384, maxStreamBytes: 1048576, adapters: {}, perAgentOverrides: {} },
    analyze: {
      enabled: true,
      onlyWhen,
      digest: { enabled: true, agent: 'local-gemma26', maxInputChars: 50000, timeoutMs: 60000 },
      signals: { enabled: false, agent: 'x', timeoutMs: 60000, maxInputChars: null, definitions: [] },
    },
  };
}
```

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/agentchat/test/worker/merge-reconciler.test.ts
```

Expected: FAIL — `thoughtsConfig`, `listThoughtEvents`, `runThoughtAnalyzer`, and `getParentHandoffId` are not on `ReconcilerDeps` and the analyzer hook is missing.

- [ ] **Step 3: Wire the reconciler**

In `packages/agentchat/src/worker/merge-reconciler.ts`:

1. Extend `ReconcilerDeps` with optional fields:
   - `thoughtsConfig?: RuntimeThoughtsConfig`
   - `listThoughtEvents?: (handoffId: string) => Promise<ThoughtRow[]>`
   - `runThoughtAnalyzer?: typeof runThoughtAnalyzer`
   - `getParentHandoffId?: (handoffId: string) => Promise<string | null>`
   - `log?: { warn: (...args: unknown[]) => void }`
2. After `notifyResult` is called (around line 225 in the existing file), add:

```ts
try {
  if (deps.thoughtsConfig?.analyze?.enabled
    && deps.thoughtsConfig.analyze.onlyWhen.includes(result.status)
    && deps.listThoughtEvents
    && deps.runThoughtAnalyzer) {
    const parentHandoffId = deps.getParentHandoffId ? await deps.getParentHandoffId(handoffId) : null;
    if (parentHandoffId == null) {
      const thoughts = await deps.listThoughtEvents(handoffId);
      if (thoughts.length > 0) {
        await deps.runThoughtAnalyzer({
          handoffId,
          thoughts,
          mergeStatus: result.status,
          config: deps.thoughtsConfig,
          deps: deps.thoughtAnalyzerDeps!,
        });
      }
    }
  }
} catch (err) {
  deps.log?.warn?.('thought analyzer failed', { handoffId, err: String(err) });
}
```

3. Add `thoughtAnalyzerDeps?: ThoughtAnalyzerDeps` to `ReconcilerDeps`. The worker constructs both at boot.
4. Imports: add `import type { RuntimeThoughtsConfig } from './thought-config.js';` and `import { runThoughtAnalyzer, type ThoughtRow, type ThoughtAnalyzerDeps } from './thought-analyzer.js';`.

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/agentchat/test/worker/merge-reconciler.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/src/worker/merge-reconciler.ts packages/agentchat/test/worker/merge-reconciler.test.ts
git commit -m "feat(agentchat): run thought analyzer after merge reconciliation"
```

---

## Task 9: Wire Worker Bootstrap And Capture Plumbing

**Files:**
- Modify: `packages/agentchat/bin/agentchat-worker.ts`

- [ ] **Step 1: Extend the worker bootstrap**

This task does not introduce new tests — Tasks 5/6/7/8 cover correctness; this task is mechanical wiring at the worker entry point. Verify by re-running the existing worker test suite at the end.

In `packages/agentchat/bin/agentchat-worker.ts`:

1. After `loadConfig` and the existing `loadNotificationConfig` line, add:

```ts
import { loadThoughtsConfig } from '../src/worker/thought-config.js';
import { ThoughtCapture } from '../src/worker/thought-capture.js';
import { runThoughtAnalyzer, type ThoughtAnalyzerDeps } from '../src/worker/thought-analyzer.js';

const thoughtsConfig = loadThoughtsConfig({ agentchat: config });
const thoughtCapture = thoughtsConfig.enabled
  ? new ThoughtCapture({
      config: thoughtsConfig,
      enqueue: (event) => eventQueue.enqueue(event),
      workerId,
    })
  : null;
```

2. When constructing the adapter dispatch table (the worker's existing adapter wiring), pass `thoughtCapture` into `stdio-acp` adapter deps and `cli-spawn` adapter deps.

3. Construct analyzer deps:

```ts
const thoughtAnalyzerDeps: ThoughtAnalyzerDeps = {
  chainStart: (input) => penumbraClient.chainStart(input),
  chainWait: (input) => penumbraClient.chainWait(input),
  chainResponse: (input) => penumbraClient.chainResponse(input),
  recordEvent: (event) => Promise.resolve(eventQueue.enqueue(event)),
  log,
  workerId,
};
```

If `PenumbraClient` does not already expose `chainStart`/`chainWait`/`chainResponse`, add the minimal typed methods to `packages/agentchat/src/penumbra-client.ts` that POST/GET against `/chain/start`, `/chain/wait`, `/chain/response` respectively. Mention this addition explicitly in the commit body if you have to add them.

4. Pass the new fields into `createMergeReconciler`:

```ts
const reconciler = createMergeReconciler({
  ...existingDeps,
  thoughtsConfig,
  thoughtAnalyzerDeps,
  runThoughtAnalyzer,
  listThoughtEvents: async (handoffId) => {
    const events = await penumbraClient.getDispatchEvents({ handoff_id: handoffId });
    return events
      .filter((e) => e.kind === 'agent.thought')
      .map((e) => ({
        sequence_n: (e.meta?.sequence_n as number) ?? 0,
        adapter: (e.meta?.adapter as string) ?? '',
        agent_name: (e.meta?.agent_name as string) ?? '',
        text: (e.meta?.text as string) ?? '',
        token_count: e.meta?.token_count as number | undefined,
      }))
      .sort((a, b) => a.sequence_n - b.sequence_n);
  },
  getParentHandoffId: async (handoffId) => {
    const handoff = await penumbraClient.getHandoff({ handoff_id: handoffId });
    return handoff?.parent_handoff_id ?? null;
  },
});
```

If `PenumbraClient.getDispatchEvents` does not exist, add it: a thin wrapper around `GET /dispatch/events?handoff_id=<id>` that returns the typed array. Same for `getHandoff`.

5. The worker's existing fast-path when `thoughtsConfig.enabled === false` is a single early-return (no thought capture object passed; analyzer hook on reconciler is a no-op since `thoughtsConfig.analyze.enabled` will be false).

- [ ] **Step 2: Run worker test suite**

Run:

```bash
bun test packages/agentchat/test/worker
```

Expected: PASS. The bootstrap test does not exist yet, but the worker tests should not regress.

- [ ] **Step 3: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agentchat/bin/agentchat-worker.ts packages/agentchat/src/penumbra-client.ts
git commit -m "feat(agentchat): wire thought capture and analyzer into worker"
```

If you did not need to modify `penumbra-client.ts`, drop it from the `git add`.

---

## Task 10: End-To-End Integration Test

**Files:**
- Create: `packages/agentchat/test/integration/thoughts-e2e.test.ts`

- [ ] **Step 1: Write the integration test**

Create `packages/agentchat/test/integration/thoughts-e2e.test.ts`:

```ts
import { describe, expect, it, mock } from 'bun:test';
import { startInProcessDaemon } from '../helpers/in-process-daemon.js';
import { ThoughtCapture } from '../../src/worker/thought-capture.js';
import { runThoughtAnalyzer } from '../../src/worker/thought-analyzer.js';
import { loadThoughtsConfig } from '../../src/worker/thought-config.js';

describe('thoughts e2e', () => {
  it('captures live thoughts, persists them, runs analyzer at merge time, and surfaces digest + signal events', async () => {
    const harness = await startInProcessDaemon();
    const handoffId = 'h-e2e-1';

    const config = loadThoughtsConfig({
      agentchat: {
        agents: [{ name: 'claude-acp-sonnet', adapter: 'stdio-acp', options: {}, roles: [], auto_approve_to: [] }],
        default_roles: {},
        providers: [],
        thoughts: {
          enabled: true,
          capture: { adapters: { 'stdio-acp': true } },
          analyze: {
            enabled: true,
            only_when: ['pr_opened'],
            digest: { enabled: true, agent: 'local-gemma26' },
            signals: { enabled: true, agent: 'local-gemma26', definitions: [{ name: 'uncertainty', prompt: 'list doubts' }] },
          },
        },
      },
    });

    const capture = new ThoughtCapture({
      config,
      enqueue: (event) => { void harness.postDispatchEvent({ ...event, handoff_id: handoffId }); },
      workerId: 'worker-test',
    });

    capture.recordThought({ handoffId, adapter: 'stdio-acp', agentName: 'claude-acp-sonnet', text: 'thinking step 1' });
    capture.recordThought({ handoffId, adapter: 'stdio-acp', agentName: 'claude-acp-sonnet', text: 'thinking step 2' });

    // Confirm thought events landed in dispatch_events live.
    const eventsAfterCapture = await harness.getDispatchEvents(handoffId);
    expect(eventsAfterCapture.filter((e) => e.kind === 'agent.thought')).toHaveLength(2);

    // Simulate reconciler reaching merge with status pr_opened.
    const stubResponses = new Map<string, string>([
      ['list doubts', 'agent expressed doubt about test X'],
      ['Summarize', 'Agent reasoned through two steps and committed.'],
    ]);
    const chainStart = mock(async (input: { message: string }) => {
      const matched = [...stubResponses.entries()].find(([k]) => input.message.includes(k));
      const text = matched?.[1] ?? 'unknown';
      return { conversation_id: `conv-${text.slice(0, 8)}`, handoff_id: 'h-sub' };
    });
    const responseFor = new Map<string, string>();
    chainStart.mock.calls.forEach(([{ message }]: any) => {});
    const chainWait = mock(async () => ({ status: 'completed' as const }));
    const chainResponse = mock(async ({ conversation_id }: { conversation_id: string }) => {
      const text = [...stubResponses.values()].find((v) => conversation_id.includes(v.slice(0, 8))) ?? 'no match';
      return { responses: [{ text }] };
    });

    await runThoughtAnalyzer({
      handoffId,
      thoughts: eventsAfterCapture
        .filter((e) => e.kind === 'agent.thought')
        .map((e) => ({ sequence_n: e.meta.sequence_n, adapter: e.meta.adapter, agent_name: e.meta.agent_name, text: e.meta.text })),
      mergeStatus: 'pr_opened',
      config,
      deps: {
        chainStart,
        chainWait,
        chainResponse,
        recordEvent: async (event) => { await harness.postDispatchEvent(event); },
        log: console,
        workerId: 'worker-test',
      },
    });

    // Final event set: 2 thoughts + 1 digest + 1 signal.
    const finalEvents = await harness.getDispatchEvents(handoffId);
    const kinds = finalEvents.map((e) => e.kind).sort();
    expect(kinds).toEqual([
      'agent.thought',
      'agent.thought',
      'agent.thought.digest',
      'agent.thought.signal',
    ]);

    // The MCP timeline tool surfaces the same shape (dispatch.timeline reads dispatch_events).
    const timeline = await harness.dispatchTimeline(handoffId);
    expect(timeline.events.map((e: any) => e.kind).sort()).toEqual(kinds);

    await harness.stop();
  });
});
```

If `startInProcessDaemon` / `postDispatchEvent` / `getDispatchEvents` / `dispatchTimeline` helpers do not exist on the test harness, add them under `packages/agentchat/test/helpers/in-process-daemon.ts`. Each is a thin wrapper around the daemon's existing routes.

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/agentchat/test/integration/thoughts-e2e.test.ts
```

Expected: FAIL until any missing helpers are added.

- [ ] **Step 3: Add missing helpers if needed**

If the harness doesn't have `dispatchTimeline`, add a method that POSTs/GETs against the existing daemon route. The MCP tool itself routes through the same daemon endpoint (`GET /dispatch/events?handoff_id=…` returns the timeline shape).

- [ ] **Step 4: Run GREEN**

Run:

```bash
bun test packages/agentchat/test/integration/thoughts-e2e.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agentchat/test/integration/thoughts-e2e.test.ts packages/agentchat/test/helpers/in-process-daemon.ts
git commit -m "test(agentchat): end-to-end thought capture and analyze"
```

If `in-process-daemon.ts` was untouched, drop it from `git add`.

---

## Task 11: Documentation

**Files:**
- Modify: `docs/superpowers/notes/2026-04-28-discord-mcp-setup.md`

- [ ] **Step 1: Add a "Thought capture" section**

Append a new top-level section to the existing setup doc (the same file that holds the Discord setup so operators have one canonical setup reference):

````markdown
## Thought capture

The worker can capture per-adapter agent reasoning chunks as `agent.thought` dispatch events, persist them in `dispatch_events`, and optionally run a digest plus configurable signal extractors at merge time. Defaults are off.

### Enable capture

Add a `thoughts:` block to `agentchat.yaml`:

```yaml
thoughts:
  enabled: true
  capture:
    max_text_bytes: 16384
    max_stream_bytes: 1048576
    adapters:
      stdio-acp: true        # captures ACP agent_thought_chunk
      cli-spawn: false       # opt-in per-agent below if needed
    per_agent_overrides:
      claude-acp-sonnet: true
      gemini-acp-pro: false  # explicit off
```

For `stdio-acp` to actually receive thoughts, the underlying agent must emit them. Today claude-acp-sonnet emits when `MAX_THINKING_TOKENS` is set in its env (already configured in agentchat.yaml). Other ACP agents are upstream-blocked.

For `cli-spawn`, set `emit_stdout_thoughts: true` on a specific agent's options block to enable parsing of `<thinking>…</thinking>` markers from stdout.

### Enable analysis

Adds reconciler-time digest and signal extraction. Both run only when the dispatch's merge status matches `only_when`:

```yaml
thoughts:
  enabled: true
  analyze:
    enabled: true
    only_when: [pr_opened, test_failed, typecheck_failed]
    digest:
      enabled: true
      agent: local-gemma26
      max_input_chars: 50000
      timeout_ms: 60000
    signals:
      enabled: true
      agent: local-gemma26
      timeout_ms: 60000
      definitions:
        - name: uncertainty
          prompt: "List excerpts where the agent expressed doubt about its approach…"
        - name: security
          prompt: "List places where the agent flagged a security risk and how it resolved it…"
```

### Inspecting captured thoughts

```bash
# Live (during dispatch): see thought events flow through SSE
penumbra dispatch timeline <handoff_id>

# After merge: digest + signal events appear in the same timeline
penumbra dispatch timeline <handoff_id> | grep agent.thought
```

### Privacy notes

- `agent.thought` text is run through a credential-redaction pre-filter (api keys, github tokens, discord webhooks, bearer tokens) before persistence. Best-effort; do not rely on it.
- The original dispatch prompt is NOT stripped from thought text. If your prompts are sensitive, set `thoughts.capture.adapters.<adapter>: false` or `per_agent_overrides.<name>: false` for that workload.
- Thoughts inherit the existing `dispatch_events` retention policy.

### Disable

Set `thoughts.enabled: false` (or omit the block). The capture pipeline is dead code in this state; no events are written.
````

- [ ] **Step 2: Verify required terms appear**

Run:

```bash
rg -n "thoughts:|agent.thought|MAX_THINKING_TOKENS|emit_stdout_thoughts|local-gemma26|only_when" docs/superpowers/notes/2026-04-28-discord-mcp-setup.md
```

Expected: every term appears.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/notes/2026-04-28-discord-mcp-setup.md
git commit -m "docs(agentchat): document thought capture setup"
```

---

## Task 12: Final Verification Sweep

**Files:**
- No new files.

- [ ] **Step 1: Run focused suite**

```bash
bun test \
  packages/agentchat/test/worker/thought-config.test.ts \
  packages/agentchat/test/worker/thought-capture.test.ts \
  packages/agentchat/test/worker/thought-analyzer.test.ts \
  packages/agentchat/test/worker/merge-reconciler.test.ts \
  packages/agentchat/test/adapters/stdio-acp.test.ts \
  packages/agentchat/test/adapters/cli-spawn.test.ts \
  packages/core/test/services/dispatch-event-log.test.ts \
  packages/daemon/test/routes/dispatch-events.test.ts \
  packages/agentchat/test/integration/thoughts-e2e.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run broad worker + daemon suites**

```bash
bun test packages/agentchat/test/worker packages/agentchat/test/adapters packages/daemon/test/routes packages/core/test/services
```

Expected: PASS. The Bun ONNX teardown panic after the pass/fail summary is cosmetic; trust the pass/fail line above the panic.

- [ ] **Step 4: Confirm no secrets or fake credentials in tests escaped redaction**

```bash
rg -n "sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|discord\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]+" packages docs
```

Expected: matches only inside the redaction test fixture (`thought-capture.test.ts`) and the redaction-pattern declaration (`thought-capture.ts`).

- [ ] **Step 5: Manual live smoke (operator)**

Document this step but do not commit a code change. Inform the operator:

> Once Task 12 is merged, the operator can flip `thoughts.enabled: true` for a single project, dispatch a real coding task to claude-acp-sonnet (the only active emitter at v1), and inspect `penumbra dispatch timeline <handoff_id>` for `agent.thought` events. After the dispatch reaches a `pr_opened`/`test_failed`/`typecheck_failed` outcome, the timeline should also contain `agent.thought.digest` and `agent.thought.signal` events.

- [ ] **Step 6: Commit final adjustments if any**

If any of the steps above required source or test adjustments:

```bash
git add .
git commit -m "test(agentchat): verify thought capture pipeline"
```

Otherwise, no commit.

---

## Rollout Risks

- The capture path runs inline with the dispatch hot path. The redaction pass + truncation are O(n) on the thought text; per-row cap is 16 KB so cost is bounded. Defaults-off keeps the path dead until explicitly enabled.
- The reconciler-time analyzer dispatches sub-handoffs through `chain_start`. Local models are recommended to avoid quota burn; if the configured agent is a paid premium model, every analyzed merge spends quota.
- `parent_handoff_id` recursion guard depends on the reconciler being able to look up the parent. If `getParentHandoffId` returns null incorrectly, an analyzer-of-analyzer recursion is possible. Mitigation: timeouts on each sub-handoff (default 60s), and the analyzer skips dispatches with no thoughts (chat-only digester dispatches don't emit thoughts).
- Adapter coverage is honest at v1: only claude-acp-sonnet is confirmed to emit. Operators expecting gemini-acp-pro or codex-acp-zed coverage need to know upstream gaps; documentation calls this out.
- `cli-spawn` `<thinking>` parsing is opportunistic. If a CLI agent embeds `<thinking>` markers in its tool output rather than internal reasoning, the parser will lift them as thoughts. Documented as opt-in for that reason.

## Migration Notes

- Existing config without a `thoughts:` block retains exactly today's behavior.
- New `DispatchEventKind` values are additive. Older daemons running against newer worker code will reject the new kinds with HTTP 400; restart the daemon after merging Task 3.
- Worker carries its own thought-config at boot. Adding or changing `thoughts:` requires a worker reload (existing pattern; same as `notifications:`).
- No DB migration required.

## Self-Review Checklist (for the executing engineer)

Before opening the final PR, verify:

- [ ] Spec sections 1-6 of `docs/superpowers/specs/2026-05-02-reconciler-thought-capture-design.md` each map to one or more tasks above.
- [ ] No `agent.thought.digest` event has empty `digest_text`; failures record `<analyzer failed: …>`.
- [ ] `thoughts.enabled: false` produces zero new dispatch events and zero new code paths in profiled traces.
- [ ] All four new event kinds round-trip through POST → DB → GET → MCP `dispatch.timeline`.
- [ ] Redaction patterns covered in tests are also documented in the operator setup section.
