import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { useSession } from "../hooks/useSession";
import { DaemonClient } from "../api/client";
import { useDaemonStore } from "../stores/daemon-store";
import { chainsByStatus, handoffsPending } from "../lib/query-keys";
import { summarizeWords } from "../lib/format";
import { HEARTBEAT_MS } from "../lib/timing";

function makeDefaultClient(): DaemonClient {
  return new DaemonClient({ getConfig: () => useDaemonStore.getState() });
}

function MissionSidebar(): JSX.Element {
  const client = useMemo(() => makeDefaultClient(), []);
  const session = useSession({ client });
  const pendingHandoffs = useQuery({
    queryKey: handoffsPending(),
    queryFn: () => client.listHandoffs({ status: "pending" }),
    refetchInterval: HEARTBEAT_MS,
  });
  const liveChains = useQuery({
    queryKey: chainsByStatus("dispatched"),
    queryFn: () => client.listChains({ status: "dispatched" }),
    refetchInterval: HEARTBEAT_MS,
  });

  const sessionData = session.data;
  const pending = pendingHandoffs.data?.handoffs ?? [];
  const chains = liveChains.data?.chains ?? [];

  return (
    <>
      {sessionData ? (
        <div className="exp-section">
          <h2>SESSION</h2>
          <div className="exp-row">
            <span className="fico brand">●</span>
            <span className="lbl">{sessionData.id}</span>
            <span className="meta">live</span>
          </div>
        </div>
      ) : null}
      <div className="exp-section">
        <h2>
          PENDING <span className="count">{pending.length}</span>
        </h2>
        {pending.map((handoff) => (
          <div key={handoff.handoff_id} className="exp-row" onClick={() => {}}>
            <span className="dot dot-warn dot-live" style={{ flexShrink: 0 }} />
            <span className="lbl">{summarizeWords(handoff.message, 5)}</span>
          </div>
        ))}
      </div>
      <div className="exp-section">
        <h2>
          IN-FLIGHT <span className="count">{chains.length}</span>
        </h2>
        {chains.map((chain) => (
          <div key={chain.conversation_id} className="exp-row" onClick={() => {}}>
            <span className="dot dot-brand dot-live" style={{ flexShrink: 0 }} />
            <span className="lbl">{chain.to_agent || chain.conversation_id}</span>
          </div>
        ))}
      </div>
    </>
  );
}

export function Explorer(): JSX.Element {
  const location = useLocation();
  const projectName = "penumbra";
  const projectId =
    "/Volumes/WorkSSD/repos/penumbra-worktrees/9adf5379-d159-4904-9d65-0a59e87a67fa";
  const branch = "main";
  const dirty = 0;
  const isMission = location.pathname === "/mission";

  // TODO: wire from daemon /workspace endpoint when it exists.
  return (
    <aside className="exp">
      <div className="exp-proj">
        <div className="t-label" style={{ marginBottom: 6 }}>
          PROJECT
        </div>
        <div className="exp-proj-card">
          <span className="pdot" />
          <div className="ptxt">
            <div className="pname">{projectName}</div>
            <div className="ppath">{projectId}</div>
          </div>
          <span className="pchev">▾</span>
        </div>
        <div
          style={{
            display: "flex",
            gap: 6,
            marginTop: 6,
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span className="mono t-tertiary" style={{ fontSize: 10 }}>
            ⎇ {branch}
          </span>
          {dirty > 0 ? (
            <span className="mono" style={{ fontSize: 10, color: "var(--color-warn)" }}>
              {dirty} dirty
            </span>
          ) : (
            <span className="mono t-ghost" style={{ fontSize: 10 }}>
              clean
            </span>
          )}
        </div>
      </div>
      {isMission ? <MissionSidebar /> : null}
    </aside>
  );
}
