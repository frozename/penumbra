import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
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
 * Phase 5 hardening: the Option-B warm-connection reuse is proven against MOCK
 * clients in stdio-acp-warm-reuse.test.ts. This exercises the SAME guarantees
 * end-to-end through a REAL child process speaking ACP over real stdio pipes
 * (the acp-recorder.ts fixture), so the integration — process pooling, fresh
 * session/new per dispatch at the dispatch cwd, and per-dispatch storage-root
 * re-injection — is verified on the actual transport, not just the unit mock.
 *
 * One real process serves two dispatches at two different worktree cwds; we
 * assert it is reused, that each dispatch minted a fresh session at its own cwd,
 * and that each dispatch's PENUMBRA_STORAGE_ROOT reached session/new correctly
 * even though the reused process's frozen env still holds the first one's value
 * (regression guard for eba1d3d9).
 */
describe("stdio-acp warm pool real subprocess reuse (Phase 5)", () => {
  test("reuses ONE real process across two worktree cwds; fresh session + correct storage root each", async () => {
    const fixture = join(testDir, "../fixtures/acp-recorder.ts");
    const repoRoot = mkdtempSync(join(tmpdir(), "warm-repo-"));
    const wtA = mkdtempSync(join(tmpdir(), "warm-wtA-"));
    const wtB = mkdtempSync(join(tmpdir(), "warm-wtB-"));
    const storageA = join(wtA, ".test-storage");
    const storageB = join(wtB, ".test-storage");
    const recordFile = join(mkdtempSync(join(tmpdir(), "warm-rec-")), "session-new.jsonl");

    // Shared pool + startServer spy across both adapter instances: a warm hit on
    // the 2nd dispatch must skip startServer entirely (process reuse).
    const pool = createAcpWarmPool({ graceMs: 60_000 });
    const startServer = vi.fn((opts: Parameters<typeof startStdioAcpServer>[0]) =>
      startStdioAcpServer(opts),
    );
    const createClient = (handle: any) =>
      new StdioAcpClient({ stdin: handle.stdin, stdout: handle.stdout });

    const mk = (cwd: string, storageRoot: string) =>
      new StdioAcpAdapter(
        {
          binary: "bun",
          args: [fixture],
          cwd,
          model: "codex-acp-fast",
          agentName: "codex-acp-fast",
          warmPool: true,
          repoRoot,
          mcpServers: [
            { name: "penumbra", command: "bun", args: [join(repoRoot, "penumbra-mcp.ts")] },
          ],
          env: { PENUMBRA_STORAGE_ROOT: storageRoot, ACP_RECORD_FILE: recordFile },
        } as any,
        { startServer, createClient, pool } as any,
      );

    const events: any[] = [];
    const dispatchInput = (handoffId: string): DispatchInput => ({
      prompt: "hello",
      conversation: { id: handoffId, project_id: null },
      config: {},
      signal: new AbortController().signal,
      handoff_id: handoffId,
      eventContext: { handoffId, workerId: "w1" },
      onEvent: (e) => events.push(e),
    });

    const first = await mk(wtA, storageA).dispatch(dispatchInput("hA"));
    const second = await mk(wtB, storageB).dispatch(dispatchInput("hB"));

    // 1. ONE real process served both dispatches (warm reuse skipped startServer).
    expect(startServer).toHaveBeenCalledTimes(1);
    expect(first.text).toBe("ok");
    expect(second.text).toBe("ok");

    // 2. Connection reuse fired exactly once — only the 2nd dispatch — and the
    //    cold start fired exactly once — only the 1st.
    expect(events.filter((e) => e.kind === "acp.session.reuse")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "acp.server.start")).toHaveLength(1);

    // 3. Each dispatch ran a FRESH session/new at ITS OWN cwd.
    const records = readFileSync(recordFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.cwd)).toEqual([wtA, wtB]);
    expect(records[0].sessionId).not.toBe(records[1].sessionId); // distinct fresh sessions

    // 4. Re-injection guard (eba1d3d9): the reused process's FROZEN process env
    //    still holds A's storage root on the 2nd dispatch, but session/new
    //    carried B's — proving the adapter re-injects the per-dispatch value
    //    rather than letting the stale process env leak through.
    expect(records.map((r) => r.storageRoot)).toEqual([storageA, storageB]);
    expect(records[0].processStorageRoot).toBe(storageA);
    expect(records[1].processStorageRoot).toBe(storageA); // frozen on the reused process
    expect(records[1].storageRoot).toBe(storageB); // but session/new is per-dispatch correct

    pool.shutdown();
  }, 15_000);
});
