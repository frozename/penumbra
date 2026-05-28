export type ApprovalChoice =
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "redirect"; target: string }
  | { kind: "skip" };

export function parseApprovalKey(line: string): ApprovalChoice | null {
  const trimmed = line.trim();
  if (trimmed === "y" || trimmed === "yes") return { kind: "yes" };
  if (trimmed === "n" || trimmed === "no") return { kind: "no" };
  if (trimmed === "s" || trimmed === "skip") return { kind: "skip" };
  const m = trimmed.match(/^r(?:edirect)?\s+([A-Za-z0-9_-]+)$/);
  if (m) return { kind: "redirect", target: m[1]! };
  return null;
}
