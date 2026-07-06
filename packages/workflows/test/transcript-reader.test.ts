import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findActiveTranscriptForCwd,
  resetTranscriptReaderCache,
} from "../src/transcript-reader.js";

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

test("incremental cache: appended lines add to previous total without re-parsing", async () => {
  const root = await makeRoot();
  const sub = join(root, CWD_DIR);
  await mkdir(sub, { recursive: true });
  const path = join(sub, "session.jsonl");

  const lineA =
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "aaaa" }] },
    }) + "\n";
  const lineB =
    JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "bb" }] },
    }) + "\n";
  await writeFile(path, lineA);

  resetTranscriptReaderCache();
  const first = findActiveTranscriptForCwd({ cwd: CWD, claudeProjectsRoot: root });
  expect(first).not.toBeNull();
  // "aaaa" = 4 * 0.25 = 1
  expect(first!.estimatedTokens).toBe(1);

  await appendFile(path, lineB);

  const second = findActiveTranscriptForCwd({ cwd: CWD, claudeProjectsRoot: root });
  expect(second).not.toBeNull();
  // "aaaa" (1) + "bb" (2 chars -> 1) = 2
  expect(second!.estimatedTokens).toBe(2);
});

test("incremental cache: cold re-reads when file is truncated", async () => {
  const root = await makeRoot();
  const sub = join(root, CWD_DIR);
  await mkdir(sub, { recursive: true });
  const path = join(sub, "session.jsonl");

  const lineA =
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "aaaaaaaa" }] },
    }) + "\n";
  const lineShort =
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "z" }] },
    }) + "\n";
  await writeFile(path, lineA + lineA);

  resetTranscriptReaderCache();
  const first = findActiveTranscriptForCwd({ cwd: CWD, claudeProjectsRoot: root });
  expect(first).not.toBeNull();
  // Two lines of "aaaaaaaa" (8 * 0.25 = 2 each) = 4
  expect(first!.estimatedTokens).toBe(4);

  // Truncate & replace with a much smaller file (rotation-like).
  await truncate(path, 0);
  await writeFile(path, lineShort);

  const second = findActiveTranscriptForCwd({ cwd: CWD, claudeProjectsRoot: root });
  expect(second).not.toBeNull();
  // Fresh content only: "z" = 1 char -> ceil(0.25) = 1
  expect(second!.estimatedTokens).toBe(1);
});

test("incremental cache: second call after append is dramatically faster", async () => {
  const root = await makeRoot();
  const sub = join(root, CWD_DIR);
  await mkdir(sub, { recursive: true });
  const path = join(sub, "session.jsonl");

  const lines: string[] = [];
  for (let i = 0; i < 30_000; i++) {
    lines.push(
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: `line-${i}` }] },
      }),
    );
  }
  await writeFile(path, lines.join("\n") + "\n");

  resetTranscriptReaderCache();
  // Warm the JIT with a dry pass on a different, unrelated read is unnecessary;
  // the first call is the "expensive" cold pass we care about.
  const t1Start = Bun.nanoseconds();
  const first = findActiveTranscriptForCwd({ cwd: CWD, claudeProjectsRoot: root });
  const t1 = Bun.nanoseconds() - t1Start;
  expect(first).not.toBeNull();

  const appended =
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "appended" }] },
    }) + "\n";
  await appendFile(path, appended);

  const t2Start = Bun.nanoseconds();
  const second = findActiveTranscriptForCwd({ cwd: CWD, claudeProjectsRoot: root });
  const t2 = Bun.nanoseconds() - t2Start;
  expect(second).not.toBeNull();
  // "appended" = 8 * 0.25 = 2 tokens added
  expect(second!.estimatedTokens).toBe(first!.estimatedTokens + 2);

  // Defect check: 2nd call after 1-line append <= first/20
  expect(t2 * 20).toBeLessThanOrEqual(t1);
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
