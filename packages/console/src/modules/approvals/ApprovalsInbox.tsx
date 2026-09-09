import { useMemo } from "react";

import { DaemonClient } from "@src/api/client";
import { DaemonHttpError } from "@src/api/errors";
import { type DaemonActionSpec, useDaemonAction } from "@src/hooks/useDaemonAction";
import { useLiveQuery } from "@src/hooks/useLiveQuery";
import { useDaemonStore } from "@src/stores/daemon-store";
import { Card, CardHead } from "@src/ui/Card";

import type { ApprovalItem } from "./queues/types";

import { type ErasedQueue, QUEUES } from "./queues";
export interface ApprovalsInboxProps {
  client?: DaemonClient;
}

function makeDefaultClient(): DaemonClient {
  return new DaemonClient({ getConfig: () => useDaemonStore.getState() });
}

const INERT_SPEC: DaemonActionSpec<ApprovalItem, unknown> = {
  id: "noop",
  tier: "safe",
  label: "",
  run: async () => undefined,
  invalidate: () => [],
};

interface ApprovalRowProps {
  kind: ErasedQueue["kind"];
  item: ApprovalItem;
  queue: ErasedQueue;
  client: DaemonClient;
}

function extractConflictStatus(error: DaemonHttpError | null): string | null {
  if (error?.status !== 409) return null;
  try {
    const body = JSON.parse(error.bodyText) as { current_status?: unknown };
    if (typeof body.current_status === "string") return body.current_status;
  } catch {
    /* ignore parse failure */
  }
  return null;
}

function ApprovalRow({ kind, item, queue, client }: ApprovalRowProps): JSX.Element {
  const approveAction = useDaemonAction(queue.approve ?? INERT_SPEC, { client });
  const rejectAction = useDaemonAction(queue.reject ?? INERT_SPEC, { client });
  const busy = approveAction.isPending || rejectAction.isPending;
  const status =
    extractConflictStatus(approveAction.lastError) ?? extractConflictStatus(rejectAction.lastError);

  return (
    <div
      data-testid="approval-row"
      data-kind={kind}
      data-id={item.id}
      style={{
        padding: "12px 14px",
        borderTop: "1px solid var(--color-border-subtle)",
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: 12,
        alignItems: "center",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13 }}>{item.title}</span>
          {item.subtitle && (
            <span className="mono" style={{ fontSize: 10.5, color: "var(--color-text-tertiary)" }}>
              {item.subtitle}
            </span>
          )}
        </div>
        {status && (
          <span
            className="mono"
            data-testid="approval-row-status"
            style={{ fontSize: 10.5, color: "var(--color-text-tertiary)" }}
          >
            {status}
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => {
            void approveAction.execute(item);
          }}
        >
          Approve
        </button>
        {queue.reject && (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => {
              void rejectAction.execute(item);
            }}
          >
            Reject
          </button>
        )}
      </div>
    </div>
  );
}

export function ApprovalsInbox(props: ApprovalsInboxProps = {}): JSX.Element {
  const client = useMemo(() => props.client ?? makeDefaultClient(), [props.client]);

  const rows: { kind: ErasedQueue["kind"]; item: ApprovalItem; queue: ErasedQueue }[] = [];
  const queueErrors: { kind: ErasedQueue["kind"]; message: string }[] = [];
  let anyPending = false;
  for (const q of QUEUES) {
    const query = useLiveQuery<ApprovalItem[]>({
      queryKey: q.queryKey(),
      queryFn: () => q.fetch(client),
      owner: "approvals",
      topic: q.topic,
    });
    const items = query.data ?? [];
    for (const item of items) {
      rows.push({ kind: q.kind, item, queue: q });
    }
    if (query.isError) {
      queueErrors.push({
        kind: q.kind,
        message: query.error instanceof Error ? query.error.message : String(query.error),
      });
    }
    if (!query.isSuccess) {
      anyPending = true;
    }
  }

  rows.sort((a, b) => a.item.ts.localeCompare(b.item.ts));

  const allEmpty = rows.length === 0 && queueErrors.length === 0 && !anyPending;

  return (
    <>
      <header className="surface-head">
        <h1>
          Approvals <em>· inbox</em>
        </h1>
        <p className="lede">Pending handoffs, permissions and session-note drafts.</p>
      </header>
      <Card>
        <CardHead title="Approval queue" id={`${rows.length} pending`} />
        {anyPending && (
          <div
            className="t-tertiary mono"
            data-testid="approvals-loading"
            style={{ padding: 12 }}
          >
            Loading…
          </div>
        )}
        {allEmpty && (
          <div className="t-tertiary mono" data-testid="approvals-empty" style={{ padding: 12 }}>
            No approvals pending.
          </div>
        )}
        {queueErrors.map(({ kind, message }) => (
          <div
            key={`error-${kind}`}
            className="t-tertiary mono"
            data-testid="approvals-queue-error"
            data-kind={kind}
            style={{ padding: 12, color: "var(--color-err)" }}
          >
            Failed to load {kind} queue: {message}
          </div>
        ))}
        {rows.map(({ kind, item, queue }) => (
          <ApprovalRow
            key={`${kind}-${item.id}`}
            kind={kind}
            item={item}
            queue={queue}
            client={client}
          />
        ))}
      </Card>
    </>
  );
}
