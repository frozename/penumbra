import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runLatestContinuationNoteSource } from "@src/recall-sources/latest-continuation-note.js";

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "latest-continuation-"));
  mkdirSync(join(repo, "docs/notes"), { recursive: true });
  return repo;
}

test("picks the newest-mtime candidate among bare and .skeleton.md files", async () => {
  const repo = makeRepo();
  try {
    const older = join(repo, "docs/notes/maestro-continuation-2026-05-01.md");
    const newer = join(repo, "docs/notes/maestro-continuation-2026-05-02.skeleton.md");
    writeFileSync(older, "older note\n");
    writeFileSync(newer, "newer note\n");
    const oldTime = new Date("2026-05-01T00:00:00.000Z");
    const newTime = new Date("2026-05-02T00:00:00.000Z");
    await Promise.all([utimes(older, oldTime, oldTime), utimes(newer, newTime, newTime)]);

    const out = await runLatestContinuationNoteSource({ cwd: repo, args: {} });

    if (out.result === null) throw new Error("expected newest continuation note");
    expect(out.result.path).toBe(newer);
    expect(out.result.body).toBe("newer note\n");
    expect(out.result.truncated).toBe(false);
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ignores a newer unapproved .draft.md file and picks the bare note", async () => {
  const repo = makeRepo();
  try {
    const approved = join(repo, "docs/notes/maestro-continuation-2026-05-02.md");
    const draft = join(repo, "docs/notes/maestro-continuation-2026-05-03.draft.md");
    writeFileSync(approved, "approved note\n");
    writeFileSync(draft, "draft note\n");
    const approvedTime = new Date("2026-05-02T00:00:00.000Z");
    const draftTime = new Date("2026-05-03T00:00:00.000Z");
    await Promise.all([
      utimes(approved, approvedTime, approvedTime),
      utimes(draft, draftTime, draftTime),
    ]);

    const out = await runLatestContinuationNoteSource({ cwd: repo, args: {} });

    if (out.result === null) throw new Error("expected approved continuation note");
    expect(out.result.path).toBe(approved);
    expect(out.result.body).toBe("approved note\n");
    expect(out.result.truncated).toBe(false);
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("returns null when only an unapproved .draft.md continuation file is present", async () => {
  const repo = makeRepo();
  try {
    writeFileSync(
      join(repo, "docs/notes/maestro-continuation-2026-05-03.draft.md"),
      "draft note\n",
    );

    const out = await runLatestContinuationNoteSource({ cwd: repo, args: {} });

    expect(out.result).toBeNull();
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("returns null, not a throw, when docs/notes/ is empty", async () => {
  const repo = makeRepo();
  try {
    const out = await runLatestContinuationNoteSource({ cwd: repo, args: {} });
    expect(out.result).toBeNull();
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("tolerates a partially-written file -- parse failure degrades to null", async () => {
  const repo = makeRepo();
  try {
    writeFileSync(
      join(repo, "docs/notes/maestro-continuation-2026-05-03.md"),
      Buffer.from([0xff, 0xfe, 0xfd]),
    );

    const out = await runLatestContinuationNoteSource({ cwd: repo, args: {} });

    expect(out.result).toBeNull();
    expect(out.warnings).toEqual([]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the glob is anchored to repoRoot/docs/notes and cannot be widened by a crafted template variable", async () => {
  const repo = makeRepo();
  try {
    writeFileSync(join(repo, "maestro-continuation-2026-05-04.md"), "outside\n");
    writeFileSync(join(repo, "docs/notes/maestro-continuation-2026-05-04.md"), "inside\n");

    const out = await runLatestContinuationNoteSource({
      cwd: repo,
      args: { pattern: "../maestro-continuation-*.md" },
    });

    if (out.result === null) throw new Error("expected contained continuation note");
    expect(out.result.body).toBe("inside\n");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("finds repoRoot docs/notes candidates when cwd is a repo subdirectory", async () => {
  const repo = makeRepo();
  try {
    const subdir = join(repo, "packages/core");
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(repo, "docs/notes/maestro-continuation-2026-05-05.md"), "root note\n");

    const out = await runLatestContinuationNoteSource({
      cwd: subdir,
      repoRoot: repo,
      args: {},
    });

    if (out.result === null) throw new Error("expected repo-root continuation note");
    expect(out.result.body).toBe("root note\n");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("skips one stat failure without discarding other continuation candidates", async () => {
  const repo = makeRepo();
  try {
    const bad = "maestro-continuation-2026-05-05.md";
    const good = "maestro-continuation-2026-05-04.md";
    writeFileSync(join(repo, "docs/notes", bad), "bad newer\n");
    writeFileSync(join(repo, "docs/notes", good), "good older\n");

    const out = await runLatestContinuationNoteSource({
      cwd: repo,
      args: {},
      statFile: async (path: Parameters<typeof stat>[0]) => {
        if (String(path).endsWith(bad)) {
          throw new Error("simulated unreadable stat");
        }
        return await stat(path);
      },
    });

    if (out.result === null) throw new Error("expected fallback continuation note");
    expect(out.result.body).toBe("good older\n");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
