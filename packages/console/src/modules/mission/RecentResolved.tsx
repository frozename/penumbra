import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardHead } from "../../ui/Card";
import { StatusBadge } from "../../ui/StatusBadge";
import { DaemonClient } from "../../api/client";
import { useDaemonStore } from "../../stores/daemon-store";

function makeDefaultClient(): DaemonClient {
  return new DaemonClient({ getConfig: () => useDaemonStore.getState() });
}

export function RecentResolved(): JSX.Element {
  const client = useMemo(() => makeDefaultClient(), []);

  const query = useQuery({
    queryKey: ["chains", "resolved", 4],
    queryFn: () => client.listChains({ status: "completed", limit: 4 }),
    refetchInterval: 30_000,
  });

  const chains = query.data?.chains ?? [];

  return (
    <Card>
      <CardHead title="Recently resolved" id={`${chains.length}`} />
      <div className="rr-list">
        {chains.length === 0 && (
          <div className="t-tertiary mono" style={{ padding: 12 }}>
            No resolved chains yet.
          </div>
        )}
        {chains.map((c) => (
          <div
            key={c.conversation_id}
            className="rr-row"
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              padding: "6px 8px",
              borderBottom: "1px solid var(--color-border)",
            }}
          >
            <span
              className={`dot ${c.latest_status === "completed" ? "dot-ok" : "dot-err"}`}
            />
            <span
              className="mono"
              style={{
                fontSize: 11,
                color: "var(--color-text-tertiary)",
                minWidth: 80,
              }}
            >
              {c.root_handoff_id?.slice(0, 8) ?? c.conversation_id.slice(0, 8)}
            </span>
            <span style={{ flex: 1, fontSize: 12 }}>{c.handoff_count} hops</span>
            <StatusBadge status={c.latest_status} />
          </div>
        ))}
      </div>
    </Card>
  );
}
