import type { SessionEvent } from "@penumbra/api-contract";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { DaemonClient, type SessionEventParseResult } from "@src/api/client";
import { fmtTs } from "@src/lib/format";
import { sessionEvents } from "@src/lib/query-keys";
import { HEARTBEAT_MS } from "@src/lib/timing";
import { useDaemonStore } from "@src/stores/daemon-store";
import { Badge } from "@src/ui/Badge";
import { Card, CardHead } from "@src/ui/Card";

export interface SessionTimelineProps {
  client?: DaemonClient;
  limit?: number;
  staleAfterHours?: number;
  now?: () => number;
}

function makeDefaultClient(): DaemonClient {
  return new DaemonClient({ getConfig: () => useDaemonStore.getState() });
}

export function SessionTimeline(props: SessionTimelineProps = {}): JSX.Element {
  const client = useMemo(() => props.client ?? makeDefaultClient(), [props.client]);
  const limit = props.limit ?? 200;
  const staleAfterHours = props.staleAfterHours ?? 6;
  const now = props.now ?? Date.now;
  const query = useQuery({
    queryKey: sessionEvents(),
    queryFn: () => client.listSessionEvents({ limit }),
    refetchInterval: HEARTBEAT_MS,
  });
  const items = useMemo(() => sortTimelineItems(query.data?.events ?? []), [query.data?.events]);
  const staleSkeleton = findStaleSkeleton(items, now(), staleAfterHours);
  const error = query.isError ? errorMessage(query.error) : null;

  return (
    <Card>
      {error ? (
        <div
          className="t-tertiary mono"
          data-testid="sessions-timeline-error"
          style={{ padding: 12, color: "var(--color-err)" }}
        >
          Failed to load session events: {error}
        </div>
      ) : (
        <>
          <CardHead title="Session events" id={`${items.length} events`} />
          <div className="session-events">
            {items.length === 0 && (
              <div className="t-tertiary mono" data-testid="sessions-empty" style={{ padding: 12 }}>
                No session events yet.
              </div>
            )}
            {items.map((item, index) =>
              item.ok ? (
                <SessionEventRow
                  event={item.event}
                  isStaleSkeleton={item.event === staleSkeleton}
                  key={eventKey(item.event, index)}
                />
              ) : (
                <MalformedEventRow item={item} key={`malformed-${String(index)}`} />
              ),
            )}
          </div>
        </>
      )}
    </Card>
  );
}

function SessionEventRow({
  event,
  isStaleSkeleton,
}: {
  event: SessionEvent;
  isStaleSkeleton: boolean;
}): JSX.Element {
  const family = event.kind.split(".")[0] === "continuity" ? "continuity" : "session";
  const badgeVariant = family === "continuity" ? "brand" : "muted";

  return (
    <div
      className="session-event-row"
      data-testid="session-event-row"
      data-kind={event.kind}
      data-family={family}
      style={rowStyle}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Badge variant={badgeVariant}>{event.kind}</Badge>
          {event.kind === "continuity.note_superseded" && (
            <span data-testid="session-event-superseded-badge">
              <Badge variant="warn">superseded</Badge>
            </span>
          )}
          {isStaleSkeleton && (
            <span data-testid="session-event-stale-badge">
              <Badge variant="err">stale</Badge>
            </span>
          )}
        </div>
        <div
          className="mono"
          style={{ fontSize: 10.5, color: "var(--color-text-tertiary)", marginTop: 6 }}
        >
          {fmtTs(Date.parse(event.ts))} · {shortId(event.session_id)}
          {event.related_session_id ? ` ↔ ${shortId(event.related_session_id)}` : ""}
          {event.ref_path ? ` · ${basename(event.ref_path)}` : ""}
        </div>
      </div>
    </div>
  );
}

function MalformedEventRow({ item }: { item: Extract<SessionEventParseResult, { ok: false }> }) {
  return (
    <div
      className="session-event-row"
      data-testid="session-event-malformed"
      style={{ ...rowStyle, color: "var(--color-text-secondary)" }}
    >
      <div className="mono" style={{ fontSize: 11, minWidth: 0 }}>
        Malformed session event: {item.reason}
        <div
          style={{
            marginTop: 6,
            color: "var(--color-text-tertiary)",
            overflowWrap: "anywhere",
          }}
        >
          {stringifyRaw(item.raw)}
        </div>
      </div>
    </div>
  );
}

const rowStyle = {
  padding: "12px 14px",
  borderTop: "1px solid var(--color-border-subtle)",
} satisfies React.CSSProperties;

function sortTimelineItems(items: SessionEventParseResult[]): SessionEventParseResult[] {
  // The daemon is chronological; the console timeline intentionally presents newest-first.
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const tsDelta = itemTs(b.item) - itemTs(a.item);
      if (tsDelta !== 0) return tsDelta;

      const idDelta = itemId(b.item) - itemId(a.item);
      if (idDelta !== 0) return idDelta;

      return a.index - b.index;
    })
    .map(({ item }) => item);
}

function itemTs(item: SessionEventParseResult): number {
  if (item.ok) return Date.parse(item.event.ts);
  if (isRecord(item.raw) && typeof item.raw.ts === "string") return Date.parse(item.raw.ts);
  return 0;
}

function itemId(item: SessionEventParseResult): number {
  if (item.ok) {
    return typeof item.event.id === "number" && Number.isFinite(item.event.id)
      ? item.event.id
      : -Infinity;
  }
  if (isRecord(item.raw) && typeof item.raw.id === "number" && Number.isFinite(item.raw.id)) {
    return item.raw.id;
  }
  return -Infinity;
}

function findStaleSkeleton(
  items: SessionEventParseResult[],
  nowMs: number,
  staleAfterHours: number,
): SessionEvent | null {
  const events = items.filter((item): item is { ok: true; event: SessionEvent } => item.ok);
  const skeleton = events
    .filter((item) => item.event.kind === "continuity.skeleton_generated")
    .sort((a, b) => Date.parse(b.event.ts) - Date.parse(a.event.ts))[0]?.event;
  if (!skeleton) return null;

  const skeletonMs = Date.parse(skeleton.ts);
  const hasLaterBoot = events.some(
    (item) =>
      item.event.kind === "continuity.boot_pickup" && Date.parse(item.event.ts) > skeletonMs,
  );
  const staleMs = staleAfterHours * 3_600_000;
  return !hasLaterBoot && nowMs - skeletonMs > staleMs ? skeleton : null;
}

function eventKey(event: SessionEvent, index: number): string {
  return event.id !== undefined
    ? `event-${String(event.id)}`
    : `${event.kind}-${event.ts}-${index}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function shortId(value: string | null): string {
  return value ? value.slice(0, 8) : "—";
}

function stringifyRaw(raw: unknown): string {
  try {
    return JSON.stringify(raw).slice(0, 200);
  } catch {
    return String(raw).slice(0, 200);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
