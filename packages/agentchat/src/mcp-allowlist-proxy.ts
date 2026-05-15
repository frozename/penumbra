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

  clientLines.on("line", (line) => {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      child.stdin!.write(line + "\n");
      return;
    }
    if (msg["method"] === "tools/call") {
      const params = msg["params"] as Record<string, unknown> | undefined;
      const name = params?.["name"] as string | undefined;
      if (!allowlist.has(name ?? "")) {
        if (msg["id"] !== undefined) {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg["id"],
              error: { code: -32601, message: `tool not in allowlist: ${name}` },
            }) + "\n"
          );
        }
        return;
      }
    }
    if (msg["id"] !== undefined && msg["method"]) {
      pendingMethod.set(msg["id"] as string | number, msg["method"] as string);
    }
    child.stdin!.write(line + "\n");
  });

  upstreamLines.on("line", (line) => {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      process.stdout.write(line + "\n");
      return;
    }
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
          process.stdout.write(JSON.stringify(msg) + "\n");
          return;
        }
      }
    }
    process.stdout.write(line + "\n");
  });

  child.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.on("SIGINT", () => child.kill("SIGINT"));
}
