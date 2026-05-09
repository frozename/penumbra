import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { type ChainSummary } from "@penumbra/api-contract";
import { DaemonClient } from "../../api/client";
import { usePressureSnapshot } from "../../hooks/usePressureSnapshot";
import { useSession } from "../../hooks/useSession";
import { useDaemonStore } from "../../stores/daemon-store";
import { chainsByStatus, handoffsPending } from "../../lib/query-keys";
import { fmtDur, providerLabel } from "../../lib/format";
import { HEARTBEAT_MS } from "../../lib/timing";
import { StatRow } from "./StatRow";
import { PendingHandoffs } from "./PendingHandoffs";
import { PressureGrid } from "./PressureGrid";
import { InFlightChains } from "./InFlightChains";
import { T0Tail } from "./T0Tail";
import { RecentResolved } from "./RecentResolved";

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
  const startedAt = sessionData ? new Date(sessionData.started_at).getTime() : NaN;
  const elapsed = Number.isFinite(startedAt) ? fmtDur((Date.now() - startedAt) / 1000) : "0m";
  const hasRealSession = sessionData && sessionData.id !== "no-session";
  const liveChains = liveChainCount(dispatchedChains.data?.chains);
  const pendingCount = pendingHandoffs.data?.handoffs.length ?? 0;

  return (
    <>
      <header className="surface-head" style={{ position: "relative", overflow: "hidden" }}>
        <div className="glow-bg" />
        <div style={{ position: "relative", zIndex: 1 }}>
          <h1>
            Mission control{" "}
            <em>· {hasRealSession ? sessionData.project.name : "no project"}</em>
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
            . Maestro session {hasRealSession ? sessionData.id : "no-session"}, {elapsed} in.
          </p>
          <div className="heads-row">
            <span className="chip">
              session · {hasRealSession ? sessionData.id : "no-session"}
            </span>
            <span className="chip">
              project · {hasRealSession ? sessionData.project.id : "—"}
            </span>
            <span className="chip">
              budget · {hasRealSession ? sessionData.budget.current : 0}/{hasRealSession ? sessionData.budget.max_concurrent : 0} concurrent
            </span>
            <span className="chip">dispatched · {hasRealSession ? sessionData.dispatched : 0}</span>
            <span className="chip" style={{ color: "var(--color-ok)" }}>
              resolved · {hasRealSession ? sessionData.resolved : 0}
            </span>
            <span className="chip" style={{ color: "var(--color-err)" }}>
              failed · {hasRealSession ? sessionData.failed : 0}
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
