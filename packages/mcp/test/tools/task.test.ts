import { describe, expect, test } from 'bun:test';
import {
  CancelTaskInputSchema,
  CompleteTaskInputSchema,
  FailTaskInputSchema,
  FileTaskInputSchema,
  HeartbeatTaskInputSchema,
  TaskKindSchema,
  TaskRecordSchema,
  TaskStatusSchema,
} from '@penumbra/core';
import { z } from 'zod';
import { taskFileHandler } from '../../src/tools/task-file.js';
import { taskListHandler } from '../../src/tools/task-list.js';
import { taskGetHandler } from '../../src/tools/task-get.js';
import { taskNextHandler } from '../../src/tools/task-next.js';
import { taskHeartbeatHandler } from '../../src/tools/task-heartbeat.js';
import { taskCompleteHandler } from '../../src/tools/task-complete.js';
import { taskFailHandler } from '../../src/tools/task-fail.js';
import { taskCancelHandler } from '../../src/tools/task-cancel.js';

function parseToolResult(out: unknown): unknown {
  return JSON.parse((out as { content: Array<{ text: string }> }).content[0]!.text);
}

function sampleTask(taskId: string) {
  return {
    id: taskId,
    created_at: 1_746_000_000_000,
    updated_at: 1_746_000_000_123,
    created_by_kind: 'human' as const,
    created_by_id: 'cli',
    parent_task_id: null,
    kind: 'work' as const,
    priority: 'normal' as const,
    prompt: 'implement task board MCP wiring',
    acceptance_criteria: 'green tests',
    expected_artifacts: [{ type: 'commit' as const, ref: 'abc123' }],
    eligibility: {
      required_tags: ['typescript'],
      min_tier: 'oc',
      max_cost_cents: 50,
      deny_agents: [],
      allow_agents: ['codex'],
      heartbeat_ttl_ms: 90_000,
      preference_window_ms: 30_000,
      max_attempts: 1,
    },
    review_eligibility: null,
    requires_review: false,
    status: 'pending' as const,
    result_summary: null,
    result_artifacts: null,
    failure_reason: null,
    chain_id: null,
    origin: 'mcp-test',
  };
}

describe('task.* handlers', () => {
  test('task.file forwards FileTaskInput and origin, returns {task_id}', async () => {
    const calls: unknown[] = [];
    const handler = taskFileHandler({
      taskFile: async (input: unknown, opts?: { origin?: string }) => {
        calls.push({ input, opts });
        return { task_id: 'task_1' };
      },
    } as any);

    const input = {
      prompt: 'wire mcp tool',
      acceptance_criteria: 'tool is callable',
      expected_artifacts: [{ type: 'commit' as const, ref: 'deadbeef' }],
      eligibility: { required_tags: ['typescript'] },
      review_eligibility: { min_tier: 'premium' },
      priority: 'high' as const,
      kind: 'work' as const,
      requires_review: true,
      parent_task_id: 'task_parent',
      origin: 'tool-body-origin',
      created_by_kind: 'agent' as const,
      created_by_id: 'codex',
    };

    const out = await handler(input, { _meta: { origin: 'mcp-origin' } } as any);

    expect(FileTaskInputSchema.parse((calls[0] as any).input)).toEqual(input);
    expect((calls[0] as any).opts).toEqual({ origin: 'mcp-origin' });
    const parsed = z.object({ task_id: z.string().min(1) }).parse(parseToolResult(out));
    expect(parsed.task_id).toBe('task_1');
  });

  test('task.list forwards filters and returns {tasks: TaskRecord[]}', async () => {
    const calls: unknown[] = [];
    const handler = taskListHandler({
      taskList: async (input: unknown) => {
        calls.push(input);
        return { tasks: [sampleTask('task_2')] };
      },
    } as any);

    const input = {
      status: 'pending' as z.infer<typeof TaskStatusSchema>,
      kind: 'work' as z.infer<typeof TaskKindSchema>,
      eligible_for: 'codex',
      parent_task_id: 'task_parent',
      origin: 'dispatch',
      limit: 5,
      offset: 2,
    };

    const out = await handler(input);

    expect(calls[0]).toEqual(input);
    const parsed = z.object({ tasks: z.array(TaskRecordSchema) }).parse(parseToolResult(out));
    expect(parsed.tasks).toHaveLength(1);
  });

  test('task.get forwards task_id/include and returns task payload', async () => {
    const calls: unknown[] = [];
    const handler = taskGetHandler({
      taskGet: async (taskId: string, include?: Array<'lease' | 'events' | 'descendants'>) => {
        calls.push({ taskId, include });
        return {
          ...sampleTask(taskId),
          lease: {
            id: 'lease_3',
            task_id: taskId,
            agent_id: 'codex',
            claimed_at: 1_746_000_000_111,
            expires_at: 1_746_000_090_111,
            released_at: null,
            release_reason: null,
            auction_score: 0.9,
          },
          events: [{
            id: 1,
            task_id: taskId,
            at: 1_746_000_000_100,
            kind: 'filed',
            actor: 'cli',
            payload: null,
          }],
          descendants: {
            count: 0,
            depth: 0,
            ids: [],
          },
        };
      },
    } as any);

    const out = await handler({ task_id: 'task_3', include: ['lease', 'events', 'descendants'] });

    expect(calls[0]).toEqual({ taskId: 'task_3', include: { include: ['lease', 'events', 'descendants'] } });
    const parsed = z.object({
      ...TaskRecordSchema.shape,
      lease: z.object({
        id: z.string(),
        task_id: z.string(),
        agent_id: z.string(),
        claimed_at: z.number().int(),
        expires_at: z.number().int(),
        released_at: z.number().int().nullable(),
        release_reason: z.string().nullable(),
        auction_score: z.number().nullable(),
      }).nullable().optional(),
      events: z.array(z.object({
        id: z.number().int(),
        task_id: z.string(),
        at: z.number().int(),
        kind: z.enum([
          'filed',
          'auctioned',
          'leased',
          'heartbeat',
          'completed',
          'cancelled',
          'released',
          'review_filed',
          'review_passed',
          'review_failed',
        ]),
        actor: z.string().nullable(),
        payload: z.unknown().nullable(),
      })).optional(),
      descendants: z.object({
        count: z.number().int(),
        depth: z.number().int(),
        ids: z.array(z.string()),
      }).optional(),
    }).strict().parse(parseToolResult(out));
    expect(parsed.id).toBe('task_3');
  });

  test('task.next forwards lease request and maps no-task to null', async () => {
    const calls: unknown[] = [];
    const handler = taskNextHandler({
      taskNext: async (input: unknown) => {
        calls.push(input);
        return null;
      },
    } as any);

    const input = {
      agent_id: 'codex',
      tags: ['typescript'],
      max_cost_cents: 42,
    };

    const out = await handler(input);

    expect(calls[0]).toEqual(input);
    expect(parseToolResult(out)).toBeNull();
  });

  test('task.heartbeat forwards body and returns {expires_at}', async () => {
    const calls: unknown[] = [];
    const handler = taskHeartbeatHandler({
      taskHeartbeat: async (taskId: string, body: unknown) => {
        calls.push({ taskId, body });
        return { expires_at: 1_746_000_090_000 };
      },
    } as any);

    const input = { task_id: 'task_5', lease_id: 'lease_5' };
    const out = await handler(input);

    expect(calls[0]).toEqual({ taskId: 'task_5', body: { lease_id: 'lease_5' } });
    expect(HeartbeatTaskInputSchema.parse({ task_id: 'task_5', ...(calls[0] as any).body })).toEqual(input);
    const parsed = z.object({ expires_at: z.number().int() }).parse(parseToolResult(out));
    expect(parsed.expires_at).toBe(1_746_000_090_000);
  });

  test('task.complete forwards CompleteTaskInput and returns {status}', async () => {
    const calls: unknown[] = [];
    const handler = taskCompleteHandler({
      taskComplete: async (taskId: string, body: unknown) => {
        calls.push({ taskId, body });
        return { status: 'done' };
      },
    } as any);

    const input = {
      task_id: 'task_6',
      lease_id: 'lease_6',
      result_summary: 'done',
      result_artifacts: [{ type: 'commit' as const, ref: 'cafebabe' }],
      chain_id: 'conv_6',
      review_verdict: { passed: true, notes: 'checked' },
    };
    const out = await handler(input);

    expect(calls[0]).toEqual({
      taskId: 'task_6',
      body: {
        lease_id: 'lease_6',
        result_summary: 'done',
        result_artifacts: [{ type: 'commit', ref: 'cafebabe' }],
        chain_id: 'conv_6',
        review_verdict: { passed: true, notes: 'checked' },
      },
    });
    expect(CompleteTaskInputSchema.parse({ task_id: 'task_6', ...(calls[0] as any).body })).toEqual(input);
    const parsed = z.object({ status: z.string().min(1) }).parse(parseToolResult(out));
    expect(parsed.status).toBe('done');
  });

  test('task.fail forwards FailTaskInput and returns {status}', async () => {
    const calls: unknown[] = [];
    const handler = taskFailHandler({
      taskFail: async (taskId: string, body: unknown) => {
        calls.push({ taskId, body });
        return { status: 'failed' };
      },
    } as any);

    const input = { task_id: 'task_7', lease_id: 'lease_7', reason: 'tool crashed' };
    const out = await handler(input);

    expect(calls[0]).toEqual({ taskId: 'task_7', body: { lease_id: 'lease_7', reason: 'tool crashed' } });
    expect(FailTaskInputSchema.parse({ task_id: 'task_7', ...(calls[0] as any).body })).toEqual(input);
    const parsed = z.object({ status: z.string().min(1) }).parse(parseToolResult(out));
    expect(parsed.status).toBe('failed');
  });

  test('task.cancel forwards CancelTaskInput and returns {status}', async () => {
    const calls: unknown[] = [];
    const handler = taskCancelHandler({
      taskCancel: async (taskId: string, body: unknown) => {
        calls.push({ taskId, body });
        return { status: 'cancelled' };
      },
    } as any);

    const input = { task_id: 'task_8', reason: 'obsolete' };
    const out = await handler(input);

    expect(calls[0]).toEqual({ taskId: 'task_8', body: { reason: 'obsolete' } });
    expect(CancelTaskInputSchema.parse({ task_id: 'task_8', ...(calls[0] as any).body })).toEqual(input);
    const parsed = z.object({ status: z.string().min(1) }).parse(parseToolResult(out));
    expect(parsed.status).toBe('cancelled');
  });
});
