export interface PerformanceForRetry {
  outcome?: string;
  notes?: string | null;
  reliability_status?: string | null;
}

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
