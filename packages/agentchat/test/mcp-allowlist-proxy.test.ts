import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseShellArgs, pendingMethodCap } from "../src/mcp-allowlist-proxy.js";

const PROXY = new URL("../src/mcp-allowlist-proxy.ts", import.meta.url).pathname;

const FIXTURE_PATH = join(tmpdir(), `mcp-fixture-${String(Date.now())}.ts`);

// Minimal MCP server: exposes 5 tools, logs tool/call names to CALL_LOG env if set.
const FIXTURE_CODE = `
import readline from "node:readline";
import { appendFileSync } from "node:fs";

const tools = ["alpha", "beta", "gamma", "delta", "epsilon"].map((name) => ({
  name,
  description: name + " tool",
  inputSchema: { type: "object", properties: {} },
}));

const rl = readline.createInterface({ input: process.stdin });
function handle(msg: any) {
  if (msg.method === "tools/list") {
    return { jsonrpc: "2.0", id: msg.id, result: { tools } };
  } else if (msg.method === "tools/call") {
    const name = msg.params?.name;
    if (process.env.CALL_LOG) appendFileSync(process.env.CALL_LOG, name + "\\n");
    return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "called:" + name }] } };
  } else if (msg.method === "stall") {
    return null;
  } else if (msg.id !== undefined) {
    return { jsonrpc: "2.0", id: msg.id, result: {} };
  }
  return null;
}
rl.on("line", (line: string) => {
  if (!line.trim()) return;
  let msg: any;
  try { msg = JSON.parse(line); } catch { return; }
  const msgs = Array.isArray(msg) ? msg : [msg];
  const responses = [];
  for (const item of msgs) {
    const resp = handle(item);
    if (resp) responses.push(resp);
  }
  if (responses.length === 1) process.stdout.write(JSON.stringify(responses[0]) + "\\n");
  else if (responses.length > 1) process.stdout.write(JSON.stringify(responses) + "\\n");
});
`;

beforeAll(() => {
  writeFileSync(FIXTURE_PATH, FIXTURE_CODE);
});

afterAll(() => {
  try {
    rmSync(FIXTURE_PATH);
  } catch {
    /* ignore */
  }
});

interface Proxy {
  write: (msg: object) => void;
  readNext: (timeoutMs?: number) => Promise<Record<string, unknown>>;
  readBatch: (timeoutMs?: number) => Promise<Record<string, unknown>[]>;
  kill: () => void;
}

function spawnProxy(allowlist: string, extraEnv: Record<string, string> = {}): Proxy {
  const proc = spawn("bun", [PROXY], {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      MCP_PROXY_UPSTREAM: `bun "${FIXTURE_PATH}"`,
      MCP_PROXY_ALLOWLIST: allowlist,
      ...extraEnv,
    },
  });

  let buf = "";
  const lines: string[] = [];
  const waiters: ((l: string) => void)[] = [];

  proc.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    const parts = buf.split("\n");
    buf = parts.pop()!;
    for (const line of parts) {
      if (!line.trim()) continue;
      const w = waiters.shift();
      if (w) w(line);
      else lines.push(line);
    }
  });

  const write = (msg: object): boolean => proc.stdin.write(JSON.stringify(msg) + "\n");

  const readNext = (timeoutMs = 4000): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error("readNext timed out"));
      }, timeoutMs);
      const next = lines.shift();
      if (next !== undefined) {
        clearTimeout(t);
        resolve(JSON.parse(next) as Record<string, unknown>);
        return;
      }
      waiters.push((line) => {
        clearTimeout(t);
        resolve(JSON.parse(line) as Record<string, unknown>);
      });
    });

  const readBatch = async (timeoutMs = 4000): Promise<Record<string, unknown>[]> => {
    const msg = await readNext(timeoutMs);
    expect(Array.isArray(msg)).toBe(true);
    return msg as unknown as Record<string, unknown>[];
  };

  const kill = (): void => {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  };

  return { write, readNext, readBatch, kill };
}

function rmQuiet(path: string): void {
  try {
    rmSync(path);
  } catch {
    /* ignore */
  }
}

async function pollForPid(file: string, maxAttempts: number): Promise<number> {
  let pid = 0;
  for (let i = 0; i < maxAttempts && !pid; i++) {
    if (existsSync(file)) {
      const v = parseInt(readFileSync(file, "utf8").trim(), 10);
      if (Number.isInteger(v) && v > 0) pid = v;
    }
    if (!pid) await new Promise((r) => setTimeout(r, 100));
  }
  return pid;
}

async function waitForExitOrTimeout(
  proc: ChildProcess,
  timeoutMs: number,
): Promise<"exited" | "timeout"> {
  const exited = new Promise<number | null>((resolve) =>
    proc.on("exit", (code) => {
      resolve(code);
    }),
  );
  const outcome = await Promise.race([
    exited.then(() => "exited" as const),
    new Promise<"timeout">((r) =>
      setTimeout(() => {
        r("timeout");
      }, timeoutMs),
    ),
  ]);
  if (outcome === "timeout") {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  return outcome;
}

async function waitUntilPidDead(pid: number, maxAttempts: number): Promise<boolean> {
  let alive = true;
  for (let i = 0; i < maxAttempts && alive; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      alive = false;
    }
  }
  return !alive;
}

// ── Proxy behavior tests ──────────────────────────────────────────────────────

test("tools/list filtered: upstream returns 5 tools; allowlist 2; client sees 2", async () => {
  const p = spawnProxy("alpha,beta");
  try {
    p.write({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const resp = await p.readNext();
    expect(resp["id"]).toBe(1);
    const result = resp["result"] as Record<string, unknown>;
    const tools = result["tools"] as Record<string, unknown>[];
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t["name"])).toEqual(["alpha", "beta"]);
  } finally {
    p.kill();
  }
});

test("tools/call allowed: call passes through; response returns to client", async () => {
  const p = spawnProxy("alpha,beta");
  try {
    p.write({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "alpha", arguments: {} },
    });
    const resp = await p.readNext();
    expect(resp["id"]).toBe(2);
    const result = resp["result"] as Record<string, unknown>;
    const content = result["content"] as Record<string, unknown>[];
    expect(content.at(0)?.["text"]).toBe("called:alpha");
  } finally {
    p.kill();
  }
});

test("tools/call rejected: non-allowlisted tool gets -32601; upstream never receives it", async () => {
  const callLog = join(tmpdir(), `call-log-${String(Date.now())}.txt`);
  const p = spawnProxy("alpha,beta", { CALL_LOG: callLog });
  try {
    p.write({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "gamma", arguments: {} },
    });
    const resp = await p.readNext();
    expect(resp["id"]).toBe(3);
    const error = resp["error"] as Record<string, unknown>;
    expect(error["code"]).toBe(-32601);
    // Wait briefly — if upstream received the call it would have written to callLog
    await new Promise((r) => setTimeout(r, 150));
    const logged = existsSync(callLog) ? readFileSync(callLog, "utf8").trim() : "";
    expect(logged).toBe("");
  } finally {
    p.kill();
    rmQuiet(callLog);
  }
});

test("batch tools/call mixed allowlist: rejects forbidden call and forwards allowed calls", async () => {
  const callLog = join(tmpdir(), `call-log-${String(Date.now())}.txt`);
  const p = spawnProxy("alpha,beta", { CALL_LOG: callLog });
  try {
    p.write([
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "alpha", arguments: {} } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "gamma", arguments: {} } },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "beta", arguments: {} } },
    ]);
    const resp = await p.readBatch();
    expect(resp.map((r) => r["id"]).sort()).toEqual([4, 5, 6]);
    for (const item of resp) {
      expect((item["error"] as Record<string, unknown>)["code"]).toBe(-32601);
    }
    await new Promise((r) => setTimeout(r, 150));
    const logged = existsSync(callLog) ? readFileSync(callLog, "utf8").trim() : "";
    expect(logged).toBe("");
  } finally {
    p.kill();
    rmQuiet(callLog);
  }
});

test("batch tools/call all forbidden: rejects whole batch and never forwards upstream", async () => {
  const callLog = join(tmpdir(), `call-log-${String(Date.now())}.txt`);
  const p = spawnProxy("alpha,beta", { CALL_LOG: callLog });
  try {
    p.write([
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "gamma", arguments: {} } },
      { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "delta", arguments: {} } },
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "epsilon", arguments: {} } },
    ]);
    const resp = await p.readBatch();
    expect(resp.map((r) => r["id"]).sort()).toEqual([7, 8, 9]);
    for (const item of resp) {
      expect((item["error"] as Record<string, unknown>)["code"]).toBe(-32601);
    }
    await new Promise((r) => setTimeout(r, 150));
    const logged = existsSync(callLog) ? readFileSync(callLog, "utf8").trim() : "";
    expect(logged).toBe("");
  } finally {
    p.kill();
    rmQuiet(callLog);
  }
});

test("batch tools/call all allowed: batch passthrough and batch responses", async () => {
  const p = spawnProxy("alpha,beta,gamma");
  try {
    p.write([
      { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "alpha", arguments: {} } },
      { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "beta", arguments: {} } },
      { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "gamma", arguments: {} } },
    ]);
    const resp = await p.readNext();
    expect(Array.isArray(resp)).toBe(true);
    const batch = resp as unknown as Record<string, unknown>[];
    expect(batch.map((r) => r["id"]).sort()).toEqual([10, 11, 12]);
  } finally {
    p.kill();
  }
});

test("duplicate id rejection: second in-flight request with same id gets -32600", async () => {
  const p = spawnProxy("alpha,beta");
  try {
    p.write({ jsonrpc: "2.0", id: 1, method: "stall", params: {} });
    p.write({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
    const resp = await p.readNext();
    expect(resp).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: "duplicate id" },
    });
  } finally {
    p.kill();
  }
});

test("pendingMethod cap evicts oldest entries after 256 in-flight requests", () => {
  expect(pendingMethodCap()).toBe(256);
});

test("passthrough: non-tool methods (initialize, ping) pass verbatim", async () => {
  const p = spawnProxy("alpha");
  try {
    p.write({
      jsonrpc: "2.0",
      id: 10,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    const resp = await p.readNext();
    expect(resp["id"]).toBe(10);
    expect(resp["result"]).toBeDefined();

    p.write({ jsonrpc: "2.0", id: 11, method: "ping", params: {} });
    const resp2 = await p.readNext();
    expect(resp2["id"]).toBe(11);
    expect(resp2["result"]).toBeDefined();
  } finally {
    p.kill();
  }
});

// ── parseShellArgs unit tests ─────────────────────────────────────────────────

test("parseShellArgs: simple space-separated tokens", () => {
  expect(parseShellArgs("a b")).toEqual(["a", "b"]);
});

test("parseShellArgs: double-quoted arg preserves interior spaces", () => {
  expect(parseShellArgs('a "b c"')).toEqual(["a", "b c"]);
});

test("parseShellArgs: multiple consecutive spaces between tokens", () => {
  expect(parseShellArgs("a   b")).toEqual(["a", "b"]);
});

test("parseShellArgs: unquoted path with spaces splits on whitespace", () => {
  expect(parseShellArgs("/path/with spaces/x")).toEqual(["/path/with", "spaces/x"]);
});

test("parseShellArgs: quoted multi-arg with extra whitespace", () => {
  expect(parseShellArgs('  "hello world"   foo  ')).toEqual(["hello world", "foo"]);
});

test("parseShellArgs: single-quoted arg preserves interior spaces", () => {
  expect(parseShellArgs("uvx --from '/some/path with spaces' ha-mcp")).toEqual([
    "uvx",
    "--from",
    "/some/path with spaces",
    "ha-mcp",
  ]);
});

test("parseShellArgs: throws on unbalanced quote", () => {
  expect(() => parseShellArgs('"unclosed')).toThrow("unbalanced quote");
});

test("exits when its stdin closes (parent ACP seat died) — prevents orphaned proxies", async () => {
  const proc = spawn("bun", [PROXY], {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      MCP_PROXY_UPSTREAM: `bun "${FIXTURE_PATH}"`,
      MCP_PROXY_ALLOWLIST: "alpha",
    },
  });

  // Confirm the proxy + its upstream child are live (round-trip a tools/list).
  let buf = "";
  const gotResponse = new Promise<void>((resolve) => {
    proc.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes('"result"')) resolve();
    });
  });
  proc.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\n",
  );
  await Promise.race([gotResponse, new Promise((r) => setTimeout(r, 4000))]);

  // Simulate the parent ACP seat dying: its end of the stdio pipe closes, so the
  // proxy's process.stdin reaches EOF. The proxy must then tear down (kill its
  // upstream child) and exit, rather than orphaning to ppid=1 and running forever.
  proc.stdin.end();
  const outcome = await waitForExitOrTimeout(proc, 5000);
  expect(outcome).toBe("exited");
}, 15000);

test("force-kills a SIGTERM-ignoring upstream child on parent death (no re-orphan)", async () => {
  const trapPath = join(tmpdir(), `trap-fixture-${String(Date.now())}.ts`);
  const pidFile = join(tmpdir(), `trap-pid-${String(Date.now())}.txt`);
  // Upstream that TRAPS SIGTERM (ignores it) and stays alive — models a
  // third-party uvx/python MCP. Without SIGKILL escalation it would re-orphan.
  writeFileSync(
    trapPath,
    `import { writeFileSync } from "node:fs";
import readline from "node:readline";
process.on("SIGTERM", () => {});
readline.createInterface({ input: process.stdin });
writeFileSync(process.env.TRAP_PID_FILE, String(process.pid));
setInterval(() => {}, 60000);
`,
  );
  try {
    const proc = spawn("bun", [PROXY], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        MCP_PROXY_UPSTREAM: `bun "${trapPath}"`,
        MCP_PROXY_ALLOWLIST: "alpha",
        TRAP_PID_FILE: pidFile,
      },
    });

    const childPid = await pollForPid(pidFile, 50);
    expect(childPid).toBeGreaterThan(0);

    // Parent dies → proxy stdin EOF. SIGTERM is trapped, so the proxy must
    // escalate to SIGKILL and only then exit — leaving no orphaned child.
    proc.stdin.end();
    const outcome = await waitForExitOrTimeout(proc, 8000);
    expect(outcome).toBe("exited");

    // The trapping child must have been reaped (SIGKILL), not left orphaned.
    const dead = await waitUntilPidDead(childPid, 30);
    if (!dead) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
    expect(dead).toBe(true);
  } finally {
    rmQuiet(trapPath);
    rmQuiet(pidFile);
  }
}, 20000);

test("group-kills upstream grandchildren on parent death (uvx-style wrapper, no orphan)", async () => {
  const wrapperPath = join(tmpdir(), `gc-wrapper-${String(Date.now())}.ts`);
  const gcPidFile = join(tmpdir(), `gc-pid-${String(Date.now())}.txt`);
  // Upstream WRAPPER that spawns a long-lived GRANDCHILD, modelling uvx -> python:
  // the proxy's DIRECT child is the wrapper; the real MCP is the grandchild.
  // Killing only the direct child reparents the grandchild to pid 1 — the orphan
  // leak. The proxy must group-kill so the whole process tree dies.
  writeFileSync(
    wrapperPath,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import readline from "node:readline";
readline.createInterface({ input: process.stdin });
const gc = spawn("sleep", ["600"], { stdio: "ignore" });
writeFileSync(process.env.GC_PID_FILE, String(gc.pid));
setInterval(() => {}, 60000);
`,
  );
  try {
    const proc = spawn("bun", [PROXY], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        MCP_PROXY_UPSTREAM: `bun "${wrapperPath}"`,
        MCP_PROXY_ALLOWLIST: "alpha",
        GC_PID_FILE: gcPidFile,
      },
    });

    const gcPid = await pollForPid(gcPidFile, 50);
    expect(gcPid).toBeGreaterThan(0);
    // The grandchild is alive right now.
    expect(() => process.kill(gcPid, 0)).not.toThrow();

    // Parent ACP seat dies → proxy stdin EOF → the proxy must group-kill the
    // whole upstream tree (wrapper + grandchild) and exit, leaving no orphan.
    proc.stdin.end();
    const outcome = await waitForExitOrTimeout(proc, 8000);
    expect(outcome).toBe("exited");

    // The grandchild must have been reaped, not left orphaned to pid 1.
    const dead = await waitUntilPidDead(gcPid, 30);
    if (!dead) {
      // Clean up the leaked grandchild so a RED run does not leave a stray sleep.
      try {
        process.kill(gcPid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
    expect(dead).toBe(true);
  } finally {
    rmQuiet(wrapperPath);
    rmQuiet(gcPidFile);
  }
}, 20000);
