import type { DispatchEvent } from "@penumbra/api-contract";

export interface DispatchTimelineProps {
  events: readonly DispatchEvent[];
}

export function DispatchTimeline({ events }: DispatchTimelineProps): JSX.Element {
  const sorted = [...events].sort((a, b) => {
    if (a.ts > b.ts) return -1;
    if (a.ts < b.ts) return 1;
    return 0;
  });

  return (
    <ol
      data-testid="dispatch-timeline"
      style={{ maxHeight: 480, overflow: "auto", paddingLeft: 28 }}
    >
      {sorted.map((event, i) => (
        <li key={`${event.ts}-${i}`} style={{ padding: "6px 0", overflowWrap: "anywhere" }}>
          <span className="mono t-tertiary" style={{ fontSize: 10 }}>
            {event.ts}
          </span>{" "}
          <span className="mono" style={{ fontSize: 11 }}>
            {event.kind}
          </span>
          {event.worker_id && (
            <span className="mono t-tertiary" style={{ fontSize: 10 }}>
              {" "}
              · {event.worker_id}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
