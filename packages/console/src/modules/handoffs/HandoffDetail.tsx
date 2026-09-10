import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { Link, useParams } from "react-router-dom";

import { DaemonClient } from "@src/api/client";
import { dispatchAudit, dispatchEvents, handoffDetail } from "@src/lib/query-keys";
import { HEARTBEAT_MS } from "@src/lib/timing";
import { useDaemonStore } from "@src/stores/daemon-store";
import { useUIStore } from "@src/stores/ui-store";
import { Card, CardHead } from "@src/ui/Card";
import { EmptyState } from "@src/ui/EmptyState";
import { EntityLink } from "@src/ui/EntityLink";
import { StatusBadge } from "@src/ui/StatusBadge";

import { DispatchTimeline } from "./DispatchTimeline";
import { ReliabilityChip } from "./ReliabilityChip";

export interface HandoffDetailProps {
  client?: DaemonClient;
}

function makeDefaultClient(): DaemonClient {
  return new DaemonClient({ getConfig: () => useDaemonStore.getState() });
}

export function HandoffDetail(props: HandoffDetailProps = {}): JSX.Element {
  const { handoffId } = useParams<{ handoffId: string }>();
  const client = useMemo(() => props.client ?? makeDefaultClient(), [props.client]);
  const setActiveModule = useUIStore((s) => s.setActiveModule);
  useEffect(() => {
    setActiveModule("handoffs");
  }, [setActiveModule]);

  const detail = useQuery({
    queryKey: handoffDetail(handoffId ?? ""),
    queryFn: () => client.handoffs.get(handoffId ?? ""),
    refetchInterval: HEARTBEAT_MS,
    enabled: handoffId !== undefined,
  });

  const events = useQuery({
    queryKey: dispatchEvents(handoffId ?? ""),
    queryFn: () => client.dispatchEvents.list(handoffId ?? ""),
    refetchInterval: HEARTBEAT_MS,
    enabled: handoffId !== undefined,
  });

  const audit = useQuery({
    queryKey: dispatchAudit(handoffId ?? ""),
    queryFn: () => client.dispatchAudit.audit(handoffId ?? ""),
    refetchInterval: HEARTBEAT_MS,
    enabled: handoffId !== undefined,
  });

  if (handoffId === undefined) {
    return <div className="surface-stub">No handoff selected.</div>;
  }

  if (detail.isError) {
    const message = detail.error instanceof Error ? detail.error.message : String(detail.error);
    return (
      <div className="t-tertiary mono" data-testid="handoff-detail-error" style={{ padding: 12 }}>
        Failed to load handoff: {message}
      </div>
    );
  }

  const handoff = detail.data?.handoff;
  if (!handoff) {
    return (
      <div className="t-tertiary mono" data-testid="handoff-detail-loading" style={{ padding: 12 }}>
        Loading handoff…
      </div>
    );
  }

  const eventList = events.data?.events ?? [];
  const report = audit.data?.report ?? null;

  return (
    <>
      <header className="surface-head">
        <div style={{ marginBottom: 6 }}>
          <Link
            to="/handoffs"
            data-testid="handoff-back"
            className="mono"
            style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}
          >
            ← All handoffs
          </Link>
        </div>
        <h1 style={{ overflowWrap: "anywhere" }}>
          <EntityLink id={handoff.handoff_id} kind="handoff" />{" "}
          <StatusBadge status={handoff.status} monoLabel={handoff.status} />
        </h1>
        <p className="lede">
          <em className="brand">
            {handoff.from_agent} → {handoff.to_agent}
          </em>
          {typeof handoff.to_role === "string" && handoff.to_role
            ? ` · role: ${handoff.to_role}`
            : ""}
        </p>
      </header>
      <Card>
        <CardHead title="Details" />
        <div style={{ padding: 12, display: "grid", gap: 6 }}>
          <div
            data-testid="handoff-message"
            style={{
              fontSize: 13,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              maxHeight: 320,
              overflow: "auto",
            }}
          >
            {handoff.message}
          </div>
          <div className="t-tertiary mono" style={{ fontSize: 11 }}>
            to_agent: {handoff.to_agent}
          </div>
          {typeof handoff.branch_name === "string" && handoff.branch_name && (
            <div className="t-tertiary mono" style={{ fontSize: 11 }}>
              branch: {handoff.branch_name}
            </div>
          )}
          {typeof handoff.branch_base === "string" && handoff.branch_base && (
            <div className="t-tertiary mono" style={{ fontSize: 11 }}>
              branch_base: {handoff.branch_base}
            </div>
          )}
          <div className="t-tertiary mono" style={{ fontSize: 11 }}>
            use_worktree: {handoff.use_worktree === null ? "—" : String(handoff.use_worktree)}
          </div>
          <div className="t-tertiary mono" style={{ fontSize: 11 }}>
            conversation: <EntityLink id={handoff.conversation_id} kind="conversation" />
          </div>
        </div>
      </Card>
      <div style={{ marginTop: 16 }}>
        <Card>
          <CardHead title="Dispatch timeline" id={`${eventList.length} events`} />
          {events.isError ? (
            <div
              className="t-tertiary mono"
              data-testid="dispatch-timeline-error"
              style={{ padding: 12, color: "var(--color-err)" }}
            >
              Failed to load dispatch events:{" "}
              {events.error instanceof Error ? events.error.message : String(events.error)}
            </div>
          ) : events.isLoading ? (
            <div className="t-tertiary mono" style={{ padding: 12 }}>
              Loading dispatch events…
            </div>
          ) : eventList.length === 0 ? (
            <EmptyState testId="dispatch-timeline-empty" title="No dispatch events." />
          ) : (
            <DispatchTimeline events={eventList} />
          )}
        </Card>
      </div>
      <div style={{ marginTop: 16 }}>
        <Card>
          <CardHead title="Reliability" />
          {audit.isError ? (
            <div
              className="t-tertiary mono"
              data-testid="reliability-error"
              style={{ padding: 12, color: "var(--color-err)" }}
            >
              Failed to load reliability report:{" "}
              {audit.error instanceof Error ? audit.error.message : String(audit.error)}
            </div>
          ) : report ? (
            <div style={{ padding: 12, display: "flex", gap: 8, alignItems: "center" }}>
              <ReliabilityChip report={report} />
              <span className="t-tertiary mono" style={{ fontSize: 11 }}>
                {report.summary}
              </span>
            </div>
          ) : (
            <div
              className="t-tertiary mono"
              data-testid="reliability-loading"
              style={{ padding: 12 }}
            >
              Loading reliability…
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
