import { expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { RecallBundle, WorkflowCtx } from '@penumbra/workflows';
import { parse as parseYaml } from 'yaml';
import spec, { fn, inputSchema } from '../../../../plugin/workflows/adversarial-plan/workflow.ts';

function baseRecall(): RecallBundle {
  return {
    byKey: {
      'file.contents': {
        path: '/repo/specs/plan.md',
        body: '# Spec\n\nBuild the thing.',
      },
    },
    warnings: [],
    estimatedTokens: 10,
  };
}

function makeConfig() {
  return {
    workloads: {
      plan_refine: {
        eligible_agents: ['architect', 'simplifier', 'test-first', 'risk', 'integration'],
        fan_out: 5,
        synthesizer: 'codex',
      },
    },
  };
}

function makeCtx(opts?: {
  args?: Record<string, unknown>;
  dispatchImpl?: (input: { agent: string; message: string; task_type?: string; use_worktree?: boolean }) => Promise<{ conversation_id: string; handoff_id: string }>;
  awaitImpl?: (conversationId: string, opts?: { timeoutMs?: number }) => Promise<{ status: 'completed' | 'failed' | 'timeout'; response_text: string | null }>;
}) {
  const root = mkdtempSync(join(tmpdir(), 'adv-plan-'));
  const writes: Array<{ path: string; body: string }> = [];
  const dispatch = mock(
    opts?.dispatchImpl ??
      (async ({ agent }: { agent: string }) => ({
        conversation_id: `${agent}-conv`,
        handoff_id: `${agent}-handoff`,
      })),
  );
  const awaitChain = mock(
    opts?.awaitImpl ??
      (async (conversationId: string) => ({
        status: 'completed' as const,
        response_text: `plan for ${conversationId}`,
      })),
  );

  const ctx: WorkflowCtx = {
    dispatch,
    awaitChain,
    fileWrite: async (relativePath, body) => {
      const path = isAbsolute(relativePath) ? relativePath : join(root, relativePath);
      writes.push({ path, body });
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, body);
      return path;
    },
    config: makeConfig(),
    cwd: root,
    storageRoot: root,
    project: 'penumbra',
    args: inputSchema.parse(opts?.args ?? {}),
  };

  return { ctx, root, writes, dispatch, awaitChain };
}

function parseSynthesisFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    const parsed = parseYaml(match[1]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

test('spec metadata is registered as manual + slash ts-function workflow', () => {
  expect(spec.name).toBe('adversarial-plan');
  expect(spec.triggers).toEqual([
    { kind: 'manual' },
    { kind: 'slash', command: 'adversarial-plan' },
  ]);
  expect(spec.run).toEqual({ kind: 'ts-function' });
});

test('inputSchema applies defaults and rejects unknown keys', () => {
  expect(inputSchema.parse({})).toEqual({
    timeout_ms: 600000,
  });
  expect(() => inputSchema.parse({ unexpected: true })).toThrow();
});

test('happy path: two personas complete, synthesizer runs, and synthesis is written', async () => {
  const { ctx, root, dispatch } = makeCtx({
    args: {
      topic: 'Ship a planning workflow',
      personas: ['architect', 'simplifier'],
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      out_dir: string;
      synthesis_path: string | null;
      personas: Array<{ name: string; status: string; conversation_id: string | null }>;
      synthesizer_status: string | null;
    };
    expect(result.ok).toBe(true);
    expect(result.personas).toEqual([
      { name: 'architect', status: 'completed', conversation_id: 'architect-conv' },
      { name: 'simplifier', status: 'completed', conversation_id: 'simplifier-conv' },
    ]);
    expect(result.synthesis_path).toBe(join(result.out_dir, 'synthesis.md'));
    expect(result.synthesizer_status).toBe('completed');
    expect(dispatch).toHaveBeenCalledTimes(3);
    const synthContent = await readFile(join(result.out_dir, 'synthesis.md'), 'utf8');
    const fm = parseSynthesisFrontmatter(synthContent);
    expect(fm).not.toBeNull();
    if (!fm) return;
    expect(fm.topic).toBe('Ship a planning workflow');
    expect(fm.personas).toBe('architect, simplifier');
    expect(fm.synthesis_handoff_id).toBe('codex-handoff');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('one persona fails: synth still runs with surviving persona only', async () => {
  const { ctx, root } = makeCtx({
    args: {
      topic: 'Ship a planning workflow',
      personas: ['architect', 'simplifier'],
    },
    dispatchImpl: (() => {
      let call = 0;
      return async ({ agent }) => {
        call += 1;
        if (call === 1) {
          return { conversation_id: 'claude-conv', handoff_id: 'claude-handoff' };
        }
        if (call === 2) {
          return { conversation_id: 'codex-conv', handoff_id: 'codex-handoff' };
        }
        return { conversation_id: `${agent}-synth-conv`, handoff_id: `${agent}-synth-handoff` };
      };
    })(),
    awaitImpl: async (conversationId: string) => {
      if (conversationId === 'claude-conv') {
        return {
          status: 'completed' as const,
          response_text: 'architect plan',
        };
      }
      if (conversationId === 'codex-conv') {
        return {
          status: 'failed' as const,
          response_text: null,
        };
      }
      if (conversationId === 'codex-synth-conv') {
        return {
          status: 'completed' as const,
          response_text: 'synthesized plan',
        };
      }
      return {
        status: 'failed' as const,
        response_text: null,
      };
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      out_dir: string;
      synthesis_path: string | null;
      personas: Array<{ name: string; status: string; conversation_id: string | null }>;
      synthesizer_status: string | null;
    };
    expect(result.ok).toBe(true);
    expect(result.personas).toEqual([
      { name: 'architect', status: 'completed', conversation_id: 'claude-conv' },
      { name: 'simplifier', status: 'failed', conversation_id: 'codex-conv' },
    ]);
    expect(result.synthesis_path).toBe(join(result.out_dir, 'synthesis.md'));
    expect(result.synthesizer_status).toBe('completed');
    const synthContent = await readFile(join(result.out_dir, 'synthesis.md'), 'utf8');
    expect(synthContent).toContain('synthesized plan');
    expect(synthContent).not.toContain('simplifier plan');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('all personas fail: synth does not run and synthesis_path is null', async () => {
  const { ctx, root, dispatch } = makeCtx({
    args: {
      topic: 'Ship a planning workflow',
      personas: ['architect', 'simplifier'],
    },
    dispatchImpl: async () => {
      throw new Error('dispatch failed');
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      synthesis_path: string | null;
      error?: string;
      synthesizer_status: string | null;
    };
    expect(result.ok).toBe(false);
    expect(result.synthesis_path).toBeNull();
    expect(result.error).toBe('all_persona_dispatches_failed');
    expect(result.synthesizer_status).toBeNull();
    expect(dispatch).toHaveBeenCalledTimes(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown_personas error when args.personas includes an unconfigured name', async () => {
  const { ctx, root } = makeCtx({
    args: {
      topic: 'Ship a planning workflow',
      personas: ['architect', 'ghost'],
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; error?: string; missing_personas?: string[] };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('unknown_personas');
    expect(result.missing_personas).toEqual(['ghost']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no_personas_configured error when plan_refine workload has no eligible agents', async () => {
  const { ctx, root } = makeCtx({
    args: {
      topic: 'Ship a planning workflow',
    },
  });
  try {
    const planRefine = (ctx.config.workloads as Record<string, unknown>).plan_refine as Record<string, unknown>;
    planRefine.eligible_agents = [];
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('no_personas_configured');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no_topic_or_content error when neither topic nor content_path is provided', async () => {
  const { ctx, root } = makeCtx();
  try {
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('no_topic_or_content');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('synth dispatch message includes the anti-derail preamble and uses workload synthesizer', async () => {
  const { ctx, root, dispatch } = makeCtx({
    args: {
      topic: 'Ship a planning workflow',
      personas: ['architect', 'simplifier'],
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; synthesizer_status: string | null };
    expect(result.ok).toBe(true);
    expect(result.synthesizer_status).toBe('completed');
    expect(dispatch).toHaveBeenCalledTimes(3);
    const synthCall = dispatch.mock.calls[2]?.[0] as { message: string } | undefined;
    const synthMessage = synthCall?.message ?? '';
    expect(synthMessage).toContain('You are the synthesizer for an /adversarial-plan fan-out');
    expect(synthMessage).toContain('This is NOT a session start');
    expect(synthMessage).toContain('Do not run first moves');
    expect(synthMessage).toContain('Do not check git status');
    expect(synthMessage).toContain('Do not output status summaries');
    const synthAgentCall = dispatch.mock.calls[2]?.[0] as { agent?: string } | undefined;
    expect(synthAgentCall?.agent).toBe('codex');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
