import { describe, expect, test } from 'bun:test';
import {
  buildSilentRetryPayload,
  SILENT_RETRY_PREFIX,
  shouldRetryForSilentFailure,
  shouldRetryHandoffForSilentFailure,
} from '../../src/worker/silent-failure-retry.js';

describe('shouldRetryForSilentFailure', () => {
  test('null/undefined perf does not trigger retry', () => {
    expect(shouldRetryForSilentFailure(null)).toBe(false);
    expect(shouldRetryForSilentFailure(undefined)).toBe(false);
  });

  test('original case: outcome=failed + notes include silent_failure → retry', () => {
    expect(
      shouldRetryForSilentFailure({
        outcome: 'failed',
        notes: 'silent_failure: no worktree changes',
      }),
    ).toBe(true);
  });

  test('outcome=failed without silent_failure note does not trigger', () => {
    expect(
      shouldRetryForSilentFailure({
        outcome: 'failed',
        notes: 'agent crashed',
      }),
    ).toBe(false);
  });

  test('reliability_status=no_worktree_activity triggers retry even when outcome=success', () => {
    expect(
      shouldRetryForSilentFailure({
        outcome: 'success',
        reliability_status: 'no_worktree_activity',
        notes: 'completed',
      }),
    ).toBe(true);
  });

  test('reliability_status=tool_failure_with_end_turn triggers retry even when outcome=success', () => {
    expect(
      shouldRetryForSilentFailure({
        outcome: 'success',
        reliability_status: 'tool_failure_with_end_turn',
        notes: 'tool call failed during dispatch (1); end_turn reached without recovery',
      }),
    ).toBe(true);
  });

  test('reliability_status=non_terminal_stale + recommended_action=cancel hint triggers retry', () => {
    expect(
      shouldRetryForSilentFailure({
        outcome: 'success',
        reliability_status: 'non_terminal_stale',
        notes: 'expired (recommended_action=cancel)',
      }),
    ).toBe(true);
  });

  test('reliability_status=non_terminal_stale without cancel hint does NOT trigger retry', () => {
    expect(
      shouldRetryForSilentFailure({
        outcome: 'success',
        reliability_status: 'non_terminal_stale',
        notes: 'expired',
      }),
    ).toBe(false);
  });

  test('healthy success does not trigger retry', () => {
    expect(
      shouldRetryForSilentFailure({
        outcome: 'success',
        reliability_status: 'complete',
        notes: 'completed',
      }),
    ).toBe(false);
  });

  test('null notes safe for non_terminal_stale path', () => {
    expect(
      shouldRetryForSilentFailure({
        outcome: 'success',
        reliability_status: 'non_terminal_stale',
        notes: null,
      }),
    ).toBe(false);
  });
});

describe('shouldRetryHandoffForSilentFailure', () => {
  const perfThatRetries = {
    outcome: 'success',
    reliability_status: 'non_terminal_stale',
    notes: 'expired (recommended_action=cancel)',
  } as const;

  const perfThatDoesNotRetry = {
    outcome: 'success',
    reliability_status: 'non_terminal_stale',
    notes: 'expired',
  } as const;

  test.each([
    ['null dispatch_kind', null],
    ['undefined dispatch_kind', undefined],
  ])('%s delegates to shouldRetryForSilentFailure', (_, dispatch_kind) => {
    expect(shouldRetryHandoffForSilentFailure({ dispatch_kind }, perfThatRetries)).toBe(true);
  });

  test('returns false for long_lived_tick even when underlying policy would retry', () => {
    expect(shouldRetryHandoffForSilentFailure({ dispatch_kind: 'long_lived_tick' }, perfThatRetries)).toBe(false);
  });

  test('returns false for long_lived_tick when underlying policy would not retry', () => {
    expect(shouldRetryHandoffForSilentFailure({ dispatch_kind: 'long_lived_tick' }, perfThatDoesNotRetry)).toBe(false);
  });
});

describe('buildSilentRetryPayload', () => {
  const base = {
    failed_handoff_id: 'h-failed',
    failed_to_agent: 'codex-acp-deep',
    conversation_id: 'conv-1',
    project_id: 'penumbra',
    task_type: 'implement_small',
    message: 'do the work',
    next_agent: 'codex-acp-fast',
  };

  test('use_worktree is always true', () => {
    expect(buildSilentRetryPayload(base).use_worktree).toBe(true);
  });

  test('message is prefixed with retry marker and parent fields', () => {
    const p = buildSilentRetryPayload(base);
    expect(p.message.startsWith(`${SILENT_RETRY_PREFIX} retry_of=h-failed prior_agent=codex-acp-deep`)).toBe(true);
    expect(p.message.endsWith('do the work')).toBe(true);
  });

  test('trust_mode is all', () => {
    expect(buildSilentRetryPayload(base).trust_mode).toBe('all');
  });

  test('forwards conversation_id, project_id, task_type, next_agent unchanged', () => {
    const p = buildSilentRetryPayload(base);
    expect(p.conversation_id).toBe('conv-1');
    expect(p.project_id).toBe('penumbra');
    expect(p.task_type).toBe('implement_small');
    expect(p.initial_agent).toBe('codex-acp-fast');
  });
});
