import { describe, expect, test } from "bun:test";

import {
  classifyBranchByContent,
  classifyBranchLandStatus,
  isAncestorOf,
  isThreeDotDiffEmpty,
} from "@src/worktree/branch-land-probe.js";
import type { WorktreeCommandRunner } from "@src/worktree/manager.js";

const REPO_DIR = "/repo";
const CANDIDATE = "agent/x";
const BASE = "main";

// bun:test types report `.rejects.toThrow(...)` / `.resolves.toBe(...)` as
// returning `void`, so eslint's no-confusing-void-expression flags the await
// chain. Assert resolutions and rejections by hand instead.
async function expectResolves<T>(promise: Promise<T>, expected: Awaited<T>): Promise<void> {
  expect(await promise).toEqual(expected);
}

async function expectRejectsWith(promise: Promise<unknown>, matcher: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toMatch(matcher);
    return;
  }
  throw new Error("expected promise to reject but it resolved");
}

type RejectSpec = { code?: number | string | null; stderr?: string | Uint8Array };
type ScriptResult = { stdout: string } | { reject: RejectSpec };

interface FakeRunner {
  runner: WorktreeCommandRunner;
  calls: { cmd: string; args: string[]; cwd?: string }[];
}

function makeRunner(script: (args: string[]) => ScriptResult): FakeRunner {
  const calls: FakeRunner["calls"] = [];
  const runner: WorktreeCommandRunner = (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    const result = script(args);
    if ("reject" in result) {
      const { code, stderr } = result.reject;
      return Promise.reject(Object.assign(new Error("x"), { code, stderr }));
    }
    return Promise.resolve({ stdout: result.stdout, stderr: "" });
  };
  return { runner, calls };
}

const UNSCRIPTED: ScriptResult = { reject: { code: 99, stderr: "unscripted" } };

function isWriteTree(args: string[]): boolean {
  return args[0] === "merge-tree" && args[1] === "--write-tree";
}

function isLegacyMergeTree(args: string[]): boolean {
  return args[0] === "merge-tree" && args[1] !== "--write-tree";
}

function isLegacyMergeBase(args: string[]): boolean {
  return args[0] === "merge-base" && args[1] !== "--is-ancestor";
}

function isAncestorCall(args: string[]): boolean {
  return args[0] === "merge-base" && args[1] === "--is-ancestor";
}

function ancestorScript(result: ScriptResult): (args: string[]) => ScriptResult {
  return (args) => (isAncestorCall(args) ? result : UNSCRIPTED);
}

function diffScript(result: ScriptResult): (args: string[]) => ScriptResult {
  return (args) => (args[0] === "diff" ? result : UNSCRIPTED);
}

function contentScript(
  revParse: ScriptResult,
  writeTree: ScriptResult,
): (args: string[]) => ScriptResult {
  return (args) => {
    if (args[0] === "rev-parse") return revParse;
    if (isWriteTree(args)) return writeTree;
    return UNSCRIPTED;
  };
}

function fallbackScript(
  writeTreeReject: RejectSpec,
  mergeBase: ScriptResult,
  legacyMergeTree: ScriptResult,
): (args: string[]) => ScriptResult {
  return (args) => {
    if (args[0] === "rev-parse") return { stdout: "T1\n" };
    if (isWriteTree(args)) return { reject: writeTreeReject };
    if (isLegacyMergeBase(args)) return mergeBase;
    if (isLegacyMergeTree(args)) return legacyMergeTree;
    return UNSCRIPTED;
  };
}

describe("isAncestorOf", () => {
  test("A1 resolves true and issues the is-ancestor argv", async () => {
    const { runner, calls } = makeRunner(ancestorScript({ stdout: "" }));

    await expectResolves(isAncestorOf(runner, REPO_DIR, CANDIDATE, BASE), true);
    expect(calls[0]).toEqual({
      cmd: "git",
      args: ["merge-base", "--is-ancestor", "agent/x", "main"],
      cwd: "/repo",
    });
  });

  test("A2 exit code 1 resolves false", async () => {
    const { runner } = makeRunner(ancestorScript({ reject: { code: 1 } }));

    await expectResolves(isAncestorOf(runner, REPO_DIR, CANDIDATE, BASE), false);
  });

  test("A3 unexpected exit code rejects with code and stderr", async () => {
    const { runner } = makeRunner(
      ancestorScript({ reject: { code: 128, stderr: "fatal: bad rev" } }),
    );

    await expectRejectsWith(
      isAncestorOf(runner, REPO_DIR, CANDIDATE, BASE),
      /failed \(128\): fatal: bad rev/,
    );
  });

  test("A4 Uint8Array stderr is decoded into the rejection message", async () => {
    const { runner } = makeRunner(
      ancestorScript({ reject: { code: 128, stderr: new TextEncoder().encode("fatal: bytes") } }),
    );

    await expectRejectsWith(isAncestorOf(runner, REPO_DIR, CANDIDATE, BASE), /fatal: bytes/);
  });

  test("A5 stderr is truncated to 500 chars in the rejection message", async () => {
    const { runner } = makeRunner(
      ancestorScript({ reject: { code: 128, stderr: "y".repeat(600) } }),
    );

    const err = (await isAncestorOf(runner, REPO_DIR, CANDIDATE, BASE).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err.message).toContain("y".repeat(500));
    expect(err.message).not.toContain("y".repeat(501));
  });
});

describe("isThreeDotDiffEmpty", () => {
  test("D1 whitespace-only stdout is empty", async () => {
    const { runner } = makeRunner(diffScript({ stdout: "  \n\t" }));

    await expectResolves(isThreeDotDiffEmpty(runner, REPO_DIR, CANDIDATE, BASE), true);
  });

  test("D2 non-empty stat output is not empty", async () => {
    const { runner } = makeRunner(diffScript({ stdout: " a.txt | 1 +\n" }));

    await expectResolves(isThreeDotDiffEmpty(runner, REPO_DIR, CANDIDATE, BASE), false);
  });

  test("D3 uses base...candidate three-dot range", async () => {
    const { runner, calls } = makeRunner(diffScript({ stdout: "" }));

    await isThreeDotDiffEmpty(runner, REPO_DIR, CANDIDATE, BASE);
    expect(calls[0]?.args).toEqual(["diff", "--stat", "main...agent/x"]);
  });
});

describe("classifyBranchByContent", () => {
  test("C1 rev-parse failure errors without a merge-tree call", async () => {
    const { runner, calls } = makeRunner(
      contentScript({ reject: { code: 128 } }, { stdout: "T1\n" }),
    );

    await expectResolves(classifyBranchByContent(runner, REPO_DIR, BASE, CANDIDATE), "error");
    expect(calls.some((c) => c.args[0] === "merge-tree")).toBe(false);
  });

  test("C2 matching merge tree is landed", async () => {
    const { runner } = makeRunner(contentScript({ stdout: "T1\n" }, { stdout: "T1\n" }));

    await expectResolves(classifyBranchByContent(runner, REPO_DIR, BASE, CANDIDATE), "landed");
  });

  test("C3 differing merge tree is unlanded", async () => {
    const { runner } = makeRunner(contentScript({ stdout: "T1\n" }, { stdout: "T2\n" }));

    await expectResolves(classifyBranchByContent(runner, REPO_DIR, BASE, CANDIDATE), "unlanded");
  });

  test("C4 merge-tree exit 1 is unlanded", async () => {
    const { runner } = makeRunner(
      contentScript({ stdout: "T1\n" }, { reject: { code: 1, stderr: "" } }),
    );

    await expectResolves(classifyBranchByContent(runner, REPO_DIR, BASE, CANDIDATE), "unlanded");
  });

  test("C5 code 128 falls back to legacy merge-tree with trimmed merge base", async () => {
    const { runner, calls } = makeRunner(
      fallbackScript({ code: 128, stderr: "" }, { stdout: "MB\n" }, { stdout: "" }),
    );

    await expectResolves(classifyBranchByContent(runner, REPO_DIR, BASE, CANDIDATE), "landed");
    const legacyCall = calls.find((c) => isLegacyMergeTree(c.args));
    expect(legacyCall?.args).toEqual(["merge-tree", "MB", "main", "agent/x"]);
  });

  test("C6 unknown-option stderr on exit 2 also falls back", async () => {
    const { runner } = makeRunner(
      fallbackScript(
        { code: 2, stderr: "error: unknown option `write-tree'" },
        { stdout: "MB\n" },
        { stdout: "" },
      ),
    );

    await expectResolves(classifyBranchByContent(runner, REPO_DIR, BASE, CANDIDATE), "landed");
  });

  test("C7 unrelated exit 2 errors without legacy fallback", async () => {
    const { runner, calls } = makeRunner(
      contentScript({ stdout: "T1\n" }, { reject: { code: 2, stderr: "fatal: something else" } }),
    );

    await expectResolves(classifyBranchByContent(runner, REPO_DIR, BASE, CANDIDATE), "error");
    expect(calls.some((c) => c.args[0] === "merge-base")).toBe(false);
  });

  test("C8 blank merge base errors without legacy merge-tree", async () => {
    const { runner, calls } = makeRunner(
      fallbackScript({ code: 128, stderr: "" }, { stdout: "  \n" }, { stdout: "" }),
    );

    await expectResolves(classifyBranchByContent(runner, REPO_DIR, BASE, CANDIDATE), "error");
    expect(calls.some((c) => isLegacyMergeTree(c.args))).toBe(false);
  });

  test("C9 legacy merge-tree output means unlanded", async () => {
    const { runner } = makeRunner(
      fallbackScript({ code: 128, stderr: "" }, { stdout: "MB\n" }, { stdout: "conflict\n" }),
    );

    await expectResolves(classifyBranchByContent(runner, REPO_DIR, BASE, CANDIDATE), "unlanded");
  });

  test("C10 legacy merge-base failure errors", async () => {
    const { runner } = makeRunner(
      fallbackScript({ code: 128, stderr: "" }, { reject: { code: 128 } }, { stdout: "" }),
    );

    await expectResolves(classifyBranchByContent(runner, REPO_DIR, BASE, CANDIDATE), "error");
  });
});

describe("classifyBranchLandStatus", () => {
  test("S1 empty three-dot diff lands without the content probe", async () => {
    const { runner, calls } = makeRunner((args) => {
      if (isAncestorCall(args)) return { reject: { code: 1 } };
      if (args[0] === "diff") return { stdout: "" };
      return UNSCRIPTED;
    });

    await expectResolves(classifyBranchLandStatus(runner, REPO_DIR, CANDIDATE, BASE), "landed");
    expect(calls.some((c) => c.args[0] === "rev-parse" || c.args[0] === "merge-tree")).toBe(false);
  });

  test("S2 is-ancestor hard failure resolves error, never rejects", async () => {
    const { runner } = makeRunner(ancestorScript({ reject: { code: 128, stderr: "fatal" } }));

    await expectResolves(classifyBranchLandStatus(runner, REPO_DIR, CANDIDATE, BASE), "error");
  });
});
