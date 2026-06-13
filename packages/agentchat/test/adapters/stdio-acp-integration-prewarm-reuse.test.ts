import { describe, expect, test, vi } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioAcpAdapter } from "../../src/adapters/stdio-acp.js";
import { StdioAcpClient } from "../../src/adapters/stdio-acp-client.js";
import { startStdioAcpServer } from "../../src/adapters/stdio-acp-server.js";
import { createAcpWarmPool } from "../../src/adapters/acp-warm-pool.js";
import type { DispatchInput } from "../../src/sdk/adapter.js";

const testDir = dirname(fileURLToPath(import.meta.url));

/**
 * Phase 5 hardening — the prewarm()→dispatch reuse seam end-to-end through a
 * REAL child process.
 *
 * stdio-acp-prewarm.test.ts proves prewarm()→dispatch reuse against a MOCK
 * client; stdio-acp-integration-warm-reuse.test.ts proves real-subprocess reuse
 * but only across cold-dispatch→warm-dispatch (no prewarm). This closes the
 * intersection the pre-warm LOOP actually depends on: a connection established
 * eagerly by prewarm() — handshake-only, at the repoRoot, with NO mcpServers,
 * exactly how bin/agentchat-worker.ts's prewarmOne builds it — is later reused
 * by a worktree dispatch over real stdio pipes (the acp-recorder.ts fixture).
 *
 * It asserts the four guarantees the pre-warm loop relies on:
 *   1. prewarm spawns ONE real process and issues NO session/new (the recorder
 *      file is not even created until the dispatch runs — handshake-only proven
 *      at the real transport, not just the unit mock);
 *   2. the dispatch reuses that process (startServer never fires a 2nd time; it
 *      emits acp.session.reuse, not acp.server.start);
 *   3. the dispatch mints a FRESH session at ITS OWN worktree cwd, and it is the
 *      first session the process ever minted (proving prewarm consumed none);
 *   4. PENUMBRA_STORAGE_ROOT is re-injected per dispatch even though the reused
 *      process was spawned by prewarm with a DIFFERENT (now-stale) storage root
 *      frozen in its process env (regression guard eba1d3d9, on the prewarm seam).
 */
describe("stdio-acp warm pool real subprocess prewarm→dispatch reuse (Phase 5)", () => {
  test("prewarm establishes ONE real process handshake-only; a later worktree dispatch reuses it with a fresh per-cwd session + re-injected storage root", async () => {
    const fixture = join(testDir, "../fixtures/acp-recorder.ts");
    const repoRoot = mkdtempSync(join(tmpdir(), "prewarm-repo-"));
    const worktree = mkdtempSync(join(tmpdir(), "prewarm-wt-"));
    const prewarmStorage = join(repoRoot, ".prewarm-storage"); // frozen on the spawned process
    const dispatchStorage = join(worktree, ".test-storage"); // per-dispatch, must be re-injected
    const recordFile = join(mkdtempSync(join(tmpdir(), "prewarm-rec-")), "session-new.jsonl");

    // Shared pool + startServer spy across the prewarm adapter and the dispatch
    // adapter: the dispatch must NOT spawn a 2nd process — it reuses the pinned
    // pre-warmed connection.
    const pool = createAcpWarmPool({ graceMs: 60_000 });
    const startServer = vi.fn((opts: Parameters<typeof startStdioAcpServer>[0]) =>
      startStdioAcpServer(opts),
    );
    const createClient = (handle: any) =>
      new StdioAcpClient({ stdin: handle.stdin, stdout: handle.stdout });

    // Prewarm adapter: handshake-only, keyed on repoRoot, NO mcpServers — exactly
    // how prewarmOne (bin/agentchat-worker.ts) builds it. Its frozen process env
    // carries prewarmStorage, which is STALE relative to the dispatch worktree.
    const prewarmAdapter = new StdioAcpAdapter(
      {
        binary: "bun",
        args: [fixture],
        cwd: repoRoot,
        model: "codex-acp-fast",
        agentName: "codex-acp-fast",
        warmPool: true,
        repoRoot,
        env: { PENUMBRA_STORAGE_ROOT: prewarmStorage, ACP_RECORD_FILE: recordFile },
      } as any,
      { startServer, createClient, pool } as any,
    );

    // Dispatch adapter: same agent + binary + repoRoot (so it acquires the
    // pre-warmed entry — the pool keys on (agent, repoRoot)), but at the worktree
    // cwd, WITH the penumbra MCP server and the per-dispatch storage root.
    const dispatchAdapter = new StdioAcpAdapter(
      {
        binary: "bun",
        args: [fixture],
        cwd: worktree,
        model: "codex-acp-fast",
        agentName: "codex-acp-fast",
        warmPool: true,
        repoRoot,
        mcpServers: [
          { name: "penumbra", command: "bun", args: [join(repoRoot, "penumbra-mcp.ts")] },
        ],
        env: { PENUMBRA_STORAGE_ROOT: dispatchStorage, ACP_RECORD_FILE: recordFile },
      } as any,
      { startServer, createClient, pool } as any,
    );

    // 1. Pre-warm: ONE real process, handshake-only.
    const prewarmResult = await prewarmAdapter.prewarm();
    expect(prewarmResult.deposited).toBe(true);
    expect(startServer).toHaveBeenCalledTimes(1);
    // Handshake-only at the REAL transport: no session/new ran, so the recorder
    // never wrote a line — the file is not even created.
    expect(existsSync(recordFile)).toBe(false);

    // 2. Dispatch at the worktree reuses the pre-warmed process.
    const events: any[] = [];
    const dispatchInput: DispatchInput = {
      prompt: "hello",
      conversation: { id: "hA", project_id: null },
      config: {},
      signal: new AbortController().signal,
      handoff_id: "hA",
      eventContext: { handoffId: "hA", workerId: "w1" },
      onEvent: (e: any) => events.push(e),
    } as any;
    const out = await dispatchAdapter.dispatch(dispatchInput);

    // ONE real process served both prewarm + dispatch (no 2nd startServer).
    expect(startServer).toHaveBeenCalledTimes(1);
    expect(out.text).toBe("ok");
    // Connection reuse fired (the pre-warm seam); the dispatch did NOT cold-start.
    expect(events.filter((e) => e.kind === "acp.session.reuse")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "acp.server.start")).toHaveLength(0);

    // 3 + 4. Exactly one fresh session/new ran — on the DISPATCH, at the worktree
    // cwd, and it is the FIRST session the process ever minted (proving prewarm
    // consumed none).
    const records = readFileSync(recordFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(records).toHaveLength(1);
    expect(records[0].cwd).toBe(worktree);
    expect(records[0].sessionId).toBe("recorder-session-1");
    // Re-injection guard (eba1d3d9) across the prewarm seam: the reused process's
    // FROZEN env still holds prewarmStorage, but session/new carried the
    // dispatch's own dispatchStorage — proving per-dispatch re-injection, not a
    // leak of the pre-warm process env.
    expect(prewarmStorage).not.toBe(dispatchStorage);
    expect(records[0].processStorageRoot).toBe(prewarmStorage);
    expect(records[0].storageRoot).toBe(dispatchStorage);

    pool.shutdown();
  }, 15_000);
});
