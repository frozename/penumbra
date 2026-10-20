import { loadSqliteVec, migrate } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRegistry,
  composeRecall,
  evaluateTriggerEvent,
  executeWorkflow,
  type TemplateVarContext,
} from "@src/index.js";
import { emitNextSessionPromptOutput } from "@src/outputs/index.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

function seedRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "mcp-repo-"));
  execSync("git init -q -b main", { cwd: repo });
  execSync("git config user.email t@t", { cwd: repo });
  execSync("git config user.name t", { cwd: repo });
  writeFileSync(join(repo, "tracked.txt"), "one\n");
  execSync('git add tracked.txt && git commit -q -m "init"', { cwd: repo, shell: "/bin/bash" });
  return repo;
}

function makeContinuationNote(charCount: number, lastLine = "LAST_LINE_SENTINEL"): string {
  const first = "NOTE_START\n";
  const last = `\n${lastLine}\n`;
  return first + "n".repeat(Math.max(0, charCount - first.length - last.length)) + last;
}

async function renderPrime(
  repo: string,
  opts: {
    now?: Date;
    sessionStart?: string;
    project?: string;
    setupStorageRoot?: (root: string) => void | Promise<void>;
  } = {},
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "mcp-int-"));
  const playbookSrc = join(
    import.meta.dir,
    "../../../../plugin/playbooks/maestro-context-prime/playbook.md",
  );
  try {
    await opts.setupStorageRoot?.(root);
    const pbDir = join(root, "playbooks/maestro-context-prime");
    mkdirSync(pbDir, { recursive: true });
    writeFileSync(join(pbDir, "playbook.md"), readFileSync(playbookSrc, "utf8"));
    mkdirSync(join(root, "workflows"), { recursive: true });

    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    expect(reg.errors).toEqual([]);
    const spec = evaluateTriggerEvent(reg, { kind: "lifecycle", event: "session-start" })[0]!;

    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const templateCtx: TemplateVarContext = {
      now: () => opts.now ?? new Date("2026-05-05T08:00:00Z"),
      project: opts.project ?? "penumbra",
      sessionStart: opts.sessionStart ?? "2026-05-05T07:00:00Z",
      tz: "UTC",
      repoRoot: repo,
    };

    try {
      const bundle = await composeRecall({
        db,
        embedder: new TestEmbedder({ dim: 384 }),
        cwd: repo,
        storageRoot: root,
        project: templateCtx.project,
        sources: spec.recall,
        now: templateCtx.now,
        budgetTokens: spec.recall_budget_tokens,
        templateCtx,
      });

      const result = await executeWorkflow({
        spec,
        bundle,
        storageRoot: root,
        templateCtx,
      });

      expect(result.outcome).toBe("success");
      return result.sessionReminder ?? result.composedPrompt ?? "";
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("rendered context embeds the newest continuation note's body", async () => {
  const repo = seedRepo();
  try {
    mkdirSync(join(repo, "docs/notes"), { recursive: true });
    writeFileSync(
      join(repo, "docs/notes/maestro-continuation-2026-05-05.md"),
      "Newest continuation body\n",
    );

    const body = await renderPrime(repo);

    expect(body).toContain("Newest continuation body");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the three hardcoded First-moves shell lines are absent and collector-derived fields are present", async () => {
  const repo = seedRepo();
  try {
    writeFileSync(join(repo, "dirty.txt"), "dirty\n");

    const body = await renderPrime(repo);

    expect(body).not.toContain("git status --short && launchctl list | grep penumbra");
    expect(body).not.toContain("mcp__penumbra__handoff_list_pending");
    expect(body).not.toContain("Carry forward whatever was queued");
    expect(body).toContain("git_status_dirty_count: 1");
    expect(body).toContain("head_sha:");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("real playbook budget keeps the continuation note and first-moves payload", async () => {
  const repo = seedRepo();
  try {
    mkdirSync(join(repo, "docs/notes"), { recursive: true });
    writeFileSync(
      join(repo, "docs/notes/maestro-continuation-2026-05-05.md"),
      makeContinuationNote(12_000),
    );

    const body = await renderPrime(repo, {
      now: new Date("2026-05-05T08:00:00Z"),
      sessionStart: "2026-05-05T07:00:00Z",
      setupStorageRoot: async (root) => {
        await emitNextSessionPromptOutput({
          body: "PENDING_START\n" + "p".repeat(33_000),
          storageRoot: root,
          workflowName: "session-handoff-stop",
          project: "penumbra",
          now: () => new Date("2026-05-05T07:30:00Z"),
        });
      },
    });

    expect(body).toContain("NOTE_START");
    expect(body).toContain("LAST_LINE_SENTINEL");
    expect(body).toContain("git_status_dirty_count:");
    expect(body).toContain("head_sha:");
    expect(body).toContain("pending_handoffs:");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("renders a 'no continuation note found' marker, not a crash, on an empty docs/notes", async () => {
  const repo = seedRepo();
  try {
    mkdirSync(join(repo, "docs/notes"), { recursive: true });

    const body = await renderPrime(repo);

    expect(body).toContain("no continuation note found");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("boot context carries only the current project's pending handoff, never a foreign or unfenced head", async () => {
  const repo = seedRepo();
  const now = new Date("2026-09-21T16:00:00Z");
  const setupStorageRoot = async (root: string): Promise<void> => {
    writeFileSync(
      join(root, "pending-handoff.md"),
      "# PENUMBRA continuation 2026-09-09\n## First moves\n1. FOREIGN_BOUNCE_THE_DAEMON\n",
    );
    for (const [project, body] of [
      ["penumbra", "PENUMBRA_CHECKPOINT"],
      ["geo-eval", "GEO_EVAL_CHECKPOINT"],
    ] as const) {
      await emitNextSessionPromptOutput({
        body,
        storageRoot: root,
        workflowName: "session-handoff-stop",
        project,
        now: () => now,
      });
    }
  };
  try {
    const geo = await renderPrime(repo, { now, project: "geo-eval", setupStorageRoot });
    const penumbra = await renderPrime(repo, { now, project: "penumbra", setupStorageRoot });

    expect(geo).toContain("GEO_EVAL_CHECKPOINT");
    expect(geo).not.toContain("PENUMBRA_CHECKPOINT");
    expect(geo).not.toContain("FOREIGN_BOUNCE_THE_DAEMON");
    expect(penumbra).toContain("PENUMBRA_CHECKPOINT");
    expect(penumbra).not.toContain("GEO_EVAL_CHECKPOINT");
    expect(penumbra).not.toContain("FOREIGN_BOUNCE_THE_DAEMON");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
