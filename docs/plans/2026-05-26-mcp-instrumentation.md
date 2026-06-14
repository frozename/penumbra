# MCP Instrumentation Implementation Plan

> **For Gemini:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement per-invocation logging for MCP tools (calls, arg/result bytes, errors, origin) to JSONL.

**Architecture:** We add a wrapper around all MCP handlers that records JSON.stringify byte counts of args and results. The wrapper logs a single JSON line to ~/.local/state/penumbra/mcp-invocations.jsonl. We apply this wrapper in server.ts for internal tools and client.ts for federated tools. We add an analysis script to read the logs. The entire feature is opt-in via PENUMBRA_MCP_INVOCATION_LOG=1.

**Tech Stack:** TypeScript, Node.js (fs, path, os), Zod (config).

---

### Task 1: Update Configuration Schema

**Files:**

- Modify: packages/config/src/env.ts

**Step 1: Write failing test**
_No test to write here, simple schema update._

**Step 2: Write minimal implementation**
Modify packages/config/src/env.ts around line 206 (before dreaming config):

```typescript
  PENUMBRA_MCP_INVOCATION_LOG: {
    schema: Bool,
    default: false,
    description: "Enable append-only JSONL logging of MCP tool invocations.",
  },
```

**Step 3: Commit**

```bash
git add packages/config/src/env.ts
git commit -m "feat(config): add PENUMBRA_MCP_INVOCATION_LOG env var"
```

### Task 2: Create State Path Resolver

**Files:**

- Modify: packages/config/src/files/operator-paths.ts

**Step 1: Write minimal implementation**
Add resolveOperatorStatePath function to packages/config/src/files/operator-paths.ts.

```typescript
// Add constants near the top:
const DEFAULT_STATE_DIR = ".local/state/penumbra";

// Add the export function
export function resolveOperatorStatePath(
  filename: string,
  env: Record<string, string | undefined>,
): string {
  const baseDir =
    env.PENUMBRA_STATE_DIR && env.PENUMBRA_STATE_DIR.length > 0
      ? env.PENUMBRA_STATE_DIR
      : join(resolveHomeDir(env), DEFAULT_STATE_DIR);
  return join(baseDir, filename);
}
```

**Step 2: Commit**

```bash
git add packages/config/src/files/operator-paths.ts
git commit -m "feat(config): add resolveOperatorStatePath for XDG state dir"
```

### Task 3: Create Instrumentation Wrapper

**Files:**

- Create: packages/mcp/src/instrumentation.ts

**Step 1: Write minimal implementation**
Create packages/mcp/src/instrumentation.ts.

```typescript
import { resolveOperatorStatePath } from "@penumbra/config/files/operator-paths.js";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveToolOrigin } from "./tool-origin.js";

interface InvocationLog {
  ts: string;
  tool: string;
  origin: string | null;
  args_bytes: number;
  result_bytes: number;
  duration_ms: number;
  ok: boolean;
  error_kind: string | null;
}

let logPathCached: string | undefined;

function getLogPath(): string {
  if (!logPathCached) {
    logPathCached = resolveOperatorStatePath("mcp-invocations.jsonl", process.env);
  }
  return logPathCached;
}

async function writeLogLine(log: InvocationLog) {
  if (
    process.env.PENUMBRA_MCP_INVOCATION_LOG !== "1" &&
    process.env.PENUMBRA_MCP_INVOCATION_LOG !== "true"
  ) {
    return;
  }
  try {
    const path = getLogPath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(log) + "\n", "utf-8");
  } catch (err) {
    // Swallow logger errors
  }
}

function safeByteSize(obj: unknown): number {
  if (obj === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(obj), "utf8");
  } catch {
    // Handle circular refs or serialization errors by returning -1
    return -1;
  }
}

export function wrapHandler(
  name: string,
  handler: (args: unknown, extra: unknown) => Promise<unknown>,
): (args: unknown, extra: unknown) => Promise<unknown> {
  return async (args: unknown, extra: unknown) => {
    const start = performance.now();
    const origin = resolveToolOrigin(extra) ?? null;
    const argsBytes = safeByteSize(args);

    let resultBytes = 0;
    let ok = false;
    let errorKind: string | null = null;

    try {
      const result = await handler(args, extra);
      resultBytes = safeByteSize(result);
      ok = true;
      return result;
    } catch (err) {
      errorKind = (err as Error)?.name || "Error";
      throw err;
    } finally {
      const durationMs = Math.round(performance.now() - start);
      void writeLogLine({
        ts: new Date().toISOString(),
        tool: name,
        origin,
        args_bytes: argsBytes,
        result_bytes: resultBytes,
        duration_ms: durationMs,
        ok,
        error_kind: errorKind,
      });
    }
  };
}
```

**Step 2: Commit**

```bash
git add packages/mcp/src/instrumentation.ts
git commit -m "feat(mcp): add instrumentation wrapper for mcp tools"
```

### Task 4: Apply Wrapper to Native Tools

**Files:**

- Modify: packages/mcp/src/server.ts

**Step 1: Write minimal implementation**
In packages/mcp/src/server.ts:

1. Import wrapHandler: `import { wrapHandler } from "./instrumentation.js";`
2. Update the handler registration inside buildServer:

```typescript
server.registerTool(
  name,
  def.descriptor as Parameters<typeof server.registerTool>[1],
  wrapHandler(name, def.makeHandler(opts.daemon) as any) as unknown as Parameters<
    typeof server.registerTool
  >[2],
);
```

**Step 2: Commit**

```bash
git add packages/mcp/src/server.ts
git commit -m "feat(mcp): apply instrumentation wrapper to native tools"
```

### Task 5: Apply Wrapper to Federated Tools

**Files:**

- Modify: packages/mcp/src/federation/client.ts

**Step 1: Write minimal implementation**
In packages/mcp/src/federation/client.ts:

1. Import wrapHandler: `import { wrapHandler } from "../instrumentation.js";`
2. Wrap the handler function passed to registerTool inside registerFederatedTools:

```typescript
opts.server.registerTool(
  tool.name,
  {
    description: tool.description ?? `(federated via daemon) ${tool.name}`,
    inputSchema: PASSTHROUGH_INPUT_SCHEMA,
  } as any,
  wrapHandler(tool.name, (async (args: unknown, extra?: unknown) => {
    // ... existing code ...
  }) as any) as any,
);
```

**Step 2: Commit**

```bash
git add packages/mcp/src/federation/client.ts
git commit -m "feat(mcp): apply instrumentation wrapper to federated tools"
```

### Task 6: Add Analysis Script

**Files:**

- Create: packages/mcp/scripts/invocations-summarize.ts

**Step 1: Write minimal implementation**
Create the script.

```typescript
import { resolveOperatorStatePath } from "@penumbra/config/files/operator-paths.js";
import { createReadStream } from "node:fs";
import * as readline from "node:readline";

async function main() {
  const logPath = resolveOperatorStatePath("mcp-invocations.jsonl", process.env);

  const stats = new Map<
    string,
    {
      calls: number;
      totalBytesIn: number;
      totalBytesOut: number;
      errors: number;
      bytesOutSamples: number[];
    }
  >();

  try {
    const fileStream = createReadStream(logPath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const log = JSON.parse(line);
        let stat = stats.get(log.tool);
        if (!stat) {
          stat = { calls: 0, totalBytesIn: 0, totalBytesOut: 0, errors: 0, bytesOutSamples: [] };
          stats.set(log.tool, stat);
        }
        stat.calls++;
        stat.totalBytesIn += log.args_bytes > 0 ? log.args_bytes : 0;
        stat.totalBytesOut += log.result_bytes > 0 ? log.result_bytes : 0;
        if (!log.ok) stat.errors++;
        if (log.result_bytes > 0) stat.bytesOutSamples.push(log.result_bytes);
      } catch {
        // Ignore parse errors
      }
    }
  } catch (err) {
    console.error(`Failed to read log at ${logPath}: ${(err as Error).message}`);
    process.exit(1);
  }

  const results = Array.from(stats.entries()).map(([tool, stat]) => {
    stat.bytesOutSamples.sort((a, b) => a - b);
    const p50 =
      stat.bytesOutSamples.length > 0
        ? stat.bytesOutSamples[Math.floor(stat.bytesOutSamples.length * 0.5)]
        : 0;
    const p95 =
      stat.bytesOutSamples.length > 0
        ? stat.bytesOutSamples[Math.floor(stat.bytesOutSamples.length * 0.95)]
        : 0;

    return {
      tool,
      calls: stat.calls,
      bytes_in: stat.totalBytesIn,
      bytes_out: stat.totalBytesOut,
      p50_bytes_out: p50,
      p95_bytes_out: p95,
      errors: stat.errors,
    };
  });

  results.sort((a, b) => b.calls - a.calls);

  console.table(results);
}

main().catch(console.error);
```

**Step 2: Commit**

```bash
git add packages/mcp/scripts/invocations-summarize.ts
git commit -m "feat(mcp): add analysis script for invocations log"
```
