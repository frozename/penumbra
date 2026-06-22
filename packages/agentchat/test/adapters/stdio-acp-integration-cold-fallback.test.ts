import { describe, expect, test, vi } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { acpSpecHash, createAcpWarmPool } from "../../src/adapters/acp-warm-pool.js";
import { StdioAcpClient } from "../../src/adapters/stdio-acp-client.js";
import {
  startStdioAcpServer,
  type StartStdioAcpServerOptions,
  type StdioAcpHandle,
} from "../../src/adapters/stdio-acp-server.js";
import { StdioAcpAdapter } from "../../src/adapters/stdio-acp.js";

const testDir = dirname(fileURLToPath(import.meta.url));

/**
 * Narrow the unknown `session/new` response into the single field tests need.
 * The real ACP client declares `request()` as `Promise<any>`, so callers must
 * launder the result through unknown before extracting `sessionId`.
 */
function getSessionId(result: unknown): string {
  if (typeof result === "object" && result !== null && "sessionId" in result) {
    const id = result.sessionId;
    if (typeof id === "string") return id;
  }
  throw new Error("expected session/new result with a string sessionId");
}

describe("stdio-acp warm pool real subprocess cold fallback", () => {
  test("evicts a killed idle real handle and cold-starts a replacement", async () => {
    const fixture = join(testDir, "../fixtures/acp-minimal.ts");
    const pool = createAcpWarmPool({ graceMs: 60_000 });
    const args = [fixture];
    const cwd = process.cwd();
    const key = `codex-acp-fast\0${cwd}`;
    const specHash = acpSpecHash({ binary: "bun", args, model: "codex-acp-fast" });

    const staleHandle = await startStdioAcpServer({ binary: "bun", args, cwd });
    const staleClient = new StdioAcpClient({
      stdin: staleHandle.stdin,
      stdout: staleHandle.stdout,
    });
    await staleClient.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const sessionResult = (await staleClient.request("session/new", {
      cwd,
      mcpServers: [],
    })) as unknown;
    pool.deposit(key, {
      handle: staleHandle,
      client: staleClient,
      sessionId: getSessionId(sessionResult),
      specHash,
    });
    staleHandle.kill();
    await staleHandle.exited;

    const startServer = vi.fn(
      (opts: StartStdioAcpServerOptions): Promise<StdioAcpHandle> => startStdioAcpServer(opts),
    );
    const adapter = new StdioAcpAdapter(
      { binary: "bun", args, cwd, model: "codex-acp-fast", warmPool: true },
      {
        startServer,
        createClient: (handle: StdioAcpHandle): StdioAcpClient =>
          new StdioAcpClient({ stdin: handle.stdin, stdout: handle.stdout }),
        pool,
      },
    );

    const first = await adapter.dispatch({
      prompt: "hello",
      conversation: { id: "c1", project_id: null },
      config: {},
      signal: new AbortController().signal,
      handoff_id: "h1",
    });
    const second = await adapter.dispatch({
      prompt: "hello again",
      conversation: { id: "c1", project_id: null },
      config: {},
      signal: new AbortController().signal,
      handoff_id: "h2",
    });

    expect(first.text).toBe("ok");
    expect(second.text).toBe("ok");
    expect(startServer).toHaveBeenCalledTimes(1);
    pool.shutdown();
  }, 10_000);
});
