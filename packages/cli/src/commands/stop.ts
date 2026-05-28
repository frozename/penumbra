import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DaemonHandle } from "../../../daemon/src/serve.js";

export interface RunStopOpts {
  storageRoot: string;
  handle?: DaemonHandle;
}

export async function runStop(opts: RunStopOpts): Promise<number> {
  const pidPath = join(opts.storageRoot, "pid");
  const portPath = join(opts.storageRoot, "port");
  try {
    opts.handle?.stop();
  } finally {
    if (!opts.handle && existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, "utf8"));
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* noop */
        }
      }
    }
    for (const p of [portPath, pidPath]) {
      if (existsSync(p)) unlinkSync(p);
    }
  }
  return 0;
}
