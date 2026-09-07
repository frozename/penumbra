import type { SessionNoteDraft } from "@penumbra/api-contract";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { DaemonClient } from "@src/api/client";
import { sessionNoteDrafts } from "@src/lib/query-keys";
import { HEARTBEAT_MS } from "@src/lib/timing";
import { useDaemonStore } from "@src/stores/daemon-store";
import { Badge } from "@src/ui/Badge";
import { Card, CardHead } from "@src/ui/Card";

export interface PendingDraftProps {
  client?: DaemonClient;
  now?: () => number;
}

function makeDefaultClient(): DaemonClient {
  return new DaemonClient({ getConfig: () => useDaemonStore.getState() });
}

export function PendingDraft(props: PendingDraftProps = {}): JSX.Element {
  const client = useMemo(() => props.client ?? makeDefaultClient(), [props.client]);
  const now = props.now ?? Date.now;
  const query = useQuery({
    queryKey: sessionNoteDrafts(),
    queryFn: () => client.listSessionNoteDrafts({ status: "awaiting_approval", limit: 20 }),
    refetchInterval: HEARTBEAT_MS,
  });
  const drafts = query.data?.drafts ?? [];
  const error = query.isError ? errorMessage(query.error) : null;

  return (
    <Card>
      {error ? (
        <div
          className="t-tertiary mono"
          data-testid="pending-draft-error"
          style={{ padding: 12, color: "var(--color-err)" }}
        >
          Failed to load pending drafts: {error}
        </div>
      ) : (
        <>
          <CardHead title="Pending session-note drafts" id={`${drafts.length} awaiting`} />
          <div data-testid="pending-draft-panel">
            {drafts.length === 0 && (
              <div
                className="t-tertiary mono"
                data-testid="pending-draft-empty"
                style={{ padding: 12 }}
              >
                No drafts awaiting approval.
              </div>
            )}
            {drafts.map((draft) => (
              <DraftRow draft={draft} key={draft.draft_id} nowMs={now()} />
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

function DraftRow({ draft, nowMs }: { draft: SessionNoteDraft; nowMs: number }): JSX.Element {
  return (
    <div
      data-testid="pending-draft-row"
      style={{
        padding: "12px 14px",
        borderTop: "1px solid var(--color-border-subtle)",
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 13 }}>{draft.period_key}</span>
        <span className="mono" style={{ fontSize: 10.5, color: "var(--color-text-tertiary)" }}>
          {basename(draft.draft_path)}
        </span>
        <Badge variant="warn">awaiting approval</Badge>
        <span
          className="mono"
          data-testid="pending-draft-elapsed"
          style={{ fontSize: 10.5, color: "var(--color-text-tertiary)" }}
        >
          {pendingElapsed(draft.composed_at, nowMs)}
        </span>
      </div>
      <code
        data-testid="pending-draft-approve-command"
        style={{
          fontSize: 11,
          color: "var(--color-text-secondary)",
          overflowWrap: "anywhere",
        }}
      >
        {approvalCommand(draft.draft_id)}
      </code>
    </div>
  );
}

function pendingElapsed(composedAt: string, nowMs: number): string {
  const elapsedMinutes = Math.max(0, Math.floor((nowMs - Date.parse(composedAt)) / 60_000));
  const hours = Math.floor(elapsedMinutes / 60);
  const minutes = elapsedMinutes % 60;
  if (hours === 0) return `pending ${String(minutes)}m`;
  return `pending ${String(hours)}h ${String(minutes)}m`;
}

function approvalCommand(draftId: string): string {
  return `session_note_approve ${JSON.stringify({ draft_id: draftId })}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
