import { describe, expect, test } from 'bun:test';
import {
  BoundsAxis,
  BoundsInputSchema,
  MaestroSessionRecord,
  MaestroTerminationReason,
  TaskKindSchema,
} from '../../src/index.js';
import { FileTaskInputSchema } from '../../src/tasks/schema.js';

describe('maestro schemas', () => {
  test('TaskKindSchema accepts orchestrate', () => {
    expect(() => TaskKindSchema.parse('orchestrate')).not.toThrow();
  });

  test('BoundsInputSchema round-trips', () => {
    const parsed = BoundsInputSchema.parse({
      wall_clock_ms: 1200,
      cost_cents: 42,
      max_sub_dispatches: 3,
    });
    expect(parsed).toEqual({
      wall_clock_ms: 1200,
      cost_cents: 42,
      max_sub_dispatches: 3,
    });
  });

  test('FileTaskInputSchema rejects negative bounds cost for orchestrate', () => {
    expect(() => FileTaskInputSchema.parse({
      prompt: 'coordinate the run',
      created_by_kind: 'workflow',
      created_by_id: 'workflow-1',
      kind: 'orchestrate',
      bounds: { cost_cents: -1 },
    })).toThrow();
  });

  test('MaestroTerminationReason rejects unknown values', () => {
    expect(() => MaestroTerminationReason.parse('timeout')).toThrow();
  });

  test('MaestroTerminationReason accepts pressure capped over threshold', () => {
    expect(MaestroTerminationReason.parse('pressure_capped:over_threshold')).toBe('pressure_capped:over_threshold');
  });

  test('MaestroTerminationReason accepts pressure capped stale warm', () => {
    expect(MaestroTerminationReason.parse('pressure_capped:stale_warm')).toBe('pressure_capped:stale_warm');
  });

  test('MaestroSessionRecord round-trips nullable fields', () => {
    const record = {
      task_id: 'task-1',
      chain_handoff_id: 'handoff-1',
      agent_id: 'agent-1',
      started_at: 1,
      wall_clock_budget_ms: 1000,
      cost_budget_cents: 25,
      sub_dispatch_budget: 2,
      cost_consumed_cents: 5,
      sub_dispatches_consumed: 1,
      soft_warned_at: 2,
      terminated_at: 3,
      termination_reason: 'completed',
    } as const;
    expect(MaestroSessionRecord.parse(record)).toEqual(record);
    expect(MaestroSessionRecord.parse({
      ...record,
      soft_warned_at: null,
      terminated_at: null,
      termination_reason: null,
    })).toEqual({
      ...record,
      soft_warned_at: null,
      terminated_at: null,
      termination_reason: null,
    });
  });

  test('BoundsAxis round-trips', () => {
    for (const axis of ['wall_clock', 'cost', 'sub_dispatches'] as const) {
      expect(() => BoundsAxis.parse(axis)).not.toThrow();
    }
  });

  test('BoundsAxis accepts subscription pressure', () => {
    expect(BoundsAxis.parse('subscription_pressure')).toBe('subscription_pressure');
  });

  test('existing values still parse', () => {
    expect(MaestroTerminationReason.parse('completed')).toBe('completed');
    expect(MaestroTerminationReason.parse('bounds_exceeded:wall_clock')).toBe('bounds_exceeded:wall_clock');
    expect(BoundsAxis.parse('wall_clock')).toBe('wall_clock');
  });
});
