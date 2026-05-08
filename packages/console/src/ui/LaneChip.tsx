export type Lane = "cloud" | "cli-subscription" | "local" | string;

export interface LaneChipProps {
  lane: Lane;
}

export function LaneChip({ lane }: LaneChipProps): JSX.Element {
  const color =
    lane === "cloud"
      ? "var(--color-info)"
      : lane === "cli-subscription"
        ? "var(--color-brand)"
        : lane === "local"
          ? "var(--color-ok)"
          : "var(--color-text-tertiary)";
  return (
    <span
      className="mono"
      style={{
        fontSize: 9.5,
        padding: "1px 5px",
        borderRadius: 3,
        border: `1px solid ${color}`,
        color,
        letterSpacing: 0.04,
      }}
    >
      {lane}
    </span>
  );
}
