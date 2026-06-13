import { describe, expect, test, vi } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioAcpAdapter } from "../../src/adapters/stdio-acp.js";
import { StdioAcpClient } from "../../src/adapters/stdio-acp-client.js";
import { startStdioAcpServer } from "../../src/adapters/stdio-acp-server.js";
import { acpSpecHash, createAcpWarmPool } from "../../src/adapters/acp-warm-pool.js";

const testDir = dirname(fileURLToPath(import.meta.url));

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
    const session = await staleClient.request("session/new", { cwd, mcpServers: [] });
    pool.deposit(key, {
      handle: staleHandle,
      client: staleClient,
      sessionId: session.sessionId,
      specHash,
    });
    staleHandle.kill();
    await staleHandle.exited;

    const startServer = vi.fn((opts) => startStdioAcpServer(opts));
    const adapter = new StdioAcpAdapter(
      { binary: "bun", args, cwd, model: "codex-acp-fast", warmPool: true },
      {
        startServer,
        createClient: (handle) =>
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
