import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findActiveTranscriptForCwd } from "../src/transcript-reader.js";

const CWD = "/Volumes/WorkSSD/repos/test-project";
const CWD_DIR = "-Volumes-WorkSSD-repos-test-project";

async function makeRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "transcript-reader-"));
}

test("returns null when claudeProjectsRoot does not exist", () => {
  const result = findActiveTranscriptForCwd({
    cwd: CWD,
    claudeProjectsRoot: "/definitely/does/not/exist/abc123",
  });
  expect(result).toBeNull();
});

test("returns null when cwd subdir is empty", async () => {
  const root = await makeRoot();
  await mkdir(join(root, CWD_DIR), { recursive: true });
  const result = findActiveTranscriptForCwd({ cwd: CWD, claudeProjectsRoot: root });
  expect(result).toBeNull();
});

test("returns null when no matching subdir for cwd", async () => {
  const root = await makeRoot();
  await mkdir(join(root, "-some-other-project"), { recursive: true });
  await writeFile(join(root, "-some-other-project", "session.jsonl"), "");
  const result = findActiveTranscriptForCwd({ cwd: CWD, claudeProjectsRoot: root });
  expect(result).toBeNull();
});

test("estimates tokens from user+assistant text only, skipping tool_use", async () => {
  const root = await makeRoot();
  const sub = join(root, CWD_DIR);
  await mkdir(sub, { recursive: true });
  const sample = [
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "hello there" }] },
    }),
    JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "hi back" }] },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "x", name: "y", input: {} }],
      },
    }),
  ].join("\n");
  await writeFile(join(sub, "session.jsonl"), sample);

  const result = findActiveTranscriptForCwd({ cwd: CWD, claudeProjectsRoot: root });
  expect(result).not.toBeNull();
  // 'hello there' = 11 chars * 0.25 = 2.75 -> 3
  // 'hi back' = 7 chars * 0.25 = 1.75 -> 2
  // tool_use skipped
  expect(result!.estimatedTokens).toBe(5);
  expect(result!.sessionId).toBe("session");
});

test("returns the most-recently-modified jsonl when multiple exist", async () => {
  const root = await makeRoot();
  const sub = join(root, CWD_DIR);
  await mkdir(sub, { recursive: true });
  const olderPath = join(sub, "older.jsonl");
  const newerPath = join(sub, "newer.jsonl");
  await writeFile(
    olderPath,
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "aaaa" }] },
    }),
  );
  await writeFile(
    newerPath,
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "bbbb" }] },
    }),
  );
  // Force older mtime back 10 minutes
  const tenMinAgo = new Date(Date.now() - 10 * 60_000);
  await utimes(olderPath, tenMinAgo, tenMinAgo);

  const result = findActiveTranscriptForCwd({ cwd: CWD, claudeProjectsRoot: root });
  expect(result).not.toBeNull();
  expect(result!.sessionId).toBe("newer");
});

test("returns null when transcript is stale beyond staleAfterMin", async () => {
  const root = await makeRoot();
  const sub = join(root, CWD_DIR);
  await mkdir(sub, { recursive: true });
  const path = join(sub, "old.jsonl");
  await writeFile(
    path,
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "old" }] },
    }),
  );
  const baseline = new Date("2026-05-04T12:00:00Z");
  // Mark file as modified 60 minutes before `now`
  const oldTime = new Date(baseline.getTime() - 60 * 60_000);
  await utimes(path, oldTime, oldTime);

  const result = findActiveTranscriptForCwd({
    cwd: CWD,
    claudeProjectsRoot: root,
    now: baseline,
    staleAfterMin: 30,
  });
  expect(result).toBeNull();
});
