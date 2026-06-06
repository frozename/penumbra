#!/usr/bin/env bun
/**
 * Recording ACP fixture for the Phase 5 real-subprocess warm-reuse test.
 *
 * Like acp-minimal.ts it speaks the ACP protocol over real stdio pipes, but on
 * every session/new it (a) returns a UNIQUE sessionId (so the test can prove a
 * fresh session per dispatch) and (b) appends one JSON line to ACP_RECORD_FILE
 * capturing what THIS session/new actually received:
 *   - cwd                  — the per-dispatch cwd from session/new params
 *   - storageRoot          — PENUMBRA_STORAGE_ROOT re-injected into the penumbra
 *                            MCP server's env on session/new (the per-dispatch
 *                            value the adapter must NOT freeze across reuse)
 *   - processStorageRoot   — PENUMBRA_STORAGE_ROOT from the frozen PROCESS env
 *                            (set once at spawn; stale on a reused process)
 *   - sessionId            — the id this session/new minted
 * The test reads the file back and asserts the per-dispatch values are correct
 * even though one process served both dispatches.
 */
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const recordFile = process.env.ACP_RECORD_FILE;
const rl = createInterface({ input: process.stdin, terminal: false });
let sessionCounter = 0;

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function record(entry: unknown): void {
  if (recordFile) appendFileSync(recordFile, `${JSON.stringify(entry)}\n`);
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, authMethods: [] } });
    return;
  }
  if (request.method === "session/new") {
    sessionCounter += 1;
    const sessionId = `recorder-session-${sessionCounter}`;
    const servers = Array.isArray(request.params?.mcpServers) ? request.params.mcpServers : [];
    let storageRoot: unknown;
    for (const s of servers) {
      const env = Array.isArray(s?.env) ? s.env : [];
      const found = env.find((e: any) => e?.name === "PENUMBRA_STORAGE_ROOT");
      if (found) {
        storageRoot = found.value;
        break;
      }
    }
    record({
      cwd: request.params?.cwd,
      storageRoot,
      processStorageRoot: process.env.PENUMBRA_STORAGE_ROOT,
      sessionId,
    });
    send({ jsonrpc: "2.0", id: request.id, result: { sessionId } });
    return;
  }
  if (request.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: request.params?.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "ok" },
        },
      },
    });
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, result: {} });
});
