import { describe, it, expect, afterEach } from 'bun:test';
import { fsGlobHandler } from '../../src/tools/fs-glob.js';

function fakeDaemon(impl?: Partial<{ globInWorktree: any }>): any {
  return { globInWorktree: impl?.globInWorktree ?? (async () => ({ results: [], truncated: false })) };
}

describe('fs.glob handler', () => {
  afterEach(() => {
    delete process.env.PENUMBRA_HANDOFF_ID;
  });

  it('forwards pattern + path + handoff_id to daemon', async () => {
    let received: any = null;
    const daemon = fakeDaemon({
      globInWorktree: async (id: string, args: any) => {
        received = { id, args };
        return { results: ['x'], truncated: false };
      },
    });
    const handler = fsGlobHandler(daemon);
    const out = await handler({ pattern: '*.ts', handoff_id: 'H1' });
    expect(received.id).toBe('H1');
    expect(received.args.pattern).toBe('*.ts');
    const text = JSON.parse((out.content[0] as any).text);
    expect(text.results).toEqual(['x']);
  });

  it('defaults handoff_id from PENUMBRA_HANDOFF_ID env when arg absent', async () => {
    process.env.PENUMBRA_HANDOFF_ID = 'H_ENV';
    let receivedId: string | null = null;
    const daemon = fakeDaemon({
      globInWorktree: async (id: string) => {
        receivedId = id;
        return { results: [], truncated: false };
      },
    });
    const handler = fsGlobHandler(daemon);
    await handler({ pattern: '*.ts' });
    expect(receivedId).toBe('H_ENV');
  });

  it('returns no_handoff_context error when neither arg nor env set', async () => {
    const daemon = fakeDaemon();
    const handler = fsGlobHandler(daemon);
    const out = await handler({ pattern: '*.ts' });
    expect(out.isError).toBe(true);
    const text = JSON.parse((out.content[0] as any).text);
    expect(text.error.code).toBe('no_handoff_context');
  });

  it('surfaces daemon HTTP errors as isError with code preserved', async () => {
    const daemon = fakeDaemon({
      globInWorktree: async () => {
        const err: any = new Error('daemon error');
        err.status = 404;
        err.body = { error: { code: 'not_found', message: 'worktree not found' } };
        throw err;
      },
    });
    const handler = fsGlobHandler(daemon);
    const out = await handler({ pattern: '*.ts', handoff_id: 'X' });
    expect(out.isError).toBe(true);
    const text = JSON.parse((out.content[0] as any).text);
    expect(text.error.code).toBe('not_found');
  });
});
