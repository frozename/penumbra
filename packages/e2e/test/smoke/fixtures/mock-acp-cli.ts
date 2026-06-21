#!/usr/bin/env bun
import { createInterface } from "node:readline";

interface JsonRpcRequestIn {
  jsonrpc?: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

const rl = createInterface({ input: process.stdin });
const SESSION_ID = "mock-acp-session-1";

function send(msg: object): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handleLine(line: string): Promise<void> {
  let req: JsonRpcRequestIn;
  try {
    req = JSON.parse(line) as JsonRpcRequestIn;
  } catch {
    return;
  }
  if (typeof req.method !== "string") {
    return;
  }

  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: 1, capabilities: {} } });
    return;
  }
  if (req.method === "session/new") {
    send({ jsonrpc: "2.0", id: req.id, result: { sessionId: SESSION_ID } });
    return;
  }
  if (req.method === "session/prompt") {
    const notify = (update: object): void => {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION_ID, update } });
    };

    notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "PHRASE_RESPONSE_AAA" },
    });
    notify({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "PHRASE_THOUGHT_BBB" },
    });
    notify({
      sessionUpdate: "tool_call",
      toolCallId: "tc-1",
      status: "pending",
      input: { path: "a.ts" },
    });
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      status: "completed",
      output: { ok: true },
    });

    await new Promise((r) => setTimeout(r, 20));
    send({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } });
  }
}

rl.on("line", (line) => {
  void handleLine(line);
});
