import { expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { WorkflowCtx, RecallBundle } from '@penumbra/workflows';
import { parse as parseYaml } from 'yaml';
import spec, { fn, inputSchema } from '../../../../plugin/workflows/adversarial-review/workflow.ts';

function baseRecall(): RecallBundle {
  return {
    byKey: {
      'git.diff': 'diff --git a/a.ts b/a.ts',
      'git.show': [
        {
          sha: 'abc123',
          subject: 'feat: add thing',
          ts: '2026-05-08T00:00:00.000Z',
          body: 'details',
        },
      ],
      'file.contents': {
        path: '/repo/src/a.ts',
        body: 'export const a = 1;',
      },
    },
    warnings: [],
    estimatedTokens: 10,
  };
}

function makeConfig() {
  return {
    review_personas: {
      security: {
        name: 'security',
        bias: 'security-focused',
        system_prompt: 'Find vulnerabilities.',
        preferred_agent: 'claude',
        category_hints: ['security'],
      },
      performance: {
        name: 'performance',
        bias: 'performance-focused',
        system_prompt: 'Find performance risks.',
        preferred_agent: 'gemini',
      },
    },
    review_synthesizer: {
      preferred_agent: 'codex',
      system_prompt: 'Synthesize reviews.',
    },
  };
}

function makeCtx(opts?: {
  args?: Record<string, unknown>;
  dispatchImpl?: (input: { agent: string; message: string; task_type?: string; use_worktree?: boolean }) => Promise<{ conversation_id: string; handoff_id: string }>;
  awaitImpl?: (conversationId: string, opts?: { timeoutMs?: number }) => Promise<{ status: 'completed' | 'failed' | 'timeout'; final_agent: string | null; response_text: string | null }>;
}) {
  const root = mkdtempSync(join(tmpdir(), 'adv-review-'));
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
        final_agent: 'agent',
        response_text: `review for ${conversationId}\n\n\`\`\`json\n[{"persona":"x","severity":"high","category":"bug","file":"x.ts","line":1,"title":"t","details":"d","suggestion":"s"}]\n\`\`\``,
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
  expect(spec.name).toBe('adversarial-review');
  expect(spec.triggers).toEqual([
    { kind: 'manual' },
    { kind: 'slash', command: 'adversarial-review' },
  ]);
  expect(spec.run).toEqual({ kind: 'ts-function' });
});

test('inputSchema applies defaults and rejects unknown keys', () => {
  expect(inputSchema.parse({})).toEqual({
    target_ref: 'HEAD',
    base_ref: 'main',
    timeout_ms: 600000,
  });
  expect(() => inputSchema.parse({ unexpected: true })).toThrow();
});

test('out_dir outside allowed roots is rejected', async () => {
  const { ctx, root } = makeCtx({
    args: {
      out_dir: '/tmp/external',
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('out_dir_outside_allowed_roots');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('relative out_dir resolves under cwd', async () => {
  const { ctx, root } = makeCtx({
    args: {
      out_dir: './reviews/custom',
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; out_dir: string };
    expect(result.ok).toBe(true);
    expect(result.out_dir).toBe(resolve(root, 'reviews/custom'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('all personas succeed: writes persona artifacts and synthesis with handoff_id frontmatter', async () => {
  const dispatchCalls: Array<{ agent: string; message: string; task_type?: string; use_worktree?: boolean }> = [];
  const { ctx, root, dispatch } = makeCtx();
  try {
    dispatch.mockImplementation(async (input: { agent: string; message: string; task_type?: string; use_worktree?: boolean }) => {
      dispatchCalls.push(input);
      return {
        conversation_id: `${input.agent}-conv`,
        handoff_id: `${input.agent}-handoff`,
      };
    });
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      out_dir: string;
      synthesis_path: string | null;
      personas: Array<{ name: string; status: string; findings_count: number | null }>;
      synthesizer_status: string | null;
    };
    expect(result.ok).toBe(true);
    expect(result.personas).toHaveLength(2);
    expect(result.synthesis_path).toBeTruthy();
    expect(result.synthesizer_status).toBe('completed');
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(dispatchCalls).toHaveLength(3);
    expect(dispatchCalls[0]?.use_worktree).toBe(false);
    expect(dispatchCalls[0]?.message.startsWith(`cd ${ctx.cwd}\n\n`)).toBe(true);
    expect(dispatchCalls[2]?.use_worktree).toBe(false);
    expect(dispatchCalls[2]?.message.startsWith(`cd ${ctx.cwd}\n\n`)).toBe(true);
    await stat(join(result.out_dir, 'security.json'));
    await stat(join(result.out_dir, 'security.md'));
    await stat(join(result.out_dir, 'performance.json'));
    await stat(join(result.out_dir, 'performance.md'));
    await stat(join(result.out_dir, 'synthesis.md'));
    const security = JSON.parse(await readFile(join(result.out_dir, 'security.json'), 'utf8')) as {
      status: string;
      raw_status: string;
      triviality_reason?: string;
    };
    expect(security.status).toBe('completed');
    expect(security.raw_status).toBe('completed');
    expect(security.triviality_reason).toBeUndefined();
    const synthContent = await readFile(join(result.out_dir, 'synthesis.md'), 'utf8');
    const fm = parseSynthesisFrontmatter(synthContent);
    expect(fm).not.toBeNull();
    if (!fm) return;
    expect(fm.review_run_ts).toBeString();
    expect(fm.synthesis_handoff_id).toBe('codex-handoff');
    expect(fm.target_ref).toBe('HEAD');
    expect(fm.base_ref).toBe('main');
    const personaIds = fm.persona_handoff_ids as Record<string, string>;
    expect(personaIds).toBeDefined();
    expect(personaIds.security).toBe('claude-handoff');
    expect(personaIds.performance).toBe('gemini-handoff');
    expect(synthContent).toContain('review for codex-conv');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('one persona dispatch fails: workflow still synthesizes remaining results', async () => {
  const { ctx, root, dispatch } = makeCtx({
    dispatchImpl: async ({ agent }) => {
      if (agent === 'gemini') {
        throw new Error('dispatch failed');
      }
      return { conversation_id: `${agent}-conv`, handoff_id: `${agent}-handoff` };
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as {
      ok: boolean;
      out_dir: string;
      synthesis_path: string | null;
    };
    expect(result.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(3);
    const perf = JSON.parse(await readFile(join(result.out_dir, 'performance.json'), 'utf8')) as { status: string };
    expect(perf.status).toBe('failed');
    expect(result.synthesis_path).toBeTruthy();
    const synthContent = await readFile(join(result.out_dir, 'synthesis.md'), 'utf8');
    const fm = parseSynthesisFrontmatter(synthContent);
    expect(fm).not.toBeNull();
    if (!fm) return;
    expect(fm.synthesis_handoff_id).toBe('codex-handoff');
    const personaIds = fm.persona_handoff_ids as Record<string, string>;
    expect(personaIds.security).toBe('claude-handoff');
    expect(personaIds.performance).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('all personas fail: synthesizer is not dispatched and synthesis_path is null', async () => {
  const { ctx, root, dispatch } = makeCtx({
    dispatchImpl: async () => {
      throw new Error('no route');
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; synthesis_path: string | null; error?: string };
    expect(result.ok).toBe(false);
    expect(result.synthesis_path).toBeNull();
    expect(result.error).toBe('all_persona_dispatches_failed');
    expect(dispatch).toHaveBeenCalledTimes(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('all persona awaits fail: synthesizer is not dispatched and synthesis_path is null', async () => {
  const { ctx, root, dispatch } = makeCtx({
    awaitImpl: async () => ({
      status: 'failed',
      final_agent: null,
      response_text: null,
    }),
  });
  try {
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; synthesis_path: string | null; error?: string };
    expect(result.ok).toBe(false);
    expect(result.synthesis_path).toBeNull();
    expect(result.error).toBe('all_persona_dispatches_failed');
    expect(dispatch).toHaveBeenCalledTimes(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing review_personas config returns no_personas_configured', async () => {
  const { ctx, root } = makeCtx();
  try {
    ctx.config.review_personas = undefined;
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('no_personas_configured');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing review_synthesizer config returns no_synthesizer_configured', async () => {
  const { ctx, root } = makeCtx();
  try {
    ctx.config.review_synthesizer = undefined;
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('no_synthesizer_configured');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('args.personas selects only subset of configured personas', async () => {
  const { ctx, root, dispatch } = makeCtx({ args: { personas: ['security'] } });
  try {
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; personas: Array<{ name: string }> };
    expect(result.ok).toBe(true);
    expect(result.personas.map((p) => p.name)).toEqual(['security']);
    expect(dispatch).toHaveBeenCalledTimes(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trivial response with no json findings is downgraded to failed', async () => {
  const { ctx, root } = makeCtx({
    awaitImpl: async (conversationId: string) => {
      if (conversationId.startsWith('claude')) {
        return {
          status: 'completed',
          final_agent: 'claude',
          response_text: 'Model set. Ready when you have a task.',
        };
      }
      return {
        status: 'completed',
        final_agent: 'gemini',
        response_text:
          'ok\n\n```json\n[{"persona":"p","severity":"low","category":"style","file":"x.ts","line":1,"title":"t","details":"d","suggestion":"s"}]\n```',
      };
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; out_dir: string };
    expect(result.ok).toBe(true);
    const security = JSON.parse(await readFile(join(result.out_dir, 'security.json'), 'utf8')) as {
      status: string;
      raw_status: string;
      triviality_reason?: string;
      findings: unknown;
      parse_error?: string;
    };
    expect(security.status).toBe('failed');
    expect(security.raw_status).toBe('completed');
    expect(security.triviality_reason).toBe('trivial_response');
    expect(security.findings).toBeNull();
    expect(security.parse_error).toBe('no_json_block');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('substantive response without findings is not downgraded', async () => {
  const longNoJson = `Let me read the key files and evaluate architecture choices.\n\n${'analysis '.repeat(40)}`;
  const { ctx, root } = makeCtx({
    awaitImpl: async (conversationId: string) => {
      if (conversationId.startsWith('claude')) {
        return {
          status: 'completed',
          final_agent: 'claude',
          response_text: longNoJson,
        };
      }
      return {
        status: 'completed',
        final_agent: 'gemini',
        response_text:
          'ok\n\n```json\n[{"persona":"p","severity":"low","category":"style","file":"x.ts","line":1,"title":"t","details":"d","suggestion":"s"}]\n```',
      };
    },
  });
  try {
    const result = (await fn(ctx, baseRecall())) as { ok: boolean; out_dir: string };
    expect(result.ok).toBe(true);
    const security = JSON.parse(await readFile(join(result.out_dir, 'security.json'), 'utf8')) as {
      status: string;
      raw_status: string;
      triviality_reason?: string;
      findings: unknown;
      parse_error?: string;
    };
    expect(security.status).toBe('completed');
    expect(security.raw_status).toBe('completed');
    expect(security.triviality_reason).toBeUndefined();
    expect(security.findings).toBeNull();
    expect(security.parse_error).toBe('no_json_block');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
