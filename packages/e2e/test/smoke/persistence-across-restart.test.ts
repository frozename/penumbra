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

beforeEach(() => {
  sb = makeSandbox();
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

interface RecallPayload {
  results: { tier: string; body: string }[];
}

async function observeAndEnd(): Promise<void> {
  if (!daemon) throw new Error("daemon not started");
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
      source_detail: "e2e-persist",
      session_id: "s-persist",
      event_type: "agent-prompt",
      lane: "local",
      project_id: "proj-persist",
      payload_json: { prompt: "persist this content across a restart" },
      payload_summary: "persist this content across a restart",
    },
  });
  await client.request("tools/call", {
    name: "session_end",
    arguments: { session_id: "s-persist" },
  });
  await client.close();
  await killGracefully(mcp);
  mcp = null;
}

async function recall(): Promise<{ tier: string; body: string }[]> {
  if (!daemon) throw new Error("daemon not started");
  mcp = spawnPenumbraMcp(sb.dir);
  const client = new JsonRpcStdioClient(mcp);
  await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "penumbra-e2e", version: "0.0.0" },
  });
  await client.notify("notifications/initialized");
  const r = await client.request("tools/call", {
    name: "memory_recall",
    arguments: { query: "persist this content", project_id: "proj-persist", limit: 5 },
  });
  await client.close();
  await killGracefully(mcp);
  mcp = null;
  return parseToolResultJson<RecallPayload>(r).results;
}

test("observed content survives daemon restart", async () => {
  expect((await captureOutput(spawnPenumbra(["init"], sb.dir))).exitCode).toBe(0);

  // Run 1: start, observe + end, stop.
  daemon = spawnPenumbra(["start"], sb.dir);
  drainOutput(daemon); // prevent stdout buffer deadlock
  await waitForPortFile(sb.dir, 5000);
  await observeAndEnd();
  await captureOutput(spawnPenumbra(["stop"], sb.dir));
  await killGracefully(daemon);
  daemon = null;

  // Run 2: start again, recall.
  daemon = spawnPenumbra(["start"], sb.dir);
  drainOutput(daemon); // prevent stdout buffer deadlock
  await waitForPortFile(sb.dir, 5000);
  const results = await recall();
  expect(results.length).toBe(1);
  expect(results[0]!.tier).toBe("t1");
  expect(results[0]!.body).toContain("persist");
}, 60_000);
