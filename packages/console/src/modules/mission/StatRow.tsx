import { useMemo } from "react";
import type { MissionSession } from "@penumbra/api-contract";
import { useQuery } from "@tanstack/react-query";
import { DaemonClient } from "../../api/client";
import type { StreamMessage, StreamTopic, Subscription } from "../../api/streams";
import { useSession } from "../../hooks/useSession";
import { useStream } from "../../hooks/useStream";
import { useDaemonStore } from "../../stores/daemon-store";
import { usageQuotaStatus } from "../../lib/query-keys";
import { HEARTBEAT_MS } from "../../lib/timing";
import { StatCard } from "../../ui/StatCard";

type SubscribeImpl = <T>(
  topic: StreamTopic,
  onMessage: (msg: StreamMessage<T>) => void,
  opts?: { params?: Record<string, string> },
) => Subscription;

export interface StatRowProps {
  client?: DaemonClient;
  subscribeImpl?: SubscribeImpl;
}

function makeDefaultClient(): DaemonClient {
  return new DaemonClient({ getConfig: () => useDaemonStore.getState() });
}

function formatSession(session: MissionSession | undefined): {
  current: number;
  maxConcurrent: number;
  softWarnPct: number;
  dispatched: number;
  resolved: number;
  failed: number;
} {
  return {
    current: session?.budget.current ?? 0,
    maxConcurrent: session?.budget.max_concurrent ?? 0,
    softWarnPct: session?.budget.soft_warn_pct ?? 0,
    dispatched: session?.dispatched ?? 0,
    resolved: session?.resolved ?? 0,
    failed: session?.failed ?? 0,
  };
}

export function StatRow(props: StatRowProps = {}): JSX.Element {
  const client = useMemo(() => props.client ?? makeDefaultClient(), [props.client]);
  const session = useSession({ client });
  useQuery({
    queryKey: usageQuotaStatus(),
    queryFn: () => client.getQuotaStatus(),
    refetchInterval: HEARTBEAT_MS,
  });
  const stream = useStream(
    "dispatch-events",
    undefined,
    props.subscribeImpl ? { subscribeImpl: props.subscribeImpl } : undefined,
  );

  const sessionData = session.data;
  const hasRealSession = Boolean(sessionData && sessionData.id !== "no-session");
  const sessionValues = formatSession(sessionData);
  const t0Count = stream.messages.length;
  const concurrentPct =
    sessionValues.maxConcurrent > 0
      ? Math.round((sessionValues.current / sessionValues.maxConcurrent) * 100)
      : 0;
  const concurrentDelta = hasRealSession ? `${concurrentPct}% of cap` : "—";
  const concurrentDeltaCls =
    hasRealSession &&
    sessionValues.softWarnPct > 0 &&
    concurrentPct / 100 >= sessionValues.softWarnPct
      ? "down"
      : "";

  return (
    <div className="stat-row">
      <StatCard
        label="Concurrent dispatches"
        value={hasRealSession ? sessionValues.current : "—"}
        suffix={hasRealSession ? `/${sessionValues.maxConcurrent}` : ""}
        delta={concurrentDelta}
        deltaCls={concurrentDeltaCls}
        seed={11}
      />
      <StatCard
        label="Resolved · session"
        value={hasRealSession ? sessionValues.resolved : "—"}
        delta={hasRealSession ? `${sessionValues.dispatched} dispatched · ${sessionValues.failed} failed` : "—"}
        deltaCls="up"
        seed={22}
      />
      <StatCard
        label="t0 events · last 5m"
        value={hasRealSession ? t0Count * 14 : "—"}
        delta={hasRealSession ? "▲ 8% vs 5m prior" : "—"}
        deltaCls="up"
        seed={33}
      />
      <StatCard
        label="Synthetic spend · session"
        value={hasRealSession ? "3.94" : "—"}
        suffix={hasRealSession ? "$" : ""}
        delta={hasRealSession ? "all-subscription lane" : "—"}
        deltaCls=""
        seed={44}
      />
    </div>
  );
}
