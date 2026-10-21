import { getJobResourceEnv } from "@penumbra/config";
import {
  buildResourceScopeArgv,
  createHeavyJobGate,
  createLogger,
  defaultHeavyJobLockPath,
  detectResourceScopeHost,
  HeavyJobLock,
  resolveAdmitMinGiB,
  resolveResourceScopeConfig,
} from "@penumbra/core";

import type { Exec, HeavyLockInfo, InstallPort, RuntimeState } from "./types.js";

const INSTALL_TIMEOUT_MS = 20 * 60_000;
const HEAVY_LOCK_KEY = "PENUMBRA_JOB_HEAVY_LOCK";

/**
 * The heavy-job lock the install must queue behind: this shell's setting, else the
 * one the worker unit runs with (the operator's shared lock on hosts that set it
 * there), else Penumbra's default.
 */
export function resolveHeavyLock(
  env: NodeJS.ProcessEnv,
  state: RuntimeState | null,
  home: string,
): HeavyLockInfo {
  const fromEnv = getJobResourceEnv(env).heavyLockPath;
  if (fromEnv) return { path: fromEnv, source: "env" };
  const fromWorker = state?.worker.environment[HEAVY_LOCK_KEY]?.trim();
  if (fromWorker) return { path: fromWorker, source: "worker-unit" };
  return { path: defaultHeavyJobLockPath(home), source: "default" };
}

function tail(text: string): string {
  const lines = text.trim().split("\n");
  return lines.slice(-5).join(" | ").slice(-800);
}

/** argv wrapped in a memory-capped `systemd-run --user --scope` + choom when the host allows it. */
export function scopeInstallArgv(argv: string[], env: NodeJS.ProcessEnv): string[] {
  const config = resolveResourceScopeConfig(env);
  if (config.mode === "off") return argv;
  const found = detectResourceScopeHost({ env });
  if (!found.available) return argv;
  return buildResourceScopeArgv(argv, found.host, config, {
    label: "update-install",
    childEnv: env,
  });
}

/**
 * `bun install --frozen-lockfile` serialized under the host heavy-job lock and the
 * memory admission floor (the worker's own heavy-stage gate), inside a job scope.
 */
export function createInstallPort(opts: {
  exec: Exec;
  bunPath: string;
  env: NodeJS.ProcessEnv;
  heavyLock: HeavyLockInfo;
}): InstallPort {
  const port: InstallPort = {
    install: async (repo) => {
      const jobEnv = getJobResourceEnv(opts.env);
      const log = createLogger({ component: "penumbra-update", level: "silent" });
      const gate = createHeavyJobGate({
        lock: new HeavyJobLock({ path: opts.heavyLock.path, log }),
        admitMinGiB: await resolveAdmitMinGiB(jobEnv.admitMinGiB),
        waitMs: jobEnv.admitWaitS * 1000,
        log,
      });
      const entry = await gate.enter("penumbra-update-install");
      if (!entry.ok) return { ok: false, ran: false, detail: entry.reason };
      try {
        const argv = scopeInstallArgv([opts.bunPath, "install", "--frozen-lockfile"], opts.env);
        const res = await opts.exec(argv, { cwd: repo, timeoutMs: INSTALL_TIMEOUT_MS });
        return res.code === 0
          ? { ok: true, ran: true, detail: "installed" }
          : {
              ok: false,
              ran: true,
              detail: `exit ${String(res.code)}: ${tail(res.stderr || res.stdout)}`,
            };
      } finally {
        await entry.release();
      }
    },
  };
  return port;
}
