export interface EventTypeChipProps {
  type: string;
}

const MAPPING: Record<string, { l: string; c: string }> = {
  "agent-prompt": { l: "→prompt", c: "var(--color-info)" },
  "agent-response": { l: "←resp", c: "var(--color-ok)" },
  "agent-tool-use": { l: "tool", c: "var(--color-brand)" },
  "agent-thought": { l: "thought", c: "var(--color-text-tertiary)" },
  "agent-handoff": { l: "→handoff", c: "var(--color-warn)" },
  "user-prompt": { l: "user", c: "var(--color-info)" },
  "usage-update": { l: "usage", c: "var(--color-text-tertiary)" },
  "rate-limit-snapshot": { l: "limit", c: "var(--color-warn)" },
  "subscription-pressure-cap-trip": { l: "cap-trip", c: "var(--color-err)" },
  "workflow.outcome": { l: "wflow", c: "var(--color-ok)" },
  orchestrate_filed: { l: "filed", c: "var(--color-warn)" },
  claim: { l: "claim", c: "var(--color-info)" },
  watchdog: { l: "watchdog", c: "var(--color-warn)" },
};

export function EventTypeChip({ type }: EventTypeChipProps): JSX.Element {
  const m = MAPPING[type] ?? { l: type, c: "var(--color-text-tertiary)" };
  return (
    <span
      className="mono"
      style={{
        fontSize: 10,
        padding: "2px 6px",
        borderRadius: 3,
        background: "var(--color-surface-2)",
        color: m.c,
        whiteSpace: "nowrap",
        letterSpacing: 0,
      }}
    >
      {m.l}
    </span>
  );
}
