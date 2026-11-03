import type { execFile as nodeExecFile } from "node:child_process";

import { expect, mock, test } from "bun:test";

import {
  type AutocommitDeps,
  autocommitOnChainEnd,
  extractBriefCommitMessage,
} from "@src/worker/autocommit-on-chain-end.js";

const HID = "11111111-2222-3333-4444-555555555555";
const WIP_SUBJECT_PREFIX =
  "wip(autocommit): chain ended with uncommitted changes -- agent seat-a did not commit explicitly";

// Bun's mock() loses the concrete arg tuple across the cast; this laundering
// helper lets each caller declare the tuple it expects (same pattern as
// dispatcher-autocommit-on-chain-end.test.ts).
function mockCalls<T extends readonly unknown[] = unknown[]>(fn: unknown): T[] {
  return (fn as { mock: { calls: T[] } }).mock.calls;
}

function asExecFile(fn: ReturnType<typeof mock>): typeof nodeExecFile {
  return fn as unknown as typeof nodeExecFile;
}

function makeGitExecFile(): ReturnType<typeof mock> {
  return mock((_cmd: string, args: string[]) => {
    if (args.includes("status")) return Promise.resolve({ stdout: " M src/a.ts\n", stderr: "" });
    if (args.includes("rev-parse")) return Promise.resolve({ stdout: "abc123\n", stderr: "" });
    return Promise.resolve({ stdout: "", stderr: "" });
  });
}

function makeDeps(execFile: ReturnType<typeof mock>): AutocommitDeps {
  return { execFile: asExecFile(execFile), log: { warn: mock(), debug: mock() } };
}

function commitMessageOf(execFile: ReturnType<typeof mock>): string {
  const call = mockCalls<[string, string[]]>(execFile).find((c) => c[1].includes("commit"));
  if (!call) throw new Error("expected a git commit call");
  const message = call[1][call[1].indexOf("-m") + 1];
  if (typeof message !== "string") throw new Error("expected -m <message> in git commit call");
  return message;
}

test("extractBriefCommitMessage pulls the Commit message line out of a brief", () => {
  expect(
    extractBriefCommitMessage(
      "Fix the bug.\nCommit message: fix(core): clamp retry budget\nThanks",
    ),
  ).toBe("fix(core): clamp retry budget");
});

test("extractBriefCommitMessage is case-insensitive and strips backticks and quotes", () => {
  expect(extractBriefCommitMessage("commit message: `feat(x): y`")).toBe("feat(x): y");
  expect(extractBriefCommitMessage('Commit message: "feat(x): y"')).toBe("feat(x): y");
});

test("extractBriefCommitMessage returns null without a usable Commit message line", () => {
  expect(extractBriefCommitMessage("no marker line here")).toBeNull();
  expect(extractBriefCommitMessage("Commit message:   ")).toBeNull();
  expect(extractBriefCommitMessage(undefined)).toBeNull();
});

test("autocommit uses the brief's commit message as the subject", async () => {
  const execFile = makeGitExecFile();
  const result = await autocommitOnChainEnd(
    {
      handoff_id: HID,
      conversation_id: "c1",
      to_agent: "seat-a",
      message: "do it\nCommit message: fix(core): clamp retry budget",
    },
    { path: "/wt" },
    makeDeps(execFile),
  );

  const message = commitMessageOf(execFile);
  const lines = message.split("\n");
  expect(lines[0]).toBe("fix(core): clamp retry budget");
  expect(message).not.toContain("wip(autocommit)");
  expect(lines.some((line) => line.includes("seat-a") && line.includes(HID))).toBe(true);
  expect(lines.slice(1).every((line) => !/^[A-Za-z0-9-]+: \S/.test(line))).toBe(true);
  expect(result).toEqual({ committed: true, sha: "abc123" });
});

test("autocommit keeps the wip subject when the brief has no commit message", async () => {
  const execFile = makeGitExecFile();
  await autocommitOnChainEnd(
    { handoff_id: HID, conversation_id: "c1", to_agent: "seat-a", message: "just do it" },
    { path: "/wt" },
    makeDeps(execFile),
  );

  expect(commitMessageOf(execFile).startsWith(WIP_SUBJECT_PREFIX)).toBe(true);
});

test("autocommit keeps the wip subject when the handoff omits message", async () => {
  const execFile = makeGitExecFile();
  await autocommitOnChainEnd(
    { handoff_id: HID, conversation_id: "c1", to_agent: "seat-a" },
    { path: "/wt" },
    makeDeps(execFile),
  );

  expect(commitMessageOf(execFile).startsWith(WIP_SUBJECT_PREFIX)).toBe(true);
});
