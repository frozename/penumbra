import { describe, expect, it } from 'bun:test';
import {
  AgentPerformanceCaptureFromReconcilerSchema,
  AgentRankInputSchema,
  AgentTaskTypeSchema,
  mapMergeStatusToAgentOutcome,
  inferAgentTaskType,
} from '../../src/schemas/agent-performance.js';

describe('agent performance schemas', () => {
  it('accepts the documented task types', () => {
    expect(AgentTaskTypeSchema.safeParse('implement_substantial').success).toBe(true);
    expect(AgentTaskTypeSchema.safeParse('review_adversarial').success).toBe(true);
    expect(AgentTaskTypeSchema.safeParse('bogus').success).toBe(false);
  });

  it('validates reconciler capture input', () => {
    const parsed = AgentPerformanceCaptureFromReconcilerSchema.parse({
      handoff_id: 'h1',
      result: { status: 'pr_opened', pr_url: 'https://example.test/pull/1' },
    });
    expect(parsed.handoff_id).toBe('h1');
    expect(parsed.result.status).toBe('pr_opened');
  });

  it('maps pr_opened separately from merged', () => {
    expect(mapMergeStatusToAgentOutcome('pr_opened')).toBe('pr_opened');
    expect(mapMergeStatusToAgentOutcome('merged')).toBe('merged');
    expect(mapMergeStatusToAgentOutcome('rebase_conflict')).toBe('failed');
  });

  it('infers task type conservatively', () => {
    expect(inferAgentTaskType('Task type: implement_substantial\nDo work')).toBe('implement_substantial');
    expect(inferAgentTaskType('Review-only task: inspect this branch')).toBe('review_adversarial');
    expect(inferAgentTaskType('Use this Implementation Plan to execute')).toBe('implement_substantial');
    expect(inferAgentTaskType('hello', 'no_changes')).toBe('unknown');
  });

  it('defaults rank input window fields', () => {
    const parsed = AgentRankInputSchema.parse({ task_type: 'implement_substantial' });
    expect(parsed.min_samples).toBe(1);
    expect(parsed.include_neutral).toBe(false);
  });
});
