# Penumbra Sirius Middleware Fastify Plugin Implementation Plan

> **For Gemini:** REQUIRED SUB-SKILL: Use penumbra:executing-plans to implement this plan task-by-task.

**Goal:** Replace the V1 NestJS `PenumbraObserveInterceptor` with a pure Fastify plugin to reliably capture response bodies from controllers using `@Res()`, while addressing all 9 remaining V1 follow-ups.

**Architecture:** A Fastify plugin that hooks into `preHandler` for capturing the request (agent-prompt) and `onSend` for capturing the response (agent-response), completely bypassing NestJS interceptors.

**Tech Stack:** TypeScript, Fastify, Bun (test runner).

---

### Task 1: Type Safety & NOOP Client (Follow-up #6)

**Files:**
- Create: `packages/integrations/sirius-middleware/src/client.ts`
- Modify: `packages/integrations/sirius-middleware/src/index.ts`
- Modify: `packages/integrations/sirius-middleware/test/daemon-client.test.ts` (if it exists) or create a simple unit test.

**Step 1: Write the failing test**
Create/Modify a test verifying the new NOOP client implements the interface.
```typescript
import { expect, test } from 'bun:test';
import { PenumbraDaemonNoopClient } from '../src/client.js';

test('noop client implements interface and does nothing', async () => {
  const client = new PenumbraDaemonNoopClient();
  await client.observe({} as any); // Should resolve without throwing
  expect(true).toBe(true);
});
```

**Step 2: Run test to verify it fails**
Run: `bun test test/client.test.ts` (if new)

**Step 3: Write minimal implementation**
Create `client.ts`:
```typescript
import type { T0EventInput } from '@penumbra/core';

export interface IPenumbraDaemonClient {
  observe(event: T0EventInput): Promise<void>;
}

export class PenumbraDaemonNoopClient implements IPenumbraDaemonClient {
  async observe(_event: T0EventInput): Promise<void> {}
}
```
Export it from `index.ts`.

**Step 4: Run test to verify it passes**
Run: `bun test`

**Step 5: Commit**
`git add packages/integrations/sirius-middleware/src/client.ts packages/integrations/sirius-middleware/src/index.ts test/client.test.ts`
`git commit -m "refactor(sirius-middleware): extract IPenumbraDaemonClient and NOOP implementation"`

---

### Task 2: Core Plugin Implementation - Request Capture & Init Logs (Follow-ups #4, #8)

**Files:**
- Create: `packages/integrations/sirius-middleware/src/plugin.ts`
- Modify: `packages/integrations/sirius-middleware/src/index.ts` (export plugin)

**Step 1: Write the basic plugin structure and tests**
We will TDD the plugin. Create `test/plugin.test.ts`.
```typescript
import { expect, test, describe } from 'bun:test';
import Fastify from 'fastify';
import { penumbraObservePlugin } from '../src/plugin.js';

describe('penumbraObservePlugin init', () => {
  test('logs compliant spec message when disabled', async () => {
    let logged = false;
    const fastify = Fastify();
    await fastify.register(penumbraObservePlugin, {
      logger: { warn: () => {}, info: (obj: any) => {
        if (obj.msg === 'penumbra middleware disabled') logged = true;
      }} as any,
    });
    expect(logged).toBe(true);
  });
});
```

**Step 2: Run test**
`bun test test/plugin.test.ts` (fails)

**Step 3: Write implementation**
Create `plugin.ts` using `fp` (fastify-plugin). Add the `dropped_observations` counter.
```typescript
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { T0EventInput } from '@penumbra/core';
import { PenumbraDaemonClient } from './client.js'; // You'll need to move/adapt the actual client

export interface PenumbraPluginOptions {
  baseUrl?: string;
  token?: string;
  machineId?: string;
  logger?: any;
}

export const penumbraObservePlugin: FastifyPluginAsync<PenumbraPluginOptions> = fp(async (fastify, options) => {
  const logger = options.logger || fastify.log;
  let dropped_observations = 0;

  if (!options.baseUrl) {
    logger.info({
      msg: 'penumbra middleware disabled',
      PENUMBRA_DAEMON_URL_present: false,
      PENUMBRA_DAEMON_TOKEN_present: !!options.token,
      reason: 'No baseUrl provided',
    });
    return;
  }

  const client = new PenumbraDaemonClient({ baseUrl: options.baseUrl, token: options.token });
  const machineId = options.machineId || 'unknown';

  // Request hook (prompt)
  fastify.addHook('preHandler', async (req, reply) => {
    const projectHeader = req.headers['x-penumbra-project'];
    if (!projectHeader || req.url !== '/v1/chat/completions') return;
    
    const projectId = Array.isArray(projectHeader) ? projectHeader[0] : projectHeader;
    const sessionId = (req.headers['x-request-id'] as string) || randomUUID();
    req.penumbraSession = { sessionId, projectId }; // We'll type this via fastify declaration merging
    
    // ... logic to extract body and fire agent-prompt
    // ... catch errors and increment dropped_observations, log warn matching Spec §5
  });
  
  // onSend hook setup placeholder...
});
```
(You will flesh out the full `agent-prompt` building logic here, pulling from the old interceptor).

**Step 4: Run test**
`bun test test/plugin.test.ts`

**Step 5: Commit**
`git add ... && git commit -m "feat(sirius-middleware): introduce fastify plugin base and request capture"`

---

### Task 3: Core Plugin Implementation - Response Capture (`onSend` & Streaming) (Follow-ups #3, #5, #8)

**Files:**
- Modify: `packages/integrations/sirius-middleware/src/plugin.ts`
- Modify: `packages/integrations/sirius-middleware/test/plugin.test.ts`

**Step 1: Write test for response capture**
In `test/plugin.test.ts`, add a test that mounts the plugin, makes a request to a fake `/v1/chat/completions` route, and asserts `agent-response` is fired with the correct `payload_summary` and `tokens_out` by parsing the JSON payload.

**Step 2: Run test (fails)**

**Step 3: Implement `onSend`**
In `plugin.ts`:
```typescript
  fastify.addHook('onSend', (req, reply, payload, done) => {
    if (!req.penumbraSession) return done(null, payload);
    
    if (typeof payload === 'string') {
      try {
        const body = JSON.parse(payload);
        // ... build agent-response, fire client.observe()
      } catch (err) {
         // handle parse error
      }
      return done(null, payload);
    }
    
    // Handle streaming (ReadableStream)
    if (payload && typeof (payload as any).on === 'function') {
      // tee the stream, accumulate chunks, on('end') flush buffer and fire agent-response
      // ...
      return done(null, payload);
    }

    done(null, payload);
  });
```

**Step 4: Run tests**
`bun test`

**Step 5: Commit**
`git commit -m "feat(sirius-middleware): implement fastify onSend hook for response capture"`

---

### Task 4: Fix Test Gaps & Spec Compliance (Follow-up #2)

**Files:**
- Modify: `packages/integrations/sirius-middleware/test/plugin.test.ts` (replace old interceptor tests)

**Step 1: Write the disjoint failure test**
Add a test where the daemon mock throws ONLY on `agent-prompt`. Assert that the request to the fastify route still returns 200 OK, and that `agent-response` is still attempted and captured by the mock.

**Step 2: Verify it passes (it should, inherently due to Fastify hooks)**

**Step 3: Clean up old interceptor tests**
Delete `interceptor-non-streamed.test.ts` and `interceptor-streamed.test.ts` as they are now obsolete. Ensure all their logic is ported to `plugin.test.ts`.

**Step 4: Commit**
`git add ... && git rm ... && git commit -m "test(sirius-middleware): ensure prompt failure does not block response capture"`

---

### Task 5: Remove NestJS Module and Interceptor

**Files:**
- Delete: `packages/integrations/sirius-middleware/src/interceptor.ts`
- Delete: `packages/integrations/sirius-middleware/src/module.ts`
- Modify: `packages/integrations/sirius-middleware/src/index.ts`
- Modify: `packages/integrations/sirius-middleware/package.json` (remove `@nestjs/*` dependencies if no longer needed, keeping fastify).

**Step 1: Delete files and clean up exports**
**Step 2: Run build/tests**
Ensure `bun run typecheck` and `bun test` still pass.
**Step 3: Commit**
`git commit -m "refactor(sirius-middleware): remove nestjs interceptor and module"`

---

### Task 6: Add Package README (Follow-up #7)

**Files:**
- Create: `packages/integrations/sirius-middleware/README.md`

**Step 1: Write README**
Document the plugin purpose, how to register it via `fastify.register()`, required env vars (`PENUMBRA_DAEMON_URL`, `PENUMBRA_DAEMON_TOKEN`), and the `x-penumbra-project` header contract. Emphasize fail-silent semantics.

**Step 2: Commit**
`git add README.md && git commit -m "docs(sirius-middleware): add package README"`

---

### Task 7: sirius-gateway Integration & Runbook (Follow-up #9)

**Files:**
- Modify: `/Volumes/WorkSSD/repos/personal/sirius-gateway/apps/sirius-api/src/app.module.ts` (remove `PenumbraMiddlewareModule`)
- Modify: `/Volumes/WorkSSD/repos/personal/sirius-gateway/apps/sirius-api/src/main.ts` (register plugin on Fastify adapter)
- Modify: `/Volumes/WorkSSD/repos/personal/sirius-gateway/AGENTS.md` (add verification step)

**Step 1: Modify `app.module.ts` and `main.ts`**
Remove NestJS module imports. Register `penumbraObservePlugin` directly to `app` in `main.ts`, reading config from `process.env`.

**Step 2: Update `AGENTS.md`**
Add: "Verify on startup that the log emits `penumbra middleware enabled` with the configured baseUrl."

**Step 3: Run integration tests in sirius-gateway**
`cd /Volumes/WorkSSD/repos/personal/sirius-gateway && bun test`
Ensure the E2E tests for the Penumbra wiring still pass (you may need to update the DI wiring test in `sirius-gateway` to reflect that it's no longer an `APP_INTERCEPTOR`).

**Step 4: Commit (in sirius-gateway repo)**
`git commit -a -m "refactor(sirius-api): migrate to penumbra fastify plugin"`

---

### Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-25-penumbra-sirius-middleware-fastify.md`.

Two execution options:

1.  **Subagent-Driven (this session)** - I dispatch a fresh subagent per task, review between tasks, fast iteration.
2.  **Parallel Session (separate)** - Open a new session with `executing-plans`, batch execution with checkpoints.

**Which approach?**