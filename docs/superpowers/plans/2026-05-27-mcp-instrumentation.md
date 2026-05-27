# MCP instrumentation — phased TDD plan

**Date:** 2026-05-27
**Status:** dispatch-ready (post-audit)
**Provenance:** adversarial-plan fan-out at `.penumbra/reviews/2026-05-27T01-25-49.874Z/` (simplifier, test-first, risk, integration, synthesizer) + architect re-run via `conv-60df24aa-e17e-4844-82d3-4860f2311ad6` (handoff `368cc910`). Spec input: `docs/notes/mcp-instrumentation-plan-2026-05-26.md`. Phase-4 audit findings folded in 2026-05-27.

## Phase-4 audit findings (2026-05-27, lock these)

1. **`resolveToolOrigin` is per-request, returns `string | undefined`.** Signature: `resolveToolOrigin(extra: unknown): string | undefined`. Reads `extra.requestInfo.headers['x-penumbra-origin']` (HTTP transport) or `extra._meta.origin / penumbra_origin / x-penumbra-origin` (stdio transport). The wrapper must call this function inside the async body and fallback to `"unknown"` when it returns `undefined`. Do not roll a new origin reader.
2. **Wrap site is `buildServer`, not `createMcpServer`.** `packages/mcp/src/server.ts:42-64` exports `buildServer({ daemon, shellEnabled? })`. Wrap at line 53 — replace `def.makeHandler(opts.daemon)` with `wrapHandler(name, def.makeHandler(opts.daemon))`.
3. **Federation wrap site is `packages/mcp/src/federation/client.ts:68`.** `opts.server.registerTool(tool.name, schema, asyncHandler)` — wrap the inner async handler at this call site. No monkey-patch concern; the federated handler closes over per-tool `agentId`/`tickId` which is correct.
4. **`@penumbra/config` is NOT in `packages/mcp/package.json` deps.** Phase 0 must add `"@penumbra/config": "workspace:*"` or the Phase-1 import fails at `bun test`. (Memory `t2:6d976495` flagged this exact gotcha for other packages.)
5. **MCP server is a separate stdio child process, NOT in-process with the daemon.** `packages/mcp/bin/penumbra-mcp.ts` is spawned per agentchat client (see `~/.config/agentchat/agentchat.yaml`, server name `penumbra`, `bun` + stdio transport). Daemon restart does **not** restart this MCP process. "Restart MCP server" means killing and respawning the `penumbra-mcp` stdio child — in practice, restarting the agentchat client (or whatever spawned it).
6. **Handler envelope is `(args, extra)`**, where `extra` is the MCP SDK's per-call request envelope (matches `resolveToolOrigin`'s input). RED tests should use `{ _meta: { origin: "..." } }` or `{ requestInfo: { headers: { "x-penumbra-origin": "..." } } }`, not a fabricated `{ meta: { origin } }`.

## Goal

Produce a per-tool table — calls, bytes_in, bytes_out, p50/p95 bytes_out, errors, origin — to drive the consolidation spec. Measurement-first; no surface redesign in this plan.

## Resolved decisions (lock before coding)

| Decision | Resolution | Source |
|---|---|---|
| Env-var name | `PENUMBRA_MCP_INVOCATION_LOG`, registered in `@penumbra/config` (lint rule forces it) | risk, integration, architect |
| Toggle semantics | Boolean opt-in, default `false`; runtime hot-toggle out of scope (server restart picks up change) | risk, architect |
| Log location | `$XDG_STATE_HOME/penumbra/mcp-invocations.jsonl`, fallback `~/.local/state/penumbra/` | all |
| Storage format | JSONL, not sqlite — decouples MCP logging from daemon uptime, keeps summarizer standalone | architect |
| Rotation | Daily gzip, 14-day retention, 100 MB/day soft cap | risk, test-first |
| Sink injection | `wrapHandler` calls `getSink()` (per-process singleton); no file I/O inside the wrapper itself | risk, architect |
| Origin resolution | Call existing `resolveToolOrigin(extra)` inside the async body; fallback to `"unknown"` when undefined | architect (critical), audit |
| Sampling | None — full call-level data needed for byte-distribution stats | risk |
| `session_id` | Defer; do not thread now. Schema append is backwards-compatible later | architect |
| MCP process model | Separate stdio child spawned by agentchat; toggling the env var requires restarting that child (typically by restarting the agentchat client). Daemon restart has no effect on MCP-server env. | audit |

## Pre-phase invariants (the five non-obvious risks)

1. **Origin must be resolved per-call** via existing `resolveToolOrigin(extra)`, inside the async function body. Wrapping at registration with a closed-over `origin` attributes every call to whatever context was in scope when the server started.
2. **Sink has an explicit lifecycle.** `close()` must exist and be idempotent. Daemon hot-reload (if/when added) must call it before clearing the singleton.
3. **Federated tools must use the same wrapping site** as the core registry — not via monkey-patching `server.registerTool`, which would double-wrap.
4. **Rotation must be atomic** (single-filesystem `renameSync`). If `$XDG_STATE_HOME` is cross-mount, fall back to copy+delete with a documented assumption.
5. **`@penumbra/config` ordering**: the lint rule `no-raw-process-env` forbids reads of `PENUMBRA_*` outside `@penumbra/config`. Phase 0 must complete before any other phase reads the env var.

---

## Phase 0 — Config gate in `@penumbra/config` + workspace dep wiring

**Why first:** lint rule forbids raw `process.env.PENUMBRA_*` anywhere outside this package; later phases import the typed accessor and fail the linter otherwise. Also: `packages/mcp/package.json` is missing `@penumbra/config` — must add it here or Phase 1 imports fail to resolve.

### Step 0a — Add `@penumbra/config` to `packages/mcp` workspace deps

```diff
   "dependencies": {
     "@modelcontextprotocol/sdk": "^1.29.0",
     "@penumbra/api-contract": "workspace:*",
+    "@penumbra/config": "workspace:*",
     "@penumbra/core": "workspace:*",
     "@penumbra/daemon": "workspace:*",
```

Verify with `bun install` (no error) and `node -e "console.log(require.resolve('@penumbra/config', { paths: ['packages/mcp'] }))"`.

### RED

```ts
// packages/config/test/env.test.ts (add to existing file)
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { isMcpInvocationLogEnabled } from "@penumbra/config";

describe("PENUMBRA_MCP_INVOCATION_LOG", () => {
  const saved = process.env.PENUMBRA_MCP_INVOCATION_LOG;
  beforeEach(() => { delete process.env.PENUMBRA_MCP_INVOCATION_LOG; });
  afterEach(() => {
    if (saved !== undefined) process.env.PENUMBRA_MCP_INVOCATION_LOG = saved;
    else delete process.env.PENUMBRA_MCP_INVOCATION_LOG;
  });

  it("returns false when unset", () => {
    expect(isMcpInvocationLogEnabled()).toBe(false);
  });
  it("returns true when set to '1'", () => {
    process.env.PENUMBRA_MCP_INVOCATION_LOG = "1";
    expect(isMcpInvocationLogEnabled()).toBe(true);
  });
  it("returns false for any other value", () => {
    process.env.PENUMBRA_MCP_INVOCATION_LOG = "0";
    expect(isMcpInvocationLogEnabled()).toBe(false);
  });
});
```

### GREEN

In `packages/config/src/`:

```ts
export function isMcpInvocationLogEnabled(): boolean {
  return process.env.PENUMBRA_MCP_INVOCATION_LOG === "1";
}
```

Register `PENUMBRA_MCP_INVOCATION_LOG` in whichever allowlist source the `no-raw-process-env` lint rule reads (TS source, not compiled output).

### Verify

```sh
bun install                                                    # workspace dep added
bun test packages/config
bun run lint
grep -rn "PENUMBRA_MCP_INVOCATION_LOG" packages/ --include="*.ts" | grep -v packages/config
# expect: zero hits outside packages/config
```

**Service impact:** none — feature still off.

---

## Phase 1 — Sink: JSONL writer with injectable path and explicit lifecycle

**Invariant:** Tests never write to `$XDG_STATE_HOME`. Sink has explicit `close()`, idempotent.

### RED

`packages/mcp/test/invocation-sink.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInvocationSink } from "../src/invocation-sink";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "inv-sink-")); });

it("writes a JSONL line and flushes on close", async () => {
  const sink = openInvocationSink(join(dir, "inv.jsonl"));
  sink.write({ ts: "2026-01-01T00:00:00.000Z", tool: "test", origin: "test",
               args_bytes: 10, result_bytes: 20, duration_ms: 5,
               ok: true, error_kind: null });
  await sink.close();
  const row = JSON.parse(readFileSync(join(dir, "inv.jsonl"), "utf8").trim());
  expect(row.tool).toBe("test");
});

it("double close does not throw", async () => {
  const sink = openInvocationSink(join(dir, "inv.jsonl"));
  await sink.close();
  await expect(sink.close()).resolves.toBeUndefined();
});

it("creates parent directories if missing", async () => {
  const nested = join(dir, "a", "b", "inv.jsonl");
  const sink = openInvocationSink(nested);
  sink.write({ ts: "x", tool: "y", origin: "x", args_bytes: 0,
               result_bytes: 0, duration_ms: 0, ok: true, error_kind: null });
  await sink.close();
  expect(existsSync(nested)).toBe(true);
});

it("write after close is a no-op, does not throw", async () => {
  const sink = openInvocationSink(join(dir, "inv.jsonl"));
  await sink.close();
  expect(() => sink.write({ ts: "x", tool: "y", origin: "x", args_bytes: 0,
    result_bytes: 0, duration_ms: 0, ok: true, error_kind: null })).not.toThrow();
});
```

### GREEN

`packages/mcp/src/invocation-sink.ts`:

```ts
import { mkdirSync, createWriteStream, WriteStream } from "node:fs";
import { dirname } from "node:path";

export interface InvocationRow {
  ts: string;
  tool: string;
  origin: string;
  args_bytes: number;
  result_bytes: number;
  duration_ms: number;
  ok: boolean;
  error_kind: string | null;
}

export interface InvocationSink {
  write(row: InvocationRow): void;
  close(): Promise<void>;
}

export function openInvocationSink(filePath: string): InvocationSink {
  mkdirSync(dirname(filePath), { recursive: true });
  let stream: WriteStream | null = createWriteStream(filePath, {
    flags: "a", encoding: "utf8",
  });
  return {
    write(row) {
      if (stream === null) return;
      stream.write(JSON.stringify(row) + "\n");
    },
    close() {
      if (stream === null) return Promise.resolve();
      const s = stream;
      stream = null;
      return new Promise((resolve, reject) =>
        s.end((err: Error | null | undefined) => err ? reject(err) : resolve()));
    },
  };
}
```

### Verify

```sh
bun test packages/mcp/test/invocation-sink.test.ts
bun tsc -p packages/mcp/tsconfig.json
```

**10x scale note:** `flags: "a"` is single-process O_APPEND atomic. Multi-process MCP replicas would need per-process filenames or file-locking — out of scope; flag for the consolidation spec.

---

## Phase 2 — Sink registry: per-process singleton + XDG resolution

**Invariant:** XDG resolution lives in exactly one place; tests inject path via the optional resolver argument.

### RED

`packages/mcp/test/invocation-sink-registry.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSink, _resetSinkForTest } from "../src/invocation-sink-registry";

afterEach(() => _resetSinkForTest());

it("returns the same sink on repeated calls", () => {
  const dir = mkdtempSync(join(tmpdir(), "reg-"));
  const a = getSink(() => join(dir, "a.jsonl"));
  const b = getSink(() => join(dir, "a.jsonl"));
  expect(a).toBe(b);
});

it("getSink with default resolver does not throw", () => {
  expect(() => getSink()).not.toThrow();
});

it("_resetSinkForTest throws if NODE_ENV !== 'test'", () => {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    expect(() => _resetSinkForTest()).toThrow();
  } finally {
    process.env.NODE_ENV = saved;
  }
});
```

### GREEN

`packages/mcp/src/invocation-sink-registry.ts`:

```ts
import { join } from "node:path";
import { homedir } from "node:os";
import { openInvocationSink, InvocationSink } from "./invocation-sink";

function defaultPath(): string {
  const xdg = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(xdg, "penumbra", "mcp-invocations.jsonl");
}

let _sink: InvocationSink | null = null;

export function getSink(resolvePath: () => string = defaultPath): InvocationSink {
  if (_sink === null) _sink = openInvocationSink(resolvePath());
  return _sink;
}

export async function closeSink(): Promise<void> {
  if (_sink !== null) {
    await _sink.close();
    _sink = null;
  }
}

export function _resetSinkForTest(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("_resetSinkForTest is test-only");
  }
  _sink = null;
}
```

### Verify

```sh
bun test packages/mcp/test/invocation-sink-registry.test.ts
grep -rn "XDG_STATE_HOME\|homedir()" packages/mcp/src --include="*.ts" \
  | grep -v invocation-sink-registry
# expect: zero — XDG resolution lives in exactly one place
```

**Hot-reload note:** if/when the daemon supports MCP server hot-reload, the reload hook must call `closeSink()` before tearing down the module cache, otherwise the file handle leaks.

---

## Phase 3 — `wrapHandler`: per-call origin, byte measurement, error taxonomy

**Invariant:** Origin is resolved **inside** the async function body via existing `resolveToolOrigin(extra)` (falling back to `"unknown"`) on every call. Error kind = constructor name (capped 64 chars). Sink failures never break the handler.

### RED

`packages/mcp/test/instrumentation.test.ts`:

```ts
import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as registry from "../src/invocation-sink-registry";
import { openInvocationSink } from "../src/invocation-sink";
import { wrapHandler } from "../src/instrumentation";

afterEach(() => registry._resetSinkForTest());

function withSink(): { path: string } {
  const dir = mkdtempSync(join(tmpdir(), "wrap-"));
  const path = join(dir, "inv.jsonl");
  registry._resetSinkForTest();
  spyOn(registry, "getSink").mockReturnValue(openInvocationSink(path));
  return { path };
}

it("logs a successful call with per-call origin from _meta", async () => {
  const { path } = withSink();
  const handler = wrapHandler("my_tool", async () => ({ result: "ok" }), { enabled: true });
  await handler({ x: 1 }, { _meta: { origin: "claude-code" } });
  await new Promise(r => setTimeout(r, 10));
  const row = JSON.parse(readFileSync(path, "utf8").trim());
  expect(row.tool).toBe("my_tool");
  expect(row.ok).toBe(true);
  expect(row.origin).toBe("claude-code");
  expect(row.error_kind).toBeNull();
  expect(typeof row.duration_ms).toBe("number");
});

it("origin is resolved per-call from header (not closure-captured)", async () => {
  const { path } = withSink();
  const handler = wrapHandler("t", async () => ({}), { enabled: true });
  await handler({}, { requestInfo: { headers: { "x-penumbra-origin": "caller-A" } } });
  await handler({}, { requestInfo: { headers: { "x-penumbra-origin": "caller-B" } } });
  await new Promise(r => setTimeout(r, 10));
  const lines = readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
  expect(lines[0].origin).toBe("caller-A");
  expect(lines[1].origin).toBe("caller-B");
});

it("origin defaults to 'unknown' when extra has no origin signal", async () => {
  const { path } = withSink();
  const handler = wrapHandler("t", async () => ({}), { enabled: true });
  await handler({}, {});
  await new Promise(r => setTimeout(r, 10));
  const row = JSON.parse(readFileSync(path, "utf8").trim());
  expect(row.origin).toBe("unknown");
});

it("logs a failing call with error_kind = constructor name", async () => {
  const { path } = withSink();
  class TimeoutError extends Error {}
  const handler = wrapHandler("bad", async () => { throw new TimeoutError("oops"); }, { enabled: true });
  await expect(handler({}, {})).rejects.toThrow("oops");
  await new Promise(r => setTimeout(r, 10));
  const row = JSON.parse(readFileSync(path, "utf8").trim());
  expect(row.ok).toBe(false);
  expect(row.error_kind).toBe("TimeoutError");
});

it("circular-ref args → args_bytes = -1 sentinel", async () => {
  const { path } = withSink();
  const handler = wrapHandler("t", async () => ({}), { enabled: true });
  const circular: any = {}; circular.self = circular;
  await handler(circular, {});
  await new Promise(r => setTimeout(r, 10));
  const row = JSON.parse(readFileSync(path, "utf8").trim());
  expect(row.args_bytes).toBe(-1);
});

it("is a no-op when disabled", async () => {
  const handler = wrapHandler("t", async (a: any) => ({ value: 42 }), { enabled: false });
  const result = await handler({ q: 1 }, {});
  expect(result).toEqual({ value: 42 });
});

it("sink throw is swallowed; handler result still returned", async () => {
  registry._resetSinkForTest();
  spyOn(registry, "getSink").mockReturnValue({
    write: () => { throw new Error("disk full"); },
    close: async () => {},
  });
  const handler = wrapHandler("t", async () => ({ ok: true }), { enabled: true });
  await expect(handler({}, {})).resolves.toEqual({ ok: true });
});
```

### GREEN

`packages/mcp/src/instrumentation.ts`:

```ts
import { getSink } from "./invocation-sink-registry";
import { isMcpInvocationLogEnabled } from "@penumbra/config";
import { resolveToolOrigin } from "./tool-origin";

function safeStringifyLen(value: unknown): number {
  try { return JSON.stringify(value).length; }
  catch { return -1; }
}

function errorKind(e: unknown): string {
  if (e instanceof Error) return (e.constructor.name || "Error").slice(0, 64);
  return "unknown";
}

type AnyHandler = (args: unknown, extra: unknown) => Promise<unknown>;

export function wrapHandler(
  name: string,
  handler: AnyHandler,
  opts: { enabled?: boolean } = {},
): AnyHandler {
  const enabled = opts.enabled ?? isMcpInvocationLogEnabled();
  if (!enabled) return handler;

  return async function wrappedHandler(args, extra) {
    const origin = resolveToolOrigin(extra) ?? "unknown";   // per-call, from the live envelope
    const args_bytes = safeStringifyLen(args);
    const t0 = performance.now();
    let row: import("./invocation-sink").InvocationRow;
    try {
      const result = await handler(args, extra);
      row = {
        ts: new Date().toISOString(), tool: name, origin,
        args_bytes, result_bytes: safeStringifyLen(result),
        duration_ms: performance.now() - t0,
        ok: true, error_kind: null,
      };
      try { getSink().write(row); } catch { /* never break handler */ }
      return result;
    } catch (e) {
      row = {
        ts: new Date().toISOString(), tool: name, origin,
        args_bytes, result_bytes: 0,
        duration_ms: performance.now() - t0,
        ok: false, error_kind: errorKind(e),
      };
      try { getSink().write(row); } catch { /* never break handler */ }
      throw e;
    }
  };
}
```

### Verify

```sh
bun test packages/mcp/test/instrumentation.test.ts
# manually confirm origin resolution is inside the async body, not in outer scope:
grep -n "resolveOrigin\|getSink" packages/mcp/src/instrumentation.ts
```

**Build note:** `e.constructor.name` becomes single-letter garbage under identifier minification. If the MCP server is ever built with `bun build --minify-identifiers`, add a build-exclude or move to an explicit `ErrorKind` enum. Track separately; not blocking.

---

## Phase 4 — Wire into `server.ts` and `registerFederatedTools`

**Pre-wiring audit:** done 2026-05-27 — see top of plan. Summary:
- `resolveToolOrigin(extra)` is per-request; signature `string | undefined`. Use directly inside the wrapper.
- `buildServer({ daemon, shellEnabled? })` is the entry; wrap site is `server.ts:53`.
- `@penumbra/config` is **not** in `packages/mcp` deps — added in Phase 0.
- Federation wrap site: `federation/client.ts:68` — wrap the inline async handler.

### RED

`packages/mcp/test/server.test.ts` additions:

```ts
it("PENUMBRA_MCP_INVOCATION_LOG=1: registered tool produces a log row", async () => {
  process.env.PENUMBRA_MCP_INVOCATION_LOG = "1";
  // inject sink to tmp file via registry mock
  // invoke a known registered tool via createMcpServer's call surface
  // assert JSONL line is written with correct tool name
});

it("PENUMBRA_MCP_INVOCATION_LOG unset: no log file is created", async () => {
  delete process.env.PENUMBRA_MCP_INVOCATION_LOG;
  // invoke registered tool
  // assert no file written under tmp state dir
});
```

`packages/mcp/test/federation/client.test.ts` addition:

```ts
it("federated tool handler is wrapped exactly once", async () => {
  // register a federated tool; invoke it; assert one log row
  // (regression guard against double-wrapping if server.registerTool gets monkey-patched)
});
```

### GREEN

In `packages/mcp/src/server.ts` `buildServer` registration loop (lines 46-55), preserve the existing `canonicalToolId` + allowlist logic and wrap only `def.makeHandler(opts.daemon)`:

```ts
import { wrapHandler } from "./instrumentation";

for (const [rawName, def] of Object.entries(TOOL_REGISTRY)) {
  const name = canonicalToolId(rawName);
  if (!name) continue;
  if (allowlist && !allowlist.has(name)) continue;
  const rawHandler = def.makeHandler(opts.daemon);
  server.registerTool(
    name,
    def.descriptor as Parameters<typeof server.registerTool>[1],
    wrapHandler(name, rawHandler) as unknown as Parameters<typeof server.registerTool>[2],
  );
}
```

In `packages/mcp/src/federation/client.ts:68`, wrap the inline async handler:

```ts
opts.server.registerTool(
  tool.name,
  { description: ..., inputSchema: PASSTHROUGH_INPUT_SCHEMA } as any,
  wrapHandler(tool.name, (async (args: unknown) => {
    // existing federation body — closes over agentId, tickId, opts.daemon.mcpCall
  }) as any),
);
```

**Do not** monkey-patch `server.registerTool` itself — that would double-wrap when federation calls it.

### Verify

```sh
bun test packages/mcp/test/
bun run lint
bun tsc -p packages/mcp/tsconfig.json
grep -n "wrapHandler" packages/mcp/src/server.ts packages/mcp/src/federation/*.ts
# expect: >= 2 occurrences (registry loop + federation site)
```

**Rollback procedure:** unset `PENUMBRA_MCP_INVOCATION_LOG` → kill the `penumbra-mcp` stdio child (in practice: restart the agentchat client / Claude Code session that spawned it). On respawn, `wrapHandler` returns the raw handler unchanged when disabled, so the wrapper is inert. Existing JSONL files stay where they are; no cleanup required.

**Service impact:** restart the `penumbra-mcp` stdio child to pick up new init code. **Daemon restart has no effect** — the MCP server is a separate process per agentchat client.

---

## Phase 5 — Daily rotation + 14-day retention

**Invariant:** Rotation is atomic on a single filesystem; retention pruning never touches the live file.

### RED

`packages/mcp/test/invocation-rotation.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateIfNeeded, pruneOldRotations } from "../src/invocation-rotation";

it("rotation produces a gzip with the date in the filename and removes the live file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rot-"));
  const live = join(dir, "mcp-invocations.jsonl");
  writeFileSync(live, '{"tool":"x"}\n');
  const gz = await rotateIfNeeded(live, new Date("2026-01-01"));
  expect(gz).toMatch(/2026-01-01.*\.jsonl\.gz$/);
  expect(existsSync(gz!)).toBe(true);
  expect(existsSync(live)).toBe(false);
});

it("pruneOldRotations deletes files older than retainDays", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prune-"));
  for (let i = 0; i < 16; i++) {
    const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    writeFileSync(join(dir, `mcp-invocations.${d}.jsonl.gz`), "fake");
  }
  await pruneOldRotations(dir, 14);
  expect(readdirSync(dir).length).toBe(14);
});
```

### GREEN

`packages/mcp/src/invocation-rotation.ts`:

```ts
import { renameSync, readdirSync, unlinkSync,
         createReadStream, createWriteStream, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

export async function rotateIfNeeded(
  livePath: string,
  forDate: Date = new Date(),
): Promise<string | null> {
  const dateStr = forDate.toISOString().slice(0, 10);
  const staging = livePath.replace(/\.jsonl$/, `.${dateStr}.jsonl`);
  const gzPath = staging + ".gz";
  try {
    renameSync(livePath, staging);
  } catch (e: any) {
    if (e.code === "EXDEV") {
      copyFileSync(livePath, staging);
      unlinkSync(livePath);
    } else throw e;
  }
  await pipeline(createReadStream(staging), createGzip(), createWriteStream(gzPath));
  unlinkSync(staging);
  return gzPath;
}

export async function pruneOldRotations(dir: string, retainDays: number): Promise<void> {
  const cutoff = Date.now() - retainDays * 86400_000;
  for (const name of readdirSync(dir)) {
    const m = name.match(/mcp-invocations\.(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/);
    if (!m) continue;
    if (new Date(m[1]).getTime() < cutoff) unlinkSync(join(dir, name));
  }
}
```

**Rotation trigger:** sink (Phase 1) gets a date-aware write path — on each `write()`, compare `new Date().toISOString().slice(0,10)` against the open-day. If they differ: `close()` → `rotateIfNeeded()` → re-open. One string compare per write; no cron dependency.

(Implementation note: add a follow-up Phase-1 patch wiring this into the sink, or fold into Phase 1 if Phase 5 starts before Phase 4 lands.)

### Verify

```sh
bun test packages/mcp/test/invocation-rotation.test.ts
grep -rn "setInterval\|cron" packages/mcp/src --include="*.ts" | grep -v test
# expect: zero — rotation is write-path driven, no background timer
```

---

## Phase 6 — Summarizer CLI

### RED

`packages/mcp/test/invocation-summary.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { summarize } from "../src/invocation-summary";

const ROWS = [
  { ts: "2026-01-01T00:00:01Z", tool: "tool_a", origin: "cc",
    args_bytes: 10, result_bytes: 100, duration_ms: 50, ok: true, error_kind: null },
  { ts: "2026-01-01T00:00:02Z", tool: "tool_a", origin: "cc",
    args_bytes: 20, result_bytes: 200, duration_ms: 150, ok: true, error_kind: null },
  { ts: "2026-01-01T00:00:03Z", tool: "tool_b", origin: "api",
    args_bytes: 5, result_bytes: 0, duration_ms: 10, ok: false, error_kind: "TimeoutError" },
];

it("counts calls and errors per tool", () => {
  const s = summarize(ROWS);
  expect(s.get("tool_a")!.calls).toBe(2);
  expect(s.get("tool_b")!.errors).toBe(1);
});

it("computes p50/p95 result_bytes", () => {
  const s = summarize(ROWS);
  expect(s.get("tool_a")!.p50_bytes_out).toBeGreaterThan(0);
  expect(s.get("tool_a")!.p95_bytes_out).toBeGreaterThanOrEqual(s.get("tool_a")!.p50_bytes_out);
});

it("skips malformed JSONL lines", async () => {
  const { parseLines } = await import("../src/invocation-summary");
  expect(parseLines(["{not json", JSON.stringify(ROWS[0])])).toHaveLength(1);
});
```

### GREEN

`packages/mcp/src/invocation-summary.ts` (pure aggregator), `packages/mcp/scripts/invocations-summarize.ts` (thin CLI):

```ts
// src/invocation-summary.ts
export interface SummaryRow { calls: number; errors: number;
  total_bytes_in: number; total_bytes_out: number;
  p50_bytes_out: number; p95_bytes_out: number;
  first_error: string | null; origins: Set<string>; }

export function summarize(rows: any[]): Map<string, SummaryRow> {
  const out = new Map<string, SummaryRow>();
  for (const r of rows) {
    const s = out.get(r.tool) ?? {
      calls: 0, errors: 0, total_bytes_in: 0, total_bytes_out: 0,
      p50_bytes_out: 0, p95_bytes_out: 0, first_error: null, origins: new Set(),
    };
    s.calls++;
    s.total_bytes_in += r.args_bytes;
    s.total_bytes_out += r.result_bytes;
    s.origins.add(r.origin);
    if (!r.ok) {
      s.errors++;
      if (s.first_error === null) s.first_error = r.error_kind;
    }
    out.set(r.tool, s);
  }
  for (const [tool, stats] of out) {
    const bytes = rows.filter(r => r.tool === tool).map(r => r.result_bytes).sort((a, b) => a - b);
    const pick = (pct: number) => bytes[Math.min(bytes.length - 1, Math.floor(bytes.length * pct / 100))] ?? 0;
    stats.p50_bytes_out = pick(50);
    stats.p95_bytes_out = pick(95);
  }
  return out;
}

export function parseLines(lines: string[]): any[] {
  const out: any[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}
```

CLI: streaming `readline` over `fs.createReadStream`, `--since 7d` parsed via `util.parseArgs`, markdown table to stdout sorted by call count descending.

### Verify

```sh
bun test packages/mcp/test/invocation-summary.test.ts
# After Phase 4 lands and the log has > 0 rows:
PENUMBRA_MCP_INVOCATION_LOG=1 # restart MCP server, generate calls
bun packages/mcp/scripts/invocations-summarize.ts --since 7d
```

---

## Phase 7 — E2E smoke + rollout gate

**RED (pre-rollout):**
- `PENUMBRA_MCP_INVOCATION_LOG` unset → call tools → assert zero log file in `$XDG_STATE_HOME/penumbra/`.

**GREEN (post-rollout):**
- `PENUMBRA_MCP_INVOCATION_LOG=1` → restart the `penumbra-mcp` stdio child (in practice: restart the agentchat client / Claude Code session) → execute 3+ real tool calls (`memory_search`, `task_list`, `chain_status`) → confirm JSONL growth at `$XDG_STATE_HOME/penumbra/mcp-invocations.jsonl` and field correctness (`origin` reflects the real client, `tool` matches the canonical id).

**REFACTOR:** trim any noisy fields; lock the record schema.

**Full sweep before merge:**

```sh
bun test packages/config/test/
bun test packages/mcp/test/
bun run typecheck
bun run lint
# regression sweep:
bun test packages/daemon/test/ packages/agentchat/test/cli packages/core/test/
```

**Post-midnight validation:** confirm `.jsonl.gz` archive created and `pruneOldRotations` ran (manual on first rollout; automate in a follow-up if needed).

**Data-gate:** after 3–7 days, run the summarizer; use output as input to the consolidation spec.

---

## Sequencing

| Phase | Starts after | Blocks |
|---|---|---|
| 0 — Config gate | — | all others |
| 1 — Sink | 0 | 2, 3, 5 |
| 2 — Sink registry | 1 | 3 |
| 3 — wrapHandler | 2 | 4 |
| 4 — Wire-in | 3 | (shippable) |
| 5 — Rotation | 1 | 6 |
| 6 — Summarizer | 5 | (data-gate) |
| 7 — E2E + rollout | 4 | (data-gate) |

5 and 6 can run in parallel with 3–4 once Phase 1 is solid.

---

## Failure modes

| Failure | Behavior | Covered in |
|---|---|---|
| Handler throws | `ok=false` row written, error rethrown | Phase 3 |
| Sink write failure | Swallowed silently; handler unaffected | Phase 3 |
| Circular-ref args | `args_bytes = -1` sentinel | Phase 3 |
| Sink double close | Idempotent no-op | Phase 1 |
| Write after close | Silent no-op, no throw | Phase 1 |
| Day-boundary rotation | Live file → staging → gzip; live file recreated on next write | Phase 1 + 5 |
| Cross-mount rotation (`EXDEV`) | Copy + delete fallback | Phase 5 |
| Disk full / read-only dir | Sink write throws; wrapper swallows | Phase 3 |
| Malformed JSONL line in reader | Skipped, no crash | Phase 6 |
| Feature disabled | `wrapHandler` returns raw handler; zero overhead | Phase 3 |
| Identifier minification | `error_kind` becomes single letter — build-config issue, not runtime | (tracked separately) |

---

## Open questions — all resolved at 2026-05-27 audit

1. **`resolveToolOrigin` shape** — per-request, returns `string | undefined`. Wrapper calls it inside the async body, fallbacks to `"unknown"`. (See Phase-4 audit finding #1.)
2. **MCP server process model** — separate stdio child per agentchat client. "Restart" = kill+respawn the `penumbra-mcp` stdio child. Daemon restart is unrelated. (See finding #5.)
3. **`@penumbra/config` workspace dep** — missing from `packages/mcp/package.json`; added in Phase 0 Step 0a. (See finding #4.)

---

## Trade-offs accepted

- **JSONL over sqlite**: simpler ops, summarizer is standalone, no daemon-uptime coupling. Trade-off: ad-hoc queries require shell tooling.
- **Per-process singleton sink**: clean lifecycle, but multi-process MCP replicas would need per-process filenames or locking. Out of scope; flagged.
- **Capture-at-wrap enabled flag**: runtime hot-toggle out of scope. Trade-off: changing the env var requires server restart.
- **Defer `session_id`**: schema-append is backwards-compatible; threading a stale session is worse than omitting.
- **Soft 100 MB/day cap** (risk-persona contribution): cheap guard against runaway log; honors the no-payloads invariant.
