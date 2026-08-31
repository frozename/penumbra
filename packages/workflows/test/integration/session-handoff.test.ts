import { loadSqliteVec, migrate } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRegistry, composeRecall, evaluateTriggerEvent, executeWorkflow } from "@src/index.js";
import { emitNextSessionPromptOutput, PRESERVE_NEXT_SESSION_PROMPT } from "@src/outputs/index.js";

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
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  execSync('git add . && git commit -q -m "second commit"', { cwd: dir, shell: "/bin/bash" });
  return dir;
}

test("session-handoff playbook fires on pre-compact, renders file, captures outcome", async () => {
  const root = mkdtempSync(join(tmpdir(), "sh-int-"));
  const repo = seedRepo(mkdtempSync(join(tmpdir(), "sh-repo-")));
  const playbookSrc = join(import.meta.dir, "../../../../plugin/playbooks/session-handoff");
  const stopPlaybookSrc = join(
    import.meta.dir,
    "../../../../plugin/playbooks/session-handoff-stop",
  );
  try {
    const pbDir = join(root, "playbooks/session-handoff");
    mkdirSync(pbDir, { recursive: true });
    writeFileSync(
      join(pbDir, "playbook.md"),
      readFileSync(join(playbookSrc, "playbook.md"), "utf8"),
    );
    const stopPbDir = join(root, "playbooks/session-handoff-stop");
    mkdirSync(stopPbDir, { recursive: true });
    writeFileSync(
      join(stopPbDir, "playbook.md"),
      readFileSync(join(stopPlaybookSrc, "playbook.md"), "utf8"),
    );
    mkdirSync(join(root, "workflows"), { recursive: true });

    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    expect(reg.errors).toEqual([]);
    const matched = evaluateTriggerEvent(reg, { kind: "lifecycle", event: "pre-compact" });
    expect(matched.map((s) => s.name)).toEqual(["session-handoff"]);
    const stopped = evaluateTriggerEvent(reg, { kind: "lifecycle", event: "stop" });
    expect(stopped.map((s) => s.name)).toEqual(["session-handoff-stop"]);
    const slashed = evaluateTriggerEvent(reg, {
      kind: "slash",
      command: "handoff",
    });
    expect(slashed.map((s) => s.name)).toEqual(["session-handoff"]);

    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });

    const ts1 = "2026-05-04T10:00:00Z";
    const ts2 = "2026-05-04T11:00:00Z";
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
      ts1,
      ts1,
      "session kickoff notes",
      "Started session work on workflow runtime",
      "{}",
      ts1,
      ts1,
      "session",
      JSON.stringify(["session"]),
      "low",
    );
    t2Insert.run(
      "m2",
      "penumbra",
      "u",
      "observation",
      JSON.stringify(["s1"]),
      ts2,
      ts2,
      "session midpoint review",
      "Mid-session review of progress",
      "{}",
      ts2,
      ts2,
      "session",
      JSON.stringify(["session"]),
      "low",
    );

    db.run(`
      INSERT INTO dispatch_events (id, handoff_id, source, kind, ts, meta_json)
      VALUES
        (1, 'h-pending-1', 'worker', 'dispatch.start', '2026-05-04T10:05:00Z', '{}'),
        (2, 'h-pending-1', 'worker', 'dispatch.end',   '2026-05-04T10:10:00Z', '{}');
    `);

    db.run(`
      INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
      VALUES
        ('h-pending-1', '2026-05-04T10:05:00Z', 'c1', 'maestro', 'worker', 'session-handoff seed message', 'pending');
    `);

    const spec = matched[0]!;
    const bundle = await composeRecall({
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      cwd: repo,
      project: "penumbra",
      sources: spec.recall,
      budgetTokens: spec.recall_budget_tokens,
    });

    const notesDir = join(root, "docs/notes");
    mkdirSync(notesDir, { recursive: true });
    const preservedMorningNote = join(notesDir, "maestro-continuation-2026-08-31-morning.md");
    const preservedPmNote = join(notesDir, "maestro-continuation-2026-08-31-pm.md");
    const preservedEveningNote = join(notesDir, "maestro-continuation-2026-08-31-evening.md");
    writeFileSync(preservedMorningNote, "operator morning note\n");
    writeFileSync(preservedPmNote, "operator pm note\n");
    writeFileSync(preservedEveningNote, "operator evening note\n");

    const result = await executeWorkflow({
      spec,
      bundle,
      storageRoot: root,
      repoRoot: root,
      captureCtx: { db, project: "penumbra", sessionId: "s1", userId: "u", machineId: "m" },
    });

    expect(result.outcome).toBe("success");
    const emittedNotes = readdirSync(notesDir).filter((name) => name.endsWith(".skeleton.md"));
    expect(emittedNotes).toHaveLength(1);
    expect(emittedNotes[0]).toBe("maestro-continuation-2026-08-31-pm.skeleton.md");
    const body = readFileSync(join(notesDir, emittedNotes[0]!), "utf8");
    expect(body).toContain("Maestro continuation prompt");
    expect(body).toContain("second commit");
    expect(body).toContain("h-pending-1");
    expect(readFileSync(preservedMorningNote, "utf8")).toBe("operator morning note\n");
    expect(readFileSync(preservedPmNote, "utf8")).toBe("operator pm note\n");
    expect(readFileSync(preservedEveningNote, "utf8")).toBe("operator evening note\n");

    const stats = db
      .query("SELECT samples, successes FROM workflow_stats WHERE workflow_name='session-handoff'")
      .get() as { samples: number; successes: number };
    expect(stats.samples).toBe(1);
    expect(stats.successes).toBe(1);

    const events = db
      .query("SELECT event_type FROM t0_events WHERE event_type LIKE 'workflow.%' ORDER BY ts")
      .all() as { event_type: string }[];
    expect(events.map((e) => e.event_type)).toEqual([
      "workflow.run",
      "workflow.recall",
      "workflow.outcome",
    ]);

    expect(existsSync(join(root, "pending-handoff.md"))).toBe(true);

    writeFileSync(join(notesDir, emittedNotes[0]!), "stale skeleton\n");
    const secondBundle = {
      ...bundle,
      byKey: {
        ...bundle.byKey,
        "git.log": "second-run-marker",
      },
    };
    const secondResult = await executeWorkflow({
      spec,
      bundle: secondBundle,
      storageRoot: root,
      repoRoot: root,
      captureCtx: { db, project: "penumbra", sessionId: "s1", userId: "u", machineId: "m" },
    });

    expect(secondResult.outcome).toBe("success");
    const refreshedBody = readFileSync(join(notesDir, emittedNotes[0]!), "utf8");
    expect(refreshedBody).toContain("second-run-marker");
    expect(refreshedBody).not.toBe("stale skeleton\n");
    expect(readFileSync(preservedPmNote, "utf8")).toBe("operator pm note\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("stop trigger writes lightweight checkpoint, while pre-compact keeps full handoff composer", async () => {
  const root = mkdtempSync(join(tmpdir(), "sh-int2-"));
  const repo = seedRepo(mkdtempSync(join(tmpdir(), "sh-repo-")));
  const pbRoot = join(import.meta.dir, "../../../../plugin/playbooks");
  try {
    const pbDir = join(root, "playbooks/session-handoff");
    const stopPbDir = join(root, "playbooks/session-handoff-stop");
    mkdirSync(pbDir, { recursive: true });
    mkdirSync(stopPbDir, { recursive: true });
    writeFileSync(
      join(pbDir, "playbook.md"),
      readFileSync(join(pbRoot, "session-handoff/playbook.md"), "utf8"),
    );
    writeFileSync(
      join(stopPbDir, "playbook.md"),
      readFileSync(join(pbRoot, "session-handoff-stop/playbook.md"), "utf8"),
    );
    mkdirSync(join(root, "workflows"), { recursive: true });

    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    expect(reg.errors).toEqual([]);

    const preSpec = evaluateTriggerEvent(reg, { kind: "lifecycle", event: "pre-compact" })[0]!;
    const stopSpec = evaluateTriggerEvent(reg, { kind: "lifecycle", event: "stop" })[0]!;

    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });

    const fullBundle = await composeRecall({
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      cwd: repo,
      project: "penumbra",
      sources: preSpec.recall,
      budgetTokens: preSpec.recall_budget_tokens,
    });
    const stopBundle = await composeRecall({
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      cwd: repo,
      project: "penumbra",
      sources: stopSpec.recall,
      budgetTokens: stopSpec.recall_budget_tokens,
    });

    const fullOut = join(root, "maestro-continuation.md");
    const fullResult = await executeWorkflow({
      spec: {
        ...preSpec,
        output: [{ kind: "file" as const, path: fullOut }],
      },
      bundle: fullBundle,
      storageRoot: root,
      captureCtx: { db, project: "penumbra", sessionId: "s1", userId: "u", machineId: "m" },
    });

    const stopResult = await executeWorkflow({
      spec: stopSpec,
      bundle: stopBundle,
      storageRoot: root,
      captureCtx: { db, project: "penumbra", sessionId: "s1", userId: "u", machineId: "m" },
    });

    expect(fullResult.outcome).toBe("success");
    expect(stopResult.outcome).toBe("success");
    expect(existsSync(fullOut)).toBe(true);
    expect(existsSync(join(root, "pending-handoff.md"))).toBe(true);

    const fullBody = readFileSync(fullOut, "utf8");
    expect(fullBody).toContain("Maestro continuation prompt");
    expect(fullBody).toContain("### Commits since midnight");

    const stopBody = readFileSync(join(root, "pending-handoff.md"), "utf8");
    expect(stopBody).toContain("Session handoff checkpoint");
    expect(stopBody).toContain("### Pending handoffs");
    expect(stopBody).not.toContain("Maestro continuation prompt");
    expect(stopBody).not.toContain("### Commit context");
    expect(stopBody).not.toContain("## First moves");
    expect(stopBundle.estimatedTokens).toBeLessThan(300);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("session-handoff sentinel output path still no-ops without clobbering", async () => {
  const root = mkdtempSync(join(tmpdir(), "sh-sentinel-"));
  const repo = seedRepo(mkdtempSync(join(tmpdir(), "sh-repo-")));
  try {
    const preservedNote = join(root, "pending-handoff.md");
    mkdirSync(root, { recursive: true });
    writeFileSync(preservedNote, "keep me\n");

    const result = await emitNextSessionPromptOutput({
      body: PRESERVE_NEXT_SESSION_PROMPT,
      storageRoot: root,
      workflowName: "session-handoff",
    });

    expect(result.skipped).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(readFileSync(preservedNote, "utf8")).toBe("keep me\n");
    expect(existsSync(preservedNote)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
