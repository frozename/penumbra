import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ChainSummary } from "@penumbra/api-contract";
import { Card, CardHead } from "../../ui/Card";
import { StatusBadge } from "../../ui/StatusBadge";
import { DaemonClient } from "../../api/client";
import { useDaemonStore } from "../../stores/daemon-store";
import { chainsByStatus } from "../../lib/query-keys";

function makeDefaultClient(): DaemonClient {
  return new DaemonClient({ getConfig: () => useDaemonStore.getState() });
}

function LiveChainCard({ chain }: { chain: ChainSummary }): JSX.Element {
  const rootId = chain.root_handoff_id?.slice(0, 9) ?? chain.conversation_id.slice(0, 9);
  const worktreeRaw = chain.worktree_path ?? chain.worktree_root;
  const worktree = typeof worktreeRaw === "string" ? worktreeRaw : null;

  return (
    <div className="chain-card">
      <div className="chain-card-head">
        <span
          className={`dot ${chain.latest_status === "dispatched" ? "dot-brand dot-live" : "dot-warn"}`}
        />
        <span className="chain-card-title mono">{rootId}</span>
        <span className="chain-card-hops">{chain.handoff_count} hops</span>
        <StatusBadge status={chain.latest_status} monoLabel={chain.latest_status} />
      </div>
      <div className="chain-card-body">
        {worktree ? (
          <div className="t-tertiary" style={{ fontSize: 11 }}>
            worktree: {worktree}
          </div>
        ) : null}
        <div className="t-tertiary" style={{ fontSize: 11 }}>
          conversation: {chain.conversation_id}
        </div>
        <div
          className="progress-bar"
          style={{
            height: 4,
            background: "var(--color-surface-3)",
            borderRadius: 2,
            overflow: "hidden",
            marginTop: 6,
          }}
        >
          <div
            className="progress-bar-fill"
            style={{
              width: "50%",
              height: "100%",
              background:
                "linear-gradient(90deg, var(--color-brand) 0%, var(--color-brand-muted) 100%)",
              boxShadow: "0 0 6px var(--color-brand-muted)",
            }}
          />
        </div>
        <div className="t-tertiary mono" style={{ fontSize: 10, marginTop: 4 }}>
          latest: {chain.latest_ts ?? "—"}
        </div>
      </div>
    </div>
  );
}

export function InFlightChains(): JSX.Element {
  const client = useMemo(() => makeDefaultClient(), []);

  const query = useQuery({
    queryKey: chainsByStatus("dispatched"),
    queryFn: () => client.listChains({ status: "dispatched" }),
    refetchInterval: 5_000,
  });

  const chains = query.data?.chains ?? [];

  return (
    <Card>
      <CardHead title="In-flight chains" id={`${chains.length}`} />
      <div className="ifc-list">
        {chains.length === 0 && (
          <div className="t-tertiary mono" style={{ padding: 12 }}>
            No chains running.
          </div>
        )}
        {chains.map((chain) => (
          <LiveChainCard key={chain.conversation_id} chain={chain} />
        ))}
      </div>
    </Card>
  );
}
