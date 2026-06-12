import type { Database } from "bun:sqlite";
import type { NotificationOutboxWriter } from "@penumbra/core";

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
    const projectList = [...projects.entries()].map(([p, n]) => `${p}: ${n}`).join(", ");
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
  const t0CursorIso = new Date(t0Cursor).toISOString();
  const upperBoundIso = new Date(upperBound).toISOString();

  let discovered = 0;

  const draftEvents = db
    .query<DraftEventRow, [string, string, number]>(
      `SELECT event_id, project_id, event_type, payload_json, ts
       FROM t0_events
       WHERE event_type IN ('task_draft', 'task_draft_escalation')
         AND ts > ?
         AND ts <= ?
       ORDER BY ts ASC
       LIMIT ?`,
    )
    .all(t0CursorIso, upperBoundIso, DISCOVER_BATCH_SIZE);

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
    } catch {}

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

  const pendingTtlMs =
    Number(process.env.PENUMBRA_PENDING_ACTION_TTL_MS) || PENDING_ACTION_TTL_MS_DEFAULT;
  const pendingCutoff = now - pendingTtlMs * 2;
  const newActions = db
    .query<PendingActionRow, [number, number, number]>(
      `SELECT pa.id, pa.agent_id, pa.action_kind, pa.action_target, pa.created_at, ll.project_id
       FROM long_lived_pending_actions pa
       LEFT JOIN long_lived_agents ll ON pa.agent_id = ll.id
       WHERE pa.status = 'pending'
         AND pa.created_at > ?
         AND pa.created_at <= ?
       ORDER BY pa.created_at ASC
       LIMIT ?`,
    )
    .all(Math.max(actionCursor, pendingCutoff), upperBound, DISCOVER_BATCH_SIZE);

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
      draftEvents.map((row) => Date.parse(row.ts)),
      DISCOVER_BATCH_SIZE,
    ),
  );
  writeDiscoveryCursor(
    db,
    "notification_discovery_pending_action_cursor_ms",
    nextDiscoveryCursor(
      actionCursor,
      upperBound,
      newActions.map((row) => row.created_at),
      DISCOVER_BATCH_SIZE,
    ),
  );

  return { discovered };
}

function readDiscoveryCursor(db: Database, key: string, now: number): number {
  const row = db
    .query<{ value: string }, [string]>(`SELECT value FROM db_meta WHERE key = ?`)
    .get(key);
  if (row) return Number(row.value);
  return Math.max(0, now - DISCOVERY_LOOKBACK_MS);
}

function writeDiscoveryCursor(db: Database, key: string, value: number): void {
  db.prepare(`INSERT OR REPLACE INTO db_meta (key, value) VALUES (?, ?)`).run(key, String(value));
}

function nextDiscoveryCursor(
  current: number,
  upperBound: number,
  processedTimestamps: number[],
  batchSize: number,
): number {
  if (processedTimestamps.length >= batchSize) {
    return Math.max(current, ...processedTimestamps);
  }
  return Math.max(current, upperBound);
}

export async function runNotificationDelivery(opts: NotificationSweeperDeps): Promise<{
  delivered: number;
  failed: number;
  groups: number;
}> {
  const { db, outbox, getEnv, now } = opts;
  const nowMs = now();
  const processingStaleMs =
    Number(getEnv("PENUMBRA_NOTIFICATION_PROCESSING_STALE_MS")) || PROCESSING_STALE_MS_DEFAULT;
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
    if (!byCoalesceKey.has(key)) byCoalesceKey.set(key, []);
    byCoalesceKey.get(key)!.push(row);
  }

  let delivered = 0;
  let failed = 0;

  for (const [, group] of byCoalesceKey) {
    if (group.length === 0) continue;
    const first = group[0]!;
    const projectId = first.project_id;

    const claimed = group.filter((row) => outbox.markProcessing(row.id, nowMs));
    if (claimed.length === 0) continue;

    const payload = formatDraftSummary(claimed);
    try {
      const result = await postToDiscord(webhookUrl, payload);
      if (result.ok) {
        for (const row of claimed) {
          outbox.markDone(row.id, nowMs);
        }
        delivered += claimed.length;
      } else {
        failed += claimed.length;
        markPostFailure(outbox, claimed, nowMs, result.retryable, getEnv);
        opts.log?.warn?.(
          { coalesceKey: first.coalesce_key, projectId, count: claimed.length },
          "notification-sweep: discord post failed",
        );
      }
    } catch (err) {
      failed += claimed.length;
      markPostFailure(outbox, claimed, nowMs, true, getEnv, String(err));
      opts.log?.warn?.(
        { err: String(err), coalesceKey: first.coalesce_key, projectId, count: claimed.length },
        "notification-sweep: discord post threw",
      );
    }
  }

  return { delivered, failed, groups: byCoalesceKey.size };
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
  const retryBaseMs =
    Number(getEnv("PENUMBRA_NOTIFICATION_RETRY_BASE_MS")) || RETRY_BASE_MS_DEFAULT;

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
    (Number(process.env.PENUMBRA_NOTIFICATION_SWEEP_INTERVAL_MS) || DEFAULT_INTERVAL_MS);

  const timer = setInterval(() => {
    void runNotificationSweep(opts).catch((err) => {
      opts.log?.warn?.({ err: String(err) }, "notification-sweep tick failed");
    });
  }, effectiveIntervalMs);

  if (typeof (timer as any).unref === "function") {
    (timer as any).unref();
  }
  return () => clearInterval(timer);
}
