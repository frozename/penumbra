#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildServer } from "../src/server.js";
import { DaemonClient } from "../src/daemon-client.js";
import { resolveDaemonStorageRoot } from "@penumbra/core";

let root: string;
try {
  // This server is a daemon CLIENT: it needs the daemon's token/port, not the
  // per-dispatch PENUMBRA_STORAGE_ROOT (which, for a use_worktree dispatch,
  // points at the worktree's DB root and has no token/port). requireConnectionFiles
  // makes it fall through to the canonical daemon root in that case.
  root = resolveDaemonStorageRoot({ requireConnectionFiles: true });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const tokenPath = join(root, "token");
const portPath = join(root, "port");

if (!existsSync(tokenPath) || !existsSync(portPath)) {
  console.error(
    `penumbra-mcp: missing ${tokenPath} or ${portPath}. Run 'penumbra init' + 'penumbra start' first.`,
  );
  process.exit(1);
}

// Resolve port + token on every request. `penumbra start` chooses a free OS
// port each invocation, so a long-lived MCP process must re-read these files
// to survive a daemon restart instead of caching a stale port.
const daemon = new DaemonClient({
  resolve: () => {
    const token = readFileSync(tokenPath, "utf8").trim();
    const port = readFileSync(portPath, "utf8").trim();
    if (!token) throw new Error(`penumbra-mcp: token file ${tokenPath} is empty.`);
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      throw new Error(
        `penumbra-mcp: port file ${portPath} does not contain a valid port (got: '${port}').`,
      );
    }
    return { baseUrl: `http://127.0.0.1:${portNum}`, token };
  },
});

const server = await buildServer({ daemon });
const transport = new StdioServerTransport();
await server.connect(transport);

// Parent-death teardown. This MCP server runs as a child of an ACP agent (or the
// mcp-allowlist-proxy). The SDK's StdioServerTransport listens for stdin
// 'data'/'error' but not 'end', so on abrupt parent death (no clean SIGTERM
// reaching us) this process would reparent to ppid=1 and run forever — the same
// orphan-accumulation class fixed in mcp-allowlist-proxy. Our stdin is the
// JSON-RPC request channel and stays open for the whole session, so EOF
// unambiguously means the parent is gone: close the server (flush) and exit, with
// a hard-exit fallback if close() stalls so we can never hang as an orphan.
let shuttingDown = false;
const shutdown = (reason: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  // Diagnose the stdin-EOF path on stderr (inherited by the parent's logs): a
  // spec-compliant client keeps stdin open as the request channel, so an EOF
  // here is a gone parent — but a misconfigured spawner that hands us /dev/null
  // (pre-closed) stdin trips the same path at startup. Logging makes that
  // misconfig diagnosable instead of a silent no-op. SIGTERM/SIGINT are clean.
  if (reason === "stdin-eof") {
    console.error("penumbra-mcp: stdin closed (parent gone or stdin not piped) — shutting down");
  }
  const hardExit = setTimeout(() => process.exit(0), 2000);
  void Promise.resolve(server.close())
    .catch(() => {})
    .finally(() => {
      clearTimeout(hardExit);
      process.exit(0);
    });
};
process.stdin.on("end", () => shutdown("stdin-eof"));
process.stdin.on("close", () => shutdown("stdin-eof"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
