import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DispatchEvent } from "@penumbra/api-contract";
import { Card } from "../../ui/Card";
import { DaemonClient, type UsageQuotaResponse } from "../../api/client";
import { useDaemonStore } from "../../stores/daemon-store";
import { useStream } from "../../hooks/useStream";
import type { StreamMessage, StreamTopic, Subscription } from "../../api/streams";
import { usageQuotaStatus } from "../../lib/query-keys";

type SubscribeImpl = <T>(
  topic: StreamTopic,
  onMessage: (msg: StreamMessage<T>) => void,
  opts?: { params?: Record<string, string> },
) => Subscription;

export interface StatRowProps {
  /** Override the daemon client. Defaults to a module-default backed by the daemon-store. */
  client?: DaemonClient;
  /** Override the stream subscribe impl (test seam). */
  subscribeImpl?: SubscribeImpl;
}

const FIVE_MINUTES_MS = 5 * 60_000;

function makeDefaultClient(): DaemonClient {
  return new DaemonClient({ getConfig: () => useDaemonStore.getState() });
}

function readQuotaSlot(
  data: UsageQuotaResponse | undefined,
  key: string,
): unknown {
  if (!data || typeof data !== "object") return undefined;
  return (data as Record<string, unknown>)[key];
}

function formatConcurrent(data: UsageQuotaResponse | undefined): string {
  const dispatched = readQuotaSlot(data, "dispatched_count");
  const cap = readQuotaSlot(data, "cap");
  if (typeof dispatched === "number" && typeof cap === "number") {
    return `${dispatched} / cap ${cap}`;
  }
  return "—";
}

function formatSyntheticSpend(data: UsageQuotaResponse | undefined): string {
  const sub = readQuotaSlot(data, "subscription");
  if (sub && typeof sub === "object") {
    const total = (sub as Record<string, unknown>)["synth_total"];
    if (typeof total === "number") {
      return `$${total.toFixed(2)}`;
    }
  }
  return "—";
}

export function StatRow(props: StatRowProps = {}): JSX.Element {
  const client = useMemo(() => props.client ?? makeDefaultClient(), [props.client]);

  const quota = useQuery({
    queryKey: usageQuotaStatus(),
    queryFn: () => client.getQuotaStatus(),
    refetchInterval: 5_000,
  });

  // Card 3 derives from the live dispatch-events SSE stream — count messages
  // emitted in the last 5 minutes. The api-contract DispatchEvent has `ts` as
  // an ISO string, so we can scope to "last 5m" rather than just messages.length.
  const stream = useStream<DispatchEvent>(
    "dispatch-events",
    undefined,
    props.subscribeImpl ? { subscribeImpl: props.subscribeImpl } : undefined,
  );

  const t0Count = useMemo(() => {
    const cutoff = Date.now() - FIVE_MINUTES_MS;
    let n = 0;
    for (const m of stream.messages) {
      const ts = m.data?.ts;
      if (typeof ts === "string") {
        const t = new Date(ts).getTime();
        if (Number.isFinite(t) && t >= cutoff) n += 1;
        continue;
      }
      n += 1;
    }
    return n;
  }, [stream.messages]);

  const concurrent = quota.isSuccess ? formatConcurrent(quota.data) : "—";
  const syntheticSpend = quota.isSuccess ? formatSyntheticSpend(quota.data) : "—";

  return (
    <div className="stat-row">
      <Card className="card-stat">
        <div className="t-label">Concurrent dispatches</div>
        <div className="stat-value mono">{concurrent}</div>
      </Card>

      <Card className="card-stat">
        <div className="t-label">Resolved · session</div>
        {/* Session route not yet exposed — wire when 5.x adds it. */}
        <div className="stat-value mono">—</div>
      </Card>

      <Card className="card-stat">
        <div className="t-label">t0 events · last 5m</div>
        <div className="stat-value mono">{t0Count}</div>
      </Card>

      <Card className="card-stat">
        <div className="t-label">Synthetic spend · session</div>
        <div className="stat-value mono">{syntheticSpend}</div>
      </Card>
    </div>
  );
}
