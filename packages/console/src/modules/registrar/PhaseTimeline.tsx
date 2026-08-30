import type { RegistrarPhase, RegistrarPhaseStatus } from "@penumbra/api-contract";
import { Badge, type BadgeVariant } from "@src/ui/Badge";
import { fmtTs } from "@src/lib/format";

const PHASE_STATUS_VARIANT: Record<RegistrarPhaseStatus, BadgeVariant> = {
  pending: "muted",
  active: "brand",
  blocked: "err",
  complete: "ok",
  abandoned: "warn",
};

export interface PhaseTimelineProps {
  phases: RegistrarPhase[];
}

export function PhaseTimeline({ phases }: PhaseTimelineProps): JSX.Element {
  const ordered = [...phases].sort((a, b) => a.phase_no - b.phase_no);

  return (
    <div className="phase-timeline">
      {ordered.length === 0 && (
        <div className="t-tertiary mono" style={{ padding: 12 }}>
          No phases defined.
        </div>
      )}
      {ordered.map((phase) => (
        <div
          key={phase.phase_no}
          data-testid="phase-item"
          data-phase-no={phase.phase_no}
          className="phase-item"
          style={{
            padding: "10px 14px",
            borderTop: "1px solid var(--color-border-subtle)",
            display: "grid",
            gridTemplateColumns: "auto 1fr auto",
            gap: 12,
            alignItems: "center",
          }}
        >
          <span className="mono" style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>
            P{phase.phase_no}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5 }}>{phase.title}</div>
            <div
              className="mono"
              style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}
            >
              updated {fmtTs(phase.updated_at)}
            </div>
          </div>
          <Badge variant={PHASE_STATUS_VARIANT[phase.status] ?? "muted"}>{phase.status}</Badge>
        </div>
      ))}
    </div>
  );
}
