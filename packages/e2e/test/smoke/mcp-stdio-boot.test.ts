import { TOOL_REGISTRY } from "@penumbra/mcp";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { JsonRpcStdioClient } from "../helpers/jsonrpc-stdio.js";
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

test("penumbra-mcp boots, registers all MCP tools, exits 0 on stdin close", async () => {
  mcp = spawnPenumbraMcp(sb.dir);
  const client = new JsonRpcStdioClient(mcp);

  const initResult = (await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "penumbra-e2e", version: "0.0.0" },
  })) as { serverInfo?: { name?: string } };
  expect(initResult.serverInfo?.name).toBe("penumbra");

  // The MCP spec requires the client to send the initialized notification
  // before issuing further requests.
  await client.notify("notifications/initialized");

  const toolsResult = (await client.request("tools/list", {})) as {
    tools: { name: string }[];
  };
  const names = toolsResult.tools.map((t) => t.name).sort();

  // CORE_TOOLS is hand-written and asserted first on purpose: it is the only
  // assertion here not derived from the registry itself, so it is the only one
  // that would have gone red on the 2026-05-15 dotted->underscore registry
  // rename (b8faf93e), which silently zeroed the previous scraped oracle.
  const CORE_TOOLS = [
    "chain_start",
    "chain_wait",
    "memory_observe",
    "memory_recall",
    "memory_search",
    "read_handle",
    "session_end",
    "task_next",
  ];
  expect(CORE_TOOLS.filter((n) => !names.includes(n))).toEqual([]);

  const TOOL_NAME_RULE = /^[a-z][a-z0-9_]*$/;
  expect(names.filter((n) => !TOOL_NAME_RULE.test(n))).toEqual([]);

  // read_handle registers outside TOOL_REGISTRY on purpose (it needs the
  // HandleStore, not the daemon). Deriving the expected set from the registry
  // keys keeps this assertion rename-blind by construction.
  expect(names).toEqual([...Object.keys(TOOL_REGISTRY), "read_handle"].sort());

  await client.close();
  const exitCode = await Promise.race([
    mcp.exited,
    new Promise<number>((r) => {
      setTimeout(() => {
        r(-1);
      }, 3000);
    }),
  ]);
  expect(exitCode).toBe(0);
  mcp = null;
}, 30_000);
