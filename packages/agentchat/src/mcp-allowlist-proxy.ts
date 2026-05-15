import { spawn } from "node:child_process";
import readline from "node:readline";

export function parseShellArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      cur += c;
    } else {
      if (c === '"' || c === "'") { quote = c; continue; }
      if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ""; } continue; }
      cur += c;
    }
  }
  if (cur) out.push(cur);
  if (quote) throw new Error("unbalanced quote");
  return out;
}

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
};

const PENDING_METHOD_CAP = 256;

export function pendingMethodCap(): number {
  return PENDING_METHOD_CAP;
}

function must(k: string): string {
  const v = process.env[k];
  if (!v) {
    process.stderr.write(`[mcp-allowlist-proxy] missing env ${k}\n`);
    process.exit(2);
  }
  return v;
}

if (import.meta.main) {
  const upstreamCmd = parseShellArgs(must("MCP_PROXY_UPSTREAM"));
  const allowlist = new Set(
    must("MCP_PROXY_ALLOWLIST").split(",").map((s) => s.trim()).filter(Boolean)
  );

  const child = spawn(upstreamCmd[0], upstreamCmd.slice(1), {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });

  const pendingMethod = new Map<string | number, string>();

  const clientLines = readline.createInterface({ input: process.stdin });
  const upstreamLines = readline.createInterface({ input: child.stdout! });

  function writeJsonRpc(value: unknown) {
    process.stdout.write(JSON.stringify(value) + "\n");
  }

  function queuePendingMethod(id: string | number, method: string) {
    if (pendingMethod.has(id)) {
      writeJsonRpc({
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "duplicate id" },
      });
      return false;
    }
    if (pendingMethod.size >= PENDING_METHOD_CAP) {
      const oldest = pendingMethod.keys().next().value as string | number | undefined;
      if (oldest !== undefined) {
        process.stderr.write(`[mcp-allowlist-proxy] evicting pending id ${String(oldest)}\n`);
        pendingMethod.delete(oldest);
      }
    }
    pendingMethod.set(id, method);
    return true;
  }

  function rejectBatch(batch: JsonRpcMessage[], reason: string) {
    const responses = batch
      .filter((msg) => msg.id !== undefined)
      .map((msg) => ({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: reason },
      }));
    if (responses.length > 0) writeJsonRpc(responses);
  }

  function processClientMessage(msg: JsonRpcMessage | JsonRpcMessage[]) {
    if (Array.isArray(msg)) {
      for (const item of msg) {
        if (item.method === "tools/call") {
          const params = item.params as Record<string, unknown> | undefined;
          const name = params?.["name"] as string | undefined;
          if (!allowlist.has(name ?? "")) {
            rejectBatch(msg, `tool not in allowlist: ${name}`);
            return;
          }
        }
      }
      for (const item of msg) {
        if (item.id !== undefined && item.method) {
          if (!queuePendingMethod(item.id, item.method)) return;
        }
      }
      child.stdin!.write(JSON.stringify(msg) + "\n");
      return;
    }
    if (msg["method"] === "tools/call") {
      const params = msg["params"] as Record<string, unknown> | undefined;
      const name = params?.["name"] as string | undefined;
      if (!allowlist.has(name ?? "")) {
        if (msg["id"] !== undefined) {
          writeJsonRpc({
            jsonrpc: "2.0",
            id: msg["id"],
            error: { code: -32601, message: `tool not in allowlist: ${name}` },
          });
        }
        return;
      }
    }
    if (msg["id"] !== undefined && msg["method"]) {
      if (!queuePendingMethod(msg["id"] as string | number, msg["method"] as string)) return;
    }
    child.stdin!.write(JSON.stringify(msg) + "\n");
  }

  function processUpstreamMessage(msg: JsonRpcMessage | JsonRpcMessage[]) {
    if (Array.isArray(msg)) {
      const out = msg.map((item) => filterUpstreamItem(item));
      writeJsonRpc(out);
      return;
    }
    writeJsonRpc(filterUpstreamItem(msg));
  }

  function filterUpstreamItem(msg: JsonRpcMessage) {
    const id = msg["id"] as string | number | undefined;
    if (id !== undefined && pendingMethod.has(id)) {
      const method = pendingMethod.get(id)!;
      pendingMethod.delete(id);
      if (method === "tools/list") {
        const result = msg["result"] as Record<string, unknown> | undefined;
        if (result?.["tools"]) {
          result["tools"] = (result["tools"] as Array<Record<string, unknown>>).filter(
            (t) => allowlist.has(t["name"] as string)
          );
        }
      }
    }
    return msg;
  }

  clientLines.on("line", (line) => {
    if (!line.trim()) return;
    let msg: JsonRpcMessage | JsonRpcMessage[];
    try {
      msg = JSON.parse(line) as JsonRpcMessage | JsonRpcMessage[];
    } catch {
      child.stdin!.write(line + "\n");
      return;
    }
    processClientMessage(msg);
  });

  upstreamLines.on("line", (line) => {
    if (!line.trim()) return;
    let msg: JsonRpcMessage | JsonRpcMessage[];
    try {
      msg = JSON.parse(line) as JsonRpcMessage | JsonRpcMessage[];
    } catch {
      process.stdout.write(line + "\n");
      return;
    }
    processUpstreamMessage(msg);
  });

  child.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.on("SIGINT", () => child.kill("SIGINT"));
}
