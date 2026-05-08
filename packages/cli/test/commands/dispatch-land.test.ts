import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDispatchLand, runDispatchListPending } from '../../src/commands/dispatch.js';

let storageRoot = '';

describe('runDispatchLand', () => {
  beforeEach(() => {
    storageRoot = mkdtempSync(join(tmpdir(), 'penumbra-dispatch-land-'));
    writeFileSync(join(storageRoot, 'port'), '4242\n');
    writeFileSync(join(storageRoot, 'token'), 'tok\n');
  });

  afterEach(() => {
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  });

  test('editor flow uses curated message and posts to /dispatch/land', async () => {
    const printed: string[] = [];
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    await runDispatchLand({
      handoffId: 'h-editor',
      storageRoot,
      mode: 'squash',
      deleteBranch: true,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({
          ok: true,
          commit_sha: 'abc123',
          message_subject: 'feat(core): curated subject',
          branch_deleted: true,
          pr_closed: false,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      editCommitMessage: async (template) => {
        expect(template).toContain('Curated commit message for landing dispatch h-editor');
        expect(template).toContain('Recent commits on agent branch');
        expect(template).toContain('Diff stat');
        return '# ignore\nfeat(core): curated subject\n\nBody line\n';
      },
      print: (line) => { printed.push(line); },
    } as any);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:4242/dispatch/land');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer tok');
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toMatchObject({
      handoff_id: 'h-editor',
      commit_message: 'feat(core): curated subject\n\nBody line',
      mode: 'squash',
      delete_branch: true,
      force: false,
    });
    expect(printed.join('\n')).toContain('Landed: abc123 "feat(core): curated subject"');
  });

  test('--force bypasses verdict prompt', async () => {
    let confirmCalls = 0;
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    await runDispatchLand({
      handoffId: 'h-force',
      storageRoot,
      force: true,
      message: 'chore: force',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({
          ok: true,
          commit_sha: 'force123',
          message_subject: 'chore: force',
          branch_deleted: false,
          pr_closed: false,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      confirm: async () => {
        confirmCalls += 1;
        return true;
      },
      print: () => {},
    } as any);

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.force).toBe(true);
    expect(confirmCalls).toBe(0);
  });

  test('verdict_unverified prompts then retries with force when confirmed', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const printed: string[] = [];
    let confirmCalls = 0;

    await runDispatchLand({
      handoffId: 'h-retry',
      storageRoot,
      message: 'feat: retry',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        if (calls.length === 1) {
          return new Response(JSON.stringify({
            error: {
              code: 'verdict_unverified',
              verdict: { typecheck: 'pass', tests: 'fail', summary: 'tests failed' },
            },
          }), { status: 409, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          ok: true,
          commit_sha: 'retry123',
          message_subject: 'feat: retry',
          branch_deleted: true,
          pr_closed: true,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      confirm: async () => {
        confirmCalls += 1;
        return true;
      },
      print: (line) => { printed.push(line); },
    } as any);

    expect(confirmCalls).toBe(1);
    expect(calls).toHaveLength(2);
    const first = JSON.parse(String(calls[0]?.init?.body));
    const second = JSON.parse(String(calls[1]?.init?.body));
    expect(first.force).toBe(false);
    expect(second.force).toBe(true);
    expect(printed.join('\n')).toContain('verdict failed');
  });

  test('merge_conflict prints files and throws with rebase hint', async () => {
    const printed: string[] = [];
    await expect(runDispatchLand({
      handoffId: 'h-conflict',
      storageRoot,
      message: 'feat: conflict',
      fetch: async () => new Response(JSON.stringify({
        error: {
          code: 'merge_conflict',
          files: ['a.ts', 'b.ts'],
          hint: 'rebase agent/h-conflict onto main and retry',
        },
      }), { status: 409, headers: { 'content-type': 'application/json' } }),
      print: (line) => { printed.push(line); },
    } as any)).rejects.toThrow('merge conflict');

    expect(printed.join('\n')).toContain('a.ts');
    expect(printed.join('\n')).toContain('b.ts');
    expect(printed.join('\n')).toContain('rebase agent/h-conflict onto main and retry');
  });

  test('retry after verdict_unverified still handles subsequent merge_conflict', async () => {
    const printed: string[] = [];
    let confirmCalls = 0;
    await expect(runDispatchLand({
      handoffId: 'h-retry-conflict',
      storageRoot,
      message: 'feat: retry conflict',
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.force) {
          return new Response(JSON.stringify({
            error: {
              code: 'merge_conflict',
              files: ['x.ts'],
              hint: 'rebase and retry',
            },
          }), { status: 409, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          error: {
            code: 'verdict_unverified',
            verdict: { typecheck: 'pass', tests: 'fail', summary: 'tests failed' },
          },
        }), { status: 409, headers: { 'content-type': 'application/json' } });
      },
      confirm: async () => {
        confirmCalls += 1;
        return true;
      },
      print: (line) => { printed.push(line); },
    } as any)).rejects.toThrow('merge conflict');

    expect(confirmCalls).toBe(1);
    expect(printed.join('\n')).toContain('verdict failed');
    expect(printed.join('\n')).toContain('x.ts');
    expect(printed.join('\n')).toContain('rebase and retry');
  });

  test('polls async land task until terminal result', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const printed: string[] = [];

    await runDispatchLand({
      handoffId: 'h-async',
      storageRoot,
      message: 'feat: async path',
      fetch: async (url, init) => {
        const asString = String(url);
        calls.push({ url: asString, init });
        if (asString.endsWith('/dispatch/land')) {
          return new Response(JSON.stringify({
            ok: true,
            task_id: 'task-1',
            status: 'queued',
          }), { status: 202, headers: { 'content-type': 'application/json' } });
        }
        if (asString.endsWith('/dispatch/land/task-1')) {
          const pollCount = calls.filter((call) => call.url.endsWith('/dispatch/land/task-1')).length;
          if (pollCount < 2) {
            return new Response(JSON.stringify({
              task_id: 'task-1',
              status: 'running',
              result: null,
              error: null,
            }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          return new Response(JSON.stringify({
            task_id: 'task-1',
            status: 'done',
            result: {
              ok: true,
              commit_sha: 'abc999',
              message_subject: 'feat: async path',
              branch_deleted: true,
              pr_closed: false,
            },
            error: null,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{}', { status: 404 });
      },
      print: (line) => { printed.push(line); },
    } as any);

    expect(calls.some((call) => call.url.endsWith('/dispatch/land/task-1'))).toBe(true);
    expect(printed.join('\n')).toContain('Landed: abc999 "feat: async path"');
  });
});

describe('runDispatchListPending', () => {
  beforeEach(() => {
    storageRoot = mkdtempSync(join(tmpdir(), 'penumbra-dispatch-pending-'));
    writeFileSync(join(storageRoot, 'port'), '4242\n');
    writeFileSync(join(storageRoot, 'token'), 'tok\n');
  });

  afterEach(() => {
    if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
  });

  test('prints recent reconciler verdicts with land hints', async () => {
    const printed: string[] = [];
    await runDispatchListPending({
      storageRoot,
      fetch: async () => new Response(JSON.stringify({
        verdicts: [
          {
            handoff_id: 'h-1',
            to_agent: 'codex',
            verdict: {
              typecheck: 'pass',
              tests: 'pass',
              files_changed: 3,
              lines_added: 20,
              lines_deleted: 5,
            },
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
      print: (line) => { printed.push(line); },
    } as any);

    const out = printed.join('\n');
    expect(out).toContain('h-1');
    expect(out).toContain('typecheck=pass');
    expect(out).toContain('tests=pass');
    expect(out).toContain('penumbra dispatch land h-1');
  });
});
