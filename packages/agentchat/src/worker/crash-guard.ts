import type { Logger } from "@penumbra/core";

import { writeSync } from "node:fs";

type FatalKind = "unhandledRejection" | "uncaughtException";

export interface WorkerFatalRecord {
  event: "worker_fatal";
  kind: FatalKind;
  err: string;
  stack: string | null;
}

export interface GlobalCrashHandlerOpts {
  log: Pick<Logger, "error">;
  flush?: () => void;
}

let globalCrashHandlersInstalled = false;

function normalizeError(err: unknown): { err: string; stack: string | null } {
  if (err instanceof Error) {
    return { err: err.message, stack: err.stack ?? null };
  }
  return { err: String(err), stack: null };
}

function writeFatalRecord(record: WorkerFatalRecord): void {
  writeSync(2, `${JSON.stringify(record)}\n`);
}

function shouldExit(kind: FatalKind): boolean {
  if (kind === "uncaughtException") return true;
  return process.env.PENUMBRA_WORKER_CRASH_GUARD !== "survive";
}

export function installGlobalCrashHandlers(opts: GlobalCrashHandlerOpts): void {
  if (globalCrashHandlersInstalled) return;
  globalCrashHandlersInstalled = true;

  const handleFatal = (kind: FatalKind, rawErr: unknown): void => {
    const err = normalizeError(rawErr);
    const record: WorkerFatalRecord = {
      event: "worker_fatal",
      kind,
      err: err.err,
      stack: err.stack,
    };

    try {
      opts.log.error(record, "agentchat-worker-fatal");
    } catch {
      // The synchronous stderr write below is the durable crash breadcrumb.
    }
    try {
      writeFatalRecord(record);
    } catch {
      try {
        process.stderr.write(`${JSON.stringify(record)}\n`);
      } catch {
        // Nothing else can safely be done during fatal handling.
      }
    }
    try {
      opts.flush?.();
    } catch {
      // A flush failure must not mask the original fatal event.
    }

    if (shouldExit(kind)) process.exit(1);
  };

  process.on("unhandledRejection", (err) => {
    handleFatal("unhandledRejection", err);
  });
  process.on("uncaughtException", (err) => {
    handleFatal("uncaughtException", err);
  });
}
