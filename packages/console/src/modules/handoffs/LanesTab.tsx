import { useState } from "react";

import type { DaemonClient } from "@src/api/client";
import { useLiveQuery } from "@src/hooks/useLiveQuery";
import { lanesRecent } from "@src/lib/query-keys";
import { Button } from "@src/ui/Button";
import { Card, CardHead } from "@src/ui/Card";
import { EmptyState } from "@src/ui/EmptyState";
import { EntityLink } from "@src/ui/EntityLink";

import { LaneCloseForm } from "./LaneCloseForm";

export function LanesTab({ client }: { client: DaemonClient }): JSX.Element {
  const query = useLiveQuery({
    owner: "handoffs",
    queryKey: lanesRecent(),
    queryFn: () => client.lanes.recent(),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const rows = query.data?.lanes ?? [];
  const selectedLane = query.isError
    ? undefined
    : rows.find((row) => row.lane_id === selected && row.gate_status === "open");
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card>
        <CardHead title="Recent lanes" id={String(rows.length)} />
        {query.isLoading && <div style={{ padding: 14 }}>Loading lanes…</div>}
        {query.isError && (
          <div role="alert" style={{ padding: 14, color: "var(--color-err)" }}>
            Failed to load lanes:{" "}
            {query.error instanceof Error ? query.error.message : String(query.error)}
          </div>
        )}
        {!query.isLoading && !query.isError && rows.length === 0 && (
          <EmptyState title="No recent lanes." />
        )}
        {rows.map((row) => (
          <div
            key={row.lane_id}
            data-testid="lane-row"
            style={{
              padding: 14,
              borderTop: "1px solid var(--color-border)",
              display: "grid",
              gap: 8,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <EntityLink kind="lane" id={row.lane_id} />
              <span className="mono">{row.gate_status}</span>
            </div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <span>
                Implementer: <EntityLink kind="handoff" id={row.implementer_handoff} />
              </span>
              <span>
                Reviewer:{" "}
                {row.reviewer_handoff === null ? (
                  "—"
                ) : (
                  <EntityLink kind="handoff" id={row.reviewer_handoff} />
                )}
              </span>
            </div>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <span className="mono t-tertiary">{row.task_class}</span>
              {row.gate_status === "open" && (
                <Button
                  disabled={query.isError}
                  aria-label={`Close lane ${row.lane_id}`}
                  onClick={() => {
                    setSelected(row.lane_id);
                  }}
                >
                  Close
                </Button>
              )}
            </div>
            {selectedLane?.lane_id === row.lane_id && (
              <LaneCloseForm
                key={selectedLane.lane_id}
                lane={selectedLane}
                client={client}
                onDone={() => {
                  setSelected(null);
                }}
                onCancel={() => {
                  setSelected(null);
                }}
              />
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}
