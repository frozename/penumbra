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
  execSync('git add . && git commit -q -m "init"', { cwd: dir, shell: "/bin/bash" });
  return dir;
}

test("file-context surfaces memory hits about the file_path before a Read tool call", async () => {
  const root = mkdtempSync(join(tmpdir(), "fc-int-"));
  const repo = seedRepo(mkdtempSync(join(tmpdir(), "fc-repo-")));
  const playbookSrc = join(import.meta.dir, "../../../../plugin/playbooks/file-context");
  try {
    const pbDir = join(root, "playbooks/file-context");
    mkdirSync(pbDir, { recursive: true });
    // The shipped playbook is slash-only (lifecycle firing was removed for
    // per-Read context cost); restore the lifecycle trigger in the fixture so
    // the trigger->recall->render plumbing stays exercised.
    writeFileSync(
      join(pbDir, "playbook.md"),
      readFileSync(join(playbookSrc, "playbook.md"), "utf8").replace(
        "triggers:\n  - kind: slash\n    command: file-context",
        "triggers:\n  - kind: lifecycle\n    event: pre-tool-use\n    filter:\n      tool_name: [Read]",
      ),
    );
    mkdirSync(join(root, "workflows"), { recursive: true });

    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    expect(reg.errors).toEqual([]);
    const matched = evaluateTriggerEvent(reg, { kind: "lifecycle", event: "pre-tool-use" });
    expect(matched.map((s) => s.name)).toEqual(["file-context"]);

    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });

    const ts = "2026-05-05T07:30:00Z";
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
      ts,
      ts,
      "workflows/src/exec.ts refactor",
      "Refactored exec.ts to accept observationCtx — packages/workflows/src/exec.ts is now templateCtx-aware",
      "{}",
      ts,
      ts,
      "refactor",
      JSON.stringify(["workflows"]),
      "low",
    );
    t2Insert.run(
      "m2",
      "penumbra",
      "u",
      "observation",
      JSON.stringify(["s1"]),
      ts,
      ts,
      "unrelated note",
      "something completely unrelated about agentchat",
      "{}",
      ts,
      ts,
      "note",
      JSON.stringify(["agentchat"]),
      "low",
    );

    const spec = matched[0]!;
    const filePath = "packages/workflows/src/exec.ts";
    const templateCtx: TemplateVarContext = {
      now: () => new Date("2026-05-05T08:00:00Z"),
      project: "penumbra",
      sessionStart: "2026-05-05T07:00:00Z",
      tz: "UTC",
      filePath,
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
      captureCtx: {
        db,
        project: "penumbra",
        sessionId: "hook-trigger",
        userId: "u",
        machineId: "m",
      },
      templateCtx,
    });

    expect(result.outcome).toBe("success");
    const reminder = result.sessionReminder ?? "";
    expect(reminder).toContain(`Context for \`${filePath}\``);
    expect(reminder).toContain("workflows/src/exec.ts refactor");
    expect(reminder).not.toContain("unrelated note");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
