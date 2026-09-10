import type { HandoffRow, HandoffStatus } from "@penumbra/api-contract";

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { DaemonClient } from "@src/api/client";
import { useLiveQuery } from "@src/hooks/useLiveQuery";
import { handoffsByStatus } from "@src/lib/query-keys";
import { useDaemonStore } from "@src/stores/daemon-store";
import { Button } from "@src/ui/Button";
import { Card, CardHead } from "@src/ui/Card";
import { EmptyState } from "@src/ui/EmptyState";
import { StatusBadge } from "@src/ui/StatusBadge";
import { type TabItem, Tabs } from "@src/ui/Tabs";

import { LanesTab } from "./LanesTab";

const STATUS_TABS: readonly TabItem[] = [
  { id: "pending", label: "Pending" },
  { id: "dispatched", label: "Dispatched" },
  { id: "completed", label: "Completed" },
  { id: "failed", label: "Failed" },
  { id: "lanes", label: "Lanes" },
];

const DEBOUNCE_MS = 300;
const PAGE_SIZE = 50;

export interface HandoffListProps {
  client?: DaemonClient;
}

function makeDefaultClient(): DaemonClient {
  return new DaemonClient({ getConfig: () => useDaemonStore.getState() });
}

export function HandoffList(props: HandoffListProps = {}): JSX.Element {
  const client = useMemo(() => props.client ?? makeDefaultClient(), [props.client]);
  const [status, setStatus] = useState<HandoffStatus | "lanes">("pending");
  const [agentInput, setAgentInput] = useState("");
  const [agentDebounced, setAgentDebounced] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(0);

  useEffect(() => {
    const trimmed = agentInput.trim();
    if (trimmed === "") {
      setAgentDebounced(undefined);
      setPage(0);
      return;
    }
    const handle = setTimeout(() => {
      setAgentDebounced(trimmed);
      setPage(0);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [agentInput]);

  const agent = agentDebounced;
  const queryStatus = status === "lanes" ? "pending" : status;

  const query = useLiveQuery<HandoffRow[]>({
    owner: "handoffs",
    topic: "handoff-events",
    queryKey: handoffsByStatus(queryStatus, agent),
    enabled: status !== "lanes",
    queryFn: async () => (await client.handoffs.list({ status: queryStatus, agent })).handoffs,
  });

  const handoffs = useMemo(
    () => [...(query.data ?? [])].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)),
    [query.data],
  );
  const pageCount = Math.max(1, Math.ceil(handoffs.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleHandoffs = handoffs.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  return (
    <>
      <header className="surface-head">
        <h1>
          Handoffs <em>· queue</em>
        </h1>
        <p className="lede">Browse handoffs by status and agent.</p>
      </header>
      <Tabs
        items={STATUS_TABS}
        activeId={status}
        onSelect={(id) => {
          setStatus(id as HandoffStatus | "lanes");
          setPage(0);
        }}
      />
      <div className="surface-body">
        {status === "lanes" ? (
          <LanesTab client={client} />
        ) : (
          <>
            <div style={{ padding: "8px 0" }}>
              <input
                type="text"
                aria-label="Agent filter"
                placeholder="Filter by agent…"
                value={agentInput}
                onChange={(e) => {
                  setAgentInput(e.target.value);
                }}
                className="input"
                style={{ width: "100%", padding: "6px 10px", fontSize: 12 }}
              />
            </div>
            {handoffs.length > PAGE_SIZE && (
              <div
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0 12px" }}
              >
                <Button
                  aria-label="Previous handoff page"
                  disabled={currentPage === 0}
                  onClick={() => {
                    setPage(currentPage - 1);
                  }}
                >
                  Previous
                </Button>
                <span className="mono t-tertiary" aria-live="polite">
                  Page {currentPage + 1} of {pageCount}
                </span>
                <Button
                  aria-label="Next handoff page"
                  disabled={currentPage === pageCount - 1}
                  onClick={() => {
                    setPage(currentPage + 1);
                  }}
                >
                  Next
                </Button>
              </div>
            )}
            <Card>
              <CardHead title={`${status} handoffs`} id={`${handoffs.length}`} />
              {query.isError && (
                <div
                  className="t-tertiary mono"
                  data-testid="handoffs-list-error"
                  style={{ padding: 12, color: "var(--color-err)" }}
                >
                  Failed to load handoffs:{" "}
                  {query.error instanceof Error ? query.error.message : String(query.error)}
                </div>
              )}
              {!query.isError && !query.isLoading && handoffs.length === 0 && (
                <EmptyState testId="handoffs-list-empty" title={`No ${status} handoffs.`} />
              )}
              {query.isLoading && (
                <div
                  className="t-tertiary mono"
                  data-testid="handoffs-list-loading"
                  style={{ padding: 12 }}
                >
                  Loading…
                </div>
              )}
              {visibleHandoffs.map((handoff) => (
                <Link
                  key={handoff.handoff_id}
                  to={`/handoffs/${handoff.handoff_id}`}
                  className="handoff-row"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: 12,
                    padding: "10px 14px",
                    borderTop: "1px solid var(--color-border-subtle)",
                    alignItems: "center",
                    textDecoration: "none",
                    color: "inherit",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        overflowWrap: "anywhere",
                        display: "-webkit-box",
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {handoff.message}
                    </div>
                    <div
                      className="mono"
                      style={{ fontSize: 10.5, color: "var(--color-text-tertiary)" }}
                    >
                      {handoff.from_agent} → {handoff.to_agent}
                    </div>
                  </div>
                  <StatusBadge status={handoff.status} monoLabel={handoff.status} />
                </Link>
              ))}
            </Card>
          </>
        )}
      </div>
    </>
  );
}
