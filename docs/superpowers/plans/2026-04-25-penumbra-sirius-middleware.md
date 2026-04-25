# Penumbra Sirius-Middleware (V1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@penumbra/sirius-middleware` — a NestJS module that lets sirius-gateway forward chat-completion traffic into penumbra's daemon as paired T0 events (`agent-prompt` + `agent-response`), opt-in per request via the `x-penumbra-project` header.

**Architecture:** Self-contained Bun workspace package at `packages/integrations/sirius-middleware/` with `@nestjs/common`, `@nestjs/core`, and `rxjs` as **peer deps** (not pinned). Single global interceptor reads env-driven config at module init, stamps a host-derived `machine_id` once, then on each header-bearing chat request fires two fire-and-forget `queueMicrotask` POSTs to penumbra's existing `POST /observations` route. Cross-repo wire: a separate small commit in sirius-gateway adds a `file:` dep and a one-line module registration. No penumbra-core schema changes.

**Tech Stack:** Bun 1.3+, TypeScript 5.9+ strict NodeNext ESM, NestJS 11 (peer), RxJS 7+ (peer), `@nova/contracts`-style coding conventions inherited from existing penumbra packages, `bun:test` everywhere. Real penumbra daemon for the gated integration test (no mocks at the integration layer).

**Spec:** `docs/superpowers/specs/2026-04-25-penumbra-sirius-middleware-design.md`. Read it before starting Task 1.

**Prerequisite reading for the engineer:**
- `docs/superpowers/specs/2026-04-23-penumbra-design.md` — full V1 spec; especially "Sirius-middleware (opt-in, two roles)" section.
- `packages/core/src/schemas/event.ts` — the real `T0EventInputSchema` shape.
- `packages/mcp/src/daemon-client.ts` — pattern this package's `PenumbraDaemonClient` mirrors.
- `packages/e2e/test/helpers/spawn-bin.ts` and `packages/e2e/test/smoke/persistence-across-restart.test.ts` — patterns the integration test mirrors.

---

## Sprint A — Package scaffold (Tasks 1–3)

### Task 1: Workspaces glob + package scaffold

**Files:**
- Modify: `package.json` (root)
- Create: `packages/integrations/sirius-middleware/package.json`
- Create: `packages/integrations/sirius-middleware/tsconfig.json`
- Create: `packages/integrations/sirius-middleware/tsconfig.test.json`
- Create: `packages/integrations/sirius-middleware/src/index.ts`

- [ ] **Step 1: Extend root workspaces glob to include `packages/integrations/*`**

The root `package.json` currently has `"workspaces": ["packages/*"]`. The new package lives one level deeper, so add the second glob.

Edit `package.json`:
```json
{
  "name": "penumbra",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "packages/integrations/*"],
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit -b"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 2: Create the package directory and write `package.json`**

```bash
mkdir -p packages/integrations/sirius-middleware/src packages/integrations/sirius-middleware/test
```

Write `packages/integrations/sirius-middleware/package.json`:
```json
{
  "name": "@penumbra/sirius-middleware",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "dependencies": {
    "@penumbra/core": "workspace:*"
  },
  "peerDependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "rxjs": "^7.0.0"
  },
  "devDependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/testing": "^11.0.0",
    "@nestjs/platform-fastify": "^11.0.0",
    "@types/node": "^25.6.0",
    "fastify": "^5.0.0",
    "rxjs": "^7.0.0"
  }
}
```

`@penumbra/core` is a normal dep because we import the `T0EventInputSchema` type at compile time (and only at compile time — the value is a Zod schema; we don't run `parse` on the wire shape at the boundary, the daemon does). `@nestjs/*` and `rxjs` are peer deps so the package doesn't pin sirius-gateway's NestJS version, but they're also dev deps so the package's own tests can run.

- [ ] **Step 3: Write `tsconfig.json` (build config — src only)**

Mirrors deviation #14: build config is src-only, no `rootDir`, references `@penumbra/core`.

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist"
  },
  "references": [{ "path": "../../core" }],
  "include": ["src/**/*.ts"]
}
```

Note the `../../../tsconfig.base.json` — three `..` because the package is one level deeper than the existing `packages/*` packages.

- [ ] **Step 4: Write `tsconfig.test.json` (test config — includes src + test, no emit)**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 5: Write a placeholder `src/index.ts` so `tsc` has something to compile**

```typescript
export {};
```

We'll fill in the real exports as later tasks add components.

- [ ] **Step 6: Refresh the lockfile and verify the workspace resolves**

```bash
bun install
```

Expected: bun reports the new workspace package and updates `bun.lock`. No errors.

- [ ] **Step 7: Verify the build config typechecks**

```bash
bun run typecheck
```

Expected: zero errors. The new package is part of the build graph.

- [ ] **Step 8: Commit**

```bash
git add package.json bun.lock packages/integrations/sirius-middleware/
git commit -m "feat(sirius-middleware): scaffold @penumbra/sirius-middleware package"
```

---

### Task 2: Config loader

**Files:**
- Create: `packages/integrations/sirius-middleware/src/config.ts`
- Create: `packages/integrations/sirius-middleware/test/config.test.ts`

The config loader is a pure function called once at module init. It reads `PENUMBRA_DAEMON_URL` and `PENUMBRA_DAEMON_TOKEN` from `process.env`, validates them, captures `os.hostname()` for `machine_id`, and returns either an enabled or disabled state. The interceptor consumes this via NestJS DI.

- [ ] **Step 1: Write the failing test file**

Create `packages/integrations/sirius-middleware/test/config.test.ts`:
```typescript
import { expect, test, describe } from 'bun:test';
import { loadConfig } from '../src/config.js';

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

describe('loadConfig', () => {
  test('returns enabled with parsed URL, token, and hostname-derived machineId', () => {
    const cfg = withEnv(
      { PENUMBRA_DAEMON_URL: 'http://127.0.0.1:49222', PENUMBRA_DAEMON_TOKEN: 'tk-1' },
      () => loadConfig(),
    );
    expect(cfg.kind).toBe('enabled');
    if (cfg.kind !== 'enabled') return;
    expect(cfg.baseUrl).toBe('http://127.0.0.1:49222');
    expect(cfg.token).toBe('tk-1');
    expect(typeof cfg.machineId).toBe('string');
    expect(cfg.machineId.length).toBeGreaterThan(0);
  });

  test('strips trailing slash from baseUrl', () => {
    const cfg = withEnv(
      { PENUMBRA_DAEMON_URL: 'http://127.0.0.1:49222/', PENUMBRA_DAEMON_TOKEN: 'tk' },
      () => loadConfig(),
    );
    expect(cfg.kind).toBe('enabled');
    if (cfg.kind !== 'enabled') return;
    expect(cfg.baseUrl).toBe('http://127.0.0.1:49222');
  });

  test('accepts https URLs', () => {
    const cfg = withEnv(
      { PENUMBRA_DAEMON_URL: 'https://penumbra.example.com', PENUMBRA_DAEMON_TOKEN: 'tk' },
      () => loadConfig(),
    );
    expect(cfg.kind).toBe('enabled');
  });

  test('returns disabled when PENUMBRA_DAEMON_URL is missing', () => {
    const cfg = withEnv(
      { PENUMBRA_DAEMON_URL: undefined, PENUMBRA_DAEMON_TOKEN: 'tk' },
      () => loadConfig(),
    );
    expect(cfg.kind).toBe('disabled');
    if (cfg.kind !== 'disabled') return;
    expect(cfg.reason).toMatch(/PENUMBRA_DAEMON_URL/);
  });

  test('returns disabled when PENUMBRA_DAEMON_TOKEN is missing', () => {
    const cfg = withEnv(
      { PENUMBRA_DAEMON_URL: 'http://127.0.0.1:49222', PENUMBRA_DAEMON_TOKEN: undefined },
      () => loadConfig(),
    );
    expect(cfg.kind).toBe('disabled');
    if (cfg.kind !== 'disabled') return;
    expect(cfg.reason).toMatch(/PENUMBRA_DAEMON_TOKEN/);
  });

  test('returns disabled when PENUMBRA_DAEMON_URL is unparseable', () => {
    const cfg = withEnv(
      { PENUMBRA_DAEMON_URL: 'not-a-url', PENUMBRA_DAEMON_TOKEN: 'tk' },
      () => loadConfig(),
    );
    expect(cfg.kind).toBe('disabled');
  });

  test('returns disabled when protocol is not http or https', () => {
    const cfg = withEnv(
      { PENUMBRA_DAEMON_URL: 'ftp://host', PENUMBRA_DAEMON_TOKEN: 'tk' },
      () => loadConfig(),
    );
    expect(cfg.kind).toBe('disabled');
  });

  test('returns disabled when token is empty string', () => {
    const cfg = withEnv(
      { PENUMBRA_DAEMON_URL: 'http://x', PENUMBRA_DAEMON_TOKEN: '' },
      () => loadConfig(),
    );
    expect(cfg.kind).toBe('disabled');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/integrations/sirius-middleware/test/config.test.ts
```

Expected: FAIL with module-not-found (`'../src/config.js'`).

- [ ] **Step 3: Write the minimal implementation**

Create `packages/integrations/sirius-middleware/src/config.ts`:
```typescript
import { hostname } from 'node:os';

export type MiddlewareConfig =
  | { kind: 'enabled'; baseUrl: string; token: string; machineId: string }
  | { kind: 'disabled'; reason: string };

export function loadConfig(): MiddlewareConfig {
  const rawUrl = process.env.PENUMBRA_DAEMON_URL;
  const rawToken = process.env.PENUMBRA_DAEMON_TOKEN;

  if (!rawUrl) {
    return { kind: 'disabled', reason: 'PENUMBRA_DAEMON_URL is not set' };
  }
  if (!rawToken) {
    return { kind: 'disabled', reason: 'PENUMBRA_DAEMON_TOKEN is not set' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { kind: 'disabled', reason: `PENUMBRA_DAEMON_URL is not a valid URL: ${rawUrl}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'disabled', reason: `PENUMBRA_DAEMON_URL must be http or https (got ${parsed.protocol})` };
  }

  const baseUrl = rawUrl.replace(/\/$/, '');
  const machineId = hostname() || 'unknown-host';
  return { kind: 'enabled', baseUrl, token: rawToken, machineId };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test packages/integrations/sirius-middleware/test/config.test.ts
```

Expected: 8 pass / 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/integrations/sirius-middleware/src/config.ts packages/integrations/sirius-middleware/test/config.test.ts
git commit -m "feat(sirius-middleware): config loader (env-driven, hostname machine_id)"
```

---

### Task 3: Daemon HTTP client

**Files:**
- Create: `packages/integrations/sirius-middleware/src/daemon-client.ts`
- Create: `packages/integrations/sirius-middleware/test/daemon-client.test.ts`

Mirrors `packages/mcp/src/daemon-client.ts`'s shape but only exposes `observe(event)` (this package never recalls or ends sessions). Adds an explicit 2s timeout via `AbortController`. Throws on non-2xx; the caller decides whether to log.

- [ ] **Step 1: Write the failing test file**

Create `packages/integrations/sirius-middleware/test/daemon-client.test.ts`:
```typescript
import { expect, test } from 'bun:test';
import { PenumbraDaemonClient } from '../src/daemon-client.js';
import type { T0EventInput } from '@penumbra/core';

const baseEvent: T0EventInput = {
  ts: '2026-04-25T12:00:00Z',
  source: 'sirius-middleware',
  source_detail: '/v1/chat/completions',
  project_id: 'proj-test',
  user_id: 'u',
  machine_id: 'm',
  session_id: 's',
  event_type: 'agent-prompt',
  lane: 'unknown',
  payload_json: { foo: 'bar' },
};

test('observe POSTs to /observations with bearer token and JSON body', async () => {
  let captured: { method: string; path: string; headers: Headers; body: unknown } | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      captured = {
        method: req.method,
        path: new URL(req.url).pathname,
        headers: req.headers,
        body: await req.json(),
      };
      return Response.json({ event_id: 'e-1' });
    },
  });
  try {
    const c = new PenumbraDaemonClient({ baseUrl: `http://localhost:${server.port}`, token: 'tk-1' });
    await c.observe(baseEvent);
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe('POST');
    expect(captured!.path).toBe('/observations');
    expect(captured!.headers.get('authorization')).toBe('Bearer tk-1');
    expect(captured!.headers.get('content-type')).toBe('application/json');
    expect(captured!.body).toMatchObject({ source: 'sirius-middleware', event_type: 'agent-prompt' });
  } finally { server.stop(true); }
});

test('observe throws on 4xx with status in error message', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response('{"error":"bad shape"}', { status: 400, headers: { 'content-type': 'application/json' } }),
  });
  try {
    const c = new PenumbraDaemonClient({ baseUrl: `http://localhost:${server.port}`, token: 'tk' });
    await expect(c.observe(baseEvent)).rejects.toThrow(/HTTP 400/);
  } finally { server.stop(true); }
});

test('observe throws on 5xx', async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response('boom', { status: 500 }) });
  try {
    const c = new PenumbraDaemonClient({ baseUrl: `http://localhost:${server.port}`, token: 'tk' });
    await expect(c.observe(baseEvent)).rejects.toThrow(/HTTP 500/);
  } finally { server.stop(true); }
});

test('observe throws on network error', async () => {
  const c = new PenumbraDaemonClient({ baseUrl: 'http://127.0.0.1:1', token: 'tk' });
  await expect(c.observe(baseEvent)).rejects.toThrow();
});

test('observe aborts after the configured timeout', async () => {
  // Server that never responds.
  const server = Bun.serve({
    port: 0,
    fetch: () => new Promise<Response>(() => { /* never resolves */ }),
  });
  try {
    const c = new PenumbraDaemonClient({ baseUrl: `http://localhost:${server.port}`, token: 'tk', timeoutMs: 50 });
    await expect(c.observe(baseEvent)).rejects.toThrow(/abort|timeout/i);
  } finally { server.stop(true); }
});

test('observe strips trailing slash from baseUrl', async () => {
  let path: string | null = null;
  const server = Bun.serve({
    port: 0,
    fetch(req) { path = new URL(req.url).pathname; return Response.json({ event_id: 'x' }); },
  });
  try {
    const c = new PenumbraDaemonClient({ baseUrl: `http://localhost:${server.port}/`, token: 'tk' });
    await c.observe(baseEvent);
    expect(path).toBe('/observations');
  } finally { server.stop(true); }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/integrations/sirius-middleware/test/daemon-client.test.ts
```

Expected: FAIL with module-not-found (`'../src/daemon-client.js'`).

- [ ] **Step 3: Write the minimal implementation**

Create `packages/integrations/sirius-middleware/src/daemon-client.ts`:
```typescript
import type { T0EventInput } from '@penumbra/core';

export interface PenumbraDaemonClientOpts {
  baseUrl: string;
  token: string;
  /** Per-request timeout in milliseconds. Defaults to 2000. */
  timeoutMs?: number;
}

export class PenumbraDaemonClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(opts: PenumbraDaemonClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 2000;
  }

  async observe(event: T0EventInput): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/observations`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`penumbra daemon /observations: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test packages/integrations/sirius-middleware/test/daemon-client.test.ts
```

Expected: 6 pass / 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/integrations/sirius-middleware/src/daemon-client.ts packages/integrations/sirius-middleware/test/daemon-client.test.ts
git commit -m "feat(sirius-middleware): PenumbraDaemonClient with bearer auth + 2s timeout"
```

---

## Sprint B — Observation builder + interceptor (Tasks 4–7)

### Task 4: Observation builder (pure functions)

**Files:**
- Create: `packages/integrations/sirius-middleware/src/observation-builder.ts`
- Create: `packages/integrations/sirius-middleware/test/observation-builder.test.ts`

Two pure functions — `buildPromptEvent` and `buildResponseEvent` — plus a helper `extractUserMessageText`. Pure functions are unit-tested without NestJS plumbing.

- [ ] **Step 1: Write the failing test file**

Create `packages/integrations/sirius-middleware/test/observation-builder.test.ts`:
```typescript
import { expect, test, describe } from 'bun:test';
import {
  buildPromptEvent,
  buildResponseEvent,
  extractUserMessageText,
} from '../src/observation-builder.js';

const baseInput = {
  projectId: 'proj-1',
  userId: 'u-1',
  machineId: 'host-1',
  requestId: 'req-1',
  model: 'gpt-4o-mini',
  messages: [
    { role: 'system', content: 'be helpful' },
    { role: 'user', content: 'hi' },
  ],
  captureStartTs: 1_777_000_000_000, // ms
} as const;

describe('buildPromptEvent', () => {
  test('produces a T0EventInput with agent-prompt event_type and the request shape', () => {
    const ev = buildPromptEvent(baseInput);
    expect(ev.source).toBe('sirius-middleware');
    expect(ev.source_detail).toBe('/v1/chat/completions');
    expect(ev.project_id).toBe('proj-1');
    expect(ev.user_id).toBe('u-1');
    expect(ev.machine_id).toBe('host-1');
    expect(ev.session_id).toBe('req-1');
    expect(ev.request_id).toBe('req-1');
    expect(ev.event_type).toBe('agent-prompt');
    expect(ev.lane).toBe('unknown');
    expect(ev.provider).toBeNull();
    expect(ev.model).toBe('gpt-4o-mini');
    expect(ev.tokens_in).toBeNull();
    expect(ev.tokens_out).toBeNull();
    expect(ev.cost_usd).toBeNull();
    expect(ev.latency_ms).toBeNull();
    expect(ev.payload_json).toEqual({ messages: baseInput.messages });
    expect(ev.payload_summary).toBe('hi');
    expect(ev.ts).toBe(new Date(1_777_000_000_000).toISOString());
  });
});

describe('buildResponseEvent', () => {
  test('with usage block populates tokens and uses response.model + provider', () => {
    const ev = buildResponseEvent({
      ...baseInput,
      assistantText: 'hello back',
      response: {
        model: 'gpt-4o-mini-2024-07-18',
        provider: 'openai',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello back' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      completionTs: 1_777_000_000_500,
    });
    expect(ev.event_type).toBe('agent-response');
    expect(ev.session_id).toBe('req-1');
    expect(ev.request_id).toBe('req-1');
    expect(ev.provider).toBe('openai');
    expect(ev.model).toBe('gpt-4o-mini-2024-07-18');
    expect(ev.tokens_in).toBe(10);
    expect(ev.tokens_out).toBe(5);
    expect(ev.latency_ms).toBe(500);
    expect(ev.payload_summary).toBe('hello back');
    expect(ev.payload_json).toEqual({
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello back' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });

  test('without usage falls back to nulls and uses request.model when response.model is missing', () => {
    const ev = buildResponseEvent({
      ...baseInput,
      assistantText: 'ok',
      response: { choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] },
      completionTs: 1_777_000_000_100,
    });
    expect(ev.tokens_in).toBeNull();
    expect(ev.tokens_out).toBeNull();
    expect(ev.provider).toBeNull();
    expect(ev.model).toBe('gpt-4o-mini'); // from request
  });

  test('latency_ms is computed as completionTs - captureStartTs', () => {
    const ev = buildResponseEvent({
      ...baseInput,
      assistantText: 'x',
      response: { choices: [] },
      completionTs: 1_777_000_001_234,
    });
    expect(ev.latency_ms).toBe(1234);
  });
});

describe('extractUserMessageText', () => {
  test('returns the content string of the last user message', () => {
    expect(
      extractUserMessageText([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'second' },
      ]),
    ).toBe('second');
  });

  test('returns empty string when no user message present', () => {
    expect(extractUserMessageText([{ role: 'system', content: 's' }])).toBe('');
  });

  test('joins multi-part content text segments with single space, replacing non-text', () => {
    expect(
      extractUserMessageText([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image_url', image_url: { url: 'data:...' } },
            { type: 'text', text: 'and this' },
          ],
        },
      ]),
    ).toBe('look at this [image] and this');
  });

  test('returns empty string for messages with no extractable text', () => {
    expect(
      extractUserMessageText([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }]),
    ).toBe('[image]');
  });

  test('handles missing content gracefully', () => {
    expect(extractUserMessageText([{ role: 'user' }])).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/integrations/sirius-middleware/test/observation-builder.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Write the implementation**

Create `packages/integrations/sirius-middleware/src/observation-builder.ts`:
```typescript
import type { T0EventInput } from '@penumbra/core';

export interface ChatMessage {
  role: string;
  content?: string | ChatMessageContentPart[];
}

export type ChatMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: unknown }
  | { type: string; [k: string]: unknown };

export interface ChatResponseLike {
  model?: string;
  provider?: string;
  choices?: unknown[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface BuildPromptInput {
  projectId: string;
  userId: string;
  machineId: string;
  requestId: string;
  model: string;
  messages: ChatMessage[];
  captureStartTs: number;
}

export interface BuildResponseInput extends BuildPromptInput {
  assistantText: string;
  response: ChatResponseLike;
  completionTs: number;
}

const ROUTE = '/v1/chat/completions';

export function buildPromptEvent(input: BuildPromptInput): T0EventInput {
  return {
    ts: new Date(input.captureStartTs).toISOString(),
    source: 'sirius-middleware',
    source_detail: ROUTE,
    project_id: input.projectId,
    user_id: input.userId,
    machine_id: input.machineId,
    session_id: input.requestId,
    event_type: 'agent-prompt',
    lane: 'unknown',
    provider: null,
    model: input.model,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: input.requestId,
    payload_json: { messages: input.messages },
    payload_summary: extractUserMessageText(input.messages),
  };
}

export function buildResponseEvent(input: BuildResponseInput): T0EventInput {
  const usage = input.response.usage ?? {};
  return {
    ts: new Date(input.completionTs).toISOString(),
    source: 'sirius-middleware',
    source_detail: ROUTE,
    project_id: input.projectId,
    user_id: input.userId,
    machine_id: input.machineId,
    session_id: input.requestId,
    event_type: 'agent-response',
    lane: 'unknown',
    provider: input.response.provider ?? null,
    model: input.response.model ?? input.model,
    tokens_in: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null,
    tokens_out: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null,
    cost_usd: null,
    latency_ms: input.completionTs - input.captureStartTs,
    request_id: input.requestId,
    payload_json: {
      choices: input.response.choices ?? [],
      ...(input.response.usage ? { usage: input.response.usage } : {}),
    },
    payload_summary: input.assistantText,
  };
}

export function extractUserMessageText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const parts: string[] = [];
      for (const part of c) {
        if (part && typeof part === 'object') {
          if (part.type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
            parts.push((part as { text: string }).text);
          } else if (part.type === 'image_url') {
            parts.push('[image]');
          } else {
            parts.push('[binary]');
          }
        }
      }
      return parts.join(' ');
    }
    return '';
  }
  return '';
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test packages/integrations/sirius-middleware/test/observation-builder.test.ts
```

Expected: 9 pass / 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/integrations/sirius-middleware/src/observation-builder.ts packages/integrations/sirius-middleware/test/observation-builder.test.ts
git commit -m "feat(sirius-middleware): observation builders for agent-prompt/agent-response events"
```

---

### Task 5: Interceptor (non-streamed path)

**Files:**
- Create: `packages/integrations/sirius-middleware/src/interceptor.ts`
- Create: `packages/integrations/sirius-middleware/src/tokens.ts`
- Create: `packages/integrations/sirius-middleware/test/interceptor-non-streamed.test.ts`

The interceptor is a NestJS `NestInterceptor`. It depends on the config and the daemon client via DI. This task implements the **non-streamed** path; streamed responses come in Task 6.

- [ ] **Step 1: Add NestJS DI tokens (one-line file for clean injection)**

Create `packages/integrations/sirius-middleware/src/tokens.ts`:
```typescript
export const PENUMBRA_CONFIG = Symbol('PENUMBRA_CONFIG');
export const PENUMBRA_DAEMON_CLIENT = Symbol('PENUMBRA_DAEMON_CLIENT');
```

- [ ] **Step 2: Write the failing test for the non-streamed path**

Create `packages/integrations/sirius-middleware/test/interceptor-non-streamed.test.ts`:
```typescript
import { expect, test, describe, beforeEach } from 'bun:test';
import { Test } from '@nestjs/testing';
import { Controller, Post, Body, Headers, Module } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PenumbraObserveInterceptor } from '../src/interceptor.js';
import { PENUMBRA_CONFIG, PENUMBRA_DAEMON_CLIENT } from '../src/tokens.js';
import type { T0EventInput } from '@penumbra/core';

interface CapturedCall { event: T0EventInput }
function makeFakeClient(): { observed: CapturedCall[]; reject: boolean; client: { observe: (e: T0EventInput) => Promise<void> } } {
  const state = { observed: [] as CapturedCall[], reject: false };
  const client = {
    async observe(event: T0EventInput) {
      if (state.reject) throw new Error('fake daemon down');
      state.observed.push({ event });
    },
  };
  return { ...state, client, get observed() { return state.observed; }, set reject(v: boolean) { state.reject = v; } } as unknown as {
    observed: CapturedCall[]; reject: boolean; client: { observe: (e: T0EventInput) => Promise<void> };
  };
}

@Controller()
class FakeController {
  @Post('v1/chat/completions')
  chat(@Body() body: unknown, @Headers() headers: Record<string, string>): unknown {
    void headers; void body;
    return {
      model: 'gpt-4o-mini',
      provider: 'openai',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi back' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    };
  }

  @Post('v1/embeddings')
  embed(): unknown {
    return { data: [] };
  }

  @Post('health')
  health(): { ok: true } {
    return { ok: true };
  }
}

async function buildApp(opts: { configEnabled: boolean; client: { observe: (e: T0EventInput) => Promise<void> } }) {
  @Module({
    controllers: [FakeController],
    providers: [
      {
        provide: PENUMBRA_CONFIG,
        useValue: opts.configEnabled
          ? { kind: 'enabled', baseUrl: 'http://x', token: 'tk', machineId: 'host-1' }
          : { kind: 'disabled', reason: 'test' },
      },
      { provide: PENUMBRA_DAEMON_CLIENT, useValue: opts.client },
      { provide: APP_INTERCEPTOR, useClass: PenumbraObserveInterceptor },
    ],
  })
  class TestAppModule {}

  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

async function flushMicrotasks(): Promise<void> {
  // Two ticks: outer queueMicrotask schedules the POST; inner one resolves it.
  await new Promise<void>((r) => queueMicrotask(r));
  await new Promise<void>((r) => setTimeout(r, 0));
}

describe('PenumbraObserveInterceptor (non-streamed)', () => {
  test('header missing → no observe call', async () => {
    const fc = makeFakeClient();
    const app = await buildApp({ configEnabled: true, client: fc.client });
    try {
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'POST', url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        payload: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.statusCode).toBe(201);
      await flushMicrotasks();
      expect(fc.observed).toHaveLength(0);
    } finally { await app.close(); }
  });

  test('embeddings route + header → no observe call (loop guard)', async () => {
    const fc = makeFakeClient();
    const app = await buildApp({ configEnabled: true, client: fc.client });
    try {
      await app.getHttpAdapter().getInstance().inject({
        method: 'POST', url: '/v1/embeddings',
        headers: { 'content-type': 'application/json', 'x-penumbra-project': 'p1' },
        payload: { input: 'x' },
      });
      await flushMicrotasks();
      expect(fc.observed).toHaveLength(0);
    } finally { await app.close(); }
  });

  test('non-chat route + header → no observe call', async () => {
    const fc = makeFakeClient();
    const app = await buildApp({ configEnabled: true, client: fc.client });
    try {
      await app.getHttpAdapter().getInstance().inject({
        method: 'POST', url: '/health',
        headers: { 'content-type': 'application/json', 'x-penumbra-project': 'p1' },
        payload: {},
      });
      await flushMicrotasks();
      expect(fc.observed).toHaveLength(0);
    } finally { await app.close(); }
  });

  test('chat + header → exactly two observe calls (prompt + response) sharing session_id', async () => {
    const fc = makeFakeClient();
    const app = await buildApp({ configEnabled: true, client: fc.client });
    try {
      await app.getHttpAdapter().getInstance().inject({
        method: 'POST', url: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          'x-penumbra-project': 'proj-1',
          'x-penumbra-user': 'alice',
          'x-request-id': 'req-abc',
        },
        payload: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      });
      await flushMicrotasks();
      expect(fc.observed).toHaveLength(2);
      const [first, second] = fc.observed;
      expect(first!.event.event_type).toBe('agent-prompt');
      expect(second!.event.event_type).toBe('agent-response');
      expect(first!.event.session_id).toBe('req-abc');
      expect(second!.event.session_id).toBe('req-abc');
      expect(first!.event.user_id).toBe('alice');
      expect(second!.event.tokens_in).toBe(3);
      expect(second!.event.tokens_out).toBe(2);
      expect(second!.event.payload_summary).toBe('hi back');
    } finally { await app.close(); }
  });

  test('user header missing → user_id falls back to "anonymous"', async () => {
    const fc = makeFakeClient();
    const app = await buildApp({ configEnabled: true, client: fc.client });
    try {
      await app.getHttpAdapter().getInstance().inject({
        method: 'POST', url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'x-penumbra-project': 'p' },
        payload: { model: 'm', messages: [{ role: 'user', content: 'q' }] },
      });
      await flushMicrotasks();
      expect(fc.observed[0]!.event.user_id).toBe('anonymous');
      expect(fc.observed[1]!.event.user_id).toBe('anonymous');
    } finally { await app.close(); }
  });

  test('request-id header missing → generated UUID is shared across both events', async () => {
    const fc = makeFakeClient();
    const app = await buildApp({ configEnabled: true, client: fc.client });
    try {
      await app.getHttpAdapter().getInstance().inject({
        method: 'POST', url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'x-penumbra-project': 'p' },
        payload: { model: 'm', messages: [{ role: 'user', content: 'q' }] },
      });
      await flushMicrotasks();
      expect(fc.observed).toHaveLength(2);
      expect(fc.observed[0]!.event.session_id).toEqual(fc.observed[1]!.event.session_id);
      expect(fc.observed[0]!.event.session_id).toMatch(/^[0-9a-f-]{36}$/);
    } finally { await app.close(); }
  });

  test('config disabled → no observe call ever', async () => {
    const fc = makeFakeClient();
    const app = await buildApp({ configEnabled: false, client: fc.client });
    try {
      await app.getHttpAdapter().getInstance().inject({
        method: 'POST', url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'x-penumbra-project': 'p' },
        payload: { model: 'm', messages: [{ role: 'user', content: 'q' }] },
      });
      await flushMicrotasks();
      expect(fc.observed).toHaveLength(0);
    } finally { await app.close(); }
  });

  test('daemon client rejects → caller still gets the response, no exception bubbles', async () => {
    const fc = makeFakeClient();
    fc.reject = true;
    const app = await buildApp({ configEnabled: true, client: fc.client });
    try {
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'POST', url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'x-penumbra-project': 'p' },
        payload: { model: 'm', messages: [{ role: 'user', content: 'q' }] },
      });
      expect(res.statusCode).toBe(201);
      await flushMicrotasks();
      // Failures are silent — we only assert the response wasn't broken.
    } finally { await app.close(); }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
bun test packages/integrations/sirius-middleware/test/interceptor-non-streamed.test.ts
```

Expected: FAIL with module-not-found (`'../src/interceptor.js'`).

- [ ] **Step 4: Write the interceptor implementation (non-streamed path)**

Create `packages/integrations/sirius-middleware/src/interceptor.ts`:
```typescript
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { PENUMBRA_CONFIG, PENUMBRA_DAEMON_CLIENT } from './tokens.js';
import type { MiddlewareConfig } from './config.js';
import type { PenumbraDaemonClient } from './daemon-client.js';
import {
  buildPromptEvent,
  buildResponseEvent,
  type ChatMessage,
  type ChatResponseLike,
} from './observation-builder.js';

const CHAT_PATH = '/v1/chat/completions';
const EMBED_PREFIX = '/v1/embeddings';

@Injectable()
export class PenumbraObserveInterceptor implements NestInterceptor {
  private readonly logger = new Logger('PenumbraObserveInterceptor');

  constructor(
    @Inject(PENUMBRA_CONFIG) private readonly config: MiddlewareConfig,
    @Inject(PENUMBRA_DAEMON_CLIENT) private readonly daemon: PenumbraDaemonClient,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.config.kind !== 'enabled') return next.handle();

    const httpCtx = context.switchToHttp();
    const req = httpCtx.getRequest<{
      method?: string;
      url?: string;
      originalUrl?: string;
      headers: Record<string, string | string[] | undefined>;
      body?: unknown;
    }>();

    const projectHeader = headerValue(req.headers, 'x-penumbra-project');
    if (!projectHeader) return next.handle();

    const path = normalizePath(req.url ?? req.originalUrl ?? '');
    if (path.startsWith(EMBED_PREFIX)) return next.handle();
    if (path !== CHAT_PATH || (req.method ?? '').toUpperCase() !== 'POST') return next.handle();

    const body = (req.body ?? {}) as { model?: string; messages?: ChatMessage[] };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const requestId = headerValue(req.headers, 'x-request-id') ?? crypto.randomUUID();
    const userId = headerValue(req.headers, 'x-penumbra-user') ?? 'anonymous';
    const captureStartTs = Date.now();

    const promptInput = {
      projectId: projectHeader,
      userId,
      machineId: this.config.machineId,
      requestId,
      model: typeof body.model === 'string' ? body.model : 'unknown',
      messages,
      captureStartTs,
    };

    return next.handle().pipe(
      tap({
        next: (responseValue) => {
          const completionTs = Date.now();
          const response = (responseValue ?? {}) as ChatResponseLike;
          const assistantText = extractAssistantText(response);
          const promptEvent = buildPromptEvent(promptInput);
          const responseEvent = buildResponseEvent({
            ...promptInput,
            assistantText,
            response,
            completionTs,
          });
          this.fireAndForget(promptEvent.session_id ?? requestId, promptEvent, 'agent-prompt');
          this.fireAndForget(responseEvent.session_id ?? requestId, responseEvent, 'agent-response');
        },
      }),
    );
  }

  private fireAndForget(sessionId: string, event: import('@penumbra/core').T0EventInput, label: string): void {
    queueMicrotask(() => {
      this.daemon.observe(event).catch((err: unknown) => {
        this.logger.warn({
          msg: 'penumbra observe failed — dropping event',
          label,
          session_id: sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length > 0 ? t : null;
  }
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') {
    const t = v[0].trim();
    return t.length > 0 ? t : null;
  }
  return null;
}

function normalizePath(url: string): string {
  try {
    return new URL(url, 'http://x').pathname.replace(/\/+$/, '') || '/';
  } catch {
    const q = url.indexOf('?');
    return (q === -1 ? url : url.slice(0, q)).replace(/\/+$/, '') || '/';
  }
}

function extractAssistantText(response: ChatResponseLike): string {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  if (first && first.message && typeof first.message.content === 'string') {
    return first.message.content;
  }
  return '';
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
bun test packages/integrations/sirius-middleware/test/interceptor-non-streamed.test.ts
```

Expected: 8 pass / 0 fail.

If the test runner can't resolve `@nestjs/testing` or `@nestjs/core` types, run `bun install` first to fetch the dev deps declared in Task 1.

- [ ] **Step 6: Commit**

```bash
git add packages/integrations/sirius-middleware/src/interceptor.ts \
        packages/integrations/sirius-middleware/src/tokens.ts \
        packages/integrations/sirius-middleware/test/interceptor-non-streamed.test.ts
git commit -m "feat(sirius-middleware): PenumbraObserveInterceptor non-streamed path"
```

---

### Task 6: Interceptor — streamed-response path

**Files:**
- Modify: `packages/integrations/sirius-middleware/src/interceptor.ts`
- Create: `packages/integrations/sirius-middleware/test/interceptor-streamed.test.ts`

NestJS handlers can return either a plain object (non-streamed, what Task 5 covers) or a `ReadableStream` / Node `Readable` (streamed, used for SSE chat completions). When the response is a stream, the `tap.next` from Task 5 fires once with the stream object, before any tokens have flowed. We need to read the stream to its end, accumulate the assistant text, and only then fire the observations.

Strategy: detect a stream-like value in `tap.next`. If detected, **don't** fire observations there. Instead, replace the emitted value with a wrapped stream that records bytes as they pass through, and fire the two observations on stream completion.

This task assumes the stream produces standard OpenAI-compat SSE chunks (`data: {"choices":[{"delta":{"content":"..."}}]}`). The interceptor doesn't need to be perfect — for this V1, we accumulate text from `delta.content` fields if we can find them; otherwise we fall back to an empty string.

- [ ] **Step 1: Write the failing streamed-response test**

Create `packages/integrations/sirius-middleware/test/interceptor-streamed.test.ts`:
```typescript
import { expect, test, describe } from 'bun:test';
import { Test } from '@nestjs/testing';
import { Controller, Post, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PenumbraObserveInterceptor } from '../src/interceptor.js';
import { PENUMBRA_CONFIG, PENUMBRA_DAEMON_CLIENT } from '../src/tokens.js';
import type { T0EventInput } from '@penumbra/core';

interface CapturedCall { event: T0EventInput }

function makeFakeClient(): {
  observed: CapturedCall[];
  client: { observe: (e: T0EventInput) => Promise<void> };
} {
  const observed: CapturedCall[] = [];
  return {
    observed,
    client: { async observe(event: T0EventInput) { observed.push({ event }); } },
  };
}

@Controller()
class StreamingController {
  @Post('v1/chat/completions')
  chat(): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(enc.encode('data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n'));
        ctrl.enqueue(enc.encode('data: {"choices":[{"index":0,"delta":{"content":" world"}}]}\n\n'));
        ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
        ctrl.close();
      },
    });
  }
}

async function buildApp(client: { observe: (e: T0EventInput) => Promise<void> }) {
  @Module({
    controllers: [StreamingController],
    providers: [
      {
        provide: PENUMBRA_CONFIG,
        useValue: { kind: 'enabled', baseUrl: 'http://x', token: 'tk', machineId: 'host-1' },
      },
      { provide: PENUMBRA_DAEMON_CLIENT, useValue: client },
      { provide: APP_INTERCEPTOR, useClass: PenumbraObserveInterceptor },
    ],
  })
  class TestAppModule {}

  const m = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
  const app = m.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((r) => queueMicrotask(r));
  await new Promise<void>((r) => setTimeout(r, 10));
}

describe('PenumbraObserveInterceptor (streamed)', () => {
  test('streamed response → observations fire after stream end with concatenated text', async () => {
    const fc = makeFakeClient();
    const app = await buildApp(fc.client);
    try {
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'POST', url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'x-penumbra-project': 'p1' },
        payload: { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true },
      });
      expect(res.statusCode).toBe(201);
      await flushMicrotasks();
      expect(fc.observed).toHaveLength(2);
      const responseEvent = fc.observed.find((c) => c.event.event_type === 'agent-response');
      expect(responseEvent).toBeDefined();
      expect(responseEvent!.event.payload_summary).toBe('hello world');
    } finally { await app.close(); }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/integrations/sirius-middleware/test/interceptor-streamed.test.ts
```

Expected: FAIL — current interceptor sees the stream as a plain object and fires observations with empty `payload_summary`.

- [ ] **Step 3: Modify the interceptor to detect and accumulate stream responses**

Edit `packages/integrations/sirius-middleware/src/interceptor.ts`. Replace the existing `intercept` method's `next.handle().pipe(...)` block with a stream-aware version, and add the helpers below the existing `extractAssistantText` function:

```typescript
    return next.handle().pipe(
      mergeMap(async (responseValue) => {
        if (isReadableStream(responseValue)) {
          const { teedForResponse, accumulationDone } = teeAndAccumulate(responseValue);
          accumulationDone.then((accumulatedText) => {
            const completionTs = Date.now();
            const promptEvent = buildPromptEvent(promptInput);
            const responseEvent = buildResponseEvent({
              ...promptInput,
              assistantText: accumulatedText,
              response: { choices: [], model: promptInput.model },
              completionTs,
            });
            this.fireAndForget(promptEvent.session_id ?? requestId, promptEvent, 'agent-prompt');
            this.fireAndForget(responseEvent.session_id ?? requestId, responseEvent, 'agent-response');
          }).catch((err: unknown) => {
            this.logger.warn({
              msg: 'penumbra stream accumulation failed',
              error: err instanceof Error ? err.message : String(err),
            });
          });
          return teedForResponse;
        }

        const completionTs = Date.now();
        const response = (responseValue ?? {}) as ChatResponseLike;
        const assistantText = extractAssistantText(response);
        const promptEvent = buildPromptEvent(promptInput);
        const responseEvent = buildResponseEvent({
          ...promptInput,
          assistantText,
          response,
          completionTs,
        });
        this.fireAndForget(promptEvent.session_id ?? requestId, promptEvent, 'agent-prompt');
        this.fireAndForget(responseEvent.session_id ?? requestId, responseEvent, 'agent-response');
        return responseValue;
      }),
    );
```

Replace the existing `tap` import with `mergeMap` (also imported from `'rxjs/operators'`):
```typescript
import { mergeMap } from 'rxjs/operators';
```

(Remove the `tap` import since it's no longer used.)

Add these helpers at the bottom of the file:
```typescript
function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    value instanceof ReadableStream ||
    (typeof value === 'object' && value !== null && typeof (value as ReadableStream).getReader === 'function' &&
      typeof (value as ReadableStream).tee === 'function')
  );
}

function teeAndAccumulate(stream: ReadableStream<Uint8Array>): {
  teedForResponse: ReadableStream<Uint8Array>;
  accumulationDone: Promise<string>;
} {
  const [forResponse, forAccumulation] = stream.tee();
  const accumulationDone = (async () => {
    const reader = forAccumulation.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let assistantText = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice('data:'.length).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload) as { choices?: { delta?: { content?: unknown } }[] };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === 'string') assistantText += delta;
          } catch { /* skip malformed chunk */ }
        }
      }
    } finally {
      reader.releaseLock();
    }
    return assistantText;
  })();
  return { teedForResponse: forResponse, accumulationDone };
}
```

- [ ] **Step 4: Run the streamed test to verify it passes**

```bash
bun test packages/integrations/sirius-middleware/test/interceptor-streamed.test.ts
```

Expected: 1 pass / 0 fail.

- [ ] **Step 5: Re-run the non-streamed test to verify no regression**

```bash
bun test packages/integrations/sirius-middleware/test/interceptor-non-streamed.test.ts
```

Expected: 8 pass / 0 fail.

- [ ] **Step 6: Commit**

```bash
git add packages/integrations/sirius-middleware/src/interceptor.ts \
        packages/integrations/sirius-middleware/test/interceptor-streamed.test.ts
git commit -m "feat(sirius-middleware): streamed-response support via stream tee + SSE delta accumulation"
```

---

### Task 7: Module wiring + public exports

**Files:**
- Create: `packages/integrations/sirius-middleware/src/module.ts`
- Modify: `packages/integrations/sirius-middleware/src/index.ts`
- Create: `packages/integrations/sirius-middleware/test/module.test.ts`

The NestJS module ties everything together: it loads config at instantiation, builds the daemon client (or a no-op stand-in if disabled), registers the interceptor as `APP_INTERCEPTOR`, and logs once if disabled.

- [ ] **Step 1: Write the failing module test**

Create `packages/integrations/sirius-middleware/test/module.test.ts`:
```typescript
import { expect, test, describe } from 'bun:test';
import { Test } from '@nestjs/testing';
import { PenumbraMiddlewareModule } from '../src/module.js';
import { PENUMBRA_CONFIG, PENUMBRA_DAEMON_CLIENT } from '../src/tokens.js';
import type { MiddlewareConfig } from '../src/config.js';
import type { PenumbraDaemonClient } from '../src/daemon-client.js';

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return fn().finally(() => {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

describe('PenumbraMiddlewareModule', () => {
  test('compiles when env vars are set; provides enabled config and a real client', async () => {
    await withEnv(
      { PENUMBRA_DAEMON_URL: 'http://127.0.0.1:9999', PENUMBRA_DAEMON_TOKEN: 'tk-7' },
      async () => {
        const m = await Test.createTestingModule({ imports: [PenumbraMiddlewareModule] }).compile();
        const cfg = m.get<MiddlewareConfig>(PENUMBRA_CONFIG);
        const client = m.get<PenumbraDaemonClient>(PENUMBRA_DAEMON_CLIENT);
        expect(cfg.kind).toBe('enabled');
        expect(client).toBeDefined();
        expect(typeof client.observe).toBe('function');
        await m.close();
      },
    );
  });

  test('compiles when env vars are missing; provides disabled config and a stub client', async () => {
    await withEnv(
      { PENUMBRA_DAEMON_URL: undefined, PENUMBRA_DAEMON_TOKEN: undefined },
      async () => {
        const m = await Test.createTestingModule({ imports: [PenumbraMiddlewareModule] }).compile();
        const cfg = m.get<MiddlewareConfig>(PENUMBRA_CONFIG);
        const client = m.get<PenumbraDaemonClient>(PENUMBRA_DAEMON_CLIENT);
        expect(cfg.kind).toBe('disabled');
        // The disabled-state stub is callable but a no-op.
        await expect(client.observe({} as never)).resolves.toBeUndefined();
        await m.close();
      },
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test packages/integrations/sirius-middleware/test/module.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Write the module implementation**

Create `packages/integrations/sirius-middleware/src/module.ts`:
```typescript
import { Module, Logger } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PENUMBRA_CONFIG, PENUMBRA_DAEMON_CLIENT } from './tokens.js';
import { loadConfig, type MiddlewareConfig } from './config.js';
import { PenumbraDaemonClient } from './daemon-client.js';
import { PenumbraObserveInterceptor } from './interceptor.js';

const NOOP_CLIENT: PenumbraDaemonClient = {
  observe: async () => undefined,
} as unknown as PenumbraDaemonClient;

@Module({
  providers: [
    {
      provide: PENUMBRA_CONFIG,
      useFactory: (): MiddlewareConfig => {
        const cfg = loadConfig();
        const log = new Logger('PenumbraMiddlewareModule');
        if (cfg.kind === 'disabled') {
          log.warn({
            msg: 'penumbra middleware disabled — observations will not be emitted',
            reason: cfg.reason,
          });
        } else {
          log.log({
            msg: 'penumbra middleware enabled',
            baseUrl: cfg.baseUrl,
            machine_id: cfg.machineId,
          });
        }
        return cfg;
      },
    },
    {
      provide: PENUMBRA_DAEMON_CLIENT,
      inject: [PENUMBRA_CONFIG],
      useFactory: (cfg: MiddlewareConfig): PenumbraDaemonClient => {
        if (cfg.kind !== 'enabled') return NOOP_CLIENT;
        return new PenumbraDaemonClient({ baseUrl: cfg.baseUrl, token: cfg.token });
      },
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: PenumbraObserveInterceptor,
    },
  ],
})
export class PenumbraMiddlewareModule {}
```

- [ ] **Step 4: Update `src/index.ts` with the public exports**

```typescript
export { PenumbraMiddlewareModule } from './module.js';
export { PenumbraObserveInterceptor } from './interceptor.js';
export { PenumbraDaemonClient } from './daemon-client.js';
export type { PenumbraDaemonClientOpts } from './daemon-client.js';
export { loadConfig } from './config.js';
export type { MiddlewareConfig } from './config.js';
export { PENUMBRA_CONFIG, PENUMBRA_DAEMON_CLIENT } from './tokens.js';
```

- [ ] **Step 5: Run the module test to verify it passes**

```bash
bun test packages/integrations/sirius-middleware/test/module.test.ts
```

Expected: 2 pass / 0 fail.

- [ ] **Step 6: Run all package tests to verify nothing regressed**

```bash
bun test packages/integrations/sirius-middleware/
```

Expected: 34 pass / 0 fail (8 config + 6 daemon-client + 9 builder + 8 interceptor non-streamed + 1 streamed + 2 module — adjust if a previous task added/dropped a case).

- [ ] **Step 7: Verify the package typechecks**

```bash
bun run typecheck
```

Expected: zero errors across all packages.

- [ ] **Step 8: Commit**

```bash
git add packages/integrations/sirius-middleware/src/module.ts \
        packages/integrations/sirius-middleware/src/index.ts \
        packages/integrations/sirius-middleware/test/module.test.ts
git commit -m "feat(sirius-middleware): PenumbraMiddlewareModule wiring + public exports"
```

---

## Sprint C — Integration test (Task 8)

### Task 8: Gated integration test against a real penumbra daemon

**Files:**
- Create: `packages/integrations/sirius-middleware/test/integration.test.ts`

This test boots a real penumbra daemon via the existing `@penumbra/e2e` harness pattern, points the middleware at it via env vars, runs a fake NestJS chat endpoint with the middleware registered, and reads the resulting T0 rows directly from the daemon's SQLite file.

The test is gated by `PENUMBRA_E2E=1` (matches the existing convention in `packages/e2e/test/smoke/`).

- [ ] **Step 1: Add `@penumbra/e2e` as a devDependency of the package**

We need the helper exports for daemon spawning. Edit `packages/integrations/sirius-middleware/package.json`'s `devDependencies` to add:
```json
"@penumbra/e2e": "workspace:*"
```

Run:
```bash
bun install
```

Expected: lockfile updated, no errors.

- [ ] **Step 2: Export the helpers from `@penumbra/e2e`**

The smoke tests currently import from `'../helpers/spawn-bin.js'` (relative). For other packages to consume them, we need a stable export.

Inspect `packages/e2e/package.json` to confirm the `main`/exports field. If there's no `main`, add one and re-export the helpers.

Create `packages/e2e/src/index.ts` (or modify if it exists):
```typescript
export {
  spawnPenumbra,
  waitForPortFile,
  captureOutput,
  killGracefully,
  drainOutput,
  type BunSubprocess,
} from '../test/helpers/spawn-bin.js';
export { makeSandbox, type Sandbox } from '../test/helpers/sandbox.js';
```

Update `packages/e2e/package.json` to add `"main": "./src/index.ts"` if missing. (If the tsconfig include glob doesn't already cover `src/`, add it.)

Run:
```bash
bun run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Write the integration test (gated)**

Create `packages/integrations/sirius-middleware/test/integration.test.ts`:
```typescript
import { expect, test, describe, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { Controller, Post, Module } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  spawnPenumbra,
  waitForPortFile,
  captureOutput,
  killGracefully,
  drainOutput,
  type BunSubprocess,
  makeSandbox,
  type Sandbox,
} from '@penumbra/e2e';
import { PenumbraMiddlewareModule } from '../src/index.js';

const SHOULD_RUN = process.env.PENUMBRA_E2E === '1';
const describeIf = SHOULD_RUN ? describe : describe.skip;

@Controller()
class FakeChatController {
  @Post('v1/chat/completions')
  chat(): unknown {
    return {
      model: 'fake-model',
      provider: 'fake-provider',
      choices: [{ index: 0, message: { role: 'assistant', content: 'integration ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    };
  }
}

@Module({ controllers: [FakeChatController], imports: [PenumbraMiddlewareModule] })
class IntegrationAppModule {}

describeIf('sirius-middleware integration with real penumbra daemon', () => {
  let sb: Sandbox;
  let daemon: BunSubprocess | null = null;
  let prevEnv: { url?: string; token?: string };

  beforeEach(async () => {
    sb = makeSandbox();
    expect((await captureOutput(spawnPenumbra(['init'], sb.dir))).exitCode).toBe(0);
    daemon = spawnPenumbra(['start'], sb.dir);
    drainOutput(daemon);
    const port = await waitForPortFile(sb.dir, 5000);
    const token = readFileSync(join(sb.dir, 'token'), 'utf8').trim();
    prevEnv = { url: process.env.PENUMBRA_DAEMON_URL, token: process.env.PENUMBRA_DAEMON_TOKEN };
    process.env.PENUMBRA_DAEMON_URL = `http://127.0.0.1:${port}`;
    process.env.PENUMBRA_DAEMON_TOKEN = token;
  });

  afterEach(async () => {
    if (daemon) {
      await captureOutput(spawnPenumbra(['stop'], sb.dir));
      await killGracefully(daemon);
      daemon = null;
    }
    sb.cleanup();
    if (prevEnv.url === undefined) delete process.env.PENUMBRA_DAEMON_URL;
    else process.env.PENUMBRA_DAEMON_URL = prevEnv.url;
    if (prevEnv.token === undefined) delete process.env.PENUMBRA_DAEMON_TOKEN;
    else process.env.PENUMBRA_DAEMON_TOKEN = prevEnv.token;
  });

  test('one chat request produces two T0 rows in penumbra (agent-prompt + agent-response)', async () => {
    const m = await Test.createTestingModule({ imports: [IntegrationAppModule] }).compile();
    const app = m.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    try {
      const res = await app.getHttpAdapter().getInstance().inject({
        method: 'POST', url: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          'x-penumbra-project': 'integration-test',
          'x-penumbra-user': 'integration-user',
        },
        payload: { model: 'fake-model', messages: [{ role: 'user', content: 'integration probe' }] },
      });
      expect(res.statusCode).toBe(201);

      // Bounded poll for the T0 rows.
      const dbPath = join(sb.dir, 'db.sqlite');
      let rows: { event_type: string; session_id: string | null; payload_summary: string | null; user_id: string }[] = [];
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const db = new Database(dbPath, { readonly: true });
        try {
          rows = db
            .query<{ event_type: string; session_id: string | null; payload_summary: string | null; user_id: string }, []>(
              "SELECT event_type, session_id, payload_summary, user_id FROM t0_events WHERE source = 'sirius-middleware' AND project_id = 'integration-test' ORDER BY ts ASC",
            )
            .all();
        } finally { db.close(); }
        if (rows.length >= 2) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(rows).toHaveLength(2);
      expect(rows[0]!.event_type).toBe('agent-prompt');
      expect(rows[1]!.event_type).toBe('agent-response');
      expect(rows[0]!.session_id).toEqual(rows[1]!.session_id);
      expect(rows[0]!.user_id).toBe('integration-user');
      expect(rows[0]!.payload_summary).toBe('integration probe');
      expect(rows[1]!.payload_summary).toBe('integration ok');
    } finally { await app.close(); }
  });
});
```

- [ ] **Step 4: Run the integration test (gated path)**

```bash
PENUMBRA_E2E=1 bun test packages/integrations/sirius-middleware/test/integration.test.ts
```

Expected: 1 pass / 0 fail. Test boots a daemon, sends a chat request through a NestJS test app with the middleware, and verifies two rows appear in the daemon's SQLite t0_events table within 3 seconds.

If the test times out polling for rows, check:
- Daemon's pino log (the harness prints to stdout) for `/observations` requests landing.
- The middleware's warn logs for env-var or daemon errors.

- [ ] **Step 5: Run the test in skipped mode (default) to verify the gate**

```bash
bun test packages/integrations/sirius-middleware/test/integration.test.ts
```

Expected: 0 pass / 0 fail / 1 skip. The test is gated by `PENUMBRA_E2E=1`.

- [ ] **Step 6: Commit**

```bash
git add packages/integrations/sirius-middleware/package.json \
        packages/integrations/sirius-middleware/test/integration.test.ts \
        packages/e2e/src/index.ts \
        packages/e2e/package.json \
        bun.lock
git commit -m "test(sirius-middleware): gated integration test against real penumbra daemon"
```

---

## Sprint D — Cross-repo + verification (Tasks 9–10)

### Task 9: Sirius-gateway side commit (cross-repo)

**Files (sirius-gateway repo):**
- Modify: `/Volumes/WorkSSD/repos/personal/sirius-gateway/apps/sirius-api/package.json`
- Modify: `/Volumes/WorkSSD/repos/personal/sirius-gateway/apps/sirius-api/src/app.module.ts`
- Modify: `/Volumes/WorkSSD/repos/personal/sirius-gateway/.env.example`
- Create: `/Volumes/WorkSSD/repos/personal/sirius-gateway/apps/sirius-api/src/__tests__/penumbra-middleware-wired.test.ts`
- Modify: `/Volumes/WorkSSD/repos/personal/sirius-gateway/AGENTS.md`

This commit happens in a **different repository**. Switch directories with `cd` (the engineer should be aware of which repo the changes are landing in).

- [ ] **Step 1: Add the file: dep to sirius-api**

Inspect the current `apps/sirius-api/package.json`. Add `@penumbra/sirius-middleware` to its `dependencies`:
```json
"@penumbra/sirius-middleware": "file:../../../penumbra/packages/integrations/sirius-middleware"
```

Path math: from `sirius-gateway/apps/sirius-api/`, `../../..` reaches `/Volumes/WorkSSD/repos/personal/`, then `penumbra/packages/integrations/sirius-middleware` is the package directory.

- [ ] **Step 2: Register the module in sirius-api's app.module.ts**

Read `/Volumes/WorkSSD/repos/personal/sirius-gateway/apps/sirius-api/src/app.module.ts` to see the existing imports list. Add the import:
```typescript
import { PenumbraMiddlewareModule } from '@penumbra/sirius-middleware';
```

Add `PenumbraMiddlewareModule` to the `imports` array of the `@Module` decorator on `AppModule`. Order doesn't matter — NestJS resolves DI by token.

- [ ] **Step 3: Document the env vars in `.env.example`**

Read `/Volumes/WorkSSD/repos/personal/sirius-gateway/.env.example`. Append a section:
```
# Penumbra integration (optional). When both are set, sirius-gateway forwards
# chat-completion observations to a running Penumbra daemon for any request
# that carries the `x-penumbra-project` header. Missing/invalid values disable
# the integration silently — sirius-gateway keeps serving normally.
# PENUMBRA_DAEMON_URL=http://127.0.0.1:<port>
# PENUMBRA_DAEMON_TOKEN=<token from <storage_root>/token>
```

- [ ] **Step 4: Add the DI-level wiring test**

Create `/Volumes/WorkSSD/repos/personal/sirius-gateway/apps/sirius-api/src/__tests__/penumbra-middleware-wired.test.ts`:
```typescript
import { expect, test } from 'bun:test';
import { Test } from '@nestjs/testing';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PenumbraObserveInterceptor } from '@penumbra/sirius-middleware';
import { AppModule } from '../app.module.js';

test('PenumbraObserveInterceptor is registered as APP_INTERCEPTOR', async () => {
  // Without env vars, the middleware module compiles in disabled state and
  // the interceptor still registers; per-request gate short-circuits to no-op.
  delete process.env.PENUMBRA_DAEMON_URL;
  delete process.env.PENUMBRA_DAEMON_TOKEN;
  const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const interceptors = m.get<unknown[]>(APP_INTERCEPTOR, { strict: false });
  // NestJS may resolve a single instance or array depending on registration shape.
  const list = Array.isArray(interceptors) ? interceptors : [interceptors];
  const found = list.some((i) => i instanceof PenumbraObserveInterceptor);
  expect(found).toBe(true);
  await m.close();
});
```

If the existing `AppModule` cannot bootstrap without other env vars (database URL, etc.), set those to test-safe values inside the test before `Test.createTestingModule` (the test cares only that the module graph compiles and the interceptor is in the DI tree).

- [ ] **Step 5: Document the integration in AGENTS.md**

Read `/Volumes/WorkSSD/repos/personal/sirius-gateway/AGENTS.md`. Add a short section near the bottom:
```markdown
## Penumbra observation (optional)

`apps/sirius-api` registers `@penumbra/sirius-middleware`'s
`PenumbraMiddlewareModule`. When `PENUMBRA_DAEMON_URL` and
`PENUMBRA_DAEMON_TOKEN` are both set, any inbound `POST /v1/chat/completions`
request that carries an `x-penumbra-project` header is forwarded to the
penumbra daemon as a paired `agent-prompt` + `agent-response` T0 event
(opt-in per request). Missing config or daemon errors are logged at warn
and dropped — sirius-gateway never fails a request because of penumbra.
Embedding routes (`/v1/embeddings*`) are never observed (loop guard).
```

- [ ] **Step 6: Install + typecheck + test in sirius-gateway**

```bash
bun install
bun run typecheck
bun run test
```

Expected: zero errors; the new wiring test passes alongside existing tests.

- [ ] **Step 7: Commit (in sirius-gateway repo)**

```bash
git add apps/sirius-api/package.json \
        apps/sirius-api/src/app.module.ts \
        apps/sirius-api/src/__tests__/penumbra-middleware-wired.test.ts \
        .env.example \
        AGENTS.md \
        bun.lock
git commit -m "feat(sirius-api): register @penumbra/sirius-middleware for opt-in observation"
```

This commit lives in the sirius-gateway repo, not penumbra. The penumbra-side commits from Tasks 1–8 stay independent.

---

### Task 10: Repo-wide verification (in penumbra)

**Files:** none modified.

Final checkpoint: confirm the penumbra repo builds clean, all tests pass, and the new package is discoverable by the workspace.

- [ ] **Step 1: Run repo-wide typecheck (penumbra)**

```bash
bun run typecheck
```

Expected: zero errors across `core`, `daemon`, `mcp`, `cli`, `e2e`, and the new `sirius-middleware` package.

- [ ] **Step 2: Run all unit tests (non-gated)**

```bash
bun test
```

Expected: a count consistent with the prior baseline (`172 pass / 1 skip / 0 fail` from V1 Sprint I) **plus** the new package's unit tests (~34 from sirius-middleware) **plus** the integration test in skipped state (1 skip). Final expected shape: roughly `206 pass / 2 skip / 0 fail`.

- [ ] **Step 3: Run the gated integration test**

```bash
PENUMBRA_E2E=1 bun test packages/integrations/sirius-middleware/test/integration.test.ts
```

Expected: 1 pass / 0 fail.

- [ ] **Step 4: Verify the package's public surface is importable**

Quick smoke from the repo root:
```bash
bun -e "import('@penumbra/sirius-middleware').then((m) => console.log(Object.keys(m).sort()))"
```

Expected output (sorted):
```
[
  "PENUMBRA_CONFIG",
  "PENUMBRA_DAEMON_CLIENT",
  "PenumbraDaemonClient",
  "PenumbraMiddlewareModule",
  "PenumbraObserveInterceptor",
  "loadConfig",
]
```

- [ ] **Step 5: No commit needed**

Verification only — no files changed.

---

## Self-review

**Spec coverage:**
- §1 scope (chat-only, paired events, header opt-in) → Tasks 4, 5, 6 (interceptor) and Task 4 (builders).
- §2 architecture (package layout, peer deps, file: dep wiring) → Task 1 (penumbra), Task 9 (sirius-gateway).
- §3 interceptor flow (gate, capture, wait, build two events, fire-and-forget) → Tasks 5, 6.
- §4 wire format (every field rule) → Task 4 builder tests assert each field; Task 5/6 interceptor tests assert end-to-end shape; Task 8 integration test asserts persisted shape.
- §5 configuration & failure posture (env vars, hostname, no-op on disabled, warn-and-drop) → Tasks 2, 7 (module factory log), 5 (interceptor swallows errors).
- §6 testing (unit + gated integration) → Tasks 2, 3, 4, 5, 6, 7, 8.
- §7 sirius-gateway side wiring (file: dep, app.module, .env.example, DI test, AGENTS.md) → Task 9.
- §8 future-considerations (triad analysis) → no implementation, only spec; no task needed.
- §9 deviations applied (#14 tsconfig split, #4 @types/node, #33 numeric env parsing — N/A here, no numeric env, but URL parser is the analogue) → Task 1 (tsconfig split), Task 1 (devDep `@types/node`), Task 2 (URL parsing rejects bad input).
- §10 explicit non-scope → no task; deferrals are not implemented by definition.
- §11 acceptance criteria → Task 10 verification step.

**Placeholder scan:** No "TBD", "TODO", "implement later", "similar to Task N", or "fill in details". Every task body has the actual code or the actual command.

**Type consistency check:**
- `MiddlewareConfig` (Task 2) is consumed verbatim by the module factory (Task 7) and the interceptor (Task 5).
- `PenumbraDaemonClient`'s `observe(event: T0EventInput)` signature (Task 3) matches what the interceptor's `fireAndForget` calls (Task 5) and what the module's no-op stub satisfies (Task 7).
- `T0EventInput` (`@penumbra/core`) is imported in Tasks 3, 4, 5, 7, 8 — same module path everywhere.
- `ChatMessage` / `ChatResponseLike` (Task 4) are used by the interceptor (Task 5) without re-defining.
- `PENUMBRA_CONFIG` and `PENUMBRA_DAEMON_CLIENT` symbol tokens (Task 5) are referenced consistently in interceptor tests (Tasks 5, 6) and the module (Task 7).
- `BuildPromptInput` and `BuildResponseInput` (Task 4) are used by the interceptor (Tasks 5, 6) without restructuring.

**Scope check:** Single implementation plan covers ~10 source files across 1 new penumbra package + 5 small files in sirius-gateway. ~34 unit tests + 1 integration test. Suitable for a single plan.

**Ambiguity check:**
- Header names (`x-penumbra-project`, `x-penumbra-user`, `x-request-id`) are hardcoded in code, not configurable — matches §10.
- The streamed-response SSE parser only reads `delta.content` from the first choice — it's not a general-purpose SSE parser. Documented in Task 6's strategy paragraph.
- Path matching uses exact string equality on `'/v1/chat/completions'` after `normalizePath` strips trailing slashes — explicit in Task 5 code.
- Module instantiation happens once per NestJS process; `loadConfig()` runs once; `os.hostname()` is captured once. The factory in Task 7 is a `useFactory`, which NestJS calls exactly once for module-scoped providers (default).

All self-review checks pass.

---

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-04-25-penumbra-sirius-middleware.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. Required sub-skill: `superpowers:subagent-driven-development`.

2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
