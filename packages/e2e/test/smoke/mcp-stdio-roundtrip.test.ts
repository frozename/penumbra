import { afterEach, beforeEach, expect, test } from "bun:test";

import { JsonRpcStdioClient } from "../helpers/jsonrpc-stdio.js";
import { parseToolResultJson } from "../helpers/mcp-envelope.js";
import { makeSandbox, type Sandbox } from "../helpers/sandbox.js";
import {
  type BunSubprocess,
  captureOutput,
  drainOutput,
  killGracefully,
  spawnPenumbra,
  spawnPenumbraMcp,
  waitForPortFile,
} from "../helpers/spawn-bin.js";

let sb: Sandbox;
let daemon: BunSubprocess | null = null;
let mcp: BunSubprocess | null = null;

beforeEach(async () => {
  sb = makeSandbox();
  expect((await captureOutput(spawnPenumbra(["init"], sb.dir))).exitCode).toBe(0);
  daemon = spawnPenumbra(["start"], sb.dir);
  drainOutput(daemon); // prevent stdout buffer deadlock
  await waitForPortFile(sb.dir, 5000);
});

afterEach(async () => {
  if (mcp) {
    await killGracefully(mcp);
    mcp = null;
  }
  if (daemon) {
    await captureOutput(spawnPenumbra(["stop"], sb.dir));
    await killGracefully(daemon);
    daemon = null;
  }
  sb.cleanup();
});

test("observe → session.end → recall round-trip via stdio MCP", async () => {
  mcp = spawnPenumbraMcp(sb.dir);
  const client = new JsonRpcStdioClient(mcp);

  await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "penumbra-e2e", version: "0.0.0" },
  });
  await client.notify("notifications/initialized");

  await client.request("tools/call", {
    name: "memory_observe",
    arguments: {
      ts: new Date().toISOString(),
      source: "mcp",
      source_detail: "e2e-stdio",
      session_id: "s-stdio",
      event_type: "agent-prompt",
      lane: "local",
      project_id: "proj-stdio",
      payload_json: { prompt: "refactor auth middleware" },
      payload_summary: "refactor auth middleware",
    },
  });

  await client.request("tools/call", {
    name: "memory_observe",
    arguments: {
      ts: new Date().toISOString(),
      source: "mcp",
      source_detail: "e2e-stdio",
      session_id: "s-stdio",
      event_type: "agent-response",
      lane: "local",
      project_id: "proj-stdio",
      payload_json: { response: "updated src/auth.ts" },
      payload_summary: "updated src/auth.ts",
    },
  });

  await client.request("tools/call", {
    name: "session_end",
    arguments: { session_id: "s-stdio" },
  });

  const recall = await client.request("tools/call", {
    name: "memory_recall",
    arguments: { query: "refactor auth middleware", project_id: "proj-stdio", limit: 5 },
  });
  const payload = parseToolResultJson<{ results: { tier: string; body: string }[] }>(recall);
  expect(payload.results.length).toBe(1);
  expect(payload.results[0]!.tier).toBe("t1");
  expect(payload.results[0]!.body).toContain("refactor");

  await client.close();
}, 45_000);
