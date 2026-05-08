import { useMemo, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { HandoffRow } from "@penumbra/api-contract";
import { Card, CardHead } from "../../ui/Card";
import { Button } from "../../ui/Button";
import { DaemonClient } from "../../api/client";
import { useDaemonStore } from "../../stores/daemon-store";

const PENDING_QUERY_KEY = ["handoffs", "pending"] as const;

export interface PendingHandoffsProps {
  /** Override the daemon client. Defaults to a module-default backed by the daemon-store. */
  client?: DaemonClient;
}

function makeDefaultClient(): DaemonClient {
  return new DaemonClient({ getConfig: () => useDaemonStore.getState() });
}

function fmtAgo(d: Date): string {
  const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function previewMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length <= 80) return trimmed;
  return trimmed.slice(0, 80) + "…";
}

export function PendingHandoffs(props: PendingHandoffsProps = {}): JSX.Element {
  const client = useMemo(
    () => props.client ?? makeDefaultClient(),
    [props.client],
  );
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: PENDING_QUERY_KEY,
    queryFn: () => client.listHandoffs({ status: "pending" }),
    refetchInterval: 5_000,
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
          <PendingHandoffRow
            key={row.handoff_id}
            row={row}
            client={client}
            queryClient={queryClient}
          />
        ))}
      </div>
    </Card>
  );
}

interface PendingHandoffRowProps {
  row: HandoffRow;
  client: DaemonClient;
  queryClient: QueryClient;
}

function PendingHandoffRow({
  row,
  client,
  queryClient,
}: PendingHandoffRowProps): JSX.Element {
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");

  const onApprove = async () => {
    setBusy("approve");
    try {
      await client.approveHandoff(row.handoff_id);
      await queryClient.invalidateQueries({ queryKey: PENDING_QUERY_KEY });
    } finally {
      setBusy(null);
    }
  };

  const onSubmitDeny = async () => {
    setBusy("deny");
    try {
      await client.approveHandoff(row.handoff_id, {
        reject: true,
        reason: reason || "denied",
      });
      await queryClient.invalidateQueries({ queryKey: PENDING_QUERY_KEY });
    } finally {
      setBusy(null);
      setDenying(false);
      setReason("");
    }
  };

  const filedAt = new Date(row.ts);
  const disabled = busy !== null;

  return (
    <div
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
        <span
          className="mono"
          style={{ fontSize: 9.5, color: "var(--color-text-tertiary)" }}
        >
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
          <span
            className="mono"
            style={{ fontSize: 11, color: "var(--color-text-secondary)" }}
          >
            {row.from_agent}
          </span>
          <span className="t-ghost mono">→</span>
          <span
            className="mono"
            style={{ fontSize: 11, color: "var(--color-brand)" }}
          >
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

        {denying && (
          <div
            style={{
              display: "flex",
              gap: 6,
              marginTop: 8,
              alignItems: "center",
            }}
          >
            <input
              name="deny-reason"
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
              placeholder="reason (optional)"
              style={{
                flex: 1,
                padding: "4px 8px",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-subtle)",
                borderRadius: 4,
              }}
            />
            <Button
              variant="danger"
              onClick={onSubmitDeny}
              disabled={disabled}
              style={{ fontSize: 11 }}
            >
              Submit deny
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setDenying(false);
                setReason("");
              }}
              disabled={disabled}
              style={{ fontSize: 11 }}
            >
              Cancel
            </Button>
          </div>
        )}
      </div>

      {/* TODO: needs daemon-side defer route */}
      {!denying && (
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <Button
            variant="danger"
            onClick={() => setDenying(true)}
            disabled={disabled}
            style={{ fontSize: 11 }}
          >
            Deny
          </Button>
          <Button
            variant="ok"
            onClick={onApprove}
            disabled={disabled}
            style={{ fontSize: 11 }}
          >
            Approve
          </Button>
        </div>
      )}
    </div>
  );
}
