import { loadSqliteVec, migrate } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRegistry,
  composeRecall,
  evaluateTriggerEvent,
  executeWorkflow,
  type TemplateVarContext,
} from "@src/index.js";

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
  execSync('git add . && git commit -q -m "feat: first feature"', { cwd: dir, shell: "/bin/bash" });
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  execSync('git add . && git commit -q -m "fix: a bug"', { cwd: dir, shell: "/bin/bash" });
  return dir;
}

const realFetch = globalThis.fetch;

test("session-summarize fires on stop, writes markdown file, and POSTs observation", async () => {
  const root = mkdtempSync(join(tmpdir(), "ss-int-"));
  const repo = seedRepo(mkdtempSync(join(tmpdir(), "ss-repo-")));
  const playbookSrc = join(import.meta.dir, "../../../../plugin/playbooks/session-summarize");
  try {
    const pbDir = join(root, "playbooks/session-summarize");
    mkdirSync(pbDir, { recursive: true });
    writeFileSync(
      join(pbDir, "playbook.md"),
      readFileSync(join(playbookSrc, "playbook.md"), "utf8"),
    );
    mkdirSync(join(root, "workflows"), { recursive: true });
    writeFileSync(join(root, "port"), "54321");
    writeFileSync(join(root, "token"), "test-token");

    const reg = await buildRegistry({
      playbooksDir: join(root, "playbooks"),
      workflowsDir: join(root, "workflows"),
    });
    expect(reg.errors).toEqual([]);
    const matched = evaluateTriggerEvent(reg, { kind: "lifecycle", event: "stop" });
    expect(matched.map((s) => s.name)).toEqual(["session-summarize"]);

    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });

    const sessionStart = "2026-05-05T07:00:00Z";
    const tsRecent = "2026-05-05T07:30:00Z";
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
      "Observation Output Sink Built",
      "New workflow output sink that POSTs to /observations",
      "{}",
      tsRecent,
      tsRecent,
      "feature",
      JSON.stringify(["workflows"]),
      "low",
    );
    db.run(`
      INSERT INTO dispatch_events (id, handoff_id, source, kind, ts, meta_json)
      VALUES
        (1, 'h-1', 'worker', 'dispatch.start', '2026-05-05T07:15:00Z', '{}'),
        (2, 'h-1', 'worker', 'dispatch.end',   '2026-05-05T07:25:00Z', '{}');
    `);

    const spec = matched[0]!;
    const tempOutFile = join(root, "session-summary-output.md");
    const patchedSpec = {
      ...spec,
      output: [{ kind: "file" as const, path: tempOutFile }, { kind: "observation" as const }],
    };

    const templateCtx: TemplateVarContext = {
      now: (): Date => new Date("2026-05-05T08:00:00Z"),
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

    type ObservationCall = {
      url: string;
      body: {
        source_detail?: string;
        session_id?: string;
        project_id?: string;
        payload_json?: { full_summary?: string };
      };
    };
    const observationCalls: ObservationCall[] = [];
    const fakeFetch: typeof globalThis.fetch = (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const urlStr =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const bodyStr = typeof init?.body === "string" ? init.body : "";
      observationCalls.push({ url: urlStr, body: JSON.parse(bodyStr) as ObservationCall["body"] });
      return Promise.resolve(
        new Response(JSON.stringify({ event_id: "evt-stop-1" }), { status: 200 }),
      );
    };
    globalThis.fetch = fakeFetch;
    let result;
    try {
      result = await executeWorkflow({
        spec: patchedSpec,
        bundle,
        storageRoot: root,
        captureCtx: {
          db,
          project: "penumbra",
          sessionId: "hook-trigger",
          userId: "u",
          machineId: "m",
        },
        observationCtx: { sessionId: "sess-actual", projectId: "penumbra" },
        templateCtx,
      });
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(result.outcome).toBe("success");
    expect(existsSync(tempOutFile)).toBe(true);
    const body = readFileSync(tempOutFile, "utf8");
    expect(body).toContain("Session summary");
    expect(body).toContain("Observation Output Sink Built");
    expect(body).toContain("feat: first feature");
    expect(body).toContain("fix: a bug");

    expect(observationCalls.length).toBe(1);
    expect(observationCalls[0]?.url).toBe("http://127.0.0.1:54321/observations");
    expect(observationCalls[0]?.body.source_detail).toBe("workflow:session-summarize");
    expect(observationCalls[0]?.body.session_id).toBe("sess-actual");
    expect(observationCalls[0]?.body.project_id).toBe("penumbra");
    expect(observationCalls[0]?.body.payload_json?.full_summary).toContain("Session summary");
    expect(result.artifacts).toContain("observation:evt-stop-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
