import type { NotificationOutboxWriter } from "@penumbra/core";
import type { Database } from "bun:sqlite";

export interface NotificationSweeperDeps {
  db: Database;
  outbox: NotificationOutboxWriter;
  getEnv: (key: string) => string | undefined;
  now: () => number;
  log?: {
    info?: (obj: Record<string, unknown>, msg: string) => void;
    warn?: (obj: Record<string, unknown>, msg: string) => void;
  };
}

interface DiscordField {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordEmbed {
  title?: string;
  description?: string;
  color: number;
  fields: DiscordField[];
  timestamp?: string;
}

interface DiscordEmbedsPayload {
  embeds: DiscordEmbed[];
}

const COALESCE_WINDOW_MS = 5 * 60 * 1000;
const DISCOVER_BATCH_SIZE = 200;
const DELIVER_BATCH_SIZE = 50;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const PROCESSING_STALE_MS_DEFAULT = 10 * 60 * 1000;
const MAX_ATTEMPTS_DEFAULT = 3;
const RETRY_BASE_MS_DEFAULT = 60 * 1000;
const DISCOVERY_LOOKBACK_MS = 60 * 60 * 1000;
const DISCOVERY_SETTLE_MS = 5 * 1000;

const PENDING_ACTION_TTL_MS_DEFAULT = 7 * 24 * 60 * 60 * 1000;

const COLOR_YELLOW = 0xcc9900;
const COLOR_RED = 0xcc0000;

function formatDraftSummary(rows: NotificationOutboxRow[]): DiscordEmbedsPayload {
  const count = rows.length;
  const kinds = new Map<string, number>();
  const projects = new Map<string, number>();
  for (const row of rows) {
    kinds.set(row.kind, (kinds.get(row.kind) ?? 0) + 1);
    const key = row.project_id ?? "_default";
    projects.set(key, (projects.get(key) ?? 0) + 1);
  }

  const fields: DiscordField[] = [{ name: "total", value: String(count), inline: true }];

  const kindLabels: Record<string, string> = {
    task_draft: "New drafts",
    task_draft_escalation: "Escalations",
    pending_action_created: "Pending actions",
    pending_action_expired: "Expired actions",
  };
  for (const [kind, k] of kinds) {
    fields.push({ name: kindLabels[kind] ?? kind, value: String(k), inline: true });
  }

  if (projects.size > 0) {
    const projectList = [...projects.entries()].map(([p, n]) => `${p}: ${String(n)}`).join(", ");
    fields.push({ name: "projects", value: projectList, inline: false });
  }

  const summaries = rows
    .filter((r) => r.summary)
    .slice(0, 5)
    .map((r) => r.summary);
  if (summaries.length > 0) {
    fields.push({ name: "details", value: summaries.join("\n"), inline: false });
  }

  return {
    embeds: [
      {
        title: "penumbra triage inbox",
        color: COLOR_YELLOW,
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

interface NotificationOutboxRow {
  id: number;
  project_id: string | null;
  kind: string;
  reference_id: string;
  summary: string | null;
  payload_json: string;
  status: string;
  created_at: number;
  coalesce_key: string;
  attempt_count: number;
  deliver_after: number | null;
}

interface DraftEventRow {
  event_id: string;
  project_id: string | null;
  event_type: string;
  payload_json: string;
  ts: string;
}

interface PendingActionRow {
  id: string;
  agent_id: string;
  action_kind: string;
  action_target: string;
  created_at: number;
  project_id: string | null;
}

export interface NotificationSweepResult {
  discovered: number;
  delivered: number;
  failed: number;
}

function parseNonNegativeEnvNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value.trim() === "") return defaultValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

interface DiscoveryCursor {
  ts: number;
  id: string;
}

export function runNotificationDiscovery(
  db: Database,
  outbox: NotificationOutboxWriter,
  now: number,
): { discovered: number } {
  const upperBound = Math.max(0, now - DISCOVERY_SETTLE_MS);
  const t0Cursor = readDiscoveryCursor(db, "notification_discovery_t0_cursor_ms", now);
  const actionCursor = readDiscoveryCursor(
    db,
    "notification_discovery_pending_action_cursor_ms",
    now,
  );
  const t0CursorIso = new Date(t0Cursor.ts).toISOString();
  const upperBoundIso = new Date(upperBound).toISOString();

  let discovered = 0;

  const draftEvents = db
    .query<DraftEventRow, [string, string, string, string, number]>(
      `SELECT event_id, project_id, event_type, payload_json, ts
       FROM t0_events
       WHERE event_type IN ('task_draft', 'task_draft_escalation')
         AND (ts > ? OR (ts = ? AND event_id > ?))
         AND ts <= ?
       ORDER BY ts ASC, event_id ASC
       LIMIT ?`,
    )
    .all(t0CursorIso, t0CursorIso, t0Cursor.id, upperBoundIso, DISCOVER_BATCH_SIZE);

  for (const ev of draftEvents) {
    if (outbox.exists(ev.event_type, ev.event_id)) continue;

    let summary: string | undefined;
    try {
      const payload = JSON.parse(ev.payload_json) as Record<string, unknown>;
      if (typeof payload.prompt === "string") {
        summary = payload.prompt.slice(0, 200);
      } else if (typeof payload.text === "string") {
        summary = payload.text.slice(0, 200);
      }
    } catch {
      // payload may be non-JSON or non-object; leave summary undefined
    }

    outbox.enqueue({
      project_id: ev.project_id,
      kind: ev.event_type as "task_draft" | "task_draft_escalation",
      reference_id: ev.event_id,
      summary,
      payload: { event_type: ev.event_type, ts: ev.ts },
      created_at: now,
    });
    discovered++;
  }

  const pendingTtlMs = parseNonNegativeEnvNumber(
    process.env.PENUMBRA_PENDING_ACTION_TTL_MS,
    PENDING_ACTION_TTL_MS_DEFAULT,
  );
  const pendingCutoff = now - pendingTtlMs * 2;
  const actionLowerBound = Math.max(actionCursor.ts, pendingCutoff);
  const actionLowerBoundId = actionLowerBound === actionCursor.ts ? actionCursor.id : "";
  const newActions = db
    .query<PendingActionRow, [number, number, string, number, number]>(
      `SELECT pa.id, pa.agent_id, pa.action_kind, pa.action_target, pa.created_at, ll.project_id
       FROM long_lived_pending_actions pa
       LEFT JOIN long_lived_agents ll ON pa.agent_id = ll.id
       WHERE pa.status = 'pending'
         AND (pa.created_at > ? OR (pa.created_at = ? AND pa.id > ?))
         AND pa.created_at <= ?
       ORDER BY pa.created_at ASC, pa.id ASC
       LIMIT ?`,
    )
    .all(actionLowerBound, actionLowerBound, actionLowerBoundId, upperBound, DISCOVER_BATCH_SIZE);

  for (const action of newActions) {
    if (outbox.exists("pending_action_created", action.id)) continue;

    outbox.enqueue({
      project_id: action.project_id,
      kind: "pending_action_created",
      reference_id: action.id,
      summary: `${action.action_kind} → ${action.action_target}`,
      payload: {
        action_id: action.id,
        agent_id: action.agent_id,
        action_kind: action.action_kind,
        action_target: action.action_target,
      },
      created_at: now,
    });
    discovered++;
  }

  writeDiscoveryCursor(
    db,
    "notification_discovery_t0_cursor_ms",
    nextDiscoveryCursor(
      t0Cursor,
      upperBound,
      draftEvents.map((row) => ({ ts: Date.parse(row.ts), id: row.event_id })),
      DISCOVER_BATCH_SIZE,
    ),
  );
  writeDiscoveryCursor(
    db,
    "notification_discovery_pending_action_cursor_ms",
    nextDiscoveryCursor(
      actionCursor,
      upperBound,
      newActions.map((row) => ({ ts: row.created_at, id: row.id })),
      DISCOVER_BATCH_SIZE,
    ),
  );

  return { discovered };
}

function readDiscoveryCursor(db: Database, key: string, now: number): DiscoveryCursor {
  const row = db
    .query<{ value: string }, [string]>(`SELECT value FROM db_meta WHERE key = ?`)
    .get(key);
  if (row) return parseDiscoveryCursor(row.value);
  return { ts: Math.max(0, now - DISCOVERY_LOOKBACK_MS), id: "" };
}

function writeDiscoveryCursor(db: Database, key: string, value: DiscoveryCursor): void {
  db.prepare(`INSERT OR REPLACE INTO db_meta (key, value) VALUES (?, ?)`).run(
    key,
    JSON.stringify(value),
  );
}

function nextDiscoveryCursor(
  current: DiscoveryCursor,
  upperBound: number,
  processedRows: DiscoveryCursor[],
  batchSize: number,
): DiscoveryCursor {
  if (processedRows.length >= batchSize) {
    return processedRows.reduce(
      (best, row) => (compareDiscoveryCursor(row, best) > 0 ? row : best),
      current,
    );
  }
  return compareDiscoveryCursor({ ts: upperBound, id: "" }, current) > 0
    ? { ts: upperBound, id: "" }
    : current;
}

function parseDiscoveryCursor(raw: string): DiscoveryCursor {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "number" && Number.isFinite(parsed)) {
      return { ts: parsed, id: "" };
    }
    if (parsed && typeof parsed === "object") {
      const cursor = parsed as Partial<DiscoveryCursor>;
      if (
        typeof cursor.ts === "number" &&
        Number.isFinite(cursor.ts) &&
        typeof cursor.id === "string"
      ) {
        return { ts: cursor.ts, id: cursor.id };
      }
    }
  } catch {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return { ts: parsed, id: "" };
  }
  return { ts: 0, id: "" };
}

function compareDiscoveryCursor(a: DiscoveryCursor, b: DiscoveryCursor): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.id.localeCompare(b.id);
}

export async function runNotificationDelivery(opts: NotificationSweeperDeps): Promise<{
  delivered: number;
  failed: number;
  groups: number;
}> {
  const { db, outbox, getEnv, now } = opts;
  const nowMs = now();
  const processingStaleMs = parseNonNegativeEnvNumber(
    getEnv("PENUMBRA_NOTIFICATION_PROCESSING_STALE_MS"),
    PROCESSING_STALE_MS_DEFAULT,
  );
  outbox.requeueStaleProcessing(nowMs - processingStaleMs);

  // Webhook config is global today (resolveWebhookUrl ignores project_id), so
  // resolve it once before touching the queue: with no valid sink, querying
  // would let permanently-undeliverable rows occupy the oldest LIMIT slots on
  // every sweep. Rows stay pending untouched until a valid webhook appears.
  // Revisit when per-project routing replaces the global env config.
  const webhookUrl = resolveWebhookUrl(getEnv, null);
  if (!webhookUrl) {
    opts.log?.warn?.({}, "notification-sweep: no valid webhook configured; delivery skipped");
    return { delivered: 0, failed: 0, groups: 0 };
  }

  const cutoff = nowMs - COALESCE_WINDOW_MS;
  const rows = db
    .query<NotificationOutboxRow, [number, number, number]>(
      `SELECT *
         FROM notification_outbox
        WHERE status = 'pending'
          AND created_at < ?
          AND (deliver_after IS NULL OR deliver_after <= ?)
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .all(cutoff, nowMs, DELIVER_BATCH_SIZE);

  if (rows.length === 0) return { delivered: 0, failed: 0, groups: 0 };

  const byCoalesceKey = new Map<string, NotificationOutboxRow[]>();
  for (const row of rows) {
    const key = row.coalesce_key;
    const bucket = byCoalesceKey.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      byCoalesceKey.set(key, [row]);
    }
  }

  let delivered = 0;
  let failed = 0;

  for (const [, group] of byCoalesceKey) {
    const result = await deliverGroup(group, { webhookUrl, nowMs, outbox, getEnv, log: opts.log });
    delivered += result.delivered;
    failed += result.failed;
  }

  return { delivered, failed, groups: byCoalesceKey.size };
}

interface DeliverGroupCtx {
  webhookUrl: string;
  nowMs: number;
  outbox: NotificationOutboxWriter;
  getEnv: (key: string) => string | undefined;
  log: NotificationSweeperDeps["log"];
}

async function deliverGroup(
  group: NotificationOutboxRow[],
  ctx: DeliverGroupCtx,
): Promise<{ delivered: number; failed: number }> {
  const first = group[0];
  if (!first) return { delivered: 0, failed: 0 };
  const projectId = first.project_id;

  const claimed = group.filter((row) => ctx.outbox.markProcessing(row.id, ctx.nowMs));
  if (claimed.length === 0) return { delivered: 0, failed: 0 };

  const payload = formatDraftSummary(claimed);
  try {
    const result = await postToDiscord(ctx.webhookUrl, payload);
    if (result.ok) {
      for (const row of claimed) {
        ctx.outbox.markDone(row.id, ctx.nowMs);
      }
      return { delivered: claimed.length, failed: 0 };
    }
    markPostFailure(ctx.outbox, claimed, ctx.nowMs, result.retryable, ctx.getEnv);
    ctx.log?.warn?.(
      { coalesceKey: first.coalesce_key, projectId, count: claimed.length },
      "notification-sweep: discord post failed",
    );
    return { delivered: 0, failed: claimed.length };
  } catch (err) {
    markPostFailure(ctx.outbox, claimed, ctx.nowMs, true, ctx.getEnv, String(err));
    ctx.log?.warn?.(
      { err: String(err), coalesceKey: first.coalesce_key, projectId, count: claimed.length },
      "notification-sweep: discord post threw",
    );
    return { delivered: 0, failed: claimed.length };
  }
}

function resolveWebhookUrl(
  getEnv: (key: string) => string | undefined,
  _projectId: string | null,
): string | undefined {
  const url = getEnv("PENUMBRA_DISCORD_WEBHOOK_URL");
  if (!url) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== "https:") return undefined;

  const allowedHosts = new Set(
    (getEnv("PENUMBRA_WEBHOOK_HOST_ALLOWLIST") ?? "discord.com,discordapp.com")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!allowedHosts.has(parsed.hostname.toLowerCase())) return undefined;

  return parsed.toString();
}

function markPostFailure(
  outbox: NotificationOutboxWriter,
  rows: NotificationOutboxRow[],
  now: number,
  retryable: boolean,
  getEnv: (key: string) => string | undefined,
  error = "discord_post_failed",
): void {
  const rawMaxAttempts = getEnv("PENUMBRA_NOTIFICATION_MAX_ATTEMPTS");
  const parsedMaxAttempts =
    rawMaxAttempts === undefined || rawMaxAttempts.trim() === "" ? NaN : Number(rawMaxAttempts);
  // Not `||`: an explicit 0 must mean zero retries, not fall back to the default.
  const maxAttempts =
    Number.isFinite(parsedMaxAttempts) && parsedMaxAttempts >= 0
      ? parsedMaxAttempts
      : MAX_ATTEMPTS_DEFAULT;
  const retryBaseMs = parseNonNegativeEnvNumber(
    getEnv("PENUMBRA_NOTIFICATION_RETRY_BASE_MS"),
    RETRY_BASE_MS_DEFAULT,
  );

  for (const row of rows) {
    const attempt = row.attempt_count + 1;
    if (retryable && attempt < maxAttempts) {
      const deliverAfter = now + retryBaseMs * 2 ** Math.max(0, attempt - 1);
      outbox.markRetry(row.id, error, deliverAfter);
    } else {
      outbox.markFailed(row.id, now, error);
    }
  }
}

async function postToDiscord(
  webhookUrl: string,
  payload: DiscordEmbedsPayload,
): Promise<{ ok: boolean; retryable: boolean }> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, retryable: res.status === 429 || res.status >= 500 };
  } catch {
    return { ok: false, retryable: true };
  }
}

export interface NotificationSweeperResult {
  discovery: { discovered: number };
  delivery: { delivered: number; failed: number; groups: number };
}

export async function runNotificationSweep(
  opts: NotificationSweeperDeps,
): Promise<NotificationSweeperResult> {
  const discovery = runNotificationDiscovery(opts.db, opts.outbox, opts.now());
  const delivery = await runNotificationDelivery(opts);
  return { discovery, delivery };
}

export function startNotificationSweeper(
  opts: NotificationSweeperDeps,
  intervalMs?: number,
): () => void {
  const effectiveIntervalMs =
    intervalMs ??
    parseNonNegativeEnvNumber(
      process.env.PENUMBRA_NOTIFICATION_SWEEP_INTERVAL_MS,
      DEFAULT_INTERVAL_MS,
    );

  const timer = setInterval(() => {
    void runNotificationSweep(opts).catch((err: unknown) => {
      opts.log?.warn?.({ err: String(err) }, "notification-sweep tick failed");
    });
  }, effectiveIntervalMs);

  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
