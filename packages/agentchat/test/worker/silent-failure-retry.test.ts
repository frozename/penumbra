import { describe, expect, test } from 'bun:test';
import { shouldRetryForSilentFailure } from '../../src/worker/silent-failure-retry.js';

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
