import type { DiscordNotificationEvent } from "./discord-events.js";
import type { RuntimeNotificationConfig } from "./notification-config.js";

export interface NotificationSchedulerProviderRow {
  provider: string;
  model?: string;
  used_tokens: number;
  quota_tokens: number | null;
  remaining_pct_tokens: number | null;
}

export interface NotificationSchedulerDeps {
  now: () => number;
  intervalMs: number;
  config: RuntimeNotificationConfig;
  getQuotaSummary: () => Promise<{
    providers: NotificationSchedulerProviderRow[];
  }>;
  postEvent: (event: DiscordNotificationEvent) => Promise<void> | void;
}

function periodKey(ts: number, interval: "daily" | "hourly"): string {
  const iso = new Date(ts).toISOString();
  return interval === "hourly" ? iso.slice(0, 13) : iso.slice(0, 10);
}

function formatUsageSummary(rows: NotificationSchedulerProviderRow[]): string {
  if (rows.length === 0) return "no configured provider quotas";
  return rows
    .map((row) => {
      const label = row.model ? `${row.provider}/${row.model}` : row.provider;
      const quota = row.quota_tokens === null ? "n/a" : String(row.quota_tokens);
      const remaining =
        row.remaining_pct_tokens === null ? "n/a" : String(row.remaining_pct_tokens);
      return `${label}: ${String(row.used_tokens)}/${quota} tokens (${remaining}% remaining)`;
    })
    .join("\n");
}

export function createNotificationScheduler(deps: NotificationSchedulerDeps): {
  tick: () => Promise<void>;
  start: () => void;
  stop: () => void;
} {
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastSentPeriod: string | null = null;

  async function tick(): Promise<void> {
    try {
      if (!deps.config.enabled) return;
      if (!deps.config.events.cost_quota_summary) return;
      if (!deps.config.summaries.costQuota.enabled) return;

      const period = periodKey(deps.now(), deps.config.summaries.costQuota.interval);
      if (period === lastSentPeriod) return;

      const summary = await deps.getQuotaSummary();
      await deps.postEvent({
        kind: "cost_quota_summary",
        period,
        usage_summary: formatUsageSummary(summary.providers),
      });
      lastSentPeriod = period;
    } catch {
      return;
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      void tick();
    }, deps.intervalMs);
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    tick,
    start,
    stop,
  };
}
