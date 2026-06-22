import { spawn } from "node:child_process";
import readline from "node:readline";

type ParseState = { cur: string; out: string[]; quote: '"' | "'" | null };

function handleQuotedChar(c: string, state: ParseState): void {
  if (c === state.quote) {
    state.quote = null;
    return;
  }
  state.cur += c;
}

function handleUnquotedChar(c: string, state: ParseState): void {
  if (c === '"' || c === "'") {
    state.quote = c;
    return;
  }
  if (/\s/.test(c)) {
    if (state.cur) {
      state.out.push(state.cur);
      state.cur = "";
    }
    return;
  }
  state.cur += c;
}

export function parseShellArgs(s: string): string[] {
  const state: ParseState = { cur: "", out: [], quote: null };
  for (const c of s) {
    if (state.quote !== null) {
      handleQuotedChar(c, state);
    } else {
      handleUnquotedChar(c, state);
    }
  }
  if (state.cur) state.out.push(state.cur);
  if (state.quote !== null) throw new Error("unbalanced quote");
  return state.out;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

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

function getStringField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = obj?.[key];
  return typeof v === "string" ? v : undefined;
}

if (import.meta.main) {
  const upstreamCmd = parseShellArgs(must("MCP_PROXY_UPSTREAM"));
  const [command, ...args] = upstreamCmd;
  if (!command) throw new Error("MCP_PROXY_UPSTREAM did not include a command");
  const allowlist = new Set(
    must("MCP_PROXY_ALLOWLIST")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
    // Own process group (group leader) so teardown can group-kill the WHOLE
    // upstream tree — a uvx/python wrapper plus its grandchildren — not just the
    // direct child. Without this, killing child.pid reparents grandchildren to
    // pid 1: the orphan-accumulation leak. Mirrors acp-server.ts / stdio-acp-server.ts.
    detached: process.platform !== "win32",
  });

  const pendingMethod = new Map<string | number, string>();

  const clientLines = readline.createInterface({ input: process.stdin });
  const upstreamLines = readline.createInterface({ input: child.stdout });

  function writeJsonRpc(value: unknown): void {
    process.stdout.write(JSON.stringify(value) + "\n");
  }

  function queuePendingMethod(id: string | number, method: string): boolean {
    if (pendingMethod.has(id)) {
      writeJsonRpc({
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "duplicate id" },
      });
      return false;
    }
    if (pendingMethod.size >= PENDING_METHOD_CAP) {
      const oldest = pendingMethod.keys().next().value;
      if (oldest !== undefined) {
        process.stderr.write(`[mcp-allowlist-proxy] evicting pending id ${String(oldest)}\n`);
        pendingMethod.delete(oldest);
      }
    }
    pendingMethod.set(id, method);
    return true;
  }

  function rejectBatch(batch: JsonRpcMessage[], reason: string): void {
    const responses = batch
      .filter((msg) => msg.id !== undefined)
      .map((msg) => ({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: reason },
      }));
    if (responses.length > 0) writeJsonRpc(responses);
  }

  function checkBatchAllowlist(msg: JsonRpcMessage[]): boolean {
    for (const item of msg) {
      if (item.method !== "tools/call") continue;
      const name = getStringField(item.params, "name");
      if (!allowlist.has(name ?? "")) {
        rejectBatch(msg, `tool not in allowlist: ${name ?? "<unknown>"}`);
        return false;
      }
    }
    return true;
  }

  function processBatchMessage(msg: JsonRpcMessage[]): void {
    if (!checkBatchAllowlist(msg)) return;
    for (const item of msg) {
      if (item.id !== undefined && item.method) {
        if (!queuePendingMethod(item.id, item.method)) return;
      }
    }
    child.stdin.write(JSON.stringify(msg) + "\n");
  }

  function processSingleMessage(msg: JsonRpcMessage): void {
    if (msg.method === "tools/call") {
      const name = getStringField(msg.params, "name");
      if (!allowlist.has(name ?? "")) {
        if (msg.id !== undefined) {
          writeJsonRpc({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: `tool not in allowlist: ${name ?? "<unknown>"}` },
          });
        }
        return;
      }
    }
    if (msg.id !== undefined && msg.method) {
      if (!queuePendingMethod(msg.id, msg.method)) return;
    }
    child.stdin.write(JSON.stringify(msg) + "\n");
  }

  function processClientMessage(msg: JsonRpcMessage | JsonRpcMessage[]): void {
    if (Array.isArray(msg)) {
      processBatchMessage(msg);
      return;
    }
    processSingleMessage(msg);
  }

  function processUpstreamMessage(msg: JsonRpcMessage | JsonRpcMessage[]): void {
    if (Array.isArray(msg)) {
      const out = msg.map((item) => filterUpstreamItem(item));
      writeJsonRpc(out);
      return;
    }
    writeJsonRpc(filterUpstreamItem(msg));
  }

  function filterUpstreamItem(msg: JsonRpcMessage): JsonRpcMessage {
    const { id } = msg;
    if (id === undefined) return msg;
    const method = pendingMethod.get(id);
    if (method === undefined) return msg;
    pendingMethod.delete(id);
    if (method !== "tools/list") return msg;
    const { result } = msg;
    if (result === undefined) return msg;
    const tools = result["tools"];
    if (!Array.isArray(tools)) return msg;
    result["tools"] = (tools as Record<string, unknown>[]).filter((t) => {
      const name = t["name"];
      return typeof name === "string" && allowlist.has(name);
    });
    return msg;
  }

  clientLines.on("line", (line) => {
    if (!line.trim()) return;
    let msg: JsonRpcMessage | JsonRpcMessage[];
    try {
      msg = JSON.parse(line) as JsonRpcMessage | JsonRpcMessage[];
    } catch {
      child.stdin.write(line + "\n");
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

  // Signal the upstream child's whole PROCESS GROUP. The child is spawned
  // detached (its own group leader), so a uvx/python wrapper's grandchildren
  // share its group and a negative-pid kill reaps the entire tree. Gated by
  // PENUMBRA_OPENCODE_GROUP_KILL so a single env flip falls back to a
  // direct-child kill (mirrors acp-server.ts:189-200). Wrapped in try/catch: a
  // negative-pid kill of an already-reaped group throws ESRCH, and a missing pid
  // would throw TypeError.
  const signalProcess = (signal: NodeJS.Signals): void => {
    if (!child.pid) return;
    try {
      if (process.platform !== "win32" && process.env["PENUMBRA_OPENCODE_GROUP_KILL"] !== "0") {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      /* process/group may already be gone */
    }
  };

  // When the direct child exits, sweep its group once more before we exit: a
  // wrapper that spawns-and-abandons a grandchild could otherwise exit first and
  // leave the grandchild alive (the process group persists while any member
  // lives). The group SIGKILL is a no-op (swallowed ESRCH) when the tree is
  // already gone — the common cooperative case.
  child.on("exit", (code: number | null) => {
    signalProcess("SIGKILL");
    process.exit(code ?? 0);
  });

  // Teardown shared by parent-death (stdin EOF), SIGTERM, and SIGINT.
  //
  // This proxy is spawned as an ACP seat's MCP server, so its parent is the ACP
  // agent process. If that parent dies ABRUPTLY (worker server.kill on eviction,
  // a seat crash, or a daemon/worker restart) without a clean signal reaching us,
  // our stdin (the JSON-RPC request channel) hits EOF. Without teardown the proxy
  // — and its upstream child tree — run forever, reparented to ppid=1: the
  // orphan-accumulation leak. stdin stays open for the whole session during
  // normal operation, so EOF unambiguously means the parent is gone.
  //
  // Group-SIGTERM the upstream tree; child.on("exit") above exits us the instant
  // the direct child dies (the cooperative penumbra-mcp upstream does this
  // immediately). If the tree traps or delays SIGTERM — e.g. a third-party
  // uvx/python MCP wrapped as upstream — escalate to a group SIGKILL after a
  // grace window so it can't itself re-orphan, then exit regardless. Never exit
  // while the child tree may still be alive and un-signalled.
  let shuttingDown = false;
  const teardownAndExit = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    signalProcess("SIGTERM");
    setTimeout(() => {
      signalProcess("SIGKILL");
      process.exit(0);
    }, 1000);
  };
  process.stdin.on("end", teardownAndExit);
  clientLines.on("close", teardownAndExit);
  process.on("SIGTERM", teardownAndExit);
  process.on("SIGINT", teardownAndExit);
}
