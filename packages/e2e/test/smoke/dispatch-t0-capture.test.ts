import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { JsonRpcStdioClient } from "../helpers/jsonrpc-stdio.js";
import { toolResultText } from "../helpers/mcp-envelope.js";
import { makeSandbox, type Sandbox } from "../helpers/sandbox.js";
import {
  type BunSubprocess,
  captureOutput,
  drainOutput,
  killGracefully,
  spawnBun,
  spawnPenumbra,
  spawnPenumbraMcp,
  waitForPortFile,
} from "../helpers/spawn-bin.js";

let sb: Sandbox;
let daemon: BunSubprocess | null = null;
let mcp: BunSubprocess | null = null;
let worker: BunSubprocess | null = null;

beforeEach(async () => {
  sb = makeSandbox();

  const mockCliPath = resolve(import.meta.dir, "fixtures", "mock-acp-cli.ts");
  const agentchatYaml = `
agents:
  - name: mock-acp
    adapter: stdio-acp
    options:
      binary: bun
      fsReadTextFile: true
      args:
        - ${mockCliPath}
`;
  const agentchatPath = join(sb.dir, "agentchat.yaml");
  const penumbraConfigDir = join(sb.dir, "penumbra-config");
  writeFileSync(agentchatPath, agentchatYaml);
  mkdirSync(penumbraConfigDir, { recursive: true });
  writeFileSync(join(penumbraConfigDir, "agents.yaml"), agentchatYaml);
  writeFileSync(join(penumbraConfigDir, "routing.yaml"), "default_roles: {}\n");
  writeFileSync(join(penumbraConfigDir, "quotas.yaml"), "providers: []\n");

  expect(
    (
      await captureOutput(
        spawnPenumbra(["init"], sb.dir, {
          AGENTCHAT_CONFIG: agentchatPath,
          PENUMBRA_CONFIG_DIR: penumbraConfigDir,
        }),
      )
    ).exitCode,
  ).toBe(0);
  daemon = spawnPenumbra(["start"], sb.dir, {
    AGENTCHAT_CONFIG: agentchatPath,
    PENUMBRA_CONFIG_DIR: penumbraConfigDir,
  });
  drainOutput(daemon);
  await waitForPortFile(sb.dir, 5000);

  worker = spawnBun(["packages/agentchat/bin/agentchat-worker.ts"], {
    PENUMBRA_STORAGE_ROOT: sb.dir,
    AGENTCHAT_CONFIG: agentchatPath,
    PENUMBRA_CONFIG_DIR: penumbraConfigDir,
  });
  drainOutput(worker);
  await new Promise((r) => setTimeout(r, 2000));
});

afterEach(async () => {
  if (worker) {
    await killGracefully(worker);
    worker = null;
  }
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

interface StartData {
  conversation_id: string;
  handoff_id: string;
}

interface T0Row {
  event_type: string;
  ts: string;
  payload_summary: string;
}

function dumpSandboxLogs(dir: string): void {
  try {
    process.stdout.write(execSync(`find ${dir} -type f -name "*.log"`).toString());
    process.stdout.write(execSync(`cat ${dir}/logs/*.log 2>/dev/null || true`).toString());
  } catch {
    /* best-effort log dump */
  }
}

test("dispatch t0 capture end-to-end", async () => {
  mcp = spawnPenumbraMcp(sb.dir);
  const client = new JsonRpcStdioClient(mcp);

  await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "penumbra-e2e", version: "0.0.0" },
  });
  await client.notify("notifications/initialized");

  const startRes = await client.request("tools/call", {
    name: "chain_start",
    arguments: {
      initial_agent: "mock-acp",
      message: "PHRASE_PROMPT_CCC",
      task_class: "TRIVIAL",
      // use_worktree:false is load-bearing beyond hermeticity. Without it,
      // chain_start creates a REAL git worktree and branch in the developer's
      // live repo on every run, and it also gates the cwd project resolution
      // that would parent-walk the real ~/.config/penumbra/projects.yaml and
      // get the handoff rejected by the sandbox worker. Do NOT substitute
      // project_id:null — it also passes but still leaks a worktree per run.
      use_worktree: false,
    },
  });

  const startText = toolResultText(startRes);
  process.stdout.write(`START_TEXT: ${JSON.stringify(startText)}\n`);
  const startJson = startText.substring(startText.indexOf("{"));
  let startData: StartData;
  try {
    startData = JSON.parse(startJson) as StartData;
  } catch (e) {
    console.error("FAIL PARSING JSON. LOGS:");
    dumpSandboxLogs(sb.dir);
    throw e;
  }
  const convId = startData.conversation_id;

  await client.request("tools/call", {
    name: "chain_wait",
    arguments: { conversation_id: convId, timeout_ms: 15000 },
  });

  const db = new Database(join(sb.dir, "db.sqlite"), { readonly: true });
  const failed = db.query(`SELECT resolution_reason FROM handoffs WHERE status = 'failed'`).all();
  process.stdout.write(`FAILED HANDOFFS: ${JSON.stringify(failed)}\n`);

  const rows = db
    .query(
      `
    SELECT event_type, ts, payload_summary FROM t0_events
    WHERE session_id = ?
      AND event_type IN ('agent-prompt', 'agent-response', 'agent-thought', 'agent-tool-use')
    ORDER BY ts ASC
  `,
    )
    .all(convId) as T0Row[];
  db.close();

  const types = rows.map((r) => r.event_type);
  expect(types).toContain("agent-prompt");
  expect(types).toContain("agent-response");
  expect(types).toContain("agent-thought");
  expect(types).toContain("agent-tool-use");
  expect(types[0]).toBe("agent-prompt");
  expect(types[types.length - 1]).toBe("agent-response");

  const recallRes = await client.request("tools/call", {
    name: "memory_recall",
    arguments: {
      query: "PHRASE_THOUGHT_BBB",
      session_id: convId,
      include_raw: true,
      limit: 10,
      min_score: 0,
    },
  });

  const recallText = toolResultText(recallRes);
  expect(recallText).toContain("PHRASE_THOUGHT_BBB");

  await client.close();
}, 45_000);
