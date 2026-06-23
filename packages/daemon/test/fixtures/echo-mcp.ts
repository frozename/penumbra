#!/usr/bin/env bun
import { stdin, stdout } from "node:process";

const delay = parseInt(process.env.ECHO_DELAY_MS ?? "0", 10);
let buf = "";

type JsonObject = Record<string, unknown>;
type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  method: string;
  id?: JsonRpcId;
  params?: JsonObject;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || typeof value === "number";
}

function parseJsonRpcRequest(line: string): JsonRpcRequest {
  const parsed = JSON.parse(line) as unknown;
  if (!isJsonObject(parsed) || typeof parsed.method !== "string") {
    throw new Error("invalid json-rpc request");
  }

  const request: JsonRpcRequest = { method: parsed.method };
  if (parsed.id !== undefined) {
    if (!isJsonRpcId(parsed.id)) {
      throw new Error("invalid json-rpc id");
    }
    request.id = parsed.id;
  }
  if (parsed.params !== undefined) {
    if (!isJsonObject(parsed.params)) {
      throw new Error("invalid json-rpc params");
    }
    request.params = parsed.params;
  }
  return request;
}

stdin.setEncoding("utf8");
stdin.on("data", (chunk) => {
  buf += String(chunk);
  let idx: number;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const req = parseJsonRpcRequest(line);
    setTimeout(() => {
      respond(req);
    }, delay);
  }
});

function respond(req: JsonRpcRequest): void {
  let result: JsonObject;
  if (req.method === "initialize") {
    result = { protocolVersion: "2025-03-26", capabilities: {} };
  } else if (req.method === "tools/list") {
    result = { tools: [{ name: "echo", description: "echoes its args" }] };
  } else if (req.method === "tools/call") {
    if (req.params?.name === "unknown") {
      stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: "method_not_found" },
        }) + "\n",
      );
      return;
    }
    result = { content: [{ type: "text", text: JSON.stringify(req.params.arguments ?? null) }] };
  } else {
    stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: "method_not_found" },
      }) + "\n",
    );
    return;
  }
  stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n");
}
