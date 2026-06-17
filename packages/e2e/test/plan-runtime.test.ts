import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  derivePlanId,
  loadSqliteVec,
  migrate,
  PlanWriter,
  TaskEventBus,
  TaskWriter,
} from "@penumbra/core";
import { createPlanRuntimeSweeper } from "../../daemon/src/sweepers/plan-runtime.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {}

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const d of cleanupDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function seedRepo(name: string, seedFile: string): string {
  const dir = mkdtempSync(join(tmpdir(), `e2e-plan-runtime-${name}-`));
  cleanupDirs.push(dir);
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email e2e@x", { cwd: dir });
  execSync("git config user.name e2e", { cwd: dir });
  const segments = seedFile.split("/");
  if (segments.length > 1) {
    mkdirSync(join(dir, ...segments.slice(0, -1)), { recursive: true });
  }
  writeFileSync(join(dir, seedFile), "seed\n");
  execSync("git add . && git commit -q -m init", { cwd: dir, shell: "/bin/bash" });
  return dir;
}

test("cross-repo plan runs end-to-end: 3 leaf tasks fire across 2 repos with real git ops", async () => {
  const penumbraRepo = seedRepo("penumbra", "packages/core/src/.keep");
  const siriusRepo = seedRepo("sirius", ".keep");

  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const bus = new TaskEventBus();
  const taskWriter = new TaskWriter(db, {
    bus,
    resolveAgent: (name: string) => ({ name, maestro_capable: true }),
  });
  const plans = new PlanWriter(db);

  const planRoot = mkdtempSync(join(tmpdir(), "e2e-plan-runtime-meta-"));
  cleanupDirs.push(planRoot);
  const demoSrc = join(__dirname, "fixtures/v2-cross-repo-smoke.md");
  const demoBytes = readFileSync(demoSrc);
  const planPath = join(planRoot, "v2-cross-repo-smoke.md");
  writeFileSync(planPath, demoBytes);

  const planId = derivePlanId(demoBytes, Date.now());
  plans.register({
    plan_id: planId,
    file_path: planPath,
    home_project: "penumbra",
    tasks: [
      { task_meta_id: "1.1", project_id: "penumbra" },
      { task_meta_id: "1.2", project_id: "sirius" },
      { task_meta_id: "1.3", project_id: "penumbra" },
    ],
  });

  const sweeper = createPlanRuntimeSweeper({ db, plans, taskWriter });
  const unsubSweeper = sweeper.subscribe(bus);

  const filedEvents = bus.subscribe((event) => event.kind === "filed");
  const stubLoop = (async () => {
    try {
      for await (const event of filedEvents) {
        const task = taskWriter.get(event.task_id);
        if (task.kind !== "orchestrate") continue;

        let repo: string | null = null;
        let action: "add-1.1" | "add-1.2" | "remove-1.3" | null = null;
        if (/Task 1\.1/.test(task.prompt)) {
          repo = penumbraRepo;
          action = "add-1.1";
        } else if (/Task 1\.2/.test(task.prompt)) {
          repo = siriusRepo;
          action = "add-1.2";
        } else if (/Task 1\.3/.test(task.prompt)) {
          repo = penumbraRepo;
          action = "remove-1.3";
        }
        if (!repo || !action) continue;

        if (action === "add-1.1") {
          mkdirSync(join(repo, "packages/core/src"), { recursive: true });
          writeFileSync(join(repo, "packages/core/src/v2demo-marker.txt"), "v2-demo-step-1\n");
          execSync('git add -A && git commit -q -m "chore: add v2demo marker"', {
            cwd: repo,
            shell: "/bin/bash",
          });
        } else if (action === "add-1.2") {
          writeFileSync(join(repo, "v2demo-marker.txt"), "v2-demo-step-2\n");
          execSync('git add -A && git commit -q -m "chore: add v2demo marker"', {
            cwd: repo,
            shell: "/bin/bash",
          });
        } else {
          rmSync(join(repo, "packages/core/src/v2demo-marker.txt"));
          execSync('git add -A && git commit -q -m "chore: remove v2demo marker"', {
            cwd: repo,
            shell: "/bin/bash",
          });
        }

        const lease = taskWriter.lease({ task_id: event.task_id, agent_id: "e2e-stub" });
        taskWriter.complete({
          task_id: event.task_id,
          lease_id: lease.lease_id,
          result_summary: `${action} done`,
        });
      }
    } catch (error) {
      // iterator closed at teardown — nothing to do
    }
  })();

  await sweeper.tick();

  const deadline = Date.now() + 25_000;
  let finalStatus: string | undefined;
  while (Date.now() < deadline) {
    finalStatus = plans.getPlan(planId)?.status;
    if (finalStatus === "completed" || finalStatus === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  expect(finalStatus).toBe("completed");

  const finalTasks = plans.getTasks(planId);
  expect(finalTasks.map((t) => t.task_meta_id).sort()).toEqual(["1.1", "1.2", "1.3"]);
  expect(finalTasks.every((t) => t.status === "completed")).toBe(true);

  const penumbraLog = execSync("git log --oneline", {
    cwd: penumbraRepo,
    encoding: "utf8",
  });
  expect(penumbraLog).toContain("chore: add v2demo marker");
  expect(penumbraLog).toContain("chore: remove v2demo marker");
  expect(penumbraLog.trim().split("\n")).toHaveLength(3);

  const siriusLog = execSync("git log --oneline", {
    cwd: siriusRepo,
    encoding: "utf8",
  });
  expect(siriusLog).toContain("chore: add v2demo marker");
  expect(siriusLog.trim().split("\n")).toHaveLength(2);

  unsubSweeper();
  await filedEvents.return?.();
  await stubLoop;
  db.close();
}, 60_000);
