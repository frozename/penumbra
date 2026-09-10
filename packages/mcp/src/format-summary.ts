const DIM_OPEN = "\x1b[2m";
const DIM_CLOSE = "\x1b[0m";

export function dimColor(text: string): string {
  if (process.env.NO_COLOR === "1") return text;
  return `${DIM_OPEN}${text}${DIM_CLOSE}`;
}

export function truncateId(id: string, length: number): string {
  if (id.length <= length) return id;
  return `${id.slice(0, length)}…`;
}

export function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${String(Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return s > 0 ? `${String(m)}m${s.toString().padStart(2, "0")}s` : `${String(m)}m`;
  }
  if (ms < 86_400_000) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return m > 0 ? `${String(h)}h ${String(m)}m` : `${String(h)}h`;
  }
  const d = Math.floor(ms / 86_400_000);
  const h = Math.round((ms % 86_400_000) / 3_600_000);
  return h > 0 ? `${String(d)}d ${String(h)}h` : `${String(d)}d`;
}

const GLYPH_MAP: Record<string, string> = {
  dispatched: "◌",
  pending: "◐",
  completed: "●",
  approved: "●",
  failed: "◑",
  rejected: "◑",
  cancelled: "◑",
  expired: "◑",
  timeout: "◑",
};

export function glyphFor(status: string): string {
  return GLYPH_MAP[status] ?? "●";
}

// Wrap a tool's structured payload with a header for human readability.
// The maestro parses the JSON; the user reads the header.
export function wrapWithSummary(summary: string, payload: unknown): string {
  return `${summary}\n\n${JSON.stringify(payload, null, 2)}`;
}

// ----- Per-tool formatters -----

export interface ChainStartResult {
  conversation_id: string;
  handoff_id: string;
  agent?: string;
  trust_mode?: string;
  task_class?: string;
  lane_id?: string | null;
  recalled_memory_ids?: string[];
  recalled_memories?: {
    id: string;
    title: string;
    obs_type: string;
    snippet_head?: string;
  }[];
  routed_agent?: string;
  routed_role?: string | null;
  routing_task_type?: string | null;
  routing_warning?: {
    code: "prompt_project_mismatch";
    project_id: string;
    mentioned_paths: string[];
    missing_in_project: string[];
    suggested_project_id?: string;
    hint: string;
  };
  routing_advisory?: {
    code: "project_registry_unavailable" | "unknown_project_id_dropped";
    project_id?: string;
    known_project_ids?: string[];
  };
}
export function formatChainStart(r: ChainStartResult): string {
  const id = dimColor(`h-${truncateId(r.handoff_id.replaceAll("-", ""), 7)}`);
  const agent = r.agent ?? "unknown-agent";
  const trust = r.trust_mode ?? "all";
  return `◌ chain_start  ${agent}  ${id}  trust=${trust}`;
}

export interface ChainStatusResult {
  handoff_id: string;
  status: string;
  worker_id: string | null;
  started_at: string | null;
  resolved_at: string | null;
  error_summary: string | null;
}
export function formatChainStatus(r: ChainStatusResult): string {
  const id = dimColor(`h-${truncateId(r.handoff_id.replaceAll("-", ""), 7)}`);
  const worker = r.worker_id ? dimColor(r.worker_id) : "unassigned";
  const elapsed = r.started_at
    ? formatElapsed(Date.now() - new Date(r.started_at).getTime())
    : "0s";
  const errSuffix = r.error_summary ? `  err=${r.error_summary.slice(0, 30)}` : "";
  return `${glyphFor(r.status)} chain_status  ${id}  ${r.status} on ${worker}  ${elapsed}${errSuffix}`;
}

export interface ChainWaitResult {
  status: string;
  last_handoff_id: string;
}
// elapsedMsHint optional — caller can pass a measured elapsed; else 0
export function formatChainWait(r: ChainWaitResult, elapsedMsHint = 0): string {
  const id = dimColor(`h-${truncateId(r.last_handoff_id.replaceAll("-", ""), 7)}`);
  const elapsed = formatElapsed(elapsedMsHint);
  return `${glyphFor(r.status)} chain_wait  ${id}  ${r.status} in ${elapsed}`;
}

export interface ChainGetResponseResult {
  responses: { ts: string; agent: string; text: string; handoff_id?: string | null }[];
}
export function formatChainGetResponse(r: ChainGetResponseResult): string {
  const n = r.responses.length;
  const response = n > 0 ? r.responses[n - 1] : undefined;
  const agent = response?.agent ?? "no-agent";
  const id = response?.handoff_id
    ? `  ${dimColor(`h-${truncateId(response.handoff_id.replaceAll("-", ""), 7)}`)}`
    : "";
  const noun = n === 1 ? "response" : "responses";
  return `● chain_get_response  ${agent}${id}  ${String(n)} ${noun}`;
}

export interface HandoffGetResult {
  handoff: {
    handoff_id: string;
    to_agent: string;
    status: string;
  };
}
export function formatHandoffGet(r: HandoffGetResult): string {
  const h = r.handoff;
  const id = dimColor(`h-${truncateId(h.handoff_id.replaceAll("-", ""), 7)}`);
  return `${glyphFor(h.status)} handoff  ${id}  ${h.to_agent}  ${h.status}`;
}

export interface HandoffListPendingResult {
  handoffs: { handoff_id: string; worker_id: string | null; status: string }[];
}
export function formatHandoffListPending(r: HandoffListPendingResult): string {
  const hs = r.handoffs;
  if (hs.length === 0) return "● handoff_list_pending  no pending";
  const byWorker = new Map<string, number>();
  for (const h of hs) {
    const w = h.worker_id ?? "unassigned";
    byWorker.set(w, (byWorker.get(w) ?? 0) + 1);
  }
  const summary = Array.from(byWorker.entries())
    .map(([w, c]) => `${dimColor(w)}:${String(c)}`)
    .join(", ");
  return `◌ handoff_list_pending  ${String(hs.length)} entries  ${summary}`;
}

export interface PermissionListPendingResult {
  permissions: { permission_id: string; requested_at: string }[];
}
export function formatPermissionListPending(r: PermissionListPendingResult): string {
  const ps = r.permissions;
  if (ps.length === 0) return "● permission_list_pending  no pending";
  const oldestAt = ps.reduce(
    (min, p) => Math.min(min, new Date(p.requested_at).getTime()),
    Infinity,
  );
  const oldestAge = formatElapsed(Date.now() - oldestAt);
  return `◐ permission_list_pending  ${String(ps.length)} pending  oldest ${oldestAge}`;
}

export interface PermissionApproveResult {
  permission_id: string;
  status: string;
  decision: string;
  remember?: string;
}
export function formatPermissionApprove(r: PermissionApproveResult): string {
  const id = dimColor(truncateId(r.permission_id.replaceAll("-", ""), 6));
  const remember = r.remember ?? "this_call";
  return `${glyphFor(r.status)} permission  ${id}  ${r.decision}  remember=${remember}`;
}
