import type { RegistrarEvent } from "@penumbra/api-contract";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";

import { DaemonClient } from "@src/api/client";
import { DaemonHttpError } from "@src/api/errors";
import { fmtTs } from "@src/lib/format";
import { registrarDetail, registrarEvents } from "@src/lib/query-keys";
import { HEARTBEAT_MS } from "@src/lib/timing";
import { useDaemonStore } from "@src/stores/daemon-store";
import { Card, CardHead } from "@src/ui/Card";
import { EmptyState } from "@src/ui/EmptyState";

import { JournalComposer } from "./JournalComposer";
import { JournalFeed } from "./JournalFeed";
import { PhaseTimeline } from "./PhaseTimeline";

export interface RegistrarDetailProps {
  /** Override the daemon client. Defaults to a module-default backed by the daemon-store. */
  client?: DaemonClient;
}

function makeDefaultClient(): DaemonClient {
  return new DaemonClient({ getConfig: () => useDaemonStore.getState() });
}

function isRegistrarDisabled(err: unknown): boolean {
  return err instanceof DaemonHttpError && err.status === 404 && err.code === null;
}

interface JournalSectionProps {
  registrarId: string;
  client: DaemonClient;
  events: RegistrarEvent[];
  error: string | null;
}

function JournalSection({ registrarId, client, events, error }: JournalSectionProps): JSX.Element {
  return (
    <div style={{ marginTop: 16 }}>
      <Card>
        {error !== null ? (
          <div
            className="t-tertiary mono"
            data-testid="registrar-journal-error"
            style={{ padding: 12, color: "var(--color-err)" }}
          >
            Failed to load journal events: {error}
          </div>
        ) : (
          <>
            <CardHead title="Journal" id={`${events.length} events`} />
            <JournalComposer registrarId={registrarId} client={client} />
            <JournalFeed events={events} />
          </>
        )}
      </Card>
    </div>
  );
}

export function RegistrarDetail(props: RegistrarDetailProps = {}): JSX.Element {
  const { registrarId } = useParams<{ registrarId: string }>();
  const client = useMemo(() => props.client ?? makeDefaultClient(), [props.client]);

  const detail = useQuery({
    queryKey: registrarDetail(registrarId ?? ""),
    queryFn: () => client.getRegistrarEntry(registrarId ?? ""),
    refetchInterval: HEARTBEAT_MS,
    enabled: registrarId !== undefined,
  });
  const events = useQuery({
    queryKey: registrarEvents(registrarId ?? ""),
    queryFn: () => client.listRegistrarEvents(registrarId ?? ""),
    refetchInterval: HEARTBEAT_MS,
    enabled: registrarId !== undefined,
  });

  if (registrarId === undefined) {
    return <div className="surface-stub">No initiative selected.</div>;
  }

  if (isRegistrarDisabled(detail.error)) {
    return (
      <EmptyState
        testId="registrar-disabled"
        title="registrar disabled"
        body="The daemon is running with PENUMBRA_REGISTRAR=0."
      />
    );
  }

  if (detail.isError) {
    const message = detail.error instanceof Error ? detail.error.message : String(detail.error);
    return (
      <div className="t-tertiary mono" data-testid="registrar-detail-error" style={{ padding: 12 }}>
        Failed to load initiative: {message}
      </div>
    );
  }

  const data = detail.data;
  if (!data) {
    return (
      <div
        className="t-tertiary mono"
        data-testid="registrar-detail-loading"
        style={{ padding: 12 }}
      >
        Loading initiative…
      </div>
    );
  }

  const { entry, phases, rollup } = data;
  const journalEvents = events.data?.events ?? [];
  const journalError = events.isError
    ? events.error instanceof Error
      ? events.error.message
      : String(events.error)
    : null;

  return (
    <>
      <header className="surface-head">
        <div style={{ marginBottom: 6 }}>
          <Link
            to="/registrar"
            data-testid="registrar-back"
            className="mono"
            style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}
          >
            ← All plans
          </Link>
        </div>
        <h1>
          {entry.title} <em>· {entry.slug}</em>
        </h1>
        <p className="lede">
          <em className="brand">{entry.status}</em> · {entry.home_project} · updated{" "}
          {fmtTs(entry.updated_at)}
        </p>
        <div className="heads-row">
          <span className="chip">phases · {phases.length}</span>
          <span
            data-testid="detail-open-blockers"
            className={`badge ${rollup.open_blockers > 0 ? "badge-err" : "badge-muted"}`}
          >
            {rollup.open_blockers} blockers
          </span>
          <span
            data-testid="detail-open-follow-ups"
            className={`badge ${rollup.open_follow_ups > 0 ? "badge-warn" : "badge-muted"}`}
          >
            {rollup.open_follow_ups} follow-ups
          </span>
        </div>
      </header>
      <Card>
        <CardHead title="Phase timeline" id={`${phases.length} phases`} />
        <PhaseTimeline phases={phases} />
      </Card>
      <JournalSection
        registrarId={registrarId}
        client={client}
        events={journalEvents}
        error={journalError}
      />
    </>
  );
}
