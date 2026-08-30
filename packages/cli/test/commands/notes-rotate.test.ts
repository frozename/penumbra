import { runNotesRotate } from "@src/commands/notes-rotate.js";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectAsyncThrow } from "./_helpers.js";

let rootDir = "";
let originalCwd = "";

beforeEach(() => {
  originalCwd = process.cwd();
  rootDir = mkdtempSync(join(tmpdir(), "penumbra-notes-rotate-"));
  mkdirSync(join(rootDir, "docs", "notes"), { recursive: true });
  process.chdir(rootDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  mock.restore();
});

function writeNotes(name: string, content = name): void {
  writeFileSync(join(rootDir, "docs", "notes", name), `${content}\n`);
}

function notesPath(name: string): string {
  return join(rootDir, "docs", "notes", name);
}

function archivePath(name: string, month = "2026-05"): string {
  return join(rootDir, "docs", "notes", "archive", month, name);
}

function git(args: string[]): void {
  const proc = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: rootDir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(proc.stderr)}`);
  }
}

describe("runNotesRotate", () => {
  test("dry-run lists files that would be moved and does not mutate the filesystem", async () => {
    for (let i = 1; i <= 12; i++)
      writeNotes(`maestro-continuation-2026-05-${String(i).padStart(2, "0")}.md`);
    for (let i = 1; i <= 12; i++)
      writeNotes(`session-summary-2026-05-${String(i).padStart(2, "0")}.md`);

    const result = await runNotesRotate({
      rootDir,
      apply: false,
      keepCount: 10,
      now: new Date("2026-05-19T12:00:00.000Z"),
    });

    expect(result.dry_run).toBe(true);
    expect(result.would_move).toHaveLength(4);
    expect(result.moved).toHaveLength(0);
    expect(existsSync(archivePath("maestro-continuation-2026-05-01.md"))).toBe(false);
    expect(existsSync(notesPath("maestro-continuation-2026-05-01.md"))).toBe(true);
  });

  test("--apply moves old files into docs/notes/archive/YYYY-MM/ and returns counts", async () => {
    for (let i = 1; i <= 12; i++)
      writeNotes(`maestro-continuation-2026-05-${String(i).padStart(2, "0")}.md`);

    const result = await runNotesRotate({
      rootDir,
      apply: true,
      keepCount: 10,
      now: new Date("2026-05-19T12:00:00.000Z"),
    });

    expect(result.dry_run).toBe(false);
    expect(result.moved).toHaveLength(2);
    expect(result.moved[0]?.destination).toBe(archivePath("maestro-continuation-2026-05-01.md"));
    expect(existsSync(notesPath("maestro-continuation-2026-05-01.md"))).toBe(false);
    expect(existsSync(archivePath("maestro-continuation-2026-05-01.md"))).toBe(true);
    expect(readFileSync(archivePath("maestro-continuation-2026-05-01.md"), "utf8")).toContain(
      "maestro-continuation-2026-05-01.md",
    );
  });

  test("files at or above the keep-count threshold are not moved", async () => {
    for (let i = 1; i <= 10; i++)
      writeNotes(`session-summary-2026-05-${String(i).padStart(2, "0")}.md`);

    const result = await runNotesRotate({
      rootDir,
      apply: true,
      keepCount: 10,
      now: new Date("2026-05-19T12:00:00.000Z"),
    });

    expect(result.would_move).toHaveLength(0);
    expect(result.moved).toHaveLength(0);
    expect(existsSync(notesPath("session-summary-2026-05-01.md"))).toBe(true);
    expect(existsSync(archivePath("session-summary-2026-05-01.md"))).toBe(false);
  });

  test("--keep-count 5 keeps only 5 files and moves older ones", async () => {
    for (let i = 1; i <= 6; i++)
      writeNotes(`maestro-continuation-2026-05-${String(i).padStart(2, "0")}.md`);

    const result = await runNotesRotate({
      rootDir,
      apply: true,
      keepCount: 5,
      now: new Date("2026-05-19T12:00:00.000Z"),
    });

    expect(result.moved).toHaveLength(1);
    expect(existsSync(notesPath("maestro-continuation-2026-05-01.md"))).toBe(false);
    expect(existsSync(notesPath("maestro-continuation-2026-05-06.md"))).toBe(true);
  });

  test("--keep-count 4 fails the sanity guard", async () => {
    writeNotes("maestro-continuation-2026-05-01.md");

    await expectAsyncThrow(
      runNotesRotate({
        rootDir,
        apply: false,
        keepCount: 4,
        now: new Date("2026-05-19T12:00:00.000Z"),
      }),
      "keep-count must be at least 5",
    );
  });

  test("refuses to rotate when a candidate has a staged-only modification", async () => {
    for (let i = 1; i <= 12; i++)
      writeNotes(`maestro-continuation-2026-05-${String(i).padStart(2, "0")}.md`);

    git(["init", "--quiet", "-b", "main"]);
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "seed notes"]);

    // Modify and stage a candidate (worktree is clean after `git add`).
    const candidate = notesPath("maestro-continuation-2026-05-01.md");
    writeFileSync(candidate, "staged-only edit\n");
    git(["add", candidate]);

    await expectAsyncThrow(
      runNotesRotate({
        rootDir,
        apply: true,
        keepCount: 10,
        now: new Date("2026-05-19T12:00:00.000Z"),
      }),
      /refusing.*modified files/,
    );

    expect(existsSync(notesPath("maestro-continuation-2026-05-01.md"))).toBe(true);
    expect(existsSync(archivePath("maestro-continuation-2026-05-01.md"))).toBe(false);
  });

  test("refuses to rotate when git status fails while checking candidates", async () => {
    for (let i = 1; i <= 12; i++)
      writeNotes(`maestro-continuation-2026-05-${String(i).padStart(2, "0")}.md`);

    git(["init", "--quiet", "-b", "main"]);
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "seed notes"]);

    const candidate = notesPath("maestro-continuation-2026-05-01.md");
    writeFileSync(candidate, "dirty edit\n");
    writeFileSync(join(rootDir, ".git", "index"), "not a git index\n");

    await expectAsyncThrow(
      runNotesRotate({
        rootDir,
        apply: true,
        keepCount: 10,
        now: new Date("2026-05-19T12:00:00.000Z"),
      }),
      /git status failed while checking candidate files/,
    );

    expect(existsSync(notesPath("maestro-continuation-2026-05-01.md"))).toBe(true);
    expect(existsSync(archivePath("maestro-continuation-2026-05-01.md"))).toBe(false);
  });

  test("unrelated prefixes are not touched", async () => {
    writeNotes("eval-plan-T1-prereq-report-2026-05-16.md");
    writeNotes("maestro-continuation-2026-05-01.md");
    writeNotes("session-summary-2026-05-01.md");
    writeNotes("session-summary-2026-05-02.md");
    writeNotes("session-summary-2026-05-03.md");
    writeNotes("session-summary-2026-05-04.md");
    writeNotes("session-summary-2026-05-05.md");
    writeNotes("session-summary-2026-05-06.md");
    writeNotes("session-summary-2026-05-07.md");
    writeNotes("session-summary-2026-05-08.md");
    writeNotes("session-summary-2026-05-09.md");
    writeNotes("session-summary-2026-05-10.md");
    writeNotes("session-summary-2026-05-11.md");

    const result = await runNotesRotate({
      rootDir,
      apply: true,
      keepCount: 10,
      now: new Date("2026-05-19T12:00:00.000Z"),
    });

    expect(existsSync(notesPath("eval-plan-T1-prereq-report-2026-05-16.md"))).toBe(true);
    expect(result.moved.some((row) => row.source.includes("eval-plan"))).toBe(false);
  });
});
