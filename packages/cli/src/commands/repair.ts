import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { runStatus } from "./status.js";

export type RepairOutcome = "ok" | "recovered" | "restored-from-backup" | "failed";
export interface RepairResult {
  outcome: RepairOutcome;
  notes: string[];
}

export async function runRepair(opts: { storageRoot: string }): Promise<RepairResult> {
  const notes: string[] = [];

  const status = await runStatus({ storageRoot: opts.storageRoot });
  if (status.status === "running") {
    throw new Error("Daemon is running; stop it before repairing.");
  }

  const dbPath = join(opts.storageRoot, "db.sqlite");

  const integrity = spawnSync("sqlite3", [dbPath, "PRAGMA integrity_check;"], { encoding: "utf8" });
  if (integrity.status === 0 && integrity.stdout.trim() === "ok") {
    notes.push("integrity_check: ok");
    return { outcome: "ok", notes };
  }
  notes.push(`integrity_check failed: ${(integrity.stdout || integrity.stderr || "").trim()}`);

  const recoverPath = `${dbPath}.recovered`;
  const recoverSql = spawnSync("sqlite3", [dbPath, ".recover"], { encoding: "utf8" });
  if (recoverSql.status === 0 && recoverSql.stdout.length > 0) {
    const load = spawnSync("sqlite3", [recoverPath], {
      input: recoverSql.stdout,
      encoding: "utf8",
    });
    if (load.status === 0 && existsSync(recoverPath)) {
      rmSync(dbPath, { force: true });
      copyFileSync(recoverPath, dbPath);
      rmSync(recoverPath, { force: true });
      notes.push("recovered via sqlite3 .recover");
      return { outcome: "recovered", notes };
    }
  }
  notes.push(".recover pipeline failed");

  const backupDir = join(opts.storageRoot, "backups");
  if (existsSync(backupDir)) {
    const picks = readdirSync(backupDir)
      .filter((f) => f.endsWith(".db"))
      .sort()
      .reverse();
    const mostRecent = picks[0];
    if (mostRecent) {
      rmSync(dbPath, { force: true });
      copyFileSync(join(backupDir, mostRecent), dbPath);
      notes.push(`restored from backup ${mostRecent}`);
      return { outcome: "restored-from-backup", notes };
    }
  }

  notes.push("no backups available");
  return { outcome: "failed", notes };
}
