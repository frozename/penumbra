const DIM_OPEN = '\x1b[2m';
const DIM_CLOSE = '\x1b[0m';

export function dimColor(text: string): string {
  if (process.env.NO_COLOR === '1') return text;
  return `${DIM_OPEN}${text}${DIM_CLOSE}`;
}

export function truncateId(id: string, length: number): string {
  if (id.length <= length) return id;
  return `${id.slice(0, length)}…`;
}

export function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return s > 0 ? `${m}m${s.toString().padStart(2, '0')}s` : `${m}m`;
  }
  if (ms < 86_400_000) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(ms / 86_400_000);
  const h = Math.round((ms % 86_400_000) / 3_600_000);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

const GLYPH_MAP: Record<string, string> = {
  dispatched: '◌',
  pending: '◐',
  completed: '●',
  approved: '●',
  failed: '◑',
  rejected: '◑',
  cancelled: '◑',
  expired: '◑',
  timeout: '◑',
};

export function glyphFor(status: string): string {
  return GLYPH_MAP[status] ?? '●';
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
}
export function formatChainStart(r: ChainStartResult): string {
  const id = dimColor(`h-${truncateId(r.handoff_id.replace(/-/g, ''), 7)}`);
  const agent = r.agent ?? 'unknown-agent';
  const trust = r.trust_mode ?? 'all';
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
  const id = dimColor(`h-${truncateId(r.handoff_id.replace(/-/g, ''), 7)}`);
  const worker = r.worker_id ? dimColor(r.worker_id) : 'unassigned';
  const elapsed = r.started_at
    ? formatElapsed(Date.now() - new Date(r.started_at).getTime())
    : '0s';
  const errSuffix = r.error_summary ? `  err=${r.error_summary.slice(0, 30)}` : '';
  return `${glyphFor(r.status)} chain_status  ${id}  ${r.status} on ${worker}  ${elapsed}${errSuffix}`;
}

export interface ChainWaitResult {
  status: string;
  last_handoff_id: string;
}
// elapsedMsHint optional — caller can pass a measured elapsed; else 0
export function formatChainWait(r: ChainWaitResult, elapsedMsHint: number = 0): string {
  const id = dimColor(`h-${truncateId(r.last_handoff_id.replace(/-/g, ''), 7)}`);
  const elapsed = formatElapsed(elapsedMsHint);
  return `${glyphFor(r.status)} chain_wait  ${id}  ${r.status} in ${elapsed}`;
}

export interface ChainGetResponseResult {
  responses: Array<{ ts: string; agent: string; text: string }>;
}
export function formatChainGetResponse(r: ChainGetResponseResult): string {
  const n = r.responses.length;
  const agent = n > 0 ? r.responses[n - 1]!.agent : 'no-agent';
  const noun = n === 1 ? 'response' : 'responses';
  return `● chain_get_response  ${agent}  ${n} ${noun}`;
}

export interface HandoffGetResult {
  handoff: {
    handoff_id: string;
    agent_name: string;
    status: string;
  };
}
export function formatHandoffGet(r: HandoffGetResult): string {
  const h = r.handoff;
  const id = dimColor(`h-${truncateId(h.handoff_id.replace(/-/g, ''), 7)}`);
  return `${glyphFor(h.status)} handoff  ${id}  ${h.agent_name}  ${h.status}`;
}

export interface HandoffListPendingResult {
  handoffs: Array<{ handoff_id: string; worker_id: string | null; status: string }>;
}
export function formatHandoffListPending(r: HandoffListPendingResult): string {
  const hs = r.handoffs;
  if (hs.length === 0) return '● handoff_list_pending  no pending';
  const byWorker = new Map<string, number>();
  for (const h of hs) {
    const w = h.worker_id ?? 'unassigned';
    byWorker.set(w, (byWorker.get(w) ?? 0) + 1);
  }
  const summary = Array.from(byWorker.entries()).map(([w, c]) => `${dimColor(w)}:${c}`).join(', ');
  return `◌ handoff_list_pending  ${hs.length} entries  ${summary}`;
}

export interface PermissionListPendingResult {
  permissions: Array<{ permission_id: string; requested_at: string }>;
}
export function formatPermissionListPending(r: PermissionListPendingResult): string {
  const ps = r.permissions;
  if (ps.length === 0) return '● permission_list_pending  no pending';
  const oldestAt = ps.reduce((min, p) => Math.min(min, new Date(p.requested_at).getTime()), Infinity);
  const oldestAge = formatElapsed(Date.now() - oldestAt);
  return `◐ permission_list_pending  ${ps.length} pending  oldest ${oldestAge}`;
}

export interface PermissionApproveResult {
  permission_id: string;
  status: string;
  decision: string;
  remember?: string;
}
export function formatPermissionApprove(r: PermissionApproveResult): string {
  const id = dimColor(truncateId(r.permission_id.replace(/-/g, ''), 6));
  const remember = r.remember ?? 'this_call';
  return `${glyphFor(r.status)} permission  ${id}  ${r.decision}  remember=${remember}`;
}
