import { appendFileSync } from "node:fs";

import { createLogger } from "@src/logger.js";
import { HeavyJobLock } from "@src/process/heavy-job-lock.js";

// Spawned by heavy-job-lock.test.ts to exercise the SQLite fallback across
// real processes. Usage: <lockPath> <logPath> <holdMs|"hold"> <waitMs>.
// Appends one JSON object per line to logPath: {"pid","event":"acquired","t0"}
// when the lease is taken and {"pid","event":"released","t0","t1"} after
// release. "hold" keeps the lease until the process is killed.
const [lockPath, logPath, hold, waitMs] = process.argv.slice(2) as [string, string, string, string];
const log = createLogger({ component: "heavy-job-lock-worker", level: "silent" });

function record(entry: Record<string, unknown>): void {
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

const lock = new HeavyJobLock({ path: lockPath, flockBin: null, pollMs: 5, log });
const lease = await lock.acquire({ timeoutMs: Number(waitMs) });
if (!lease) {
  record({ pid: process.pid, event: "timeout" });
  process.exit(3);
}
const t0 = Date.now();
record({ pid: process.pid, event: "acquired", t0 });
await new Promise((resolve) => setTimeout(resolve, hold === "hold" ? 30_000 : Number(hold)));
await lease.release();
record({ pid: process.pid, event: "released", t0, t1: Date.now() });
