import type { DispatchReliabilityReport } from "@penumbra/api-contract";

export interface ReliabilityChipProps {
  report: DispatchReliabilityReport;
}

export function ReliabilityChip({ report }: ReliabilityChipProps): JSX.Element {
  return (
    <span
      data-testid="reliability-chip"
      data-status={report.status}
      data-action={report.recommended_action}
      className="badge badge-muted"
    >
      {report.status} · {report.recommended_action}
    </span>
  );
}
