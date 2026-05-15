import { describe, expect, it } from 'bun:test';
import {
  AgentOutcomeSchema,
  AgentPerformanceRowSchema,
  AgentPerformanceCaptureFromReconcilerSchema,
  AgentRankInputSchema,
  AgentRankOutputSchema,
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

  it('supports legacy ledger outcome signals', () => {
    expect(AgentOutcomeSchema.parse('merged_with_concerns')).toBe('merged_with_concerns');
    expect(AgentOutcomeSchema.parse('bypassed')).toBe('bypassed');
  });

  it('accepts an operator enriched row', () => {
    const row = AgentPerformanceRowSchema.parse({
      performance_id: 'manual:abc123',
      ts: '2026-04-28T12:00:00.000Z',
      handoff_id: 'manual:2026-04-28:codex-mini:1',
      conversation_id: null,
      project_id: 'penumbra',
      agent_name: 'codex-mini',
      task_type: 'implement_substantial',
      outcome: 'merged_with_concerns',
      rounds: 1,
      smoke_pass: 'partial',
      reviewer_findings: 0,
      maestro_score: 5,
      cost_usd: 0.4,
      tokens_used: null,
      latency_ms: 13 * 60_000,
      source: 'manual_seed',
      notes: 'Imported legacy row.',
      metadata_json: JSON.stringify({ legacy_marker: '*' }),
    });
    expect(row.outcome).toBe('merged_with_concerns');
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
    expect(parsed.include_cost).toBe(false);
  });

  it('validates rank since as an ISO datetime', () => {
    expect(AgentRankInputSchema.safeParse({
      task_type: 'implement_substantial',
      since: '2026-05-15T00:00:00Z',
    }).success).toBe(true);
    expect(AgentRankInputSchema.safeParse({
      task_type: 'implement_substantial',
      since: 'garbage',
    }).success).toBe(false);
  });

  it('allows an open-ended rank window output', () => {
    const parsed = AgentRankOutputSchema.parse({
      task_type: 'implement_substantial',
      window: { from: null, to: '2026-05-01T12:00:00.000Z' },
      candidates: [],
    });
    expect(parsed.window.from).toBeNull();
  });
});
