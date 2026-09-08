import type { HandoffRow } from "@penumbra/api-contract";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { type ApproveHandoffResponse, DaemonClient } from "@src/api/client";
import { useDaemonAction } from "@src/hooks/useDaemonAction";
import { handoffsPending } from "@src/lib/query-keys";
import { HEARTBEAT_MS } from "@src/lib/timing";
import { useDaemonStore } from "@src/stores/daemon-store";
import { Button } from "@src/ui/Button";
import { Card, CardHead } from "@src/ui/Card";

export interface PendingHandoffsProps {
  /** Override the daemon client. Defaults to a module-default backed by the daemon-store. */
  client?: DaemonClient;
}

function makeDefaultClient(): DaemonClient {
  return new DaemonClient({ getConfig: () => useDaemonStore.getState() });
}

function fmtAgo(d: Date): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "unknown";
  const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function truncate(s: string, n: number): string {
  const codePoints = Array.from(s);
  if (codePoints.length <= n) return s;
  return codePoints.slice(0, n).join("") + "…";
}

function previewMessage(message: string): string {
  return truncate(message.trim(), 80);
}

export function PendingHandoffs(props: PendingHandoffsProps = {}): JSX.Element {
  const client = useMemo(() => props.client ?? makeDefaultClient(), [props.client]);

  const query = useQuery({
    queryKey: handoffsPending(),
    queryFn: () => client.listHandoffs({ status: "pending" }),
    refetchInterval: HEARTBEAT_MS,
  });

  const rows: HandoffRow[] = query.data?.handoffs ?? [];

  return (
    <Card>
      <CardHead title="Pending handoffs" id={`${rows.length} pending`} />
      <div className="ph-list">
        {rows.length === 0 && (
          <div className="t-tertiary mono" style={{ padding: 12 }}>
            No handoffs awaiting approval.
          </div>
        )}
        {rows.map((row) => (
          <PendingHandoffRow key={row.handoff_id} row={row} client={client} />
        ))}
      </div>
    </Card>
  );
}

interface PendingHandoffRowProps {
  row: HandoffRow;
  client: DaemonClient;
}

function PendingHandoffRow({ row, client }: PendingHandoffRowProps): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const approveHandoff = useDaemonAction<{ handoff_id: string }, ApproveHandoffResponse>(
    {
      id: "handoff.approve",
      tier: "safe",
      label: "Approve handoff",
      run: (daemon, { handoff_id }) => daemon.approveHandoff(handoff_id),
      invalidate: () => [handoffsPending()],
    },
    { client },
  );

  const denyHandoff = useDaemonAction<{ handoff_id: string }, ApproveHandoffResponse>(
    {
      id: "handoff.deny",
      tier: "guarded",
      label: "Deny handoff",
      confirm: { title: "Deny handoff" },
      run: (daemon, { handoff_id }, ctx) =>
        daemon.approveHandoff(handoff_id, {
          reject: true,
          reason: ctx.reason ?? "", // unreachable: ConfirmDialog gates Confirm on a non-blank reason
        }),
      invalidate: () => [handoffsPending()],
    },
    { client },
  );

  const filedAt = new Date(row.ts);
  const disabled = confirming || approveHandoff.isPending || denyHandoff.isPending;

  return (
    <div
      data-testid="pending-handoff-row"
      className="ph-row"
      style={{
        padding: "12px 14px",
        borderTop: "1px solid var(--color-border-subtle)",
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        gap: 14,
        alignItems: "start",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 4,
          paddingTop: 2,
        }}
      >
        <span className="dot dot-warn dot-live" />
        <span className="mono" style={{ fontSize: 9.5, color: "var(--color-text-tertiary)" }}>
          {fmtAgo(filedAt)}
        </span>
      </div>

      <div style={{ minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            marginBottom: 4,
            flexWrap: "wrap",
          }}
        >
          <span className="mono" style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
            {row.from_agent}
          </span>
          <span className="t-ghost mono">→</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--color-brand)" }}>
            {row.to_agent}
          </span>
          {row.to_role && (
            <span className="badge badge-muted" style={{ fontSize: 10 }}>
              {row.to_role}
            </span>
          )}
          {row.chain_task_type && (
            <span className="badge badge-info" style={{ fontSize: 10 }}>
              {row.chain_task_type}
            </span>
          )}
          {row.use_worktree && (
            <span className="badge badge-brand" style={{ fontSize: 10 }}>
              worktree
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 13,
            color: "var(--color-text)",
            lineHeight: 1.4,
          }}
        >
          {previewMessage(row.message)}
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 5 }}>
          <span className="mono-id" style={{ fontSize: 10.5 }}>
            {row.handoff_id}
          </span>
          <span className="t-ghost">·</span>
          <span className="mono-id" style={{ fontSize: 10.5 }}>
            {row.conversation_id}
          </span>
        </div>
      </div>

      {/* TODO: needs daemon-side defer route */}
      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        <Button
          variant="danger"
          onClick={() => {
            setConfirming(true);
            void denyHandoff.execute({ handoff_id: row.handoff_id }).finally(() => {
              setConfirming(false);
            });
          }}
          disabled={disabled}
          style={{ fontSize: 11 }}
        >
          Deny
        </Button>
        <Button
          variant="ok"
          onClick={() => {
            void approveHandoff.execute({ handoff_id: row.handoff_id });
          }}
          disabled={disabled}
          style={{ fontSize: 11 }}
        >
          Approve
        </Button>
      </div>
    </div>
  );
}
