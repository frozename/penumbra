import type React from "react";

export type StatusValue =
  | "in-progress"
  | "claimed"
  | "completed"
  | "failed"
  | "rejected"
  | "filed"
  | "ok"
  | "concerns";

const STATUS_BADGE: Record<StatusValue, { cls: string; dot: string; label: string }> = {
  "in-progress": { cls: "badge-info", dot: "dot-brand dot-live", label: "in-progress" },
  claimed: { cls: "badge-info", dot: "dot-brand", label: "claimed" },
  completed: { cls: "badge-ok", dot: "dot-ok", label: "completed" },
  failed: { cls: "badge-err", dot: "dot-err", label: "failed" },
  rejected: { cls: "badge-err", dot: "dot-err", label: "rejected" },
  filed: { cls: "badge-warn", dot: "dot-warn", label: "filed" },
  ok: { cls: "badge-ok", dot: "dot-ok", label: "ok" },
  concerns: { cls: "badge-warn", dot: "dot-warn", label: "concerns" },
};

export interface StatusBadgeProps {
  status: StatusValue | string;
  monoLabel?: string;
}

export function StatusBadge({ status, monoLabel }: StatusBadgeProps): JSX.Element {
  const s =
    (STATUS_BADGE as Record<string, { cls: string; dot: string; label: string }>)[status] ??
    STATUS_BADGE.filed;

  return (
    <span className={`badge ${s.cls}`}>
      <span className={`dot ${s.dot}`} />
      {monoLabel || s.label}
    </span>
  );
}
