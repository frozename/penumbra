import { loadSqliteVec, migrate } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import {
  buildRegistry,
  composeRecall,
  evaluateTriggerEvent,
  executeWorkflow,
  type TemplateVarContext,
} from "@src/index.js";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

function seedRepo(dir: string): string {
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "one\n");
  execSync('git add . && git commit -q -m "first commit"', { cwd: dir, shell: "/bin/bash" });
  return dir;
}

test('prompt-classify recall surfaces recent t2 entries, not literal "session" matches', async () => {
  const root = mkdtempSync(join(tmpdir(), "pc-int-"));
  const repo = seedRepo(mkdtempSync(join(tmpdir(), "pc-repo-")));
  const playbookSrc = join(import.meta.dir, "../../../../plugin/playbooks/prompt-classify");
  try {
    const pbDir = join(root, "playbooks/prompt-classify");
    mkdirSync(pbDir, { recursive: true });
    // The shipped playbook is slash-only (lifecycle firing was removed for
    // per-prompt context cost); restore the lifecycle trigger in the fixture
    // so the trigger->recall->render plumbing stays exercised.
    writeFileSync(
      join(pbDir, "playbook.md"),
      readFileSync(join(playbookSrc, "playbook.md"), "utf8").replace(
        "triggers:\n  - kind: slash\n    command: prompt-classify",
        "triggers:\n  - kind: lifecycle\n    event: user-prompt-submit",
      ),
    );
    mkdirSync(join(root, "workflows"), { recursive: true });

    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    expect(reg.errors).toEqual([]);
    const matched = evaluateTriggerEvent(reg, { kind: "lifecycle", event: "user-prompt-submit" });
    expect(matched.map((s) => s.name)).toEqual(["prompt-classify"]);

    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });

    const sessionStart = "2026-05-05T07:00:00Z";
    const tsRecent = "2026-05-05T07:30:00Z";
    const tsOlder = "2026-05-04T08:00:00Z";
    const t2Insert = db.prepare(`
      INSERT INTO t2_memories (
        memory_id, project_id, user_id, kind,
        source_session_ids, window_start, window_end,
        title, body, metadata_json, created_at, updated_at,
        obs_type, concepts, severity
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    t2Insert.run(
      "m1",
      "penumbra",
      "u",
      "observation",
      JSON.stringify(["s1"]),
      tsRecent,
      tsRecent,
      "Phase 5 Refactor Shipped",
      "WorkflowRegistry hoisted to core package",
      "{}",
      tsRecent,
      tsRecent,
      "feature",
      JSON.stringify(["workflows", "core"]),
      "low",
    );
    t2Insert.run(
      "m2",
      "penumbra",
      "u",
      "observation",
      JSON.stringify(["s1"]),
      tsRecent,
      tsRecent,
      "Sweeper Activity-Aware Fix",
      "Stale-handoff sweeper now considers recent activity",
      "{}",
      tsRecent,
      tsRecent,
      "bugfix",
      JSON.stringify(["reliability"]),
      "medium",
    );
    t2Insert.run(
      "m3",
      "penumbra",
      "u",
      "observation",
      JSON.stringify(["s0"]),
      tsOlder,
      tsOlder,
      "Standard Session Context",
      "session context that should NOT match anymore",
      "{}",
      tsOlder,
      tsOlder,
      "session",
      JSON.stringify(["session"]),
      "low",
    );

    const spec = matched[0]!;
    const templateCtx: TemplateVarContext = {
      now: () => new Date("2026-05-05T08:00:00Z"),
      project: "penumbra",
      sessionStart,
      tz: "UTC",
    };
    const bundle = await composeRecall({
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      cwd: repo,
      project: "penumbra",
      sources: spec.recall,
      budgetTokens: spec.recall_budget_tokens,
      templateCtx,
    });

    const result = await executeWorkflow({
      spec,
      bundle,
      storageRoot: root,
      captureCtx: { db, project: "penumbra", sessionId: "s1", userId: "u", machineId: "m" },
    });

    expect(result.outcome).toBe("success");
    const reminder = result.sessionReminder ?? "";
    expect(reminder).toContain("Recent session activity");
    expect(reminder).toContain("Phase 5 Refactor Shipped");
    expect(reminder).toContain("Sweeper Activity-Aware Fix");
    expect(reminder).not.toContain("Standard Session Context");
    expect(reminder).toContain("first commit");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
