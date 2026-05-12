export interface PerformanceForRetry {
  outcome?: string;
  notes?: string | null;
  reliability_status?: string | null;
}

export interface SilentRetryPayloadInput {
  failed_handoff_id: string;
  failed_to_agent: string;
  conversation_id: string;
  project_id: string | null;
  task_type: string | undefined;
  message: string;
  next_agent: string;
}

export interface SilentRetryPayload {
  initial_agent: string;
  message: string;
  conversation_id: string;
  project_id: string | null;
  task_type: string | undefined;
  use_worktree: true;
  trust_mode: 'all';
}

export const SILENT_RETRY_PREFIX = '[silent-failure-retry]';

export function shouldRetryForSilentFailure(perf: PerformanceForRetry | null | undefined): boolean {
  if (!perf) return false;
  const notes = typeof perf.notes === 'string' ? perf.notes : '';
  if (perf.outcome === 'failed' && notes.includes('silent_failure')) {
    return true;
  }
  if (perf.reliability_status === 'no_worktree_activity') {
    return true;
  }
  if (perf.reliability_status === 'tool_failure_with_end_turn') {
    return true;
  }
  if (perf.reliability_status === 'non_terminal_stale' && notes.includes('recommended_action=cancel')) {
    return true;
  }
  return false;
}

export function buildSilentRetryPayload(input: SilentRetryPayloadInput): SilentRetryPayload {
  return {
    initial_agent: input.next_agent,
    message: `${SILENT_RETRY_PREFIX} retry_of=${input.failed_handoff_id} prior_agent=${input.failed_to_agent}\n\n${input.message}`,
    conversation_id: input.conversation_id,
    project_id: input.project_id,
    task_type: input.task_type,
    use_worktree: true,
    trust_mode: 'all',
  };
}
