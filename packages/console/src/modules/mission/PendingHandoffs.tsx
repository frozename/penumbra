import { useMemo, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { HandoffRow } from "@penumbra/api-contract";
import { Card, CardHead } from "@src/ui/Card";
import { Button } from "@src/ui/Button";
import { DaemonClient } from "@src/api/client";
import { useDaemonStore } from "@src/stores/daemon-store";
import { handoffsPending } from "@src/lib/query-keys";
import { HEARTBEAT_MS } from "@src/lib/timing";

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
  const queryClient = useQueryClient();

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

function PendingHandoffRow({ row, client, queryClient }: PendingHandoffRowProps): JSX.Element {
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onApprove = async () => {
    setBusy("approve");
    setError(null);
    try {
      await client.approveHandoff(row.handoff_id);
      await queryClient.invalidateQueries({ queryKey: handoffsPending() });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onSubmitDeny = async () => {
    setBusy("deny");
    setError(null);
    let failed = false;
    try {
      await client.approveHandoff(row.handoff_id, {
        reject: true,
        reason: reason || "denied",
      });
      await queryClient.invalidateQueries({ queryKey: handoffsPending() });
    } catch (e) {
      failed = true;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      if (!failed) {
        setDenying(false);
        setReason("");
      }
    }
  };

  const filedAt = new Date(row.ts);
  const disabled = busy !== null;

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

        {error && (
          <div
            data-testid="ph-row-error"
            className="t-tertiary mono"
            style={{
              fontSize: 10,
              color: "var(--color-err)",
              marginTop: 4,
              padding: "2px 6px",
              background: "var(--color-surface-2)",
              borderRadius: 3,
            }}
          >
            {error}
          </div>
        )}

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
          <Button variant="ok" onClick={onApprove} disabled={disabled} style={{ fontSize: 11 }}>
            Approve
          </Button>
        </div>
      )}
    </div>
  );
}
