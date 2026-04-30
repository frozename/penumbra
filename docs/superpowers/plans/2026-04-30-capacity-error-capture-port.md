# Capacity Error CapturePort Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist cli-spawn provider capacity errors as `provider-capacity-error` T0 events via the existing `CapturePort`.

**Architecture:** `cli-spawn` already detects vendor capacity errors and exposes `onCapacityError`. This change adds a `capacity_error` notification kind to `CapturePort`, then threads the existing `capturePort` option through the four cli-spawn adapters so their callbacks emit one non-blocking T0 row per detected capacity error.

**Tech Stack:** Bun, TypeScript, bun:test, existing `CapturePort`, existing cli-spawn adapters.

---

## File Map

| Path | Change |
| --- | --- |
| `packages/agentchat/src/worker/capture-port.ts` | Add `capacity_error` notification kind and emit `provider-capacity-error` rows. |
| `packages/agentchat/test/worker/capture-port.test.ts` | Unit-test the new notification kind and payload shape. |
| `packages/agentchat/src/adapters/claude-cli.ts` | Accept optional `capturePort`; pass `onCapacityError` to `spawnCliAdapter` and `spawnCliAdapterStream`. |
| `packages/agentchat/src/adapters/codex-cli.ts` | Same as `claude-cli`. |
| `packages/agentchat/src/adapters/gemini-cli.ts` | Same as `claude-cli`. |
| `packages/agentchat/src/adapters/opencode-cli.ts` | Same as `claude-cli`, preserving existing opencode cleanup behavior. |
| `packages/agentchat/src/adapters/registry.ts` | Thread `capturePort` into the four cli-spawn adapter constructors. |
| `packages/agentchat/test/cli/loop.test.ts` | Integration-style test: a streaming cli adapter capacity error produces a `provider-capacity-error` observe call. |

## Task 1: Add `capacity_error` to CapturePort

**Files:**
- Modify: `packages/agentchat/src/worker/capture-port.ts`
- Modify: `packages/agentchat/test/worker/capture-port.test.ts`

- [ ] **Step 1: Write the failing CapturePort test**

Append this test to `packages/agentchat/test/worker/capture-port.test.ts`:

```ts
describe('CapturePort — capacity_error', () => {
  it('emits provider-capacity-error with provider/model/raw payload', async () => {
    const observed: any[] = [];
    const port = new CapturePort({
      observe: async (e) => { observed.push(e); return { event_id: 'eid' }; },
      chainId: 'conv-capacity',
      handoffId: 'h-capacity',
      projectId: 'project-1',
      agentName: 'gemini',
      provider: 'google',
      model: 'gemini-3.1-pro-preview',
      lane: 'cli-subscription',
      triggeredByEventId: 'prompt-event-1',
    });

    port.emit({
      kind: 'capacity_error',
      provider: 'google',
      model: 'gemini-3.1-pro-preview',
      raw: 'No capacity available for model gemini-3.1-pro-preview',
    });
    await port.flush();

    expect(observed).toHaveLength(1);
    expect(observed[0].event_type).toBe('provider-capacity-error');
    expect(observed[0].source).toBe('agentchat');
    expect(observed[0].source_detail).toBe('gemini');
    expect(observed[0].provider).toBe('google');
    expect(observed[0].model).toBe('gemini-3.1-pro-preview');
    expect(observed[0].session_id).toBe('conv-capacity');
    expect(observed[0].payload_json).toEqual({
      handoff_id: 'h-capacity',
      provider: 'google',
      model: 'gemini-3.1-pro-preview',
      raw: 'No capacity available for model gemini-3.1-pro-preview',
      source_kind: 'cli-spawn-stderr',
    });
    expect(observed[0].payload_summary).toBe('google/gemini-3.1-pro-preview capacity error');
    expect(observed[0].triggered_by_event_id).toBe('prompt-event-1');
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
bun test packages/agentchat/test/worker/capture-port.test.ts -t 'capacity_error'
```

Expected: FAIL because TypeScript rejects `kind: 'capacity_error'` or the port drops the unknown notification.

- [ ] **Step 3: Implement the `capacity_error` notification**

In `packages/agentchat/src/worker/capture-port.ts`, update `NotificationEvent`:

```ts
export type NotificationEvent =
  | {
      kind:
        | 'agent_message_chunk'
        | 'agent_thought_chunk'
        | 'tool_call'
        | 'tool_call_update'
        | 'usage_update';
      toolCallId?: string;
      status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled';
      content?: string;
      input?: unknown;
      output?: unknown;
      used?: number;
      size?: number;
      cost?: { amount: number; currency: string };
    }
  | {
      kind: 'capacity_error';
      provider: string;
      model: string | null;
      raw: string;
    };
```

Then add the dispatch branch:

```ts
      } else if (ev.kind === 'usage_update') {
        this.handleUsageUpdate(ev);
      } else if (ev.kind === 'capacity_error') {
        this.handleCapacityError(ev);
      }
```

Add this method near `handleUsageUpdate`:

```ts
  private handleCapacityError(ev: Extract<NotificationEvent, { kind: 'capacity_error' }>): void {
    const event = this.buildBaseEvent('provider-capacity-error', Date.now());
    event.provider = ev.provider || this.opts.provider;
    event.model = ev.model ?? this.opts.model;
    event.payload_json = {
      handoff_id: this.opts.handoffId,
      provider: ev.provider,
      model: ev.model,
      raw: ev.raw,
      source_kind: 'cli-spawn-stderr',
    };
    event.payload_summary = `${ev.provider}/${ev.model ?? 'unknown'} capacity error`.slice(0, 240);
    this.dispatch(event);
  }
```

- [ ] **Step 4: Run the CapturePort tests**

Run:

```bash
bun test packages/agentchat/test/worker/capture-port.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add packages/agentchat/src/worker/capture-port.ts packages/agentchat/test/worker/capture-port.test.ts
git commit -m "feat(agentchat): capture provider capacity errors"
```

## Task 2: Wire cli-spawn adapters to CapturePort

**Files:**
- Modify: `packages/agentchat/src/adapters/claude-cli.ts`
- Modify: `packages/agentchat/src/adapters/codex-cli.ts`
- Modify: `packages/agentchat/src/adapters/gemini-cli.ts`
- Modify: `packages/agentchat/src/adapters/opencode-cli.ts`
- Modify: `packages/agentchat/src/adapters/registry.ts`

- [ ] **Step 1: Add a shared callback pattern to each cli adapter**

In `packages/agentchat/src/adapters/gemini-cli.ts`, add imports:

```ts
import type { CapturePort } from '../worker/capture-port.js';
import type { CapacityError } from './cli-spawn.js';
```

Change the options interface:

```ts
export interface GeminiCliOptions {
  command: string;
  args?: string[];
  cwd?: string;
  pass_via?: 'stdin' | 'argv';
  env?: Record<string, string>;
  unset_env?: string[];
  strip_patterns?: string[];
  capturePort?: CapturePort;
}
```

Add this private method inside the class:

```ts
  private onCapacityError(err: CapacityError): void {
    this.opts.capturePort?.emit({
      kind: 'capacity_error',
      provider: err.provider,
      model: err.model,
      raw: err.raw,
    });
  }
```

Pass it to both spawn calls:

```ts
      onCapacityError: (err) => this.onCapacityError(err),
```

Repeat the same import/interface/method/spawn option pattern in:

```text
packages/agentchat/src/adapters/claude-cli.ts
packages/agentchat/src/adapters/codex-cli.ts
packages/agentchat/src/adapters/opencode-cli.ts
```

For `opencode-cli.ts`, keep `xdgCleanup` exactly as-is and only add `onCapacityError` to the existing `spawnCliAdapter(...)` and `spawnCliAdapterStream(...)` option objects.

- [ ] **Step 2: Thread `capturePort` through the registry**

In `packages/agentchat/src/adapters/registry.ts`, update the local type casts for `claude-cli`, `gemini-cli`, and `codex-cli` to include `capturePort?: CapturePort`. If importing the type is cleaner, add:

```ts
import type { CapturePort } from '../worker/capture-port.js';
```

For each constructor call, include `capturePort: opts.capturePort`:

```ts
return new GeminiCliAdapter({
  command: opts.command,
  args: opts.args,
  cwd: opts.cwd,
  pass_via: opts.pass_via,
  env: opts.env,
  unset_env: opts.unset_env,
  strip_patterns: opts.strip_patterns,
  capturePort: opts.capturePort,
});
```

Update `claude-cli`, `codex-cli`, and `opencode-cli` the same way. `opencode-cli` already uses `Partial<OpencodeCliOptions>`, so only add `capturePort: opts.capturePort` to the constructor object once the interface has the field.

- [ ] **Step 3: Run targeted adapter type/test checks**

Run:

```bash
bun test packages/agentchat/test/adapters/cli-spawn.test.ts packages/agentchat/test/adapters/cli-spawn-stream.test.ts
bun typecheck
```

Expected: both commands pass. `bun typecheck` is important because this task is mostly type-threading.

- [ ] **Step 4: Commit Task 2**

Run:

```bash
git add packages/agentchat/src/adapters/claude-cli.ts packages/agentchat/src/adapters/codex-cli.ts packages/agentchat/src/adapters/gemini-cli.ts packages/agentchat/src/adapters/opencode-cli.ts packages/agentchat/src/adapters/registry.ts
git commit -m "feat(agentchat): wire cli capacity errors to capture port"
```

## Task 3: Add runChatTurn coverage for end-to-end wiring

**Files:**
- Modify: `packages/agentchat/test/cli/loop.test.ts`

- [ ] **Step 1: Write the failing loop test**

Append this test to `packages/agentchat/test/cli/loop.test.ts`:

```ts
test('runChatTurn observes provider-capacity-error emitted by cli-spawn adapters', async () => {
  const capacityCfg: AgentChatConfig = {
    agents: [
      {
        name: 'gemini-capacity',
        adapter: 'gemini-cli',
        options: {
          command: 'sh',
          args: ['-c', 'echo "No capacity available for model gemini-3.1-pro-preview" 1>&2; echo OK'],
          pass_via: 'argv',
          provider: 'google',
          model: 'gemini-3.1-pro-preview',
        },
        roles: ['planner'],
      },
    ],
    default_roles: { planner: 'gemini-capacity' },
  };

  const observed: any[] = [];
  const result = await runChatTurn({
    config: capacityCfg,
    initialAgent: 'gemini-capacity',
    userMessage: 'go',
    conversation: { id: 'conv-capacity', project_id: 'project-1' },
    observe: async (event) => {
      observed.push(event);
      return { event_id: `event-${observed.length}` };
    },
    handoff_id: 'h-capacity',
  });

  expect(result.text.trim()).toBe('OK');
  const capacityEvent = observed.find((event) => event.event_type === 'provider-capacity-error');
  expect(capacityEvent).toBeDefined();
  expect(capacityEvent.provider).toBe('google');
  expect(capacityEvent.model).toBe('gemini-3.1-pro-preview');
  expect(capacityEvent.session_id).toBe('conv-capacity');
  expect(capacityEvent.payload_json).toMatchObject({
    handoff_id: 'h-capacity',
    provider: 'google',
    model: 'gemini-3.1-pro-preview',
    source_kind: 'cli-spawn-stderr',
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
bun test packages/agentchat/test/cli/loop.test.ts -t 'provider-capacity-error'
```

Expected before Task 2 is complete: FAIL because no `provider-capacity-error` observe call exists. Expected after Task 2: PASS.

- [ ] **Step 3: Run the focused test set**

Run:

```bash
bun test packages/agentchat/test/worker/capture-port.test.ts packages/agentchat/test/adapters/cli-spawn.test.ts packages/agentchat/test/adapters/cli-spawn-stream.test.ts packages/agentchat/test/cli/loop.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit Task 3**

Run:

```bash
git add packages/agentchat/test/cli/loop.test.ts
git commit -m "test(agentchat): cover capacity-error capture wiring"
```

## Task 4: Final verification

**Files:**
- No expected source edits.

- [ ] **Step 1: Run full verification**

Run:

```bash
bun typecheck
bun test packages/agentchat/test/worker/capture-port.test.ts packages/agentchat/test/adapters/cli-spawn.test.ts packages/agentchat/test/adapters/cli-spawn-stream.test.ts packages/agentchat/test/cli/loop.test.ts
git status -sb
```

Expected:
- `bun typecheck` passes.
- Focused tests pass.
- `git status -sb` is clean or shows only intentional committed-ahead state.

- [ ] **Step 2: Report result**

Report:

```text
Implemented Capacity-error CapturePort wiring.
Commits:
- feat(agentchat): capture provider capacity errors
- feat(agentchat): wire cli capacity errors to capture port
- test(agentchat): cover capacity-error capture wiring
Verification:
- bun typecheck
- focused agentchat tests
```

Do not restart `agentchat-worker`; the maestro handles service restarts if needed.
