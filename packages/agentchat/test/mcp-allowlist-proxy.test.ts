import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { parseShellArgs } from "../src/mcp-allowlist-proxy.js";

const PROXY = new URL("../src/mcp-allowlist-proxy.ts", import.meta.url).pathname;

const FIXTURE_PATH = join(tmpdir(), `mcp-fixture-${Date.now()}.ts`);

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
rl.on("line", (line: string) => {
  if (!line.trim()) return;
  let msg: any;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools } }) + "\\n");
  } else if (msg.method === "tools/call") {
    const name = msg.params?.name;
    if (process.env.CALL_LOG) appendFileSync(process.env.CALL_LOG, name + "\\n");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "called:" + name }] } }) + "\\n");
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
  }
});
`;

beforeAll(() => {
  writeFileSync(FIXTURE_PATH, FIXTURE_CODE);
});

afterAll(() => {
  try { rmSync(FIXTURE_PATH); } catch { /* ignore */ }
});

interface Proxy {
  write: (msg: object) => void;
  readNext: (timeoutMs?: number) => Promise<Record<string, unknown>>;
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
  const waiters: Array<(l: string) => void> = [];

  proc.stdout!.on("data", (chunk: Buffer) => {
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

  const write = (msg: object) => proc.stdin!.write(JSON.stringify(msg) + "\n");

  const readNext = (timeoutMs = 4000): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("readNext timed out")), timeoutMs);
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

  const kill = () => { try { proc.kill("SIGTERM"); } catch { /* ignore */ } };

  return { write, readNext, kill };
}

// ── Proxy behavior tests ──────────────────────────────────────────────────────

test("tools/list filtered: upstream returns 5 tools; allowlist 2; client sees 2", async () => {
  const p = spawnProxy("alpha,beta");
  try {
    p.write({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const resp = await p.readNext();
    expect(resp["id"]).toBe(1);
    const result = resp["result"] as Record<string, unknown>;
    const tools = result["tools"] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t["name"])).toEqual(["alpha", "beta"]);
  } finally {
    p.kill();
  }
});

test("tools/call allowed: call passes through; response returns to client", async () => {
  const p = spawnProxy("alpha,beta");
  try {
    p.write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "alpha", arguments: {} } });
    const resp = await p.readNext();
    expect(resp["id"]).toBe(2);
    const result = resp["result"] as Record<string, unknown>;
    const content = result["content"] as Array<Record<string, unknown>>;
    expect(content[0]["text"]).toBe("called:alpha");
  } finally {
    p.kill();
  }
});

test("tools/call rejected: non-allowlisted tool gets -32601; upstream never receives it", async () => {
  const callLog = join(tmpdir(), `call-log-${Date.now()}.txt`);
  const p = spawnProxy("alpha,beta", { CALL_LOG: callLog });
  try {
    p.write({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "gamma", arguments: {} } });
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
    try { rmSync(callLog); } catch { /* ignore */ }
  }
});

test("passthrough: non-tool methods (initialize, ping) pass verbatim", async () => {
  const p = spawnProxy("alpha");
  try {
    p.write({
      jsonrpc: "2.0", id: 10, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
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
    "uvx", "--from", "/some/path with spaces", "ha-mcp",
  ]);
});

test("parseShellArgs: throws on unbalanced quote", () => {
  expect(() => parseShellArgs('"unclosed')).toThrow("unbalanced quote");
});
