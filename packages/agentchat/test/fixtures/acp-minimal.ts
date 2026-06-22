#!/usr/bin/env bun
import { createInterface } from "node:readline";

interface JsonRpcRequest {
  method?: unknown;
  id?: unknown;
  params?: { sessionId?: unknown } | undefined;
}

const rl = createInterface({ input: process.stdin, terminal: false });

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line) as JsonRpcRequest;
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, authMethods: [] } });
    return;
  }
  if (request.method === "session/new") {
    send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "minimal-session" } });
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
