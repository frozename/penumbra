import type { CloseLaneRequest, LaneRow } from "@penumbra/api-contract";
import type { CSSProperties } from "react";

import { useEffect, useMemo, useRef, useState } from "react";

import { DaemonClient } from "@src/api/client";
import { useDaemonAction } from "@src/hooks/useDaemonAction";
import { lanesRecent } from "@src/lib/query-keys";
import { useDaemonStore } from "@src/stores/daemon-store";
import { Button } from "@src/ui/Button";
import { Card, CardHead } from "@src/ui/Card";

export interface LaneCloseFormProps {
  lane: LaneRow;
  client?: DaemonClient;
  onDone?: () => void;
  onCancel?: () => void;
}
interface CloseArgs {
  request: CloseLaneRequest;
  generation: number;
}
const fieldStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  font: "inherit",
  background: "var(--color-surface-0)",
  color: "var(--color-text)",
};

export function LaneCloseForm({
  lane,
  client: providedClient,
  onDone,
  onCancel,
}: LaneCloseFormProps): JSX.Element {
  const client = useMemo(
    () => providedClient ?? new DaemonClient({ getConfig: () => useDaemonStore.getState() }),
    [providedClient],
  );
  const [gateStatus, setGateStatus] = useState<CloseLaneRequest["gate_status"] | "">("");
  const [reviewer, setReviewer] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const locked = useRef(false);
  const current = useRef(lane);
  current.current = lane;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);
  useEffect(() => {
    generation.current += 1;
    locked.current = false;
    setBusy(false);
    setGateStatus("");
    setReviewer("");
    setNotes("");
  }, [lane.lane_id]);
  function isCurrent(args: CloseArgs): boolean {
    return (
      mounted.current &&
      generation.current === args.generation &&
      current.current.lane_id === args.request.lane_id &&
      current.current.gate_status === "open"
    );
  }
  const spec = useMemo(
    () => ({
      id: "lane.close",
      tier: "guarded" as const,
      label: "Close lane",
      run: async (c: DaemonClient, args: CloseArgs): Promise<LaneRow | undefined> => {
        if (!isCurrent(args)) return undefined;
        return await c.lanes.close(args.request);
      },
      invalidate: (args: CloseArgs, result: LaneRow | undefined) =>
        result !== undefined && mounted.current && generation.current === args.generation
          ? [lanesRecent()]
          : [],
      confirm: {
        title: "Close lane",
        typedTarget: (args: CloseArgs) => args.request.lane_id,
        body: ({ request }: CloseArgs) => (
          <div style={{ display: "grid", gap: 6 }}>
            <div>Lane: {request.lane_id}</div>
            <div>Status: {request.gate_status}</div>
            <div>Reviewer: {request.reviewer_handoff ?? "—"}</div>
            <div>Notes: {request.metadata?.notes ?? "—"}</div>
          </div>
        ),
      },
    }),
    [],
  );
  const action = useDaemonAction(spec, { client });
  async function submit(): Promise<void> {
    if (!gateStatus || locked.current || action.isPending || current.current.gate_status !== "open")
      return;
    const args: CloseArgs = {
      generation: generation.current,
      request: {
        lane_id: lane.lane_id,
        gate_status: gateStatus,
        ...(reviewer.trim() ? { reviewer_handoff: reviewer.trim() } : {}),
        ...(notes.trim() ? { metadata: { notes: notes.trim() } } : {}),
      },
    };
    locked.current = true;
    setBusy(true);
    try {
      const result = await action.execute(args);
      if (result && mounted.current && generation.current === args.generation) onDone?.();
    } finally {
      if (mounted.current && generation.current === args.generation) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <Card>
      <CardHead title={`Close lane ${lane.lane_id}`} />
      <div style={{ padding: 14, display: "grid", gap: 12 }}>
        <label>
          Gate status
          <select
            aria-label="Gate status"
            style={fieldStyle}
            value={gateStatus}
            disabled={busy}
            onChange={(e) => {
              setGateStatus(e.target.value as CloseLaneRequest["gate_status"]);
            }}
          >
            <option value="" disabled>
              Select a gate status
            </option>
            {(["passed", "failed", "skipped", "review_debt"] as const).map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reviewer handoff
          <input
            aria-label="Reviewer handoff"
            style={fieldStyle}
            value={reviewer}
            disabled={busy}
            onChange={(e) => {
              setReviewer(e.target.value);
            }}
          />
        </label>
        <label>
          Notes
          <textarea
            aria-label="Notes"
            style={fieldStyle}
            value={notes}
            maxLength={2000}
            rows={3}
            disabled={busy}
            onChange={(e) => {
              setNotes(e.target.value);
            }}
          />
        </label>
        {action.lastError && (
          <div
            role="alert"
            data-testid="lane-close-error"
            className="mono"
            style={{ color: "var(--color-err)" }}
          >
            {action.lastError.code ?? String(action.lastError.status)}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button disabled={busy} onClick={() => onCancel?.()}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="lane-close-submit"
            disabled={!gateStatus || busy || action.isPending || lane.gate_status !== "open"}
            onClick={() => {
              void submit();
            }}
          >
            Close lane
          </Button>
        </div>
      </div>
    </Card>
  );
}
