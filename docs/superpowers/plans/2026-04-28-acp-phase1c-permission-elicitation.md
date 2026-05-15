# ACP Phase 1c v1 — Trust-Aware Permission Elicitation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use penumbra:dispatching (recommended) or penumbra:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the maestro's auto-allow `session/request_permission` stub (Phase 1a, commit `ebd9ca5`) with trust-mode-aware decisions. When `chain_trust_mode='all'` the adapter auto-approves; when `chain_trust_mode='config'` (or anything else) the adapter rejects. Today's stub auto-approves regardless of trust mode, which means a `config` dispatch silently gets `all` semantics.

**Why v1 only?** The full Phase 1c roadmap calls for daemon-side `permission_request` handoffs that pause mid-dispatch and await operator approval via the existing handoff.approve MCP tool — that's a substantial cross-package change (~1-2 days) including new schema, new daemon route, mid-dispatch async coordination, and TTL handling. v1 closes the immediate correctness gap (trust mode is now respected) while keeping the implementation small and shippable in one cycle. Phase 1c v2 will add the human-pause flow when the operator-in-the-loop story is needed.

**Architecture:** Thread a `requestPermission` callback through `DispatchInput` from the worker to the adapter. The worker provides the callback closing over the dispatch's `chain_trust_mode`. The stdio-acp adapter's `session/request_permission` handler invokes the callback to get the decision, then maps to the canonical ACP outcome shape. The decision logic stays in the worker — adapters only execute the protocol.

**Tech Stack:** TypeScript, vitest (existing test framework in `stdio-acp.test.ts`), `bun:test` for the new worker test.

---

## File Structure

| Action | Path | Reason |
|---|---|---|
| Modify | `packages/agentchat/src/sdk/adapter.ts` | Add `requestPermission?: (toolCall: ToolCallContext) => Promise<PermissionDecision>` to `DispatchInput`, plus the `ToolCallContext` and `PermissionDecision` types. Keep optional so existing adapters (CLI, openai-compat-http, opencode-acp) need no changes. |
| Modify | `packages/agentchat/bin/agentchat-worker.ts` | Build the `requestPermission` callback from the dispatch's `trust_mode` and pass it via the dispatcher → adapter chain. v1: 'all' resolves 'approve'; anything else resolves 'reject'. |
| Modify | `packages/agentchat/src/worker/dispatcher.ts` | If `WorkerDispatcherDeps` has a permission-callback hook (it doesn't yet), thread it. If not, the worker's `dispatch:` callback in agentchat-worker.ts builds the input directly, so there's no dispatcher change. (Verify with grep before writing.) |
| Modify | `packages/agentchat/src/adapters/stdio-acp.ts` | Replace the unconditional auto-allow with a call to `input.requestPermission?.(toolCall)`. Map the returned decision to the ACP `RequestPermissionResponse` outcome shape. Fall back to current auto-allow behavior if `requestPermission` is undefined (so older callers don't break). |
| Create | `packages/agentchat/test/worker/permission-callback.test.ts` | Unit test the worker's permission-callback factory: 'all' → approve, 'config' → reject, missing trust mode (defaults to 'all') → approve. |
| Modify | `packages/agentchat/test/adapters/stdio-acp.test.ts` | Add tests: (a) when DispatchInput has requestPermission returning 'approve', adapter sends a 'selected' outcome with allow_always; (b) when returning 'reject', adapter sends 'cancelled' outcome; (c) backward-compat — when requestPermission is undefined, existing auto-allow stub behavior preserved. |

---

## Task 1: Define types in `sdk/adapter.ts`

**Files:**
- Modify: `packages/agentchat/src/sdk/adapter.ts`

- [ ] **Step 1: Add types**

In `packages/agentchat/src/sdk/adapter.ts`, after the existing type exports, add:

```ts
/**
 * Context the adapter passes to the worker's permission callback. Carries
 * the agent's tool-call request shape so the worker can make a decision
 * (or in Phase 1c v2, surface it as a handoff for operator approval).
 *
 * Shape mirrors what ACP agents send via session/request_permission, but the
 * field names are protocol-agnostic so non-ACP adapters can use the same hook.
 */
export interface ToolCallContext {
  /** Human-readable tool name (e.g. 'fs.readTextFile', 'mcp__penumbra__chain.list_agents'). */
  toolName: string;
  /** The full request payload from the agent — opaque to the worker, used for logging/auditing. */
  rawInput: unknown;
}

/** Worker's decision for a permission request. */
export type PermissionDecision = 'approve' | 'reject';

export interface DispatchInput {
  prompt: string;
  conversation: { id: string; project_id: string | null };
  config: Record<string, unknown>;
  signal: AbortSignal;
  /**
   * Optional permission callback. Adapters that surface tool-permission
   * requests during a turn (e.g. stdio-acp's session/request_permission)
   * call this to get a decision. When undefined, adapters fall back to
   * their pre-Phase-1c default behavior (auto-allow stub).
   */
  requestPermission?: (toolCall: ToolCallContext) => Promise<PermissionDecision>;
}
```

(Keep all other types in this file unchanged.)

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`

Expected: exit 0 (the new fields are optional + opt-in, no existing callers break).

- [ ] **Step 3: Commit**

```bash
git add packages/agentchat/src/sdk/adapter.ts
git commit -m "feat(agentchat): adapter SDK — DispatchInput.requestPermission hook for trust-aware permissions"
```

---

## Task 2: Worker builds the trust-aware callback

**Files:**
- Modify: `packages/agentchat/bin/agentchat-worker.ts`
- Create: `packages/agentchat/src/worker/permission-callback.ts` — pure factory function (testable without the worker boot machinery)
- Create: `packages/agentchat/test/worker/permission-callback.test.ts`

The worker reads `trust_mode` from the handoff (already exists at line ~113 of agentchat-worker.ts: `const trustMode = (handoff.chain_trust_mode ?? defaultTrust) as 'all' | 'config';`). We extract the callback construction into a pure factory for testability, then wire it.

- [ ] **Step 1: Probe the existing dispatch site**

Run: `grep -n "trustMode\|return await dispatchHandoff" packages/agentchat/bin/agentchat-worker.ts | head -10`

Expected: lines around 113-126 showing `trustMode` resolution and the `dispatchHandoff(...)` call. We'll insert the callback construction just before the dispatchHandoff call.

- [ ] **Step 2: Write the failing test**

Create `packages/agentchat/test/worker/permission-callback.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { createPermissionCallback } from '../../src/worker/permission-callback.js';

describe('createPermissionCallback', () => {
  it("returns 'approve' for trust_mode='all'", async () => {
    const cb = createPermissionCallback('all');
    const decision = await cb({ toolName: 'fs.readTextFile', rawInput: {} });
    expect(decision).toBe('approve');
  });

  it("returns 'reject' for trust_mode='config'", async () => {
    const cb = createPermissionCallback('config');
    const decision = await cb({ toolName: 'fs.readTextFile', rawInput: {} });
    expect(decision).toBe('reject');
  });

  it('decision does not depend on the toolName in v1 (no per-tool allowlist yet)', async () => {
    const cb = createPermissionCallback('all');
    expect(await cb({ toolName: 'one', rawInput: {} })).toBe('approve');
    expect(await cb({ toolName: 'two', rawInput: {} })).toBe('approve');

    const cbConfig = createPermissionCallback('config');
    expect(await cbConfig({ toolName: 'one', rawInput: {} })).toBe('reject');
    expect(await cbConfig({ toolName: 'two', rawInput: {} })).toBe('reject');
  });
});
```

- [ ] **Step 3: Run test to verify failure**

Run: `bun test packages/agentchat/test/worker/permission-callback.test.ts`

Expected: FAIL — `createPermissionCallback` not exported (file doesn't exist yet).

- [ ] **Step 4: Implement the factory**

Create `packages/agentchat/src/worker/permission-callback.ts`:

```ts
import type { PermissionDecision, ToolCallContext } from '../sdk/adapter.js';

/**
 * Builds a permission callback for a single dispatch given its trust mode.
 *
 * Phase 1c v1 logic:
 *   - 'all'    → approve every request (operator declared trust)
 *   - 'config' → reject every request (operator wants per-call control,
 *                but we don't yet have a per-tool allowlist; reject-by-default
 *                is the conservative choice and surfaces the limitation
 *                cleanly in the agent's response)
 *
 * Phase 1c v2 will replace 'config' with: consult per-agent yaml
 * `allowed_tools: [...]` allowlist; for tools NOT on the list, create a
 * permission_request handoff in the daemon and await operator approval
 * via mcp__penumbra__handoff_approve (TTL default 5min, then auto-reject).
 */
export function createPermissionCallback(
  trustMode: 'all' | 'config',
): (toolCall: ToolCallContext) => Promise<PermissionDecision> {
  return async (_toolCall: ToolCallContext): Promise<PermissionDecision> => {
    if (trustMode === 'all') return 'approve';
    return 'reject';
  };
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test packages/agentchat/test/worker/permission-callback.test.ts`

Expected: 3 pass.

- [ ] **Step 6: Wire the callback into the worker's dispatch input**

In `packages/agentchat/bin/agentchat-worker.ts`, locate the `dispatch:` callback (around line 94). Inside that function, after the `trustMode` line:

```ts
const trustMode = (handoff.chain_trust_mode ?? defaultTrust) as 'all' | 'config';
```

Add the import at the top:

```ts
import { createPermissionCallback } from '../src/worker/permission-callback.js';
```

And in the dispatchHandoff call site, add the callback to the dispatch input. The current code calls `dispatchHandoff({ ... })`, which internally creates the adapter's DispatchInput. We need to thread the callback through. The cleanest path is to add a field to the dispatchHandoff opts and have it forwarded to the adapter's `dispatch()`:

Verify the current dispatchHandoff signature in `packages/agentchat/src/cli/dispatch-handoff.ts` — it constructs a DispatchInput before invoking the adapter. Add `requestPermission` as an optional opt and forward it.

Concretely:

a) In `packages/agentchat/src/cli/dispatch-handoff.ts`, find the type that defines the function's options (DispatchHandoffOpts or similar) and the place where it builds the adapter call. Add `requestPermission?` to the opts type and pass it into the DispatchInput.

b) In `packages/agentchat/bin/agentchat-worker.ts`, build the callback once per dispatch and pass it into `dispatchHandoff({ ..., requestPermission: createPermissionCallback(trustMode) })`.

(If dispatchHandoff doesn't construct DispatchInput directly — e.g., it goes through the adapter's `.dispatch(input)` — trace one level deeper. The principle: the worker creates the callback; whatever path leads to the adapter's `dispatch(input)` call must include it in the input.)

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/agentchat/src/worker/permission-callback.ts packages/agentchat/test/worker/permission-callback.test.ts packages/agentchat/bin/agentchat-worker.ts packages/agentchat/src/cli/dispatch-handoff.ts
git commit -m "$(cat <<'EOF'
feat(agentchat): worker — trust-aware permission callback factory

Phase 1c v1 — replaces the unconditional auto-allow stub with a
trust_mode-aware decision:
  - 'all'    → approve every request
  - 'config' → reject every request (conservative until v2 adds
               per-agent allowed_tools + handoff.approve flow)

Factored into createPermissionCallback for testability. Threaded
through dispatchHandoff opts → DispatchInput.requestPermission so
adapters can call it without knowing the trust mode themselves.
EOF
)"
```

---

## Task 3: stdio-acp adapter consumes the callback

**Files:**
- Modify: `packages/agentchat/src/adapters/stdio-acp.ts`
- Modify: `packages/agentchat/test/adapters/stdio-acp.test.ts`

The current handler (after Phase 1a, ebd9ca5) is the auto-allow stub:

```ts
client.onRequest('session/request_permission', async (params: any) => {
  const options = Array.isArray(params?.options) ? params.options : [];
  const chosen =
    options.find((o: any) => o?.kind === 'allow_always') ??
    options.find((o: any) => o?.kind === 'allow_once') ??
    options[0];
  if (!chosen?.optionId) return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
});
```

Replace with a callback-aware version that defaults to the stub when no callback is provided.

- [ ] **Step 1: Write the failing test**

In `packages/agentchat/test/adapters/stdio-acp.test.ts`, add three tests in the existing `describe('StdioAcpAdapter', ...)` block (use vitest style — `it`, `vi.fn()` — to match the file):

```ts
  it('honors requestPermission=approve by selecting allow_always', async () => {
    // Setup: mock server that emits a session/request_permission and resolves prompt
    const { adapter, mockClient, sentRequests } = setupAdapterWithMockedClient({ fsReadTextFile: true });
    const requestPermission = vi.fn().mockResolvedValue('approve');
    const dispatchPromise = adapter.dispatch({
      prompt: 'hi',
      conversation: { id: 'c-1', project_id: null },
      config: {},
      signal: new AbortController().signal,
      requestPermission,
    });
    // Simulate agent sending session/request_permission with allow_always option
    await mockClient.simulateIncomingRequest({
      id: 100,
      method: 'session/request_permission',
      params: {
        sessionId: 'session-123',
        options: [
          { optionId: 'a', kind: 'allow_always', name: 'Allow always' },
          { optionId: 'r', kind: 'reject_once', name: 'Reject once' },
        ],
        toolCall: { name: 'fs.readTextFile' },
      },
    });
    await mockClient.simulateAgentMessage({ text: 'done' });
    await mockClient.simulatePromptResolve();
    await dispatchPromise;

    expect(requestPermission).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: expect.any(String) }),
    );
    const reply = sentRequests.find((r) => r.id === 100);
    expect(reply?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'a' },
    });
  });

  it('honors requestPermission=reject by returning cancelled outcome', async () => {
    const { adapter, mockClient, sentRequests } = setupAdapterWithMockedClient({ fsReadTextFile: true });
    const requestPermission = vi.fn().mockResolvedValue('reject');
    const dispatchPromise = adapter.dispatch({
      prompt: 'hi',
      conversation: { id: 'c-1', project_id: null },
      config: {},
      signal: new AbortController().signal,
      requestPermission,
    });
    await mockClient.simulateIncomingRequest({
      id: 200,
      method: 'session/request_permission',
      params: {
        sessionId: 'session-123',
        options: [{ optionId: 'a', kind: 'allow_always', name: 'Allow' }],
        toolCall: { name: 'fs.readTextFile' },
      },
    });
    await mockClient.simulateAgentMessage({ text: 'rejected' });
    await mockClient.simulatePromptResolve();
    await dispatchPromise;

    const reply = sentRequests.find((r) => r.id === 200);
    expect(reply?.result).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('falls back to auto-allow stub when requestPermission is not provided (backward compat)', async () => {
    const { adapter, mockClient, sentRequests } = setupAdapterWithMockedClient({ fsReadTextFile: true });
    const dispatchPromise = adapter.dispatch({
      prompt: 'hi',
      conversation: { id: 'c-1', project_id: null },
      config: {},
      signal: new AbortController().signal,
      // no requestPermission
    });
    await mockClient.simulateIncomingRequest({
      id: 300,
      method: 'session/request_permission',
      params: {
        sessionId: 'session-123',
        options: [{ optionId: 'a', kind: 'allow_always', name: 'Allow' }],
        toolCall: { name: 'whatever' },
      },
    });
    await mockClient.simulateAgentMessage({ text: 'fallback' });
    await mockClient.simulatePromptResolve();
    await dispatchPromise;

    const reply = sentRequests.find((r) => r.id === 300);
    expect(reply?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'a' },
    });
  });
```

NOTE: `setupAdapterWithMockedClient` is a helper — write it inline in the test file if no equivalent exists. The Phase 1a test (`'passes mcpServers from options into session/new params'`) already mocks the client.request path. Reuse the same mocking style; extend with a hook for the test to inject incoming request messages back through the StdioAcpClient's onRequest dispatch.

If the existing test infrastructure doesn't support simulating incoming requests easily, use the StdioAcpClient directly with PassThrough streams (the same pattern as `stdio-acp-client-onrequest.test.ts`) — that test file already tests onRequest end-to-end.

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test packages/agentchat/test/adapters/stdio-acp.test.ts -t "requestPermission\|backward compat"`

Expected: FAIL — adapter doesn't call requestPermission yet.

- [ ] **Step 3: Update the handler**

In `packages/agentchat/src/adapters/stdio-acp.ts`, find the existing `client.onRequest('session/request_permission', ...)` block. Replace it with:

```ts
const hasClientCapability =
  this.opts.fsReadTextFile ||
  (this.opts.mcpServers !== undefined && this.opts.mcpServers.length > 0);
if (hasClientCapability) {
  client.onRequest('session/request_permission', async (params: any) => {
    const options = Array.isArray(params?.options) ? params.options : [];
    const allowOption =
      options.find((o: any) => o?.kind === 'allow_always') ??
      options.find((o: any) => o?.kind === 'allow_once') ??
      options.find((o: any) => o?.optionId);
    const rejectOption =
      options.find((o: any) => o?.kind === 'reject_always') ??
      options.find((o: any) => o?.kind === 'reject_once');

    let decision: 'approve' | 'reject' = 'approve';
    if (input.requestPermission) {
      try {
        decision = await input.requestPermission({
          toolName: params?.toolCall?.title ?? params?.toolCall?.name ?? 'unknown',
          rawInput: params?.toolCall?.rawInput ?? params?.toolCall ?? null,
        });
      } catch (err) {
        // Treat callback errors as a reject so we fail closed on bad infra.
        decision = 'reject';
      }
    }

    if (decision === 'approve' && allowOption?.optionId) {
      return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
    }
    if (decision === 'reject' && rejectOption?.optionId) {
      return { outcome: { outcome: 'selected', optionId: rejectOption.optionId } };
    }
    // Fall back: if we want approve but only reject options were offered (or
    // vice versa), or if the agent gave us no options, return cancelled.
    return { outcome: { outcome: 'cancelled' } };
  });
}
```

The two extraction points (`toolCall.title`, `toolCall.name`) cover both the canonical ACP `ToolCallUpdate.title` field and looser variants some agents emit. `rawInput` lets the worker inspect the actual arguments if it wants to (e.g., for v2's allowlist matching).

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test packages/agentchat/test/adapters/stdio-acp.test.ts`

Expected: existing 6 + 3 new = 9 pass, 0 fail.

- [ ] **Step 5: Run full agentchat adapter suite for regression check**

Run: `bun test packages/agentchat/test/adapters/`

Expected: all pass; no regression in opencode-acp, claude-cli, etc.

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/agentchat/src/adapters/stdio-acp.ts packages/agentchat/test/adapters/stdio-acp.test.ts
git commit -m "$(cat <<'EOF'
feat(agentchat): stdio-acp — consume DispatchInput.requestPermission for trust-aware decisions

When DispatchInput.requestPermission is provided, the adapter calls it with
a ToolCallContext (toolName + rawInput) and maps the returned decision to
the ACP RequestPermissionResponse outcome:
  - 'approve' → selected with allow_always (or allow_once, or first
    optionId) optionId
  - 'reject'  → selected with reject_always/reject_once optionId, or
    cancelled if no reject option offered
  - callback throws → treated as 'reject' (fail closed)

Backward compat: when requestPermission is undefined, falls back to the
Phase 1a auto-allow stub (preserves existing single-agent test behavior).

Phase 1c v1 of the ACP roadmap. v2 will add daemon-side
permission_request handoffs + operator approval via handoff.approve.
EOF
)"
```

---

## Task 4: Smoke test (MAESTRO-SIDE — implementer should stop after Task 3)

The maestro performs:

- [ ] **Step 1: Edit `~/.config/agentchat/agentchat.yaml`**

Keep `claude-acp-sonnet` as-is (still has `mcpServers` + `fsReadTextFile: true`). No yaml change required for v1.

- [ ] **Step 2: Restart workers** (so they have Task 2's new callback wiring)

```bash
pkill -TERM -f 'agentchat-worker.ts' ; sleep 2
for w in primary b c d; do
  nohup bun packages/agentchat/bin/agentchat-worker.ts --storage-root /tmp/penumbra-live --worker-id worker-$w > /tmp/worker-$w.log 2>&1 &
done
sleep 5
```

- [ ] **Step 3: Smoke A — trust_mode='all' should still pass (regression check)**

```
mcp__penumbra__chain_start({
  initial_agent: 'claude-acp-sonnet',
  message: 'Use the penumbra MCP server to call chain.list_agents and reply EXACTLY: AGENTS: <number>',
  use_worktree: true,
  trust_mode: 'all'
})
```

Expected: `AGENTS: 51` (matching the Phase 1a smoke).

- [ ] **Step 4: Smoke B — trust_mode='config' should now reject the tool call**

```
mcp__penumbra__chain_start({
  initial_agent: 'claude-acp-sonnet',
  message: 'Use the penumbra MCP server to call chain.list_agents and reply EXACTLY: AGENTS: <number>',
  use_worktree: true,
  trust_mode: 'config'
})
```

Expected: the agent reports it cannot call the tool (permission denied / cancelled). The exact wording depends on claude-agent-acp; what matters is the response does NOT contain `AGENTS: 51`. The agent's tool call was rejected by the adapter's `session/request_permission` reply.

- [ ] **Step 5: Append outcomes to the agent-performance ledger**

Two rows: smoke A merged + smoke B merged (both verify the v1 contract).

If Smoke B agent reports `AGENTS: 51` somehow, investigate: maybe the agent has cached results, or the callback isn't being threaded correctly. Stop and surface — don't iterate.

---

## Verification — does the plan cover the spec?

| Goal | Task |
|---|---|
| Adapter receives a permission decision callback | Task 1 (sdk types) + Task 2 (worker wiring) + Task 3 (adapter consumption) |
| Trust-mode-aware decision (`all` → approve, `config` → reject) | Task 2 (`createPermissionCallback`) |
| Map decision to canonical ACP outcome shape | Task 3 (allow_always vs reject_always vs cancelled) |
| Fail-closed on callback errors | Task 3 (try/catch defaults to 'reject') |
| Backward compat for adapters without requestPermission | Task 1 (optional field) + Task 3 (fallback to Phase 1a stub) |
| Smoke verifies both modes work end-to-end | Task 4 |
| Daemon-side handoff.approve flow | NOT in v1 — explicit follow-up plan |
| Per-agent `allowed_tools` allowlist | NOT in v1 — explicit follow-up plan |
| TTL with auto-reject | NOT in v1 — explicit follow-up plan |

## End-to-end worked example

**Before this plan (Phase 1a stub):** any dispatch with `mcpServers` configured silently auto-approves every tool call regardless of `chain_trust_mode`.

**After this plan:**
- `chain_trust_mode='all'` dispatch:
  - Agent sends `session/request_permission` with `toolCall: { title: 'mcp__penumbra__chain.list_agents' }`
  - Adapter calls `requestPermission({ toolName: 'mcp__penumbra__chain.list_agents', rawInput: ... })`
  - Worker's callback: `'all'` → `'approve'`
  - Adapter responds: `{ outcome: { outcome: 'selected', optionId: 'allow-always' } }`
  - Agent proceeds, MCP call routes to penumbra-mcp, returns 51 agents.

- `chain_trust_mode='config'` dispatch:
  - Same agent request.
  - Worker's callback: `'config'` → `'reject'`
  - Adapter responds: `{ outcome: { outcome: 'selected', optionId: 'reject-once' } }` (or `cancelled` if no reject option).
  - Agent receives the rejection in its tool result, surfaces in its response: "I can't call this tool — permission denied."

## Estimated effort

- Task 1 (SDK types): 10 min
- Task 2 (worker callback factory + wiring + 3 tests): 45 min
- Task 3 (adapter consumption + 3 tests): 45 min
- Task 4 (smoke, maestro-side): 15 min

Total: ~2 hours implementer scope (Tasks 1-3); ~15 min maestro smoke.

## Phase 1c v2 (deferred — separate plan)

After v1 ships and we have real usage data on the trust-mode-only model, v2 adds:
1. Per-agent yaml `options.allowed_tools: ['fs.readTextFile', 'mcp__penumbra__chain.list_agents', ...]` — allowlist for tools that auto-approve under `config` mode.
2. Daemon-side `permission_request` handoff records (extend HandoffStatusSchema or add a new kind field).
3. Mid-dispatch async coordination: adapter blocks on the daemon's `/handoffs/:id/permission-result` until the operator calls `handoff.approve`.
4. TTL with auto-reject (default 5min, configurable via `PENUMBRA_PERMISSION_TTL_S`).
5. `handoff.approve` MCP tool extension — accept a `permission_decision: 'approve' | 'reject' | 'redirect'` field for permission-request handoffs.

Effort: ~1-2 days, separate plan when needed.
