#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { buildServer } from "../src/server.js";
import { DaemonClient } from "../src/daemon-client.js";
import { resolveDaemonStorageRoot } from "@penumbra/core";

let root: string;
try {
  root = resolveDaemonStorageRoot();
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
