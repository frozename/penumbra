import type { RegistrarEntry, RegistrarStatus } from "@penumbra/api-contract";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link } from "react-router-dom";

import { DaemonClient } from "@src/api/client";
import { fmtTs } from "@src/lib/format";
import { registrarDetail, registrarList } from "@src/lib/query-keys";
import { HEARTBEAT_MS } from "@src/lib/timing";
import { useDaemonStore } from "@src/stores/daemon-store";
import type { BadgeVariant } from "@src/ui/Badge";
import { Card, CardHead } from "@src/ui/Card";

export interface RegistrarListProps {
  /** Override the daemon client. Defaults to a module-default backed by the daemon-store. */
  client?: DaemonClient;
}

function makeDefaultClient(): DaemonClient {
  return new DaemonClient({ getConfig: () => useDaemonStore.getState() });
}

const ENTRY_STATUS_VARIANT: Record<RegistrarStatus, BadgeVariant> = {
  draft: "muted",
  active: "ok",
  paused: "warn",
  complete: "brand",
  abandoned: "err",
};

export function RegistrarList(props: RegistrarListProps = {}): JSX.Element {
  const client = useMemo(() => props.client ?? makeDefaultClient(), [props.client]);

  const query = useQuery({
    queryKey: registrarList(),
    queryFn: () => client.listRegistrarEntries(),
    refetchInterval: HEARTBEAT_MS,
  });

  const entries = query.data?.entries ?? [];
  const listError = query.isError
    ? query.error instanceof Error
      ? query.error.message
      : String(query.error)
    : null;

  return (
    <>
      <header className="surface-head">
        <h1>
          Plans <em>· registrar</em>
        </h1>
        <p className="lede">Registered initiatives with phase progress and open blockers.</p>
      </header>
      <Card>
        {listError ? (
          <div
            className="t-tertiary mono"
            data-testid="registrar-list-error"
            style={{ padding: 12, color: "var(--color-err)" }}
          >
            Failed to load registered initiatives: {listError}
          </div>
        ) : (
          <>
            <CardHead title="Registered initiatives" id={`${entries.length} registered`} />
            <div className="registrar-list">
              {entries.length === 0 && (
                <div
                  className="t-tertiary mono"
                  data-testid="registrar-empty"
                  style={{ padding: 12 }}
                >
                  No initiatives registered.
                </div>
              )}
              {entries.map((entry) => (
                <RegistrarRow key={entry.registrar_id} entry={entry} client={client} />
              ))}
            </div>
          </>
        )}
      </Card>
    </>
  );
}

interface RegistrarRowProps {
  entry: RegistrarEntry;
  client: DaemonClient;
}

function RegistrarRow({ entry, client }: RegistrarRowProps): JSX.Element {
  // The list endpoint carries no rollup, so each row polls its own detail to
  // surface phases and the daemon-computed open blocker/follow-up counts.
  const detail = useQuery({
    queryKey: registrarDetail(entry.registrar_id),
    queryFn: () => client.getRegistrarEntry(entry.registrar_id),
    refetchInterval: HEARTBEAT_MS,
  });

  const phases = detail.data?.phases;
  const rollup = detail.data?.rollup;
  const completedPhases = phases?.filter((phase) => phase.status === "complete").length;
  const rollupUnavailable = detail.isError;

  return (
    <Link
      to={`/registrar/${entry.registrar_id}`}
      style={{ display: "block", textDecoration: "none", color: "inherit" }}
    >
      <div
        data-testid="registrar-row"
        className="registrar-row"
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
            <span style={{ fontSize: 13 }}>{entry.title}</span>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--color-text-tertiary)" }}>
              {entry.slug}
            </span>
          </div>
          <div
            className="mono"
            style={{ fontSize: 10.5, color: "var(--color-text-tertiary)", marginTop: 3 }}
          >
            {entry.home_project} · updated {fmtTs(entry.updated_at)}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span
            data-testid="registrar-status"
            className={`badge badge-${ENTRY_STATUS_VARIANT[entry.status] ?? "muted"}`}
          >
            {entry.status}
          </span>
          <span data-testid="registrar-phase-progress" className="chip">
            {phases ? `${completedPhases}/${phases.length} phases` : "… phases"}
          </span>
          {rollupUnavailable ? (
            <span
              data-testid="registrar-rollup-unavailable"
              className="badge badge-muted"
              title="Open blocker/follow-up counts unavailable"
              aria-label="Open blocker and follow-up counts unavailable"
            >
              —
            </span>
          ) : (
            rollup && (
              <>
                <span
                  data-testid="registrar-open-blockers"
                  className={`badge ${rollup.open_blockers > 0 ? "badge-err" : "badge-muted"}`}
                >
                  {rollup.open_blockers} blockers
                </span>
                <span
                  data-testid="registrar-open-follow-ups"
                  className={`badge ${rollup.open_follow_ups > 0 ? "badge-warn" : "badge-muted"}`}
                >
                  {rollup.open_follow_ups} follow-ups
                </span>
              </>
            )
          )}
        </div>
      </div>
    </Link>
  );
}
