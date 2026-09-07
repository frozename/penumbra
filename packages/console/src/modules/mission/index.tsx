import { type ChainSummary } from "@penumbra/api-contract";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { DaemonClient } from "@src/api/client";
import { usePressureSnapshot } from "@src/hooks/usePressureSnapshot";
import { useSession } from "@src/hooks/useSession";
import { fmtDur, providerLabel } from "@src/lib/format";
import { chainsByStatus, handoffsPending } from "@src/lib/query-keys";
import { HEARTBEAT_MS } from "@src/lib/timing";
import { useDaemonStore } from "@src/stores/daemon-store";

import { InFlightChains } from "./InFlightChains";
import { PendingHandoffs } from "./PendingHandoffs";
import { PressureGrid } from "./PressureGrid";
import { RecentResolved } from "./RecentResolved";
import { StatRow } from "./StatRow";
import { T0Tail } from "./T0Tail";

function makeDefaultClient(): DaemonClient {
  return new DaemonClient({ getConfig: () => useDaemonStore.getState() });
}

function liveChainCount(chains: ChainSummary[] | undefined): number {
  return chains?.length ?? 0;
}

export function MissionControl(): JSX.Element {
  const client = useMemo(() => makeDefaultClient(), []);
  const session = useSession({ client });
  const pressure = usePressureSnapshot({ client });
  const dispatchedChains = useQuery({
    queryKey: chainsByStatus("dispatched"),
    queryFn: () => client.listChains({ status: "dispatched" }),
    refetchInterval: HEARTBEAT_MS,
  });
  const pendingHandoffs = useQuery({
    queryKey: handoffsPending(),
    queryFn: () => client.listHandoffs({ status: "pending" }),
    refetchInterval: HEARTBEAT_MS,
  });

  const capTrip = pressure.windows.find((window) => window.used_pct >= window.refuse_pct);
  const sessionData = session.data;
  const realSession = sessionData && sessionData.id !== "no-session" ? sessionData : undefined;
  const hasRealSession = realSession !== undefined;
  const startedAt = realSession ? new Date(realSession.started_at).getTime() : NaN;
  const elapsed =
    hasRealSession && Number.isFinite(startedAt) ? fmtDur((Date.now() - startedAt) / 1000) : "0m";
  const liveChains = liveChainCount(dispatchedChains.data?.chains);
  const pendingCount = pendingHandoffs.data?.handoffs.length ?? 0;

  return (
    <>
      <header className="surface-head" style={{ position: "relative", overflow: "hidden" }}>
        <div className="glow-bg" />
        <div style={{ position: "relative", zIndex: 1 }}>
          <h1>
            Mission control <em>· {realSession ? realSession.project.name : "no project"}</em>
          </h1>
          <p className="lede">
            <em className="brand">{liveChains}</em> chains in flight ·{" "}
            <em className="warn">{pendingCount}</em> handoffs awaiting approval
            {capTrip && (
              <>
                {" "}
                · <em className="err">cap-trip</em> on {providerLabel(capTrip.provider)}{" "}
                {capTrip.window_label}
              </>
            )}
            . Maestro session {realSession ? realSession.id : "no-session"}
            {hasRealSession ? `, ${elapsed} in.` : "."}
          </p>
          <div className="heads-row">
            <span className="chip">session · {realSession ? realSession.id : "no-session"}</span>
            <span className="chip">project · {realSession ? realSession.project.id : "—"}</span>
            <span className="chip">
              budget · {realSession ? realSession.budget.current : 0}/
              {realSession ? realSession.budget.max_concurrent : 0} concurrent
            </span>
            <span className="chip">dispatched · {realSession ? realSession.dispatched : 0}</span>
            <span className="chip" style={{ color: "var(--color-ok)" }}>
              resolved · {realSession ? realSession.resolved : 0}
            </span>
            <span className="chip" style={{ color: "var(--color-err)" }}>
              failed · {realSession ? realSession.failed : 0}
            </span>
          </div>
        </div>
      </header>
      <StatRow />
      <div
        className="mc-row"
        style={{
          display: "grid",
          gridTemplateColumns: "1.6fr 1fr",
          gap: 16,
          marginTop: 16,
        }}
      >
        <PendingHandoffs />
        <PressureGrid />
      </div>
      <div style={{ marginTop: 16 }}>
        <InFlightChains />
      </div>
      <div
        className="mc-row"
        style={{
          display: "grid",
          gridTemplateColumns: "1.4fr 1fr",
          gap: 16,
          marginTop: 16,
        }}
      >
        <T0Tail />
        <RecentResolved />
      </div>
    </>
  );
}
