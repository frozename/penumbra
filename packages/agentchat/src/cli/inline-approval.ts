export type ApprovalChoice =
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "redirect"; target: string }
  | { kind: "skip" };

const REDIRECT_RE = /^r(?:edirect)?\s+([A-Za-z0-9_-]+)$/;

export function parseApprovalKey(line: string): ApprovalChoice | null {
  const trimmed = line.trim();
  if (trimmed === "y" || trimmed === "yes") return { kind: "yes" };
  if (trimmed === "n" || trimmed === "no") return { kind: "no" };
  if (trimmed === "s" || trimmed === "skip") return { kind: "skip" };
  const m = REDIRECT_RE.exec(trimmed);
  const target = m?.[1];
  if (target !== undefined) return { kind: "redirect", target };
  return null;
}
