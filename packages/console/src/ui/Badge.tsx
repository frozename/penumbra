import type React from "react";

export type BadgeVariant = "ok" | "warn" | "err" | "info" | "brand" | "muted";

export interface BadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
}

export function Badge({ variant = "info", children }: BadgeProps): JSX.Element {
  return <span className={`badge badge-${variant}`}>{children}</span>;
}
