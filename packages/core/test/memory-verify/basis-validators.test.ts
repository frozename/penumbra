import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildServices, loadSqliteVec, migrate } from "@src/index.js";
import { validateBasis } from "@src/memory-verify/basis.js";
import { TestEmbedder } from "@src/testing/index.js";

function freshServices(opts: { mainRepoDir?: string } = {}): {
  db: Database;
  root: string;
  reviewsDir: string;
  services: ReturnType<typeof buildServices>;
  stop: () => void;
} {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const root = mkdtempSync(join(tmpdir(), "memory-basis-"));
  const reviewsDir = join(root, ".penumbra", "reviews");
  mkdirSync(reviewsDir, { recursive: true });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: join(root, "storage"),
    reviewsDir,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    mainRepoDir: opts.mainRepoDir ?? process.cwd(),
    worktreeRootDir: join(root, "worktrees"),
  });
  return {
    db,
    root,
    reviewsDir,
    services,
    stop: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function createGitRepoWithCommit(): { repoDir: string; commit: string; stop: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), "memory-basis-git-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoDir,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repoDir, stdio: "ignore" });
  writeFileSync(join(repoDir, "README.md"), "# test\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" })
    .trim()
    .slice(0, 7);
  return {
    repoDir,
    commit,
    stop: (): void => {
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

function seedHandoff(
  db: Database,
  handoffId: string,
  fromAgent: string,
  toAgent: string,
  taskType: string,
): void {
  db.run(
    `INSERT INTO handoffs(handoff_id, ts, conversation_id, from_agent, to_agent, message, status, chain_task_type)
     VALUES (?, '2026-05-17T12:00:00.000Z', ?, ?, ?, 'prompt', 'dispatched', ?)`,
    [handoffId, `c-${handoffId}`, fromAgent, toAgent, taskType],
  );
}

test("validateBasis accepts lane_close bases when the lane is closed and reviewer differs", async () => {
  const ctx = freshServices();
  try {
    ctx.db.run(
      `INSERT INTO lane_ledger(lane_id, ts_opened, ts_closed, task_class, implementer_handoff, reviewer_handoff, gate_status)
       VALUES ('lane-1', '2026-05-17T10:00:00.000Z', '2026-05-17T11:00:00.000Z', 'implement', 'h-impl', 'h-review', 'closed')`,
    );
    const result = await validateBasis(ctx.services, {
      kind: "lane_close",
      lane_id: "lane-1",
      reviewer_handoff: "h-review",
    });
    expect(result).toEqual({ ok: true });
  } finally {
    ctx.stop();
  }
});

test("validateBasis accepts dispatch_land bases when the commit exists", async () => {
  const repo = createGitRepoWithCommit();
  const ctx = freshServices({ mainRepoDir: repo.repoDir });
  try {
    seedHandoff(ctx.db, "h-review", "h-impl", "h-review", "review_adversarial");
    const result = await validateBasis(ctx.services, {
      kind: "dispatch_land",
      merge_commit: repo.commit,
      reviewer_handoff: "h-review",
    });
    expect(result).toEqual({ ok: true });
  } finally {
    ctx.stop();
    repo.stop();
  }
});

test("validateBasis rejects dispatch_land bases when the commit is missing", async () => {
  const repo = createGitRepoWithCommit();
  const ctx = freshServices({ mainRepoDir: repo.repoDir });
  try {
    seedHandoff(ctx.db, "h-review", "h-impl", "h-review", "review_adversarial");
    const result = await validateBasis(ctx.services, {
      kind: "dispatch_land",
      merge_commit: "deadbee",
      reviewer_handoff: "h-review",
    });
    expect(result).toEqual({ ok: false, status: 404, reason: "merge commit not found" });
  } finally {
    ctx.stop();
    repo.stop();
  }
});

test("validateBasis rejects adversarial_review traversal via ..", async () => {
  const ctx = freshServices();
  try {
    const result = await validateBasis(ctx.services, {
      kind: "adversarial_review",
      synthesis_path: "../escape.md",
      synthesizer_handoff: "h-synth",
    });
    expect(result).toEqual({ ok: false, status: 400, reason: "synthesis_path contains traversal" });
  } finally {
    ctx.stop();
  }
});

test("validateBasis rejects adversarial_review traversal via absolute path outside reviews dir", async () => {
  const ctx = freshServices();
  try {
    const result = await validateBasis(ctx.services, {
      kind: "adversarial_review",
      synthesis_path: "/tmp/outside.md",
      synthesizer_handoff: "h-synth",
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(typeof (result as { reason?: unknown }).reason).toBe("string");
  } finally {
    ctx.stop();
  }
});

test("validateBasis rejects adversarial_review symlink escapes", async () => {
  const ctx = freshServices();
  try {
    const outside = join(ctx.root, "outside.md");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(ctx.reviewsDir, "link.md"));
    const result = await validateBasis(ctx.services, {
      kind: "adversarial_review",
      synthesis_path: "link.md",
      synthesizer_handoff: "h-synth",
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(String((result as { reason?: unknown }).reason)).toContain("escapes");
  } finally {
    ctx.stop();
  }
});
