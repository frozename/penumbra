import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: string;
  body?: ReactNode;
  testId?: string;
}

export function EmptyState({ title, body, testId }: EmptyStateProps): JSX.Element {
  return (
    <div
      data-testid={testId ?? "empty-state"}
      className="empty-state t-tertiary"
      style={{ padding: 24, textAlign: "center" }}
    >
      <div style={{ fontSize: 13 }}>{title}</div>
      {body !== undefined && (
        <div className="mono" style={{ fontSize: 11, marginTop: 6 }}>
          {body}
        </div>
      )}
    </div>
  );
}
