import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../../cli/src/commands/init.js";
import { runStart } from "../../cli/src/commands/start.js";
import { runStop } from "../../cli/src/commands/stop.js";
import { DaemonClient } from "../src/daemon-client.js";
import { connectInMemory, firstJson } from "./helpers.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

let dir = "";
let handle: Awaited<ReturnType<typeof runStart>> | null = null;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "penumbra-e2e-"));
  await runInit({ storageRoot: dir, uuid: () => "t" });
  handle = await runStart({ storageRoot: dir });
});

afterEach(async () => {
  if (handle) await runStop({ storageRoot: dir, handle });
  rmSync(dir, { recursive: true, force: true });
});

interface RecallPayload {
  results: { tier: string; body: string }[];
}

test("observe → session.end → recall returns the session content", async () => {
  const daemon = new DaemonClient({
    baseUrl: `http://127.0.0.1:${String(handle!.port)}`,
    token: "t",
  });
  const client = await connectInMemory(daemon);
  try {
    await client.callTool({
      name: "memory_observe",
      arguments: {
        ts: new Date().toISOString(),
        source: "mcp",
        source_detail: "e2e-test",
        session_id: "s-e2e",
        event_type: "agent-prompt",
        lane: "local",
        project_id: "proj-e2e",
        payload_json: { prompt: "refactor the authentication middleware" },
        payload_summary: "refactor the authentication middleware",
      },
    });

    await client.callTool({
      name: "memory_observe",
      arguments: {
        ts: new Date().toISOString(),
        source: "mcp",
        source_detail: "e2e-test",
        session_id: "s-e2e",
        event_type: "agent-response",
        lane: "local",
        project_id: "proj-e2e",
        payload_json: { response: "Updated src/auth.ts and tests" },
        payload_summary: "Updated src/auth.ts and tests",
      },
    });

    await client.callTool({
      name: "session_end",
      arguments: { session_id: "s-e2e" },
    });

    const recall = await client.callTool({
      name: "memory_recall",
      arguments: {
        query: "refactor the authentication middleware",
        project_id: "proj-e2e",
        limit: 5,
      },
    });
    const payload = firstJson<RecallPayload>(recall);
    expect(payload.results.length).toBe(1);
    expect(payload.results[0]?.tier).toBe("t1");
    expect(payload.results[0]?.body).toContain("refactor");
  } finally {
    await client.close();
  }
});

test("context file is written for the project after session.end", async () => {
  const daemon = new DaemonClient({
    baseUrl: `http://127.0.0.1:${String(handle!.port)}`,
    token: "t",
  });
  const client = await connectInMemory(daemon);
  try {
    await client.callTool({
      name: "memory_observe",
      arguments: {
        ts: new Date().toISOString(),
        source: "mcp",
        source_detail: "e2e-test",
        session_id: "s-ctx",
        event_type: "agent-prompt",
        lane: "local",
        project_id: "proj-ctx",
        payload_json: { prompt: "x" },
        payload_summary: "x",
      },
    });
    await client.callTool({ name: "session_end", arguments: { session_id: "s-ctx" } });
    const ctxFile = Bun.file(join(dir, "context", "proj-ctx", "latest.md"));
    expect(await ctxFile.exists()).toBe(true);
    const content = await ctxFile.text();
    expect(content).toContain("generated_at");
    expect(content).toContain("Recent sessions");
    // Verify the full rollup → writer pipeline: payload_summary 'x' → first_prompt_excerpt 'x'
    // → context file line "- **First prompt:** x"
    expect(content).toContain("**First prompt:** x");
  } finally {
    await client.close();
  }
});
