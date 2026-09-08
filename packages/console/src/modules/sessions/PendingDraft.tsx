import type { SessionNoteDraft } from "@penumbra/api-contract";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { DaemonClient } from "@src/api/client";
import { useDaemonAction } from "@src/hooks/useDaemonAction";
import { approvalsCount, sessionNoteDrafts } from "@src/lib/query-keys";
import { HEARTBEAT_MS } from "@src/lib/timing";
import { useDaemonStore } from "@src/stores/daemon-store";
import { Badge } from "@src/ui/Badge";
import { Button } from "@src/ui/Button";
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
              <DraftRow client={client} draft={draft} key={draft.draft_id} nowMs={now()} />
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

interface DraftRowProps {
  client: DaemonClient;
  draft: SessionNoteDraft;
  nowMs: number;
}

function DraftRow({ client, draft, nowMs }: DraftRowProps): JSX.Element {
  const action = useDaemonAction<{ draft_id: string }, unknown>(
    {
      id: "session-note.approve",
      tier: "safe",
      label: "Approve draft",
      run: (c, args) => c.sessionNotes.approve({ draft_id: args.draft_id, approve: true }),
      invalidate: (_args, _result) => [sessionNoteDrafts(), approvalsCount()],
    },
    { client },
  );

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
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button
          variant="primary"
          onClick={() => {
            void action.execute({ draft_id: draft.draft_id });
          }}
          disabled={action.isPending}
        >
          Approve
        </Button>
      </div>
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

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
