import {
  type ClaimAffinityAgent,
  computeClaimGraceMs,
  DEFAULT_CLAIM_AFFINITY_GRACE_MS,
} from "@src/worker/claim-affinity.js";
import { describe, expect, test } from "bun:test";

const MAIN = "/repos/penumbra";
const LLAMACTL = "/repos/llamactl";

// resolveProjectRoot mirroring the worktree manager: known projects map to their
// repo root; unknown / undefined → undefined (caller falls back to mainRepoPath).
const resolveProjectRoot = (projectId?: string): string | undefined => {
  if (projectId === "penumbra") return MAIN;
  if (projectId === "llamactl") return LLAMACTL;
  return undefined;
};

const AGENTS: ClaimAffinityAgent[] = [
  { name: "codex-acp-fast", options: { warm_pool: true } },
  { name: "codex-acp-deep", options: { warm_pool: false } },
  { name: "gemini-acp-pro", options: null },
];

function grace(
  over: Partial<Parameters<typeof computeClaimGraceMs>[0]> & { toAgent: string },
): number {
  return computeClaimGraceMs({
    handoffProjectId: "penumbra",
    agents: AGENTS,
    workerProjectId: "penumbra",
    resolveProjectRoot,
    mainRepoPath: MAIN,
    graceMs: DEFAULT_CLAIM_AFFINITY_GRACE_MS,
    ...over,
  });
}

describe("computeClaimGraceMs", () => {
  test("non-warm-pooled agent → claim immediately (affinity can't help)", () => {
    // cross-project, but the agent isn't warm-pooled
    expect(grace({ toAgent: "codex-acp-deep", workerProjectId: "llamactl" })).toBe(0);
    expect(grace({ toAgent: "gemini-acp-pro", workerProjectId: "llamactl" })).toBe(0);
  });

  test("unknown agent (not in config) → claim immediately", () => {
    expect(grace({ toAgent: "does-not-exist", workerProjectId: "llamactl" })).toBe(0);
  });

  test("home worker for the handoff's project → claim immediately", () => {
    // warm agent, worker home == handoff project
    expect(grace({ toAgent: "codex-acp-fast", workerProjectId: "penumbra" })).toBe(0);
  });

  test("cross-project warm-pooled handoff → hold back by the grace", () => {
    // penumbra handoff, llamactl-homed worker, warm agent
    expect(grace({ toAgent: "codex-acp-fast", workerProjectId: "llamactl" })).toBe(
      DEFAULT_CLAIM_AFFINITY_GRACE_MS,
    );
  });

  test("shared worker (no project_id) is home for the MAIN project", () => {
    // workerProjectId undefined → home = mainRepoPath; handoff project resolves
    // to mainRepoPath too → homed → claim now.
    expect(
      grace({
        toAgent: "codex-acp-fast",
        workerProjectId: undefined,
        handoffProjectId: "penumbra",
      }),
    ).toBe(0);
  });

  test("shared worker is NOT home for a non-main project → hold back", () => {
    expect(
      grace({
        toAgent: "codex-acp-fast",
        workerProjectId: undefined,
        handoffProjectId: "llamactl",
      }),
    ).toBe(DEFAULT_CLAIM_AFFINITY_GRACE_MS);
  });

  test("null/undefined handoff project resolves to mainRepoPath (global work)", () => {
    // global handoff (project_id null) → handoffRoot = mainRepoPath; a main-homed
    // worker claims now, a llamactl-homed worker holds back.
    expect(
      grace({ toAgent: "codex-acp-fast", handoffProjectId: null, workerProjectId: "penumbra" }),
    ).toBe(0);
    expect(
      grace({ toAgent: "codex-acp-fast", handoffProjectId: null, workerProjectId: "llamactl" }),
    ).toBe(DEFAULT_CLAIM_AFFINITY_GRACE_MS);
  });

  test("graceMs <= 0 disables affinity entirely (even cross-project warm)", () => {
    expect(grace({ toAgent: "codex-acp-fast", workerProjectId: "llamactl", graceMs: 0 })).toBe(0);
    expect(grace({ toAgent: "codex-acp-fast", workerProjectId: "llamactl", graceMs: -1 })).toBe(0);
    expect(grace({ toAgent: "codex-acp-fast", workerProjectId: "llamactl", graceMs: NaN })).toBe(0);
  });

  test("custom grace value is honoured", () => {
    expect(grace({ toAgent: "codex-acp-fast", workerProjectId: "llamactl", graceMs: 250 })).toBe(
      250,
    );
  });
});
