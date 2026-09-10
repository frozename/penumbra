export interface ModuleSpec {
  /** Stable identifier — also the URL path segment. */
  readonly id: string;
  /** Route path under the shell, leading slash. */
  readonly path: string;
  /** Rail label shown on hover/expanded. */
  readonly label: string;
  /** Single-glyph icon shown in the rail. */
  readonly icon: string;
  /** When false, the module renders a "wired in P1" stub. */
  readonly available: boolean;
}

export const MODULES = [
  { id: "mission", path: "/mission", label: "Mission control", icon: "◐", available: true },
  { id: "approvals", path: "/approvals", label: "Approvals", icon: "✓", available: true },
  { id: "handoffs", path: "/handoffs", label: "Handoffs", icon: "⇄", available: true },
  { id: "registrar", path: "/registrar", label: "Plans", icon: "▤", available: true },
  { id: "sessions", path: "/sessions", label: "Sessions", icon: "◷", available: true },
  { id: "chains", path: "/chains", label: "Chains", icon: "≋", available: false },
  { id: "tasks", path: "/tasks", label: "Tasks", icon: "☷", available: false },
] as const satisfies readonly ModuleSpec[];

export type ModuleId = (typeof MODULES)[number]["id"];

export function getModule(id: ModuleId): ModuleSpec | undefined {
  return MODULES.find((m) => m.id === id);
}
