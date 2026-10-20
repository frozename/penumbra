import type { DispatchEventInput, Logger } from "@penumbra/core";

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isTerminalHttpStatus, PenumbraHttpError } from "../penumbra-client.js";

/**
 * A dispatch's terminal report, persisted worker-side so a transient daemon
 * outage cannot lose the outcome. `observations` are post-adapter t0 envelopes
 * with pre-generated event_ids (idempotent on replay); `dispatch_end` is the
 * lifecycle event the daemon's reliability classifier consumes; `outcome` is
 * the complete/fail call that decides whether the record is deleted.
 */
export interface TerminalReport {
  handoff_id: string;
  worker_id?: string;
  outcome: "complete" | "fail";
  reason?: string;
  observations: Record<string, unknown>[];
  dispatch_end: DispatchEventInput;
}

export type TerminalReportStatus = "delivered" | "pending" | "superseded";

export interface TerminalOutboxLogger {
  debug: (obj: Record<string, unknown>, msg: string) => void;
  info?: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export function loggerFromPino(log: Logger): TerminalOutboxLogger {
  return {
    debug: (obj, msg): void => {
      log.debug(obj, msg);
    },
    info: (obj, msg): void => {
      log.info(obj, msg);
    },
    warn: (obj, msg): void => {
      log.warn(obj, msg);
    },
    error: (obj, msg): void => {
      log.error(obj, msg);
    },
  };
}

export interface TerminalOutboxDeps {
  /** Directory holding one JSON record file per handoff. */
  dir: string;
  workerId: string;
  observe: (event: Record<string, unknown>, init?: { signal?: AbortSignal }) => Promise<unknown>;
  postDispatchEvents: (events: DispatchEventInput[], signal?: AbortSignal) => Promise<void>;
  complete: (handoff_id: string, init?: { signal?: AbortSignal }) => Promise<unknown>;
  markFailed: (
    handoff_id: string,
    reason: string,
    init?: { signal?: AbortSignal },
  ) => Promise<unknown>;
  log: TerminalOutboxLogger;
  now?: () => number;
  /** Timer seam; defaults to setTimeout. Return value must support cancel(). */
  schedule?: (run: () => void, delayMs: number) => { cancel: () => void };
  /** Per-attempt timeout for each send (default 15 s). Bun's fetch otherwise
   *  defaults to 300 s, which would pin a dispatcher slot past the 30 s
   *  shutdown cap. */
  stepTimeoutMs?: number;
  /** Total budget for the inline finalize attempt (default 10 s). */
  inlineBudgetMs?: number;
  /** Total budget for one drain pass (default 30 s). */
  drainBudgetMs?: number;
  /** Records older than this are dropped with an error log (default 6 h). */
  maxRecordAgeMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
}

interface OutboxRecord {
  v: 1;
  handoff_id: string;
  worker_id: string;
  outcome: "complete" | "fail";
  reason?: string;
  /** Remaining post-adapter envelopes, in order. Shrinks as sends succeed or
   *  are terminally dropped. */
  observations: Record<string, unknown>[];
  dispatch_end: DispatchEventInput;
  steps_done: { observations: boolean; dispatch_end: boolean };
  created_at: string;
  attempts: number;
  next_attempt_at: string;
}

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
const MAX_RECORD_AGE_MS = 6 * 60 * 60 * 1_000;
const STEP_TIMEOUT_MS = 15_000;
const INLINE_BUDGET_MS = 10_000;
const DRAIN_BUDGET_MS = 30_000;

function defaultSchedule(run: () => void, delayMs: number): { cancel: () => void } {
  const t = setTimeout(run, delayMs);
  return {
    cancel: (): void => {
      clearTimeout(t);
    },
  };
}

function sanitizeFileName(id: string): string {
  return id.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

function readCurrentStatus(body: unknown): string | null {
  if (body && typeof body === "object" && "current_status" in body) {
    const status = (body as { current_status?: unknown }).current_status;
    if (typeof status === "string") return status;
  }
  return null;
}

function readStatusField(res: unknown): string | null {
  if (res && typeof res === "object" && "status" in res) {
    const status = (res as { status?: unknown }).status;
    if (typeof status === "string") return status;
  }
  return null;
}

/** Post-adapter step failures (observations, dispatch.end): 4xx terminal
 *  statuses drop that step item; everything else — including 401 — is
 *  retryable. Only the terminal call's response decides record deletion. */
function classifyStepError(err: unknown): "retry" | "terminal" {
  if (err instanceof PenumbraHttpError) {
    if (err.status === 401) return "retry";
    if (isTerminalHttpStatus(err.status)) return "terminal";
    return "retry";
  }
  return "retry";
}

function isValidRecord(rec: unknown): rec is OutboxRecord {
  if (!rec || typeof rec !== "object") return false;
  const r = rec as Record<string, unknown>;
  return (
    r.v === 1 &&
    typeof r.handoff_id === "string" &&
    typeof r.worker_id === "string" &&
    (r.outcome === "complete" || r.outcome === "fail") &&
    Array.isArray(r.observations) &&
    typeof r.dispatch_end === "object" &&
    r.dispatch_end !== null &&
    typeof r.steps_done === "object" &&
    r.steps_done !== null &&
    typeof r.created_at === "string" &&
    Number.isFinite(Date.parse(r.created_at)) &&
    typeof r.attempts === "number" &&
    typeof r.next_attempt_at === "string"
  );
}

export class TerminalOutbox {
  private readonly deps: TerminalOutboxDeps;
  private readonly records = new Map<string, OutboxRecord>();
  /** Actual on-disk file name per handoff (adopted names may differ from the
   *  canonical sanitized one). */
  private readonly fileNames = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<TerminalReportStatus>>();
  private draining: Promise<{ remaining: number }> | null = null;
  private timer: { cancel: () => void } | null = null;
  private stopped = false;

  constructor(deps: TerminalOutboxDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Persist the report, then run ONE inline attempt bounded by the total
   *  inline budget. Returns promptly so dispatcher.idle() stays under the
   *  30 s shutdown cap; the background drain owns retries. */
  async reportTerminal(report: TerminalReport): Promise<TerminalReportStatus> {
    const now = this.now();
    const record: OutboxRecord = {
      v: 1,
      handoff_id: report.handoff_id,
      worker_id: report.worker_id ?? this.deps.workerId,
      outcome: report.outcome,
      ...(report.reason !== undefined ? { reason: report.reason } : {}),
      observations: [...report.observations],
      dispatch_end: report.dispatch_end,
      steps_done: {
        observations: report.observations.length === 0,
        dispatch_end: false,
      },
      created_at: new Date(now).toISOString(),
      attempts: 0,
      next_attempt_at: new Date(now).toISOString(),
    };
    this.records.set(record.handoff_id, record);
    // Write before the first send attempt. A write failure (ENOSPC/EACCES)
    // demotes the record to in-memory retry — never block or crash finalize.
    this.tryPersist(record, true);
    const status = await this.deliverSingleFlight(
      record,
      this.deps.inlineBudgetMs ?? INLINE_BUDGET_MS,
      true,
    );
    this.rearmTimer();
    return status;
  }

  /** Deliver every pending record in created_at order. In-flight records are
   *  skipped (per-handoff single-flight). */
  drain(opts?: { budgetMs?: number }): Promise<{ remaining: number }> {
    if (this.draining !== null) return this.draining;
    const draining = this.drainOnce(opts).finally(() => {
      if (this.draining === draining) this.draining = null;
    });
    this.draining = draining;
    return draining;
  }

  private async drainOnce(opts?: { budgetMs?: number }): Promise<{ remaining: number }> {
    this.loadFromDisk();
    const budget = opts?.budgetMs ?? this.deps.drainBudgetMs ?? DRAIN_BUDGET_MS;
    const deadline = this.now() + budget;
    const ordered = [...this.records.values()].sort(
      (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
    );
    for (const record of ordered) {
      if (this.now() >= deadline) break;
      if (this.records.get(record.handoff_id) !== record) continue;
      await this.deliverSingleFlight(record, Math.max(0, deadline - this.now()), false);
    }
    this.rearmTimer();
    return { remaining: this.records.size };
  }

  pendingHandoffIds(): string[] {
    this.loadFromDisk();
    return [...this.records.keys()];
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = null;
  }

  private fileNameOf(record: OutboxRecord): string {
    return this.fileNames.get(record.handoff_id) ?? `${sanitizeFileName(record.handoff_id)}.json`;
  }

  private filePathOf(record: OutboxRecord): string {
    return join(this.deps.dir, this.fileNameOf(record));
  }

  private tryPersist(record: OutboxRecord, firstWrite = false): void {
    try {
      mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
      const path = this.filePathOf(record);
      writeFileSync(`${path}.tmp`, JSON.stringify(record), { encoding: "utf-8", mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      this.fileNames.set(record.handoff_id, this.fileNameOf(record));
    } catch (err: unknown) {
      this.deps.log.error(
        { handoff_id: record.handoff_id, err: String(err) },
        firstWrite
          ? "outbox persist failed; terminal report held in memory only"
          : "outbox persist failed; continuing with in-memory state",
      );
    }
  }

  private deleteRecord(record: OutboxRecord): void {
    this.records.delete(record.handoff_id);
    const name = this.fileNames.get(record.handoff_id);
    this.fileNames.delete(record.handoff_id);
    try {
      rmSync(join(this.deps.dir, name ?? `${sanitizeFileName(record.handoff_id)}.json`), {
        force: true,
      });
    } catch (err: unknown) {
      this.deps.log.warn(
        { handoff_id: record.handoff_id, err: String(err) },
        "outbox record file removal failed",
      );
    }
  }

  private loadFromDisk(): void {
    let names: string[];
    try {
      names = readdirSync(this.deps.dir).filter((n) => n.endsWith(".json") && !n.endsWith(".tmp"));
    } catch {
      return;
    }
    for (const name of names) {
      this.loadOneFile(name);
    }
  }

  private loadOneFile(name: string): void {
    const path = join(this.deps.dir, name);
    const rec = this.readRecordFile(name, path);
    if (rec === null) return;
    if (this.dropIfAgedFile(rec, path)) return;
    const tracked = this.records.get(rec.handoff_id);
    if (tracked !== undefined) {
      // Stale duplicate file for an already-tracked record — remove it so a
      // future load does not resurrect it.
      if (this.fileNameOf(tracked) !== name) {
        try {
          rmSync(path, { force: true });
        } catch {
          // removal is best-effort
        }
      }
      return;
    }
    this.records.set(rec.handoff_id, rec);
    this.fileNames.set(rec.handoff_id, name);
  }

  private readRecordFile(name: string, path: string): OutboxRecord | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isValidRecord(parsed)) throw new Error("invalid outbox record shape");
      return parsed;
    } catch {
      try {
        renameSync(path, `${path}.bad`);
      } catch {
        // quarantine is best-effort
      }
      this.deps.log.warn({ file: name }, "quarantined corrupt outbox record");
      return null;
    }
  }

  private dropIfAgedFile(rec: OutboxRecord, path: string): boolean {
    const ageMs = this.now() - Date.parse(rec.created_at);
    const maxAge = this.deps.maxRecordAgeMs ?? MAX_RECORD_AGE_MS;
    if (ageMs <= maxAge) return false;
    this.deps.log.error(
      { handoff_id: rec.handoff_id, age_ms: ageMs },
      "dropping aged terminal outbox record",
    );
    try {
      rmSync(path, { force: true });
    } catch {
      // removal is best-effort
    }
    return true;
  }

  private stepSignal(deadline: number): AbortSignal {
    const remaining = Math.max(1, deadline - this.now());
    return AbortSignal.timeout(Math.min(this.deps.stepTimeoutMs ?? STEP_TIMEOUT_MS, remaining));
  }

  private async tryStep(
    deadline: number,
    run: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<"ok" | "retry" | "terminal" | "budget"> {
    if (this.now() >= deadline) return "budget";
    try {
      await run(this.stepSignal(deadline));
      return "ok";
    } catch (err: unknown) {
      return classifyStepError(err);
    }
  }

  private keepForRetry(record: OutboxRecord, cause: string): TerminalReportStatus {
    if (this.records.get(record.handoff_id) !== record) return "superseded";
    record.attempts += 1;
    const base = this.deps.backoffBaseMs ?? BACKOFF_BASE_MS;
    const cap = this.deps.backoffCapMs ?? BACKOFF_CAP_MS;
    const delayMs = Math.min(cap, base * 2 ** Math.max(0, record.attempts - 1));
    record.next_attempt_at = new Date(this.now() + delayMs).toISOString();
    this.tryPersist(record);
    this.deps.log.warn(
      {
        handoff_id: record.handoff_id,
        attempts: record.attempts,
        next_attempt_at: record.next_attempt_at,
        cause,
      },
      "terminal report deferred",
    );
    return "pending";
  }

  private async deliverSingleFlight(
    record: OutboxRecord,
    budgetMs: number,
    joinExisting: boolean,
  ): Promise<TerminalReportStatus> {
    const existing = this.inflight.get(record.handoff_id);
    if (existing) {
      if (!joinExisting) return "pending";
      const raced = await Promise.race([
        existing,
        new Promise<TerminalReportStatus>((resolve) => {
          setTimeout(
            () => {
              resolve("pending");
            },
            Math.max(1, budgetMs),
          );
        }),
      ]);
      return raced;
    }
    const attempt = this.attemptDelivery(record, budgetMs).catch(
      (err: unknown): TerminalReportStatus => {
        this.deps.log.error(
          { handoff_id: record.handoff_id, err: String(err) },
          "outbox delivery attempt crashed; record kept",
        );
        return "pending";
      },
    );
    this.inflight.set(record.handoff_id, attempt);
    try {
      return await attempt;
    } finally {
      if (this.inflight.get(record.handoff_id) === attempt) {
        this.inflight.delete(record.handoff_id);
      }
    }
  }

  private classifyTerminalVerdict(
    record: OutboxRecord,
    res: unknown,
  ): { verdict: "delivered" | "superseded"; current_status: string | null } {
    const expected = record.outcome === "complete" ? "completed" : "failed";
    const status = readStatusField(res);
    if (status !== null && status !== expected) {
      return { verdict: "superseded", current_status: status };
    }
    return { verdict: "delivered", current_status: status };
  }

  private classifyTerminalError(
    record: OutboxRecord,
    err: unknown,
  ): { verdict: "delivered" | "superseded" | "retry"; current_status: string | null } {
    if (!(err instanceof PenumbraHttpError)) {
      return { verdict: "retry", current_status: null };
    }
    const status = err.status;
    if (status === 409) {
      const current = readCurrentStatus(err.body);
      const expected = record.outcome === "complete" ? "completed" : "failed";
      if (current === expected) return { verdict: "delivered", current_status: current };
      return { verdict: "superseded", current_status: current };
    }
    if (status === 401) return { verdict: "retry", current_status: null };
    if (isTerminalHttpStatus(status)) return { verdict: "superseded", current_status: null };
    return { verdict: "retry", current_status: null };
  }

  private finishTerminal(
    record: OutboxRecord,
    verdict: { verdict: "delivered" | "superseded"; current_status: string | null },
  ): TerminalReportStatus {
    if (verdict.verdict === "superseded") {
      this.deps.log.warn(
        {
          handoff_id: record.handoff_id,
          outcome: record.outcome,
          current_status: verdict.current_status,
        },
        "terminal report superseded",
      );
      this.deleteRecord(record);
      return "superseded";
    }
    this.deleteRecord(record);
    return "delivered";
  }

  private async attemptDelivery(
    record: OutboxRecord,
    budgetMs: number,
  ): Promise<TerminalReportStatus> {
    const deadline = this.now() + budgetMs;
    const maxAge = this.deps.maxRecordAgeMs ?? MAX_RECORD_AGE_MS;
    if (this.now() - Date.parse(record.created_at) > maxAge) {
      this.deps.log.error(
        { handoff_id: record.handoff_id, age_ms: this.now() - Date.parse(record.created_at) },
        "dropping aged terminal outbox record",
      );
      this.deleteRecord(record);
      return "superseded";
    }

    const observations = await this.deliverObservations(record, deadline);
    if (observations !== null) return observations;
    const dispatchEnd = await this.deliverDispatchEnd(record, deadline);
    if (dispatchEnd !== null) return dispatchEnd;
    return await this.deliverTerminalCall(record, deadline);
  }

  // Step 1: pending post-adapter observations. Idempotent by event_id.
  // Returns null when the step is finished; a status when delivery must stop.
  private async deliverObservations(
    record: OutboxRecord,
    deadline: number,
  ): Promise<TerminalReportStatus | null> {
    if (record.steps_done.observations) return null;
    while (record.observations.length > 0) {
      const envelope = record.observations[0];
      if (envelope === undefined) break;
      const verdict = await this.tryStep(deadline, (signal) =>
        this.deps.observe(envelope, { signal }),
      );
      if (verdict === "retry" || verdict === "budget") {
        return this.keepForRetry(record, `observations_${verdict}`);
      }
      if (verdict === "terminal") {
        this.deps.log.warn(
          { handoff_id: record.handoff_id, event_type: envelope.event_type },
          "dropping terminally rejected observation envelope",
        );
      }
      record.observations.shift();
      this.tryPersist(record);
    }
    record.steps_done.observations = true;
    this.tryPersist(record);
    return null;
  }

  // Step 2: dispatch.end via the strict dispatch-events route.
  private async deliverDispatchEnd(
    record: OutboxRecord,
    deadline: number,
  ): Promise<TerminalReportStatus | null> {
    if (record.steps_done.dispatch_end) return null;
    const verdict = await this.tryStep(deadline, (signal) =>
      this.deps.postDispatchEvents([record.dispatch_end], signal),
    );
    if (verdict === "retry" || verdict === "budget") {
      return this.keepForRetry(record, `dispatch_end_${verdict}`);
    }
    if (verdict === "terminal") {
      this.deps.log.warn(
        { handoff_id: record.handoff_id, kind: "dispatch.end" },
        "dropping terminally rejected dispatch.end",
      );
    }
    record.steps_done.dispatch_end = true;
    this.tryPersist(record);
    return null;
  }

  // Step 3: the terminal call — its response alone decides record deletion.
  private async deliverTerminalCall(
    record: OutboxRecord,
    deadline: number,
  ): Promise<TerminalReportStatus> {
    if (this.now() >= deadline) return this.keepForRetry(record, "budget");
    try {
      const res =
        record.outcome === "complete"
          ? await this.deps.complete(record.handoff_id, { signal: this.stepSignal(deadline) })
          : await this.deps.markFailed(record.handoff_id, record.reason ?? "dispatch error", {
              signal: this.stepSignal(deadline),
            });
      return this.finishTerminal(record, this.classifyTerminalVerdict(record, res));
    } catch (err: unknown) {
      const verdict = this.classifyTerminalError(record, err);
      if (verdict.verdict === "retry") return this.keepForRetry(record, "terminal_retry");
      return this.finishTerminal(record, {
        verdict: verdict.verdict,
        current_status: verdict.current_status,
      });
    }
  }

  private rearmTimer(): void {
    this.timer?.cancel();
    this.timer = null;
    if (this.stopped || this.records.size === 0) return;
    const earliest = Math.min(
      ...[...this.records.values()].map((r) => Date.parse(r.next_attempt_at)),
    );
    const delayMs = Math.max(0, earliest - this.now());
    const schedule = this.deps.schedule ?? defaultSchedule;
    this.timer = schedule(() => {
      this.timer = null;
      void this.drain().catch((err: unknown) => {
        this.deps.log.warn({ err: String(err) }, "background outbox drain failed");
      });
    }, delayMs);
  }
}
