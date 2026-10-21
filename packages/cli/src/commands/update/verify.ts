import type { LogCursor, LogSource, ServiceManager, UpdateContext } from "./types.js";

const HEALTH_POLL_MS = 2_000;
const MARKER_TIMEOUT_MS = 60_000;
const DAEMON_READY = '"msg":"daemon started"';
const WORKER_READY = '"msg":"agentchat worker started"';
const SCOPES_ENABLED = '"msg":"job resource scopes enabled"';
const SCOPES_UNAVAILABLE = '"msg":"job resource scopes unavailable';
const ADMISSION_FLOOR = '"msg":"job memory admission floor"';

export interface LogWatch {
  daemon: { source: LogSource; cursor: LogCursor };
  worker: { source: LogSource; cursor: LogCursor };
}

export interface VerifyResult {
  ok: boolean;
  detail: string;
  notes: string[];
}

/** Log positions taken just before a restart, so only the new incarnation's lines are read. */
export async function watchLogs(ctx: UpdateContext, manager: ServiceManager): Promise<LogWatch> {
  const [daemonSource, workerSource] = await Promise.all([
    manager.logSource("daemon"),
    manager.logSource("worker"),
  ]);
  return {
    daemon: { source: daemonSource, cursor: await ctx.logs.cursor(daemonSource) },
    worker: { source: workerSource, cursor: await ctx.logs.cursor(workerSource) },
  };
}

async function waitHealthy(ctx: UpdateContext, manager: ServiceManager): Promise<string | null> {
  const deadline = ctx.clock.now() + ctx.options.verifyTimeoutS * 1000;
  for (;;) {
    const state = await manager.state();
    const health = await ctx.daemon.health();
    if (state.daemon.active && state.worker.active && health.ok) return null;
    const last = [
      `${state.daemon.name} ${state.daemon.active ? "active" : "inactive"}`,
      `${state.worker.name} ${state.worker.active ? "active" : "inactive"}`,
      `health: ${health.detail}`,
    ].join(", ");
    if (ctx.clock.now() >= deadline) {
      return `daemon/worker not healthy after ${String(ctx.options.verifyTimeoutS)}s (${last})`;
    }
    await ctx.clock.sleep(HEALTH_POLL_MS);
  }
}

interface MarkerText {
  daemon: string;
  worker: string;
}

function readyMissing(watch: LogWatch, text: MarkerText): string[] {
  const missing: string[] = [];
  if (watch.daemon.source.kind !== "none" && !text.daemon.includes(DAEMON_READY)) {
    missing.push("daemon 'daemon started'");
  }
  if (watch.worker.source.kind !== "none" && !text.worker.includes(WORKER_READY)) {
    missing.push("worker 'agentchat worker started'");
  }
  return missing;
}

async function waitReadyMarkers(
  ctx: UpdateContext,
  watch: LogWatch,
): Promise<{ text: MarkerText; missing: string[] }> {
  const deadline = ctx.clock.now() + MARKER_TIMEOUT_MS;
  for (;;) {
    const text = {
      daemon: await ctx.logs.readSince(watch.daemon.source, watch.daemon.cursor),
      worker: await ctx.logs.readSince(watch.worker.source, watch.worker.cursor),
    };
    const missing = readyMissing(watch, text);
    if (missing.length === 0 || ctx.clock.now() >= deadline) return { text, missing };
    await ctx.clock.sleep(HEALTH_POLL_MS);
  }
}

function scopeNote(who: string, text: string): string | null {
  if (text.includes(SCOPES_ENABLED)) return `${who}: job resource scopes enabled`;
  if (text.includes(SCOPES_UNAVAILABLE)) return `${who}: WARNING job resource scopes unavailable`;
  return null;
}

function admissionNote(text: string): string | null {
  const line = text.split("\n").find((l) => l.includes(ADMISSION_FLOOR));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as { admit_min_gib?: unknown };
    return `worker: job memory admission floor ${String(parsed.admit_min_gib)} GiB`;
  } catch {
    return "worker: job memory admission floor logged";
  }
}

export function markerNotes(watch: LogWatch, text: MarkerText): string[] {
  const notes: string[] = [];
  for (const [who, entry] of [
    ["daemon", watch.daemon],
    ["worker", watch.worker],
  ] as const) {
    if (entry.source.kind === "none") {
      notes.push(`${who} log not readable (${entry.source.reason})`);
    }
  }
  const optional = [
    scopeNote("daemon", text.daemon),
    scopeNote("worker", text.worker),
    admissionNote(text.worker),
  ];
  notes.push(...optional.filter((note): note is string => note !== null));
  const errors = text.worker.split("\n").filter((l) => /"level":[56]0\b/.test(l)).length;
  if (errors > 0) {
    notes.push(`WARNING ${String(errors)} error-level worker log line(s) since the restart`);
  }
  return notes;
}

/** Health, liveness of both units, the startup markers, then HEAD. */
export async function verifyRuntime(
  ctx: UpdateContext,
  manager: ServiceManager,
  watch: LogWatch,
  expectSha: string | null,
): Promise<VerifyResult> {
  const unhealthy = await waitHealthy(ctx, manager);
  if (unhealthy) return { ok: false, detail: unhealthy, notes: [] };
  const { text, missing } = await waitReadyMarkers(ctx, watch);
  const notes = markerNotes(watch, text);
  if (missing.length > 0) {
    return { ok: false, detail: `startup marker(s) missing: ${missing.join(", ")}`, notes };
  }
  if (expectSha === null) return { ok: true, detail: "worker started", notes };
  const head = await ctx.git.head();
  if (head !== expectSha) {
    return {
      ok: false,
      detail: `checkout is at ${head.slice(0, 12)}, expected ${expectSha.slice(0, 12)}`,
      notes,
    };
  }
  return { ok: true, detail: `daemon healthy, worker started at ${expectSha.slice(0, 12)}`, notes };
}
