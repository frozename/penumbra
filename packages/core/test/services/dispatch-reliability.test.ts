import { describe, expect, test } from 'bun:test';
import {
  classifyDispatchReliability,
  type DispatchReliabilityInput,
} from '../../src/services/dispatch-reliability';

function baseInput(overrides: Partial<DispatchReliabilityInput> = {}): DispatchReliabilityInput {
  return {
    handoff: {
      handoff_id: 'h-1',
      status: 'completed',
      ts: '2026-05-01T00:00:00.000Z',
      resolved_at: '2026-05-01T00:00:10.000Z',
      cancel_requested_at: null,
      chain_task_type: 'implement_small',
      use_worktree: 1,
    },
    events: [
      { kind: 'dispatch.start', ts: '2026-05-01T00:00:01.000Z' },
      { kind: 'proc.spawn', ts: '2026-05-01T00:00:02.000Z' },
      { kind: 'proc.exited.resolved', ts: '2026-05-01T00:00:08.000Z' },
      { kind: 'dispatch.end', ts: '2026-05-01T00:00:09.000Z', meta: { status: 'ok' } },
    ],
    responseCount: 1,
    finalResponseText: 'DONE',
    worktreeChanged: true,
    reconciled: true,
    adapterStreaming: true,
    now: new Date('2026-05-01T00:00:20.000Z'),
    staleAfterMs: 120_000,
    ...overrides,
  };
}

describe('classifyDispatchReliability', () => {
  test('returns complete for a terminal handoff with lifecycle and artifact evidence', () => {
    const report = classifyDispatchReliability(baseInput());
    expect(report.status).toBe('complete');
    expect(report.trustworthy).toBe(true);
    expect(report.recommended_action).toBe('accept');
    expect(report.missing_events).toEqual([]);
  });

  test('detects missing dispatch.start', () => {
    const report = classifyDispatchReliability(baseInput({
      events: [
        { kind: 'proc.spawn', ts: '2026-05-01T00:00:02.000Z' },
        { kind: 'dispatch.end', ts: '2026-05-01T00:00:09.000Z' },
      ],
    }));
    expect(report.status).toBe('missing_dispatch_start');
    expect(report.trustworthy).toBe(false);
    expect(report.missing_events).toEqual(['dispatch.start']);
  });

  test('detects missing adapter lifecycle', () => {
    const report = classifyDispatchReliability(baseInput({
      events: [
        { kind: 'dispatch.start', ts: '2026-05-01T00:00:01.000Z' },
        { kind: 'dispatch.end', ts: '2026-05-01T00:00:09.000Z' },
      ],
    }));
    expect(report.status).toBe('missing_adapter_lifecycle');
    expect(report.missing_events).toContain('adapter.lifecycle');
  });

  test('detects missing dispatch.end', () => {
    const report = classifyDispatchReliability(baseInput({
      events: [
        { kind: 'dispatch.start', ts: '2026-05-01T00:00:01.000Z' },
        { kind: 'proc.spawn', ts: '2026-05-01T00:00:02.000Z' },
        { kind: 'proc.exited.resolved', ts: '2026-05-01T00:00:08.000Z' },
      ],
    }));
    expect(report.status).toBe('missing_dispatch_end');
    expect(report.missing_events).toEqual(['dispatch.end']);
  });

  test('detects stale non-terminal handoff', () => {
    const report = classifyDispatchReliability(baseInput({
      handoff: {
        handoff_id: 'h-1',
        status: 'dispatched',
        ts: '2026-05-01T00:00:00.000Z',
        resolved_at: null,
        cancel_requested_at: null,
        chain_task_type: 'implement_small',
        use_worktree: 1,
      },
      events: [{ kind: 'dispatch.start', ts: '2026-05-01T00:00:01.000Z' }],
      now: new Date('2026-05-01T00:05:00.000Z'),
    }));
    expect(report.status).toBe('non_terminal_stale');
    expect(report.recommended_action).toBe('inspect_worktree');
  });

  test('detects cancel-requested handoff that completed', () => {
    const report = classifyDispatchReliability(baseInput({
      handoff: {
        handoff_id: 'h-1',
        status: 'completed',
        ts: '2026-05-01T00:00:00.000Z',
        resolved_at: '2026-05-01T00:00:10.000Z',
        cancel_requested_at: '2026-05-01T00:00:05.000Z',
        chain_task_type: 'implement_small',
        use_worktree: 1,
      },
    }));
    expect(report.status).toBe('cancel_completed');
    expect(report.trustworthy).toBe(false);
  });

  test('detects watchdog-only failure', () => {
    const report = classifyDispatchReliability(baseInput({
      handoff: {
        handoff_id: 'h-1',
        status: 'failed',
        ts: '2026-05-01T00:00:00.000Z',
        resolved_at: '2026-05-01T00:01:00.000Z',
        cancel_requested_at: null,
        chain_task_type: 'implement_small',
        use_worktree: 1,
      },
      events: [
        { kind: 'dispatch.start', ts: '2026-05-01T00:00:01.000Z' },
        { kind: 'proc.spawn', ts: '2026-05-01T00:00:02.000Z' },
        { kind: 'watchdog.auto_fail', ts: '2026-05-01T00:01:00.000Z' },
      ],
    }));
    expect(report.status).toBe('watchdog_only');
    expect(report.recommended_action).toBe('retry');
  });

  test('detects empty agent output', () => {
    const report = classifyDispatchReliability(baseInput({
      responseCount: 0,
      finalResponseText: '',
    }));
    expect(report.status).toBe('no_agent_output');
    expect(report.recommended_action).toBe('retry');
  });

  test('detects implementation completion without artifact evidence', () => {
    const report = classifyDispatchReliability(baseInput({
      worktreeChanged: false,
      reconciled: false,
    }));
    expect(report.status).toBe('no_worktree_activity');
    expect(report.recommended_action).toBe('review_manually');
  });

  test('detects changed worktree with missing reconciliation', () => {
    const report = classifyDispatchReliability(baseInput({
      worktreeChanged: true,
      reconciled: false,
    }));
    expect(report.status).toBe('reconcile_missing');
  });

  test('detects tool failure with end_turn and worktree changed (silent commit pattern)', () => {
    const report = classifyDispatchReliability(baseInput({
      events: [
        { kind: 'dispatch.start', ts: '2026-05-01T00:00:01.000Z' },
        { kind: 'proc.spawn', ts: '2026-05-01T00:00:02.000Z' },
        { kind: 'agent.tool_call.failed', ts: '2026-05-01T00:00:05.000Z' },
        { kind: 'acp.session.end', ts: '2026-05-01T00:00:08.000Z', meta: { stop_reason: 'end_turn' } },
        { kind: 'proc.exited.resolved', ts: '2026-05-01T00:00:08.500Z' },
        { kind: 'dispatch.end', ts: '2026-05-01T00:00:09.000Z', meta: { status: 'ok' } },
      ],
      worktreeChanged: true,
      reconciled: true,
    }));
    expect(report.status).toBe('tool_failure_with_end_turn');
    expect(report.trustworthy).toBe(false);
    expect(report.recommended_action).toBe('retry');
  });

  test('no tool failure with worktree changed still classifies as complete', () => {
    const report = classifyDispatchReliability(baseInput({
      worktreeChanged: true,
      reconciled: true,
    }));
    expect(report.status).toBe('complete');
    expect(report.trustworthy).toBe(true);
  });

  test('tool failure with worktree NOT changed yields no_worktree_activity (precedence)', () => {
    const report = classifyDispatchReliability(baseInput({
      events: [
        { kind: 'dispatch.start', ts: '2026-05-01T00:00:01.000Z' },
        { kind: 'proc.spawn', ts: '2026-05-01T00:00:02.000Z' },
        { kind: 'agent.tool_call.failed', ts: '2026-05-01T00:00:05.000Z' },
        { kind: 'acp.session.end', ts: '2026-05-01T00:00:08.000Z', meta: { stop_reason: 'end_turn' } },
        { kind: 'proc.exited.resolved', ts: '2026-05-01T00:00:08.500Z' },
        { kind: 'dispatch.end', ts: '2026-05-01T00:00:09.000Z' },
      ],
      worktreeChanged: false,
      reconciled: false,
    }));
    expect(report.status).toBe('no_worktree_activity');
  });
});
