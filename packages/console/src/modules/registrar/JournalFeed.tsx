import type { RegistrarEvent, RegistrarEventKind } from "@penumbra/api-contract";
import { Badge, type BadgeVariant } from "../../ui/Badge";
import { fmtTs } from "../../lib/format";

const KIND_LABEL: Record<RegistrarEventKind, string> = {
  progress: "Progress",
  caveat: "Caveat",
  blocker: "Blocker",
  follow_up: "Follow-up",
  decision: "Decision",
  phase_transition: "Phase transition",
  link: "Link",
  entry_transition: "Entry transition",
};

const KIND_VARIANT: Record<RegistrarEventKind, BadgeVariant> = {
  progress: "info",
  caveat: "warn",
  blocker: "err",
  follow_up: "warn",
  decision: "brand",
  phase_transition: "info",
  link: "muted",
  entry_transition: "brand",
};

export interface JournalFeedProps {
  events: RegistrarEvent[];
}

export function JournalFeed({ events }: JournalFeedProps): JSX.Element {
  const ordered = [...events].sort(
    (a, b) => a.created_at - b.created_at || a.event_id - b.event_id,
  );

  return (
    <div className="journal-feed">
      {ordered.length === 0 && (
        <div className="t-tertiary mono" data-testid="journal-empty" style={{ padding: 12 }}>
          No journal events.
        </div>
      )}
      {ordered.map((event) => (
        <div
          key={event.event_id}
          data-testid="journal-event"
          data-event-id={event.event_id}
          className="journal-event"
          style={{
            padding: "10px 14px",
            borderTop: "1px solid var(--color-border-subtle)",
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: 10,
            alignItems: "start",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
            <Badge variant={KIND_VARIANT[event.kind] ?? "muted"}>
              <span data-testid="journal-kind">{KIND_LABEL[event.kind]}</span>
            </Badge>
            <span className="mono" style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>
              {fmtTs(event.created_at)}
            </span>
          </div>
          <div style={{ minWidth: 0 }}>
            <div
              className="mono"
              style={{ fontSize: 10.5, color: "var(--color-text-tertiary)", marginBottom: 2 }}
            >
              {event.actor}
              {event.phase_no !== null ? ` · phase ${event.phase_no}` : ""}
              {event.state !== null ? ` · ${event.state}` : ""}
            </div>
            <div style={{ fontSize: 12.5 }}>{event.body}</div>
            {event.kind === "link" && event.link_value !== null && (
              <div
                className="mono"
                style={{ fontSize: 10.5, color: "var(--color-text-tertiary)", marginTop: 2 }}
              >
                {event.link_kind}: {event.link_value}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
