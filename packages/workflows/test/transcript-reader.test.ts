import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, truncate, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findActiveTranscriptForCwd,
  resetTranscriptReaderCache,
  transcriptReaderStats,
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

test("reuses an unchanged directory scan", async () => {
  const root = await makeRoot();
  const sub = join(root, CWD_DIR);
  await mkdir(sub, { recursive: true });
  const path = join(sub, "session.jsonl");
  await writeFile(path, "");
  const transcriptTime = new Date("2026-05-04T12:00:00Z");
  const directoryTime = new Date("2026-05-04T12:01:00Z");
  await utimes(path, transcriptTime, transcriptTime);
  await utimes(sub, directoryTime, directoryTime);

  resetTranscriptReaderCache();
  const opts = {
    cwd: CWD,
    claudeProjectsRoot: root,
    now: new Date("2026-05-04T12:02:00Z"),
  };
  expect(findActiveTranscriptForCwd(opts)?.sessionId).toBe("session");
  expect(findActiveTranscriptForCwd(opts)?.sessionId).toBe("session");
  expect(transcriptReaderStats().directoryScans).toBe(1);
});

test("rescans when a new file changes the directory mtime", async () => {
  const root = await makeRoot();
  const sub = join(root, CWD_DIR);
  await mkdir(sub, { recursive: true });
  const olderPath = join(sub, "older.jsonl");
  const newerPath = join(sub, "newer.jsonl");
  const olderTime = new Date("2026-05-04T12:00:00Z");
  const newerTime = new Date("2026-05-04T12:05:00Z");
  await writeFile(olderPath, "");
  await utimes(olderPath, olderTime, olderTime);
  await utimes(sub, new Date("2026-05-04T12:01:00Z"), new Date("2026-05-04T12:01:00Z"));

  resetTranscriptReaderCache();
  const opts = {
    cwd: CWD,
    claudeProjectsRoot: root,
    now: new Date("2026-05-04T12:06:00Z"),
  };
  expect(findActiveTranscriptForCwd(opts)?.sessionId).toBe("older");

  await writeFile(newerPath, "");
  await utimes(olderPath, olderTime, olderTime);
  await utimes(newerPath, newerTime, newerTime);
  await utimes(sub, new Date("2026-05-04T12:02:00Z"), new Date("2026-05-04T12:02:00Z"));

  expect(findActiveTranscriptForCwd(opts)?.sessionId).toBe("newer");
  expect(transcriptReaderStats().directoryScans).toBe(2);
});

test("appends update selected transcript tokens without rescanning the directory", async () => {
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
  const firstTime = new Date("2026-05-04T12:00:00Z");
  const secondTime = new Date("2026-05-04T12:01:00Z");
  const directoryTime = new Date("2026-05-04T12:02:00Z");
  await writeFile(path, lineA);
  await utimes(path, firstTime, firstTime);
  await utimes(sub, directoryTime, directoryTime);

  resetTranscriptReaderCache();
  const opts = {
    cwd: CWD,
    claudeProjectsRoot: root,
    now: new Date("2026-05-04T12:03:00Z"),
  };
  expect(findActiveTranscriptForCwd(opts)?.estimatedTokens).toBe(1);

  await appendFile(path, lineB);
  await utimes(path, secondTime, secondTime);
  await utimes(sub, directoryTime, directoryTime);

  expect(findActiveTranscriptForCwd(opts)?.estimatedTokens).toBe(2);
  expect(transcriptReaderStats().directoryScans).toBe(1);
});

test("TTL rescan discovers a newly active existing transcript", async () => {
  const root = await makeRoot();
  const sub = join(root, CWD_DIR);
  await mkdir(sub, { recursive: true });
  const selectedPath = join(sub, "selected.jsonl");
  const latentPath = join(sub, "latent.jsonl");
  const directoryTime = new Date("2026-05-04T12:06:00Z");
  await writeFile(selectedPath, "");
  await writeFile(latentPath, "");
  await utimes(selectedPath, new Date("2026-05-04T12:00:00Z"), new Date("2026-05-04T12:00:00Z"));
  await utimes(latentPath, new Date("2026-05-04T11:59:00Z"), new Date("2026-05-04T11:59:00Z"));
  await utimes(sub, directoryTime, directoryTime);

  const originalDateNow = Date.now;
  let wallNowMs = 1_000;
  Date.now = (): number => wallNowMs;
  try {
    resetTranscriptReaderCache();
    const opts = {
      cwd: CWD,
      claudeProjectsRoot: root,
      now: new Date("2026-05-04T12:10:00Z"),
      dirScanTtlMs: 1_000,
    };
    expect(findActiveTranscriptForCwd(opts)?.sessionId).toBe("selected");

    await appendFile(latentPath, "\n");
    await utimes(latentPath, new Date("2026-05-04T12:05:00Z"), new Date("2026-05-04T12:05:00Z"));
    await utimes(sub, directoryTime, directoryTime);

    expect(findActiveTranscriptForCwd(opts)?.sessionId).toBe("selected");
    wallNowMs += 1_001;
    expect(findActiveTranscriptForCwd(opts)?.sessionId).toBe("latent");
    expect(transcriptReaderStats().directoryScans).toBe(2);
  } finally {
    Date.now = originalDateNow;
    resetTranscriptReaderCache();
  }
});

test("opts.now cannot freeze the directory scan TTL", async () => {
  const root = await makeRoot();
  const sub = join(root, CWD_DIR);
  await mkdir(sub, { recursive: true });
  const path = join(sub, "session.jsonl");
  await writeFile(path, "");
  const transcriptTime = new Date("2026-05-04T12:00:00Z");
  const directoryTime = new Date("2026-05-04T12:01:00Z");
  await utimes(path, transcriptTime, transcriptTime);
  await utimes(sub, directoryTime, directoryTime);

  const originalDateNow = Date.now;
  let wallNowMs = 10_000;
  Date.now = (): number => wallNowMs;
  try {
    resetTranscriptReaderCache();
    const opts = {
      cwd: CWD,
      claudeProjectsRoot: root,
      now: new Date("2026-05-04T12:02:00Z"),
      dirScanTtlMs: 1_000,
    };
    expect(findActiveTranscriptForCwd(opts)?.sessionId).toBe("session");
    wallNowMs += 1_001;
    expect(findActiveTranscriptForCwd(opts)?.sessionId).toBe("session");
    expect(transcriptReaderStats().directoryScans).toBe(2);
  } finally {
    Date.now = originalDateNow;
    resetTranscriptReaderCache();
  }
});

test("deleting the cached winner forces a rescan when directory mtime is restored", async () => {
  const root = await makeRoot();
  const sub = join(root, CWD_DIR);
  await mkdir(sub, { recursive: true });
  const fallbackPath = join(sub, "fallback.jsonl");
  const winnerPath = join(sub, "winner.jsonl");
  const directoryTime = new Date("2026-05-04T12:03:00Z");
  await writeFile(fallbackPath, "");
  await writeFile(winnerPath, "");
  await utimes(fallbackPath, new Date("2026-05-04T12:00:00Z"), new Date("2026-05-04T12:00:00Z"));
  await utimes(winnerPath, new Date("2026-05-04T12:01:00Z"), new Date("2026-05-04T12:01:00Z"));
  await utimes(sub, directoryTime, directoryTime);

  resetTranscriptReaderCache();
  const opts = {
    cwd: CWD,
    claudeProjectsRoot: root,
    now: new Date("2026-05-04T12:04:00Z"),
  };
  expect(findActiveTranscriptForCwd(opts)?.sessionId).toBe("winner");

  await unlink(winnerPath);
  await utimes(sub, directoryTime, directoryTime);

  expect(findActiveTranscriptForCwd(opts)?.sessionId).toBe("fallback");
  expect(transcriptReaderStats().directoryScans).toBe(2);
});

test("caches empty directory scans and reset clears all reader state", async () => {
  const root = await makeRoot();
  const sub = join(root, CWD_DIR);
  await mkdir(sub, { recursive: true });
  const directoryTime = new Date("2026-05-04T12:00:00Z");
  await utimes(sub, directoryTime, directoryTime);
  const opts = { cwd: CWD, claudeProjectsRoot: root };

  resetTranscriptReaderCache();
  expect(findActiveTranscriptForCwd(opts)).toBeNull();
  expect(findActiveTranscriptForCwd(opts)).toBeNull();
  expect(transcriptReaderStats().directoryScans).toBe(1);

  resetTranscriptReaderCache();
  expect(transcriptReaderStats().directoryScans).toBe(0);
  expect(findActiveTranscriptForCwd(opts)).toBeNull();
  expect(transcriptReaderStats().directoryScans).toBe(1);
});

test("refreshes a cached stale transcript without rescanning the directory", async () => {
  const root = await makeRoot();
  const sub = join(root, CWD_DIR);
  await mkdir(sub, { recursive: true });
  const path = join(sub, "session.jsonl");
  const directoryTime = new Date("2026-05-04T13:01:00Z");
  await writeFile(path, "");
  await utimes(path, new Date("2026-05-04T12:00:00Z"), new Date("2026-05-04T12:00:00Z"));
  await utimes(sub, directoryTime, directoryTime);

  resetTranscriptReaderCache();
  const opts = {
    cwd: CWD,
    claudeProjectsRoot: root,
    now: new Date("2026-05-04T13:00:00Z"),
    staleAfterMin: 30,
  };
  expect(findActiveTranscriptForCwd(opts)).toBeNull();

  const refreshedTime = new Date("2026-05-04T12:55:00Z");
  await utimes(path, refreshedTime, refreshedTime);
  await utimes(sub, directoryTime, directoryTime);

  const refreshed = findActiveTranscriptForCwd(opts);
  expect(refreshed?.sessionId).toBe("session");
  expect(refreshed?.modifiedAt).toEqual(refreshedTime);
  expect(transcriptReaderStats().directoryScans).toBe(1);
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
        message: { role: "user", content: [{ type: "text", text: `line-${String(i)}` }] },
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
