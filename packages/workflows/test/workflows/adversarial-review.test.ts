import { expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { WorkflowCtx, RecallBundle } from '@penumbra/workflows';
import spec, { fn } from '../../../../plugin/workflows/adversarial-review/workflow.ts';

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
  dispatchImpl?: (input: { agent: string; message: string; task_type?: string }) => Promise<{ conversation_id: string; handoff_id: string }>;
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
    args: opts?.args ?? {},
  };
  return { ctx, root, writes, dispatch, awaitChain };
}

test('spec metadata is registered as manual + slash ts-function workflow', () => {
  expect(spec.name).toBe('adversarial-review');
  expect(spec.triggers).toEqual([
    { kind: 'manual' },
    { kind: 'slash', command: 'adversarial-review' },
  ]);
  expect(spec.run).toEqual({ kind: 'ts-function' });
});

test('all personas succeed: writes persona artifacts and synthesis', async () => {
  const { ctx, root, dispatch } = makeCtx();
  try {
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
    await stat(join(result.out_dir, 'security.json'));
    await stat(join(result.out_dir, 'security.md'));
    await stat(join(result.out_dir, 'performance.json'));
    await stat(join(result.out_dir, 'performance.md'));
    await stat(join(result.out_dir, 'synthesis.md'));
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

test('json parse failure is captured but workflow still succeeds', async () => {
  const { ctx, root } = makeCtx({
    awaitImpl: async (conversationId: string) => {
      if (conversationId.startsWith('claude')) {
        return {
          status: 'completed',
          final_agent: 'claude',
          response_text: 'review without json block',
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
      findings: unknown;
      parse_error?: string;
    };
    expect(security.findings).toBeNull();
    expect(security.parse_error).toBe('no_json_block');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
