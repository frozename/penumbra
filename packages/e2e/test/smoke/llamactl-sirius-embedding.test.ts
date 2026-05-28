import { expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { makeSandbox, type Sandbox } from "../helpers/sandbox.js";
import {
  spawnPenumbra,
  spawnPenumbraMcp,
  waitForPortFile,
  captureOutput,
  killGracefully,
  type BunSubprocess,
} from "../helpers/spawn-bin.js";
import { JsonRpcStdioClient } from "../helpers/jsonrpc-stdio.js";

const GATE = process.env.PENUMBRA_E2E_LLAMACTL === "1";
const MANIFEST =
  process.env.PENUMBRA_E2E_LLAMACTL_MANIFEST ??
  join(import.meta.dir, "..", "fixtures", "llamactl-sirius-embedder.yaml");
const SIRIUS_BASE_URL = process.env.PENUMBRA_SIRIUS_BASE_URL ?? "http://127.0.0.1:18080";
const SIRIUS_TOKEN = process.env.PENUMBRA_SIRIUS_TOKEN ?? "test";
const SIRIUS_MODEL = process.env.PENUMBRA_SIRIUS_MODEL ?? "text-embedding-3-small";
const SIRIUS_DIM = process.env.PENUMBRA_SIRIUS_DIM ?? "1536";

async function llamactlApply(): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["llamactl", "composite", "apply", "-f", MANIFEST],
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`llamactl composite apply exited ${code}`);
}

async function llamactlDelete(): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["llamactl", "composite", "delete", "-f", MANIFEST],
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited; // best-effort
}

async function siriusHealthy(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${SIRIUS_BASE_URL}/healthz`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const llamactlOnPath = Bun.which("llamactl") !== null;
const enabled = GATE && llamactlOnPath;

let provisioned = false;

beforeAll(async () => {
  if (!enabled) return;
  await llamactlApply();
  provisioned = true;
  const ok = await siriusHealthy(30_000);
  if (!ok) throw new Error("sirius /healthz did not respond in 30s");
}, 60_000);

afterAll(async () => {
  if (provisioned) await llamactlDelete();
}, 30_000);

let sb: Sandbox;
let daemon: BunSubprocess | null = null;
let mcp: BunSubprocess | null = null;
let daemonStdoutBuf = "";

beforeEach(async () => {
  if (!enabled) return;
  sb = makeSandbox();
  expect((await captureOutput(spawnPenumbra(["init"], sb.dir))).exitCode).toBe(0);
  daemon = spawnPenumbra(["start"], sb.dir, {
    PENUMBRA_EMBEDDER_PREFER_SIRIUS: "true",
    PENUMBRA_SIRIUS_BASE_URL: SIRIUS_BASE_URL,
    PENUMBRA_SIRIUS_TOKEN: SIRIUS_TOKEN,
    PENUMBRA_SIRIUS_MODEL: SIRIUS_MODEL,
    PENUMBRA_SIRIUS_DIM: SIRIUS_DIM,
  });
  daemonStdoutBuf = "";
  void (async () => {
    const reader = (daemon!.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        daemonStdoutBuf += dec.decode(value, { stream: true });
      }
    } catch {
      /* daemon dying, that's fine */
    }
  })();
  await waitForPortFile(sb.dir, 5000);
});

afterEach(async () => {
  if (!enabled) return;
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

interface CallToolResult {
  content: { type: string; text: string }[];
}

test.skipIf(!enabled)(
  "observe → end → recall round-trips through SiriusEmbedder",
  async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !daemonStdoutBuf.includes('"msg":"embedder selected"')) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const lines = daemonStdoutBuf
      .split("\n")
      .filter((l) => l.includes('"msg":"embedder selected"'));
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0]!) as { embedder: string };
    expect(parsed.embedder.startsWith("sirius:")).toBe(true);

    mcp = spawnPenumbraMcp(sb.dir);
    const client = new JsonRpcStdioClient(mcp);
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "penumbra-e2e-llamactl", version: "0.0.0" },
    });
    await client.notify("notifications/initialized");

    await client.request("tools/call", {
      name: "memory.observe",
      arguments: {
        ts: new Date().toISOString(),
        source: "mcp",
        source_detail: "e2e-llamactl",
        session_id: "s-llamactl",
        event_type: "agent-prompt",
        lane: "local",
        project_id: "proj-llamactl",
        payload_json: { prompt: "sirius embeddings smoke" },
        payload_summary: "sirius embeddings smoke",
      },
    });
    await client.request("tools/call", {
      name: "session.end",
      arguments: { session_id: "s-llamactl" },
    });

    const recall = (await client.request("tools/call", {
      name: "memory.recall",
      arguments: { query: "sirius embeddings smoke", project_id: "proj-llamactl", limit: 5 },
    })) as CallToolResult;
    const payload = JSON.parse(recall.content[0]!.text) as {
      results: { tier: string; body: string }[];
    };
    expect(payload.results.length).toBe(1);
    expect(payload.results[0]!.body).toContain("sirius");

    await client.close();
  },
  60_000,
);

test.skipIf(enabled)("llamactl-sirius-embedding gate is closed (skipped)", () => {
  expect(enabled).toBe(false);
});
